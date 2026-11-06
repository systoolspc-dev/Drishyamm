"""Image-based pilot evaluation harness.

This is the first thing you should run before trusting the pipeline on
real CCTV. It builds an in-memory gallery of enrollment embeddings, then
sweeps a set of probe images and computes per-scenario TPR/FPR/F1.

Crucially it isolates evaluation from production — no Qdrant, no Postgres,
no Redis. Pure in-memory cosine search. This makes the harness portable
(runs on a laptop) and lets us measure model accuracy independent of
infrastructure noise.

Usage:
    python -m vms_face.eval.harness \\
        --gallery ./eval_data/gallery \\
        --probe   ./eval_data/probe \\
        --manifest ./eval_data/manifest.csv \\
        --threshold 0.45 \\
        --out ./eval_data/report

Manifest CSV format:
    path,true_person_id,scenario,camera
    probe/alice_indoor.jpg,alice,indoor,cam-01
    probe/bob_outdoor_day.jpg,bob,outdoor_day,cam-02
    probe/unknown_visitor.jpg,,unknown,cam-03

If you don't have a manifest, drop probes into a folder with the filename
convention `{id_or_unknown}__scenario=X__camera=Y.jpg` and pass --probe only.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import typer

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from vms_face.eval.manifest import (
    load_gallery,
    load_probes_from_dir,
    load_probes_from_manifest,
)
from vms_face.eval.metrics import aggregate
from vms_face.eval.report import write_reports
from vms_face.eval.types import GalleryRecord, ProbeOutcome, ProbeRecord
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.recognizers import Recognizer, build_recognizer
from vms_face.services.face_quality import FaceQualityGate

log = get_logger(__name__)
app = typer.Typer(add_completion=False)


@dataclass(slots=True)
class GalleryEntry:
    person_id: str
    embedding: np.ndarray   # (512,) L2-normed


class InMemoryGallery:
    """Cosine-similarity match against L2-normed embeddings. For 5-50k
    enrollments this is plenty fast; once the gallery is bigger we'd push
    it into Qdrant. For pilot runs (<5k) keeping it in NumPy avoids any
    confound from the vector DB layer."""

    def __init__(self, entries: list[GalleryEntry]) -> None:
        self._entries = entries
        if entries:
            self._matrix = np.stack([e.embedding for e in entries]).astype(np.float32)
            self._person_ids = [e.person_id for e in entries]
        else:
            self._matrix = np.zeros((0, 512), dtype=np.float32)
            self._person_ids = []

    def __len__(self) -> int:
        return len(self._entries)

    def best_match(self, query: np.ndarray) -> tuple[str | None, float]:
        if self._matrix.shape[0] == 0:
            return None, 0.0
        sims = self._matrix @ query.astype(np.float32)
        best_idx = int(np.argmax(sims))
        return self._person_ids[best_idx], float(sims[best_idx])


def build_gallery(
    runtime: FaceRuntime,
    recognizer: Recognizer,
    records: list[GalleryRecord],
) -> InMemoryGallery:
    """Detect+embed every gallery image. Multiple images per person are
    averaged into a single 'centroid' embedding (then re-normed). Centroid
    matching is a known-good simple aggregation; a more advanced setup uses
    per-image points and votes."""
    by_person: dict[str, list[np.ndarray]] = {}
    for rec in records:
        frame = cv2.imread(str(rec.path))
        if frame is None:
            log.warning("could not read gallery image", path=str(rec.path))
            continue
        obs_list = runtime.detect(frame, max_faces=1)
        if not obs_list:
            log.warning("no face in gallery image", path=str(rec.path))
            continue
        obs = obs_list[0]
        emb = recognizer.reuse_existing(obs.embedding)
        if emb is None:
            if obs.landmark_5 is None:
                log.warning("no landmarks for gallery image", path=str(rec.path))
                continue
            emb = recognizer.embed(frame, obs.landmark_5)
        if emb is None:
            log.warning("recognizer returned no embedding", path=str(rec.path))
            continue
        by_person.setdefault(rec.person_id, []).append(emb)

    entries: list[GalleryEntry] = []
    for pid, embs in by_person.items():
        stacked = np.stack(embs).astype(np.float32)
        centroid = stacked.mean(axis=0)
        n = float(np.linalg.norm(centroid))
        if n > 0:
            centroid /= n
        entries.append(GalleryEntry(person_id=pid, embedding=centroid))
        log.info("gallery person enrolled", person_id=pid, n_images=len(embs))

    return InMemoryGallery(entries)


def evaluate_probe(
    runtime: FaceRuntime,
    recognizer: Recognizer,
    quality: FaceQualityGate,
    gallery: InMemoryGallery,
    rec: ProbeRecord,
    *,
    threshold: float,
) -> ProbeOutcome:
    frame = cv2.imread(str(rec.path))
    if frame is None:
        return ProbeOutcome(
            probe_path=rec.path,
            true_person_id=rec.true_person_id,
            predicted_person_id=None,
            similarity=None,
            threshold=threshold,
            quality_score=None,
            det_score=None,
            undetected=True,
            tags=rec.tags,
            error="image read failed",
        )

    t0 = time.perf_counter()
    observations = runtime.detect(frame, max_faces=1)
    detect_ms = (time.perf_counter() - t0) * 1000.0

    if not observations:
        return ProbeOutcome(
            probe_path=rec.path,
            true_person_id=rec.true_person_id,
            predicted_person_id=None,
            similarity=None,
            threshold=threshold,
            quality_score=None,
            det_score=None,
            undetected=True,
            detect_latency_ms=detect_ms,
            tags=rec.tags,
        )

    obs = observations[0]
    verdict = quality.evaluate(frame, obs)
    if not verdict.passed:
        return ProbeOutcome(
            probe_path=rec.path,
            true_person_id=rec.true_person_id,
            predicted_person_id=None,
            similarity=None,
            threshold=threshold,
            quality_score=verdict.score,
            det_score=obs.det_score,
            rejected_quality=True,
            detect_latency_ms=detect_ms,
            tags={**rec.tags, "rejected_for": verdict.rejected_for.value if verdict.rejected_for else "unknown"},
        )

    embedding = recognizer.reuse_existing(obs.embedding)
    if embedding is None:
        if obs.landmark_5 is None:
            return ProbeOutcome(
                probe_path=rec.path,
                true_person_id=rec.true_person_id,
                predicted_person_id=None,
                similarity=None,
                threshold=threshold,
                quality_score=verdict.score,
                det_score=obs.det_score,
                undetected=True,
                detect_latency_ms=detect_ms,
                tags=rec.tags,
                error="no landmarks",
            )
        embedding = recognizer.embed(frame, obs.landmark_5)
    if embedding is None:
        return ProbeOutcome(
            probe_path=rec.path,
            true_person_id=rec.true_person_id,
            predicted_person_id=None,
            similarity=None,
            threshold=threshold,
            quality_score=verdict.score,
            det_score=obs.det_score,
            undetected=True,
            detect_latency_ms=detect_ms,
            tags=rec.tags,
            error="recognizer failed",
        )

    t0 = time.perf_counter()
    pred_id, sim = gallery.best_match(embedding)
    match_ms = (time.perf_counter() - t0) * 1000.0
    pred_above = pred_id if sim >= threshold else None

    return ProbeOutcome(
        probe_path=rec.path,
        true_person_id=rec.true_person_id,
        predicted_person_id=pred_above,
        similarity=sim,
        threshold=threshold,
        quality_score=verdict.score,
        det_score=obs.det_score,
        detect_latency_ms=detect_ms,
        match_latency_ms=match_ms,
        tags=rec.tags,
    )


@app.command()
def main(
    gallery: Path = typer.Option(..., exists=True, file_okay=False, dir_okay=True),
    probe: Path = typer.Option(..., exists=True, file_okay=False, dir_okay=True),
    manifest: Path | None = typer.Option(None, exists=True, file_okay=True, dir_okay=False),
    threshold: float = typer.Option(settings.insightface_rec_threshold),
    out: Path = typer.Option(Path("./eval_report")),
    group_keys: str = typer.Option("scenario,camera", help="comma-separated tag names to group metrics by"),
    recognizer_backend: str = typer.Option(
        settings.recognizer_backend,
        "--recognizer",
        help=(
            "override RECOGNIZER_BACKEND for this run: "
            "insightface | insightface_batched | adaface. "
            "insightface and insightface_batched share an embedding space "
            "(same weights, same vectors) so their numbers are directly "
            "comparable; adaface does not."
        ),
    ),
) -> None:
    """Run the pilot eval and write a JSON + text + HTML report."""
    configure_logging()
    out.mkdir(parents=True, exist_ok=True)

    log.info("loading gallery", path=str(gallery))
    gallery_records = load_gallery(gallery)
    log.info("gallery loaded", n_images=len(gallery_records), n_persons=len({r.person_id for r in gallery_records}))

    if manifest is not None:
        probe_records = load_probes_from_manifest(manifest)
    else:
        probe_records = load_probes_from_dir(probe)
    log.info("probes loaded", n=len(probe_records))

    # Build a fresh recognizer for this run; honors --recognizer override so
    # you can A/B test ArcFace vs AdaFace without editing .env.
    recognizer = build_recognizer(recognizer_backend)
    log.info("recognizer ready", backend=recognizer.name)

    # If the recognizer doesn't reuse insightface's ArcFace embedding,
    # initialize FaceRuntime without the recognition module to save a
    # forward pass per face.
    needs_insightface_emb = recognizer.reuse_existing(np.zeros(512, dtype=np.float32)) is not None
    runtime = FaceRuntime(run_recognition=needs_insightface_emb)
    quality = FaceQualityGate()

    log.info("building in-memory gallery (detect+embed)")
    gal = build_gallery(runtime, recognizer, gallery_records)
    if len(gal) == 0:
        raise SystemExit("no gallery embeddings produced; check images and detector")

    outcomes: list[ProbeOutcome] = []
    for i, rec in enumerate(probe_records, 1):
        outcome = evaluate_probe(runtime, recognizer, quality, gal, rec, threshold=threshold)
        outcomes.append(outcome)
        if i % 50 == 0:
            log.info("progress", completed=i, total=len(probe_records))

    keys = [k.strip() for k in group_keys.split(",") if k.strip()]
    metrics_by_group = aggregate(outcomes, group_keys=keys)

    summary = write_reports(
        out_dir=out,
        outcomes=outcomes,
        metrics_by_group=metrics_by_group,
        threshold=threshold,
        gallery_size=len(gal),
        n_persons=len({e.person_id for e in gal._entries}),
    )

    frvt = summary.get("frvt") or {}
    op = (frvt.get("operating_points") or {}).get("fpir=1e-03") or {}
    log.info(
        "pilot complete",
        out=str(out),
        recognizer=recognizer.name,
        all_tpr=summary["overall"]["tpr_recall"],
        all_fpr=summary["overall"]["fpr"],
        all_f1=summary["overall"]["f1"],
        detection_rate=summary["overall"]["detection_rate"],
        fnir_at_fpir_1e3=op.get("fnir"),
    )


if __name__ == "__main__":
    app()
