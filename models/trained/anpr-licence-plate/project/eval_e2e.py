"""
eval_e2e.py — end-to-end ANPR evaluation: the REAL worker pipeline on a video
file, scored against human ground truth of which plates pass when.

Runs worker.CameraWorker in-process (same models, same gates, same voter, same
tier rules as the live service) with the backend switched off, records every
read the worker decides to post, and compares them with a GT CSV:

    plate,t_start_s,t_end_s[,camera[,note]]
    GJ01AB1234,12.0,17.5,eval,"white Swift, left lane"
    # lines starting with # are ignored; seconds are from the start of the video

Scorecard
    exact plate recognition rate  GT plates with ≥ 1 posted read (either tier) whose
                                  WHOLE normalised string equals the GT plate AND whose
                                  evidence-frame time lies in [t_start − tol, t_end + tol]
    confirmed-only rate           the same, counting tier 'confirmed' reads only
    near-miss rate                GT plates without an exact hit but with a posted read at
                                  Levenshtein ≤ 1 inside the window (a lead, not a hit)
    false plates                  posted reads equal to NO GT plate — listed one by one, with
                                  the nearest GT plate when it is 1 edit away (a misread of a
                                  real vehicle) vs 'spurious' (nothing like it in the GT)
    out-of-window                 exact matches of a GT plate outside its window (listed; not hits)
    duplicates per GT plate       further _post calls for the same plate (incl. the ones the
                                  worker's REPOST_SECS dedup then suppressed)
    latency                       wall: post time − wall time of the first frame the worker was
                                  handed at/after t_start; video: video time at post − t_start;
                                  evidence delay: post − evidence frame (video seconds)
    throughput                    frames handed to detection / wall s (effective fps), processed
                                  fps (past the motion gate), realtime factor, enh/ocr ms per plate

Frame clock. A file source in video_source.py stamps frames with WALL time,
so the worker's sighting ts is the wall time the frame was read. This script
subclasses VideoSource (worker.VideoSource = EvalSource — an in-process
override, worker.py is untouched) to keep a (wall, video_t) clock from the
decoded frames' pts (frame index / fps when a reader has no pts), which is how
every read is placed on the video's timeline.

Modes (--mode):
    live-sim     (default) frames decimated to ANPR_TARGET_FPS by video time — what the live
                 worker sees on a 10-fps camera at its 3-fps target — and NOT paced, so wall
                 time measures the pipeline, not the clip length
    all-frames   every frame, unpaced: maximum recall, the pipeline's raw throughput
    --pace       keep the reader's real-time pacing (wall ≈ clip duration; the live cadence)

Tracks still open when the file ends are finalised once more (--no-flush to
skip): the live worker would finalise them on later frames.

GT workflow (no GT yet):
    1. python eval_e2e.py --video clip.mp4 --make-gt-template gt_draft.csv
       → runs the pipeline and writes every posted read with its evidence time, tier,
         confidence and raw text as a CSV row (t_start/t_end = evidence time ± 2 s).
    2. A person watches the clip and edits the CSV: fix wrong plates, tighten the
       windows to when the plate is legible, ADD the vehicles the worker missed,
       delete rows that are not plates. Save as gt.csv. Never score against the
       unedited template — that is the pipeline grading itself.
    3. python eval_e2e.py --video clip.mp4 --gt gt.csv [--tol-s 5]
Writes data/eval/e2e_<stamp>.json. Run inside the worker container from this folder.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import datetime as dt
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import anpr_metrics as M  # noqa: E402


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--gt", help="ground-truth CSV: plate,t_start_s,t_end_s[,camera[,note]]")
    ap.add_argument("--tol-s", type=float, default=5.0, help="window tolerance in seconds each side")
    ap.add_argument(
        "--make-gt-template",
        metavar="OUT.csv",
        help="no GT: run and write every posted read as a CSV row to edit",
    )
    ap.add_argument("--mode", choices=["live-sim", "all-frames"], default="live-sim")
    ap.add_argument(
        "--sim-fps",
        type=float,
        default=0.0,
        help="live-sim decimation rate (default: the worker's ANPR_TARGET_FPS)",
    )
    ap.add_argument(
        "--pace", action="store_true", help="keep real-time pacing of the file (wall ≈ clip length)"
    )
    ap.add_argument(
        "--reader", choices=["auto", "pyav", "ffmpeg", "cv2"], default="auto", help="ANPR_VIDEO_BACKEND"
    )
    ap.add_argument("--max-seconds", type=float, default=0.0, help="stop after this much video (0 = all)")
    ap.add_argument("--camera-id", default="eval")
    ap.add_argument("--camera-name", default="eval clip")
    ap.add_argument("--no-flush", action="store_true", help="do not finalise open tracks when the file ends")
    ap.add_argument(
        "--workdir",
        default=os.path.join(HERE, "data", "eval", "e2e_work"),
        help="ANPR_DATA_DIR for this run (records/review the worker writes land here, not in the evidence store)",
    )
    ap.add_argument("--out", default=os.path.join(HERE, "data", "eval"))
    return ap.parse_args()


def load_gt(path: str) -> list[dict]:
    out = []
    with open(path, newline="", encoding="utf-8") as f:
        lines = [ln for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    rd = csv.DictReader(lines)
    for i, r in enumerate(rd, 1):
        plate = M.normalize_plate(r.get("plate"))
        if not plate:
            continue
        try:
            t0, t1 = float(r["t_start_s"]), float(r["t_end_s"])
        except (KeyError, TypeError, ValueError):
            sys.exit(f"{path}: row {i}: t_start_s / t_end_s must be numbers (seconds from video start)")
        if t1 < t0:
            t0, t1 = t1, t0
        out.append(
            {
                "plate": plate,
                "plate_raw": r.get("plate"),
                "t_start": t0,
                "t_end": t1,
                "camera": (r.get("camera") or "").strip() or None,
                "note": r.get("note"),
            }
        )
    return out


def iso_to_epoch(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def score_e2e(
    posts: list[dict], gt: list[dict], tol: float, first_wall_at=None, video_span: float | None = None
) -> dict:
    """Score recorded _post calls against GT rows (pure; unit-tested in tests/test_metrics.py).

    posts: dicts with plate (normalised), tier, conf, raw, frames, wall, video_t_best,
           video_t_post, dedup_by_worker. gt: dicts with plate, t_start, t_end.
    first_wall_at(t_video) → wall time of the first frame the worker was handed at/after t_video.
    → {"per_gt": [...], "false_plates": [...], "summary": {...}}"""
    posted = [p for p in posts if not p.get("dedup_by_worker")]
    gt_plates = {g["plate"] for g in gt}

    def t_of(p):
        return p.get("video_t_best") if p.get("video_t_best") is not None else p.get("video_t_post")

    def inside(p, g):
        t = t_of(p)
        return t is not None and (g["t_start"] - tol) <= t <= (g["t_end"] + tol)

    per_gt = []
    for g in gt:
        exact_in = [p for p in posted if p["plate"] == g["plate"] and inside(p, g)]
        near_in = [
            p
            for p in posted
            if p["plate"] != g["plate"] and M.levenshtein(p["plate"], g["plate"]) <= 1 and inside(p, g)
        ]
        outside = [p for p in posted if p["plate"] == g["plate"] and not inside(p, g)]
        calls = [p for p in posts if p["plate"] == g["plate"] and inside(p, g)]
        first = min(exact_in, key=lambda p: p["wall"]) if exact_in else None
        lat_wall = lat_video = ev_delay = None
        if first is not None:
            fw = first_wall_at(g["t_start"]) if first_wall_at is not None else None
            lat_wall = (first["wall"] - fw) if fw is not None else None
            lat_video = (
                (first["video_t_post"] - g["t_start"]) if first.get("video_t_post") is not None else None
            )
            if first.get("video_t_post") is not None and first.get("video_t_best") is not None:
                ev_delay = first["video_t_post"] - first["video_t_best"]
        per_gt.append(
            {
                "plate": g["plate"],
                "window": [g["t_start"], g["t_end"]],
                "hit": bool(exact_in),
                "confirmed_hit": any(p["tier"] == "confirmed" for p in exact_in),
                "near_miss": (not exact_in) and bool(near_in),
                "near_reads": [p["plate"] for p in near_in],
                "out_of_window": [round(t_of(p), 1) for p in outside if t_of(p) is not None],
                "duplicates": max(0, len(calls) - 1),
                "first_hit_tier": first["tier"] if first else None,
                "first_hit_conf": first.get("conf") if first else None,
                "latency_wall_s": round(lat_wall, 2) if lat_wall is not None else None,
                "latency_video_s": round(lat_video, 2) if lat_video is not None else None,
                "evidence_delay_s": round(ev_delay, 2) if ev_delay is not None else None,
            }
        )
    false_plates = []
    for p in posted:
        if p["plate"] in gt_plates:
            continue
        near = [g["plate"] for g in gt if M.levenshtein(p["plate"], g["plate"]) <= 1 and inside(p, g)]
        false_plates.append(
            {
                "plate": p["plate"],
                "raw": p.get("raw"),
                "tier": p["tier"],
                "conf": p.get("conf"),
                "frames": p.get("frames"),
                "t": round(t_of(p), 1) if t_of(p) is not None else None,
                "kind": f"near-miss of {near[0]}" if near else "spurious",
            }
        )
    n = len(gt)
    hits = sum(1 for g in per_gt if g["hit"])
    chits = sum(1 for g in per_gt if g["confirmed_hit"])
    nears = sum(1 for g in per_gt if g["near_miss"])
    span_min = (video_span / 60.0) if video_span else None
    summary = {
        "n_gt": n,
        "hits": hits,
        "exact_rate": hits / n if n else None,
        "confirmed_hits": chits,
        "confirmed_rate": chits / n if n else None,
        "near_misses": nears,
        "near_miss_rate": nears / n if n else None,
        "false_plates": len(false_plates),
        "false_plates_per_min": (len(false_plates) / span_min) if span_min else None,
        "posted_reads": len(posted),
        "posted_precision": (sum(1 for p in posted if p["plate"] in gt_plates) / len(posted))
        if posted
        else None,
        "duplicates_mean": M.mean(g["duplicates"] for g in per_gt),
        "latency_wall_s_mean": M.mean(g["latency_wall_s"] for g in per_gt),
        "latency_video_s_mean": M.mean(g["latency_video_s"] for g in per_gt),
        "evidence_delay_s_mean": M.mean(g["evidence_delay_s"] for g in per_gt),
        "exact_rate_ci95": list(M.wilson_interval(hits, n)) if n else None,
    }
    return {"per_gt": per_gt, "false_plates": false_plates, "summary": summary}


def main():
    args = parse_args()
    if not os.path.exists(args.video):
        sys.exit(f"video not found: {args.video}")
    if args.gt and not os.path.exists(args.gt):
        sys.exit(f"GT csv not found: {args.gt}")

    # ── environment BEFORE importing the worker: no backend, no clips, no evidence-store writes ──
    os.makedirs(args.workdir, exist_ok=True)
    os.environ["ANPR_DRY_RUN"] = "1"
    os.environ["ANPR_CLIPS"] = "0"
    os.environ["ANPR_SAVE_CROPS"] = "0"
    os.environ["ANPR_DATA_DIR"] = args.workdir
    os.environ["ANPR_RECORDS_DIR"] = os.path.join(args.workdir, "records")
    os.environ.setdefault("ANPR_STATS_EVERY", "15")
    os.environ["ANPR_CAMERA_REFRESH_SECS"] = "0"
    if args.reader != "auto":
        os.environ["ANPR_VIDEO_BACKEND"] = args.reader

    import worker  # noqa: E402  (import is side-effect free: threads start only in run_cams/main)

    sim_fps = 0.0
    if args.mode == "live-sim":
        sim_fps = args.sim_fps or float(worker.TARGET_FPS)

    class EvalSource(worker.VideoSource):
        """File source with a (wall, video_t) clock, optional decimation, no pacing."""

        instances: list = []
        cfg = {"sim_fps": sim_fps, "pace": args.pace, "max_seconds": args.max_seconds}

        def __init__(self, url, prefer=None, max_reconnects=0):
            super().__init__(url, prefer, max_reconnects)
            self.frame_no = 0  # frames decoded
            self.delivered = 0  # frames handed to the worker
            self.video_t = 0.0
            self._t0 = None
            self._next_due = 0.0
            self.clock_wall: list[float] = []
            self.clock_vt: list[float] = []
            self.fps_reported = getattr(self._reader, "fps", None) if self._reader is not None else None
            self.paced = bool(self.cfg["pace"])
            EvalSource.instances.append(self)
            rd = self._reader
            if not self.live and not self.paced and rd is not None and hasattr(rd, "_next_frame"):

                def unpaced():  # PyAV reader: skip its real-time sleep, keep its error handling
                    fr = rd._next_frame()
                    if fr is not None:
                        rd.last_frame_time = time.time()
                    return fr

                rd.read = unpaced

        def _video_time(self, f) -> float:
            pts = getattr(f, "pts", None)
            tb = getattr(self._reader, "_tb", None)
            if pts is not None and tb:
                return float(pts) * float(tb)
            fps = self.fps_reported or 25.0
            return (self.frame_no - 1) / fps

        def read(self, timeout: float = 30.0, raw: bool = False):
            if self.live:
                return super().read(timeout, raw=raw)
            while True:
                f = self._reader.read()
                if f is None:
                    return None
                self.frame_no += 1
                t = self._video_time(f)
                if self._t0 is None:
                    self._t0 = t
                vt = t - self._t0
                self.video_t = vt
                if self.cfg["max_seconds"] and vt > self.cfg["max_seconds"]:
                    return None
                sf = self.cfg["sim_fps"]
                if sf > 0:
                    if vt + 1e-6 < self._next_due:
                        continue  # decimated: the live worker would not see this frame
                    self._next_due = max(self._next_due, vt) + 1.0 / sf
                wall = time.time()
                self.delivered += 1
                self.clock_wall.append(wall)
                self.clock_vt.append(vt)
                return (f if raw else self._to_bgr(f)), wall, 0

        def vt_of_wall(self, wall):
            if wall is None or not self.clock_wall:
                return None
            i = bisect.bisect_left(self.clock_wall, wall)
            cands = [j for j in (i - 1, i) if 0 <= j < len(self.clock_wall)]
            j = min(cands, key=lambda k: abs(self.clock_wall[k] - wall))
            return self.clock_vt[j]

        def first_wall_at(self, t_video):
            i = bisect.bisect_left(self.clock_vt, t_video)
            return self.clock_wall[i] if i < len(self.clock_wall) else None

    worker.VideoSource = EvalSource  # run() looks the class up in the module namespace

    print(
        f"loading models …  (plate detector {os.path.basename(worker.PLATE_PT)}, vehicle {os.path.basename(worker.VEHICLE_PT)})"
    )
    models = worker.Models("")
    cam = {"monitorId": args.camera_id, "name": args.camera_name, "latitude": None, "longitude": None}
    w = worker.CameraWorker(cam, args.video, models, None)

    posts: list[dict] = []
    phase = ["run"]
    orig_post = w._post

    def rec_post(plate, st, cons, conf=None, feats=None, source="heuristic", tier="confirmed"):
        now = time.time()
        last_t, last_tier = w._last_post.get(plate, (0.0, ""))
        dedup = (now - last_t < worker.REPOST_SECS) and not (tier == "confirmed" and last_tier == "possible")
        src = EvalSource.instances[-1] if EvalSource.instances else None
        best_vt = src.vt_of_wall(iso_to_epoch(st.best_ts)) if src else None
        first_vt = src.vt_of_wall(iso_to_epoch(st.ts_first)) if src else None
        posts.append(
            {
                "plate": plate,
                "raw": cons.top_whole[0] if cons.top_whole else None,
                "consensus": cons.text,
                "tier": tier,
                "conf": float(conf) if conf is not None else None,
                "conf_source": source,
                "rule": (feats or {}).get("rule"),
                "frames": int(cons.n_frames),
                "reads": int(st.votes.reads),
                "agreement": round(float(cons.agreement), 4),
                "top_weight": float(cons.top_whole[1]) if cons.top_whole else None,
                "alternatives": [list(a) for a in (cons.alternatives or [])[:3]],
                "wall": now,
                "video_t_post": src.video_t if src else None,
                "best_ts": st.best_ts,
                "video_t_best": best_vt,
                "video_t_first": first_vt,
                "dedup_by_worker": dedup,
                "phase": phase[0],
                "vehicle_type": st.vtype,
                "scenario": (st.best_assess or {}).get("scenario"),
                "flags": (st.best_assess or {}).get("flags"),
            }
        )
        return orig_post(plate, st, cons, conf, feats, source, tier)

    w._post = rec_post

    print(
        f"running {args.video}  mode={args.mode} sim_fps={sim_fps or 'off'} pace={args.pace} reader={args.reader}"
    )
    t0 = time.time()
    w.run()  # synchronous: returns when the file ends
    run_wall = time.time() - t0
    if not args.no_flush:
        phase[0] = "flush"
        try:
            w._finalize(10**9, None)  # finalise open tracks (no pending crops: no frame)
        except Exception as e:  # noqa: BLE001
            print(f"flush failed: {e}")
    wall = time.time() - t0
    try:  # let the DiskWriter drain the work-dir records
        dw = worker.writer()
        for _ in range(50):
            if dw.qsize == 0:
                break
            time.sleep(0.1)
    except Exception:  # noqa: BLE001
        pass

    src = EvalSource.instances[-1] if EvalSource.instances else None
    s = dict(w.stats)
    n_pl = max(1, s.get("plates", 0))
    video_span = src.video_t if src else None
    thr = {
        "wall_s": round(wall, 2),
        "run_wall_s": round(run_wall, 2),
        "video_span_s": round(video_span, 2) if video_span is not None else None,
        "frames_decoded": src.frame_no if src else None,
        "frames_delivered": src.delivered if src else None,
        "frames_to_detection": s.get("frames", 0),
        "processed_past_motion_gate": s.get("processed", 0),
        "skipped_motion": s.get("skipped_motion", 0),
        "effective_fps": round(s.get("frames", 0) / run_wall, 2) if run_wall > 0 else None,
        "processed_fps": round(s.get("processed", 0) / run_wall, 2) if run_wall > 0 else None,
        "realtime_factor": round(video_span / run_wall, 2) if (video_span and run_wall > 0) else None,
        "file_fps": src.fps_reported if src else None,
        "reader": src.backend if src else None,
        "codec": src.codec if src else None,
        "plate_crops_read": s.get("plates", 0),
        "enh_ms_per_plate": round(s.get("enh_ms", 0.0) / n_pl, 2),
        "ocr_ms_per_plate": round(s.get("ocr_ms", 0.0) / n_pl, 2),
        "posted_confirmed": s.get("posted", 0),
        "posted_possible": s.get("posted_possible", 0),
        "review": s.get("review", 0),
        "merged_tracks": s.get("merged_tracks", 0),
        "errors": s.get("errors", 0),
    }
    posted = [p for p in posts if not p["dedup_by_worker"]]

    print(
        f"\n=== reads the worker posted ({len(posted)}; {len(posts) - len(posted)} further calls deduplicated by REPOST_SECS) ==="
    )
    print(
        M.format_table(
            [
                {
                    "t_best": p["video_t_best"],
                    "t_post": p["video_t_post"],
                    "tier": p["tier"],
                    "plate": p["plate"],
                    "raw": p["raw"],
                    "conf": p["conf"],
                    "frames": p["frames"],
                    "agree": p["agreement"],
                    "rule": p["rule"],
                    "phase": p["phase"],
                }
                for p in posts
            ],
            [
                ("t_best", "t_evidence_s"),
                ("t_post", "t_post_s"),
                ("tier", "tier"),
                ("plate", "plate"),
                ("raw", "raw"),
                ("conf", "conf"),
                ("frames", "frames"),
                ("agree", "agree"),
                ("rule", "rule"),
                ("phase", "phase"),
            ],
        )
        if posts
        else "  (none)"
    )
    print("\n=== throughput ===")
    print(
        f"  video: {thr['video_span_s']} s at {thr['file_fps']} fps via {thr['reader']} ({thr['codec']}); "
        f"{thr['frames_decoded']} frames decoded, {thr['frames_delivered']} delivered (mode {args.mode}, sim_fps {sim_fps or 'off'}, pace {args.pace})"
    )
    print(
        f"  wall {thr['run_wall_s']} s  → effective fps {thr['effective_fps']} (frames handed to detection / wall), "
        f"processed fps {thr['processed_fps']} (past the motion gate: {thr['processed_past_motion_gate']}, static {thr['skipped_motion']}), "
        f"realtime ×{thr['realtime_factor']}"
    )
    print(
        f"  plate crops read {thr['plate_crops_read']}: enhance {thr['enh_ms_per_plate']} ms, OCR {thr['ocr_ms_per_plate']} ms per crop  | "
        f"posted {thr['posted_confirmed']} confirmed + {thr['posted_possible']} possible, review {thr['review']}, errors {thr['errors']}"
    )

    result = {
        "kind": "e2e",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "video": args.video,
        "mode": args.mode,
        "sim_fps": sim_fps,
        "pace": args.pace,
        "tol_s": args.tol_s,
        "flush": not args.no_flush,
        "config": {
            "TARGET_FPS": worker.TARGET_FPS,
            "MIN_VOTES": worker.MIN_VOTES,
            "MIN_AGREEMENT": worker.MIN_AGREEMENT,
            "MIN_CONF": worker.MIN_CONF,
            "POSSIBLE": worker.POSSIBLE,
            "REPOST_SECS": worker.REPOST_SECS,
            "plate_model": os.path.basename(worker.PLATE_PT),
            "ocr": models.ocr.name,
            "calibrator": bool(models.calibrator),
        },
        "throughput": thr,
        "posts": posts,
    }

    # ── GT template ──
    if args.make_gt_template:
        os.makedirs(os.path.dirname(os.path.abspath(args.make_gt_template)), exist_ok=True)
        with open(args.make_gt_template, "w", newline="", encoding="utf-8") as f:
            f.write(
                f"# eval_e2e GT TEMPLATE for {os.path.basename(args.video)} — generated {time.strftime('%Y-%m-%d %H:%M')}\n"
            )
            f.write(
                "# This is what the pipeline READ, not the truth. A person must: fix wrong plates, tighten t_start_s/t_end_s to\n"
            )
            f.write(
                "# when the plate is legible, ADD vehicles the worker missed, delete rows that are not plates. Then --gt this file.\n"
            )
            wr = csv.writer(f)
            wr.writerow(["plate", "t_start_s", "t_end_s", "camera", "note"])
            for p in sorted(
                posted,
                key=lambda p: (
                    p["video_t_best"] if p["video_t_best"] is not None else p["video_t_post"] or 0
                ),
            ):
                tb = p["video_t_best"] if p["video_t_best"] is not None else p["video_t_post"]
                wr.writerow(
                    [
                        p["plate"],
                        f"{max(0.0, (tb or 0) - 2):.1f}",
                        f"{(tb or 0) + 2:.1f}",
                        args.camera_id,
                        f"tier={p['tier']} conf={p['conf']:.2f} frames={p['frames']} agree={p['agreement']:.2f} "
                        f"raw={p['raw']} t_evidence={tb:.1f} t_post={p['video_t_post']:.1f}"
                        if tb is not None
                        else f"tier={p['tier']} conf={p['conf']:.2f} raw={p['raw']}",
                    ]
                )
        print(
            f"\nwrote GT template → {args.make_gt_template}  ({len(posted)} rows; edit it before scoring — it is not ground truth)"
        )

    # ── scorecard ──
    if args.gt:
        gt = load_gt(args.gt)
        tol = args.tol_s
        sc = score_e2e(posts, gt, tol, src.first_wall_at if src else None, video_span)
        per_gt, false_plates, summary = sc["per_gt"], sc["false_plates"], sc["summary"]
        n, hits, chits, nears = (
            summary["n_gt"],
            summary["hits"],
            summary["confirmed_hits"],
            summary["near_misses"],
        )
        result.update(
            {"gt_file": args.gt, "gt": gt, "per_gt": per_gt, "false_plates": false_plates, "summary": summary}
        )

        def pct(v):
            return "n/a" if v is None else f"{100 * v:.1f}%"

        print(f"\n=== end-to-end scorecard vs {args.gt} (n_gt={n}, tol ±{tol:g} s) ===")
        if n == 0:
            print("  NOT MEASURED — the GT file has no plate rows")
        else:
            ci = summary["exact_rate_ci95"]
            print(
                f"  exact plate recognition   {hits}/{n} = {pct(summary['exact_rate'])}  [Wilson 95% {100 * ci[0]:.0f}–{100 * ci[1]:.0f}]"
            )
            print(f"  confirmed-tier only       {chits}/{n} = {pct(summary['confirmed_rate'])}")
            print(f"  near-miss (≤1 edit, no exact hit)  {nears}/{n} = {pct(summary['near_miss_rate'])}")
            print(
                f"  false plates              {len(false_plates)} posted read(s) match no GT plate"
                + (
                    f" ({summary['false_plates_per_min']:.2f} per video minute)"
                    if summary["false_plates_per_min"] is not None
                    else ""
                )
            )
            print(
                f"  posted-read precision     {pct(summary['posted_precision'])} of {len(posted)} posted reads are a GT plate"
            )
            print(f"  duplicates per GT plate   mean {summary['duplicates_mean']:.2f}")
            lw, lv, ed = (
                summary["latency_wall_s_mean"],
                summary["latency_video_s_mean"],
                summary["evidence_delay_s_mean"],
            )
            print(
                f"  latency (hits)            wall {lw:.2f} s | video {lv:.2f} s | evidence delay {ed:.2f} s"
                if lw is not None
                else "  latency                   NOT MEASURED — no hit to time"
            )
            print("\n  per GT plate:")
            for g in per_gt:
                tag = "HIT " if g["hit"] else ("near" if g["near_miss"] else "MISS")
                extra = []
                if g["near_reads"]:
                    extra.append("near " + "/".join(g["near_reads"]))
                if g["out_of_window"]:
                    extra.append(f"out-of-window at {g['out_of_window']}")
                if g["duplicates"]:
                    extra.append(f"dup {g['duplicates']}")
                if g["latency_video_s"] is not None:
                    extra.append(f"lat video {g['latency_video_s']:.1f}s wall {g['latency_wall_s']:.1f}s")
                print(
                    f"    {tag} {g['plate']:<12} [{g['window'][0]:.1f},{g['window'][1]:.1f}] "
                    f"{(g['first_hit_tier'] or '-'):<9} {('conf %.2f' % g['first_hit_conf']) if g['first_hit_conf'] is not None else '':<9} {'; '.join(extra)}"
                )
            if false_plates:
                print("\n  false plates:")
                for fp in false_plates:
                    print(
                        f"    t={fp['t']}  {fp['plate']:<12} raw={fp['raw']:<12} {fp['tier']:<9} conf={fp['conf']:.2f} frames={fp['frames']}  {fp['kind']}"
                    )
    elif not args.make_gt_template:
        print("\nno --gt given: recognition rates NOT MEASURED — use --make-gt-template to start a GT file")

    os.makedirs(args.out, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(args.out, f"e2e_{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1, ensure_ascii=False, default=str)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
