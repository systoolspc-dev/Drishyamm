"""Video-based pilot.

Takes one or more CCTV clips with a manifest stating who *should* appear in
each clip, and measures per-track recognition outcomes. This is closer to
real production behavior than image-based eval — it exercises the tracker
plus per-track aggregation.

Manifest CSV (manifest_videos.csv):
    video_path,expected_person_ids,scenario,camera
    clips/cam01_morning.mp4,alice;bob,indoor_day,cam-01
    clips/cam05_night.mp4,,outdoor_night,cam-05
    clips/cam03_distance.mp4,carol,outdoor_distance,cam-03

`expected_person_ids` is a `;`-delimited list. Empty means "nobody enrolled
should appear here" — used to measure FPR.

Per-clip outputs:
  - n_tracks: total tracks created
  - n_recognized_tracks: tracks whose top-K aggregated embedding matched any
    expected ID above the threshold
  - per-expected-id: was each expected id recognized in at least one track?
  - false_alarms: tracks matched to an enrolled person who is NOT expected
    (for clips where the watchlist is closed-set we treat these as FP)

Usage:
    python -m vms_face.eval.video_pilot \\
        --gallery ./eval_data/gallery \\
        --videos-manifest ./eval_data/manifest_videos.csv \\
        --threshold 0.45 \\
        --target-fps 8 \\
        --out ./eval_data/video_report
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import typer

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from vms_face.eval.harness import build_gallery, InMemoryGallery
from vms_face.eval.manifest import load_gallery
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.recognizers import Recognizer, build_recognizer
from vms_face.pipeline.ingest import RTSPIngest
from vms_face.services.face_quality import FaceQualityGate
from vms_face.services.face_tracker import IOUTracker
from vms_face.services.track_embedding_pool import TrackEmbeddingPool

log = get_logger(__name__)
app = typer.Typer(add_completion=False)


@dataclass(slots=True)
class TrackAggregate:
    track_id: str
    best_quality: float = 0.0
    best_embedding: np.ndarray | None = None
    best_similarity: float = 0.0
    best_match_id: str | None = None
    hits: int = 0
    above_threshold_hits: int = 0
    match_history: list[tuple[str | None, float]] = field(default_factory=list)


@dataclass(slots=True)
class ClipResult:
    video: str
    scenario: str
    camera: str
    expected: list[str]
    n_frames_decoded: int
    n_detections: int
    n_tracks: int
    recognized_expected: list[str]            # expected IDs that got matched in any track
    missed_expected: list[str]                # expected IDs that never matched
    false_alarms: list[tuple[str, str, float]]  # (track_id, matched_id, sim) where matched_id wasn't expected
    duration_sec: float
    threshold: float

    def to_row(self) -> dict:
        return {
            "video": self.video,
            "scenario": self.scenario,
            "camera": self.camera,
            "expected": ";".join(self.expected),
            "recognized": ";".join(self.recognized_expected),
            "missed": ";".join(self.missed_expected),
            "false_alarms": ";".join(f"{t}:{m}@{s:.3f}" for t, m, s in self.false_alarms),
            "n_frames": self.n_frames_decoded,
            "n_detections": self.n_detections,
            "n_tracks": self.n_tracks,
            "duration_sec": f"{self.duration_sec:.1f}",
            "tpr_per_clip": f"{(len(self.recognized_expected) / len(self.expected)):.3f}" if self.expected else "",
        }


def evaluate_clip(
    runtime: FaceRuntime,
    recognizer: Recognizer,
    quality: FaceQualityGate,
    gallery: InMemoryGallery,
    video_path: Path,
    *,
    target_fps: float,
    threshold: float,
    confirm_min_hits: int = 3,
    pool_top_k: int = 5,
) -> tuple[int, int, list[TrackAggregate]]:
    """Run the full pipeline on a single clip and return aggregated tracks.

    Uses per-track embedding pools (matching the production orchestrator) so
    the eval reflects what the live system would do."""
    tracker = IOUTracker()
    tracks: dict[str, TrackAggregate] = {}
    pools: dict[str, TrackEmbeddingPool] = {}
    n_frames = 0
    n_detections = 0

    ingest = RTSPIngest(str(video_path), target_fps=target_fps)
    ingest.open()
    try:
        for frame in ingest.frames():
            n_frames += 1
            observations = runtime.detect(frame.bgr)
            if not observations:
                tracker.step([])
                continue
            n_detections += len(observations)
            tracked = tracker.step(observations)
            for tf in tracked:
                verdict = quality.evaluate(frame.bgr, tf.observation)
                if not verdict.passed:
                    continue

                emb = recognizer.reuse_existing(tf.observation.embedding)
                if emb is None:
                    if tf.observation.landmark_5 is None:
                        continue
                    emb = recognizer.embed(frame.bgr, tf.observation.landmark_5)
                if emb is None:
                    continue

                pool = pools.setdefault(tf.track.track_id, TrackEmbeddingPool(top_k=pool_top_k))
                pool.add(verdict.score, emb)
                pooled = pool.pooled()
                if pooled is None:
                    continue
                pred_id, sim = gallery.best_match(pooled)

                agg = tracks.get(tf.track.track_id)
                if agg is None:
                    agg = TrackAggregate(track_id=tf.track.track_id)
                    tracks[tf.track.track_id] = agg
                agg.hits += 1
                if sim >= threshold:
                    agg.above_threshold_hits += 1
                if verdict.score > agg.best_quality:
                    agg.best_quality = verdict.score
                    agg.best_embedding = emb
                if sim > agg.best_similarity:
                    agg.best_similarity = sim
                    agg.best_match_id = pred_id
                agg.match_history.append((pred_id, sim))
    finally:
        ingest.close()

    # apply confirm_min_hits: only count tracks that survived enough frames
    confirmed = [a for a in tracks.values() if a.hits >= confirm_min_hits]
    return n_frames, n_detections, confirmed


@app.command()
def main(
    gallery: Path = typer.Option(..., exists=True, file_okay=False, dir_okay=True),
    videos_manifest: Path = typer.Option(..., exists=True, file_okay=True, dir_okay=False),
    threshold: float = typer.Option(settings.insightface_rec_threshold),
    target_fps: float = typer.Option(8.0),
    confirm_min_hits: int = typer.Option(3, help="track must have >= N detections to count"),
    pool_top_k: int = typer.Option(settings.track_pool_top_k, help="top-K quality-weighted pool size per track"),
    out: Path = typer.Option(Path("./video_report")),
    recognizer_backend: str = typer.Option(
        settings.recognizer_backend,
        "--recognizer",
        help="override RECOGNIZER_BACKEND for this run: insightface | adaface",
    ),
) -> None:
    configure_logging()
    out.mkdir(parents=True, exist_ok=True)

    log.info("loading gallery", path=str(gallery))
    gallery_records = load_gallery(gallery)
    recognizer = build_recognizer(recognizer_backend)
    log.info("recognizer ready", backend=recognizer.name)

    needs_insightface_emb = recognizer.reuse_existing(np.zeros(512, dtype=np.float32)) is not None
    runtime = FaceRuntime(run_recognition=needs_insightface_emb)
    quality = FaceQualityGate()
    gal = build_gallery(runtime, recognizer, gallery_records)
    if len(gal) == 0:
        raise SystemExit("no gallery embeddings produced")

    log.info("running video pilot", manifest=str(videos_manifest), threshold=threshold)
    results: list[ClipResult] = []
    with videos_manifest.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            video_rel = (row.get("video_path") or "").strip()
            if not video_rel:
                continue
            video_path = (videos_manifest.parent / video_rel).resolve()
            expected_raw = (row.get("expected_person_ids") or "").strip()
            expected = [x.strip() for x in expected_raw.split(";") if x.strip()]
            scenario = row.get("scenario", "")
            camera = row.get("camera", "")
            log.info("clip start", video=str(video_path), expected=expected)
            t0 = time.perf_counter()
            n_frames, n_detections, tracks = evaluate_clip(
                runtime,
                recognizer,
                quality,
                gal,
                video_path,
                target_fps=target_fps,
                threshold=threshold,
                confirm_min_hits=confirm_min_hits,
                pool_top_k=pool_top_k,
            )
            duration = time.perf_counter() - t0

            recognized_expected: set[str] = set()
            false_alarms: list[tuple[str, str, float]] = []
            expected_set = set(expected)
            for agg in tracks:
                if agg.best_match_id is None:
                    continue
                if agg.best_similarity < threshold:
                    continue
                if agg.best_match_id in expected_set:
                    recognized_expected.add(agg.best_match_id)
                else:
                    false_alarms.append((agg.track_id, agg.best_match_id, agg.best_similarity))

            missed = [pid for pid in expected if pid not in recognized_expected]
            results.append(
                ClipResult(
                    video=str(video_path),
                    scenario=scenario,
                    camera=camera,
                    expected=expected,
                    n_frames_decoded=n_frames,
                    n_detections=n_detections,
                    n_tracks=len(tracks),
                    recognized_expected=sorted(recognized_expected),
                    missed_expected=missed,
                    false_alarms=false_alarms,
                    duration_sec=duration,
                    threshold=threshold,
                )
            )
            log.info(
                "clip done",
                video=str(video_path),
                tracks=len(tracks),
                recognized=sorted(recognized_expected),
                missed=missed,
                duration_sec=round(duration, 1),
            )

    _write_video_report(out, results, threshold=threshold, gallery_size=len(gal))
    log.info("video pilot complete", out=str(out), n_clips=len(results))


def _write_video_report(out: Path, results: list[ClipResult], *, threshold: float, gallery_size: int) -> None:
    rows = [r.to_row() for r in results]
    out.mkdir(parents=True, exist_ok=True)

    # CSV
    if rows:
        with (out / "clip_results.csv").open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    # aggregates
    by_scenario: dict[str, dict] = defaultdict(lambda: {"expected": 0, "recognized": 0, "false_alarms": 0, "clips": 0})
    total_expected = total_recognized = total_false_alarms = 0
    for r in results:
        b = by_scenario[r.scenario or "(unscored)"]
        b["expected"] += len(r.expected)
        b["recognized"] += len(r.recognized_expected)
        b["false_alarms"] += len(r.false_alarms)
        b["clips"] += 1
        total_expected += len(r.expected)
        total_recognized += len(r.recognized_expected)
        total_false_alarms += len(r.false_alarms)

    summary = {
        "timestamp": dt.datetime.utcnow().isoformat() + "Z",
        "threshold": threshold,
        "gallery_size": gallery_size,
        "n_clips": len(results),
        "overall": {
            "expected": total_expected,
            "recognized": total_recognized,
            "missed": total_expected - total_recognized,
            "false_alarms": total_false_alarms,
            "tpr_per_appearance": round(total_recognized / total_expected, 4) if total_expected else 0.0,
        },
        "by_scenario": {
            k: {
                "clips": v["clips"],
                "expected": v["expected"],
                "recognized": v["recognized"],
                "false_alarms": v["false_alarms"],
                "tpr_per_appearance": round(v["recognized"] / v["expected"], 4) if v["expected"] else 0.0,
            }
            for k, v in by_scenario.items()
        },
    }

    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    # plain text
    lines = [
        "=" * 70,
        "VMS FACE PILOT — VIDEO REPORT",
        "=" * 70,
        f"Timestamp:  {summary['timestamp']}",
        f"Threshold:  {threshold:.3f}",
        f"Gallery:    {gallery_size} centroids",
        f"Clips:      {summary['n_clips']}",
        "",
        "OVERALL",
        "-" * 70,
        f"  expected appearances: {summary['overall']['expected']}",
        f"  recognized:           {summary['overall']['recognized']}",
        f"  missed:               {summary['overall']['missed']}",
        f"  false alarms:         {summary['overall']['false_alarms']}",
        f"  TPR per appearance:   {summary['overall']['tpr_per_appearance']:.3f}",
        "",
        "BY SCENARIO",
        "-" * 70,
    ]
    for k, v in summary["by_scenario"].items():
        lines.append(
            f"  [{k}]  clips={v['clips']}  expected={v['expected']}  "
            f"recognized={v['recognized']}  fa={v['false_alarms']}  "
            f"tpr={v['tpr_per_appearance']:.3f}"
        )
    (out / "report.txt").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    app()
