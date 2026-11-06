"""
Single-node GPU benchmark — Scale Blueprint §7.3, row 1.

WHAT IT SETTLES. §4.1 estimates the estate needs somewhere between 24 and 118
GPU nodes. That range exists because nobody had measured what one GPU actually
does with THIS pipeline. The blueprint calls this "the highest value per rupee
of any test here", and it is the only one of the six that a single box can
answer honestly rather than approximate.

METHOD. Run the real model set — the same Models() the worker builds, same
weights, same confidence floors — over real decoded frames, and time each stage
separately:

    vehicle detect -> per-class floors -> plate detect on vehicle crops
                   -> OCR ensemble on plate crops

Then convert measured throughput into the only number that matters for sizing:
cameras per GPU at the modelled 1 fps per camera.

WHY STAGE TIMING, NOT JUST TOTAL. The stages scale differently. Vehicle
detection is a fixed cost per frame. Plate detection and OCR scale with how many
vehicles are in shot, so a busy junction costs more than an empty road, and an
average taken over a quiet clip would flatter the result. Reporting them apart
lets the sizing be adjusted for scene density instead of assuming ours.

FRAMES. Real frames from recorded segments, not synthetic noise. An empty
synthetic frame skips plate detection and OCR entirely and would overstate
throughput by a wide margin.

Usage (inside the anpr worker container):
    python /srv/anpr/bench_gpu.py [--frames 120] [--source /recordings/...]
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, "/srv/anpr")


def log(msg: str) -> None:
    print(msg, flush=True)


def collect_frames(source: str, want: int) -> list[np.ndarray]:
    """Decode up to `want` frames. Spread across the file rather than taking the
    first N, so we sample varying traffic density instead of one moment."""
    import cv2

    files: list[Path] = []
    p = Path(source)
    if p.is_dir():
        files = sorted(p.rglob("*.mp4"))
    elif p.exists():
        files = [p]
    if not files:
        raise SystemExit(f"no video found at {source}")

    frames: list[np.ndarray] = []
    for f in files:
        cap = cv2.VideoCapture(str(f))
        if not cap.isOpened():
            continue
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        # Step through the file so we do not sample one contiguous burst.
        step = max(1, total // max(1, (want - len(frames)))) if total else 1
        idx = 0
        while len(frames) < want:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                frames.append(frame)
            idx += 1
        cap.release()
        if len(frames) >= want:
            break
    if not frames:
        raise SystemExit("decoded 0 frames — is the segment readable?")
    return frames


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=120)
    ap.add_argument("--source", default="/recordings")
    ap.add_argument(
        "--fps-per-camera",
        type=float,
        default=1.0,
        help="modelled AI frame rate per camera (Scale Blueprint uses 1 fps)",
    )
    ap.add_argument("--json-out", default="/srv/anpr/data/reports/bench_gpu.json")
    args = ap.parse_args()

    import torch

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    gpu_name = torch.cuda.get_device_name(0) if dev == "cuda" else "CPU ONLY"

    log("=" * 78)
    log("Single-node GPU benchmark — Scale Blueprint §7.3")
    log("=" * 78)
    log(f"  device        : {gpu_name}")
    if dev != "cuda":
        log("  WARNING: no CUDA. Numbers below are CPU and must NOT be used for GPU sizing.")

    log(f"  decoding      : up to {args.frames} frames from {args.source}")
    frames = collect_frames(args.source, args.frames)
    h, w = frames[0].shape[:2]
    log(f"  frames        : {len(frames)} at {w}x{h}")

    log("  loading models…")
    t0 = time.time()
    from worker import Models

    models = Models("")
    log(f"  models loaded in {time.time() - t0:.1f}s")
    log("")

    # ── Warm-up. The first CUDA call pays kernel autotune + allocator warm-up
    #    and is not steady state. BOTH detectors and the batch path have to be
    #    warmed: warming only the vehicle detector left the plate detector's
    #    first call in the sample and put a 565 ms outlier in the p95.
    for f in frames[: min(5, len(frames))]:
        models.filter_vehicle_dets(models.vdet(f))
        models.pdet(f)
    models.pdet.batch([frames[0][0:64, 0:64], frames[0][0:64, 0:64]])
    if dev == "cuda":
        torch.cuda.synchronize()

    veh_ms: list[float] = []
    plate_ms: list[float] = []
    ocr_ms: list[float] = []
    total_ms: list[float] = []
    n_vehicles = 0
    n_plates = 0
    ocr_errors: list[str] = []
    from worker import NATIVE_MAX_FRAC

    def sync() -> None:
        if dev == "cuda":
            torch.cuda.synchronize()

    log("  running…")
    bench_start = time.time()
    for frame in frames:
        f0 = time.perf_counter()

        t = time.perf_counter()
        dets = models.filter_vehicle_dets(models.vdet(frame))
        sync()
        veh_ms.append((time.perf_counter() - t) * 1000)
        n_vehicles += len(dets)

        # Plate pass, replicating CameraWorker._detect_plates exactly: ONE
        # full-frame detection, plus a BATCHED native-resolution pass over the
        # vehicle boxes that pass its size filters. An earlier version of this
        # script called pdet() once per vehicle crop, sequentially — that is not
        # what the worker does, and it overstated the stage roughly five-fold.
        t = time.perf_counter()
        boxes = [list(r) for r in models.pdet(frame)]
        crops, offs = [], []
        for d in dets:
            x1, y1, x2, y2 = (int(v) for v in d[:4])
            bw, bh = x2 - x1, y2 - y1
            if bw < 40 or bh < 30 or bw > NATIVE_MAX_FRAC * w:
                continue
            mx, my = int(bw * 0.12) + 4, int(bh * 0.12) + 4
            cx1, cy1 = max(0, x1 - mx), max(0, y1 - my)
            cx2, cy2 = min(w, x2 + mx), min(h, y2 + my)
            if cx2 - cx1 < 48 or cy2 - cy1 < 32:
                continue
            crops.append(frame[cy1:cy2, cx1:cx2])
            offs.append((cx1, cy1))
        if crops:
            for det, (ox, oy) in zip(models.pdet.batch(crops), offs):
                for d in det:
                    boxes.append([d[0] + ox, d[1] + oy, d[2] + ox, d[3] + oy, d[4], d[5]])
        sync()
        plate_ms.append((time.perf_counter() - t) * 1000)

        plate_crops = []
        for bx in boxes:
            px1, py1, px2, py2 = (int(v) for v in bx[:4])
            px1, py1 = max(0, px1), max(0, py1)
            px2, py2 = min(w, px2), min(h, py2)
            if px2 - px1 >= 4 and py2 - py1 >= 4:
                plate_crops.append(frame[py1:py2, px1:px2])
        n_plates += len(plate_crops)

        # OCR. read_many is the ensemble's real entry point — it has no read().
        # The first version of this script called models.ocr.read() inside a bare
        # except, so every call raised AttributeError and was swallowed: the
        # stage reported 0.01 ms and no OCR ran at all. Errors are counted now,
        # not hidden.
        t = time.perf_counter()
        if plate_crops:
            try:
                models.ocr.read_many(plate_crops)
            except Exception as e:
                ocr_errors.append(str(e)[:120])
        sync()
        ocr_ms.append((time.perf_counter() - t) * 1000)

        total_ms.append((time.perf_counter() - f0) * 1000)

    wall = time.time() - bench_start

    def stats(xs: list[float]) -> dict:
        s = sorted(xs)
        return {
            "mean": round(statistics.fmean(s), 2),
            "p50": round(s[len(s) // 2], 2),
            "p95": round(s[int(len(s) * 0.95) - 1], 2),
            "max": round(s[-1], 2),
        }

    tot = stats(total_ms)
    fps = 1000.0 / tot["mean"]
    fps_p95 = 1000.0 / tot["p95"]
    cams_mean = fps / args.fps_per_camera
    cams_p95 = fps_p95 / args.fps_per_camera

    log("")
    log("  stage                  mean      p50      p95      max   (ms/frame)")
    for name, xs in (("vehicle detect", veh_ms), ("plate detect", plate_ms), ("OCR ensemble", ocr_ms)):
        s = stats(xs)
        log(f"  {name:<20} {s['mean']:>7.2f} {s['p50']:>8.2f} {s['p95']:>8.2f} {s['max']:>8.2f}")
    log(f"  {'TOTAL':<20} {tot['mean']:>7.2f} {tot['p50']:>8.2f} {tot['p95']:>8.2f} {tot['max']:>8.2f}")
    log("")
    if ocr_errors:
        log("")
        log(f"  !! OCR FAILED on {len(ocr_errors)} frame(s). The OCR column below is NOT a")
        log(f"     measurement. First error: {ocr_errors[0]}")
        log("")
    log(
        f"  scene density   : {n_vehicles / len(frames):.2f} vehicles/frame, "
        f"{n_plates / len(frames):.2f} plate crops/frame"
    )
    log(f"  throughput      : {fps:.1f} fps sustained on one GPU ({wall:.1f}s wall for {len(frames)} frames)")
    log("")
    log("  ── SIZING ──────────────────────────────────────────────────────────")
    log(f"  at {args.fps_per_camera:g} fps/camera : {cams_mean:.0f} cameras per GPU (mean)")
    log(f"                      {cams_p95:.0f} cameras per GPU (p95 — size on this)")
    log("")

    # §4.1 sizes the AI tier at 8,000 cameras — 10% analytics coverage of the
    # 80,000-camera estate, NOT every camera. An earlier version of this script
    # assumed 40% and printed a GPU count 4x too high against a range it was not
    # comparable to. Keep this anchored to the document being checked.
    AI_CAMS = int(os.getenv("BENCH_AI_CAMERAS", "8000"))
    gpus_mean = AI_CAMS / cams_mean
    gpus_p95 = AI_CAMS / cams_p95
    # What §4.1 implies per GPU: 8,000 cams / 118 GPUs on pilot-class hardware.
    BLUEPRINT_CAMS_PER_GPU = 8000 / 118
    log(f"  §4.1 sizes the AI tier at {AI_CAMS:,} cameras (10% of the 80,000 estate)")
    log(f"    this GPU, at the scene density above : {gpus_mean:.0f} GPUs")
    log(f"    §4.1 pilot-class figure              : 118 GPUs  (~{BLUEPRINT_CAMS_PER_GPU:.0f} cameras/GPU)")
    log(f"    ratio                                : {BLUEPRINT_CAMS_PER_GPU / cams_mean:.1f}x")
    log("")
    log("  READ THIS BEFORE QUOTING THE RATIO. §4.1's figure comes from the pilot:")
    log("  30 REAL cameras at 1.11 fps each. This benchmark runs curated busy-traffic")
    log("  footage at ~4 vehicles/frame. Plate detection and OCR scale with vehicles")
    log("  in shot, not pixels — measured 8.6 fps at 640x360 vs 9.5 fps at 1080p, so")
    log("  resolution barely matters and density dominates. Both numbers are real;")
    log("  they describe a sparse average and a busy junction. The gap IS the")
    log("  finding: GPU sizing must be stated per scene density, not as one number.")
    log("")
    log("  Also a LAPTOP RTX A3000 — a datacentre card is materially faster.")

    out = {
        "test": "single-node GPU benchmark (Scale Blueprint 7.3)",
        "gpu": gpu_name,
        "device": dev,
        "frames": len(frames),
        "resolution": f"{w}x{h}",
        "vehicles_per_frame": round(n_vehicles / len(frames), 3),
        "plate_crops_per_frame": round(n_plates / len(frames), 3),
        "stage_ms": {
            "vehicle_detect": stats(veh_ms),
            "plate_detect": stats(plate_ms),
            "ocr": stats(ocr_ms),
            "total": tot,
        },
        "fps_sustained": round(fps, 2),
        "cameras_per_gpu_mean": round(cams_mean, 1),
        "cameras_per_gpu_p95": round(cams_p95, 1),
        "estate": {
            "cameras": AI_CAMS,
            "ai_share": round(AI_CAMS / 80000, 3),  # §4.1: AI on 10% of the 80,000 estate
            "gpus_mean": round(gpus_mean, 1),
            "gpus_p95": round(gpus_p95, 1),
        },
        "ocr_errors": len(ocr_errors),
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    try:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(out, indent=2))
        log(f"  json: {args.json_out}")
    except Exception as e:  # results on stdout still stand
        log(f"  (could not write json: {e})")


if __name__ == "__main__":
    main()
