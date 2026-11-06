"""Stage 1: UCSD frames -> cached optical flow, scalar descriptors and labels.

    python src/preprocess.py                              # both subsets, all clips
    python src/preprocess.py --subset UCSDped1            # one subset
    python src/preprocess.py --workers 8                  # parallelise over clips

Writes one directory per clip under cache/:
    flow.f16       (N, 224, 224, 2)  float16, normalised to [-1, 1]
    bits.npy       (N, 32)           float32, binarised scalar descriptors
    scalars.npy    (N, 4)            float32, raw descriptors (for inspection)
    occupancy.npy  (N,)              float32, the density proxy (for inspection)
    labels.npy     (N,)              int8 class ids
    meta.json

Run this before train.py.  It is the expensive stage: dense Farneback is the
pipeline's bottleneck, exactly as the paper reports.

Three passes, in this order, because each one needs the previous one's result:
  1. background plate per subset, from that subset's all-normal Train clips
  2. occupancy series per clip -> corpus-wide tertile cuts for the three
     density classes
  3. flow + descriptors + labels per clip, then one shared scalar calibration
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (BG_SAMPLE_STRIDE, CACHE, CALIBRATE_SCALARS,
                    CALIBRATION_PERCENTILES, CLASSES,
                    FRAME_BUDGET, FRAME_H, FRAME_W, SCALAR_NAMES,
                    SCALAR_RANGES_FILE, SCALAR_RANGES_PAPER, SEQ_LEN,
                    UCSD_SPLITS, UCSD_SUBSETS, configure_stdout, ensure_dirs,
                    set_seeds)
from datasets_io import UcsdClip, load_ucsd, load_ucsd_train, read_tif_bgr
from features import (calibrate_ranges, compute_scalars,
                      farneback_multichannel, normalize_flow, resize_frame,
                      scalars_to_bits, to_gray)
from ucsd_labels import (build_background, density_thresholds, frame_occupancy,
                         labels_from_occupancy, smooth_occupancy)


# ---------------------------------------------------------------------------
# Cache writing
# ---------------------------------------------------------------------------


def _write_clip(name: str, flow_list, scalars, labels, occupancy, extra=None) -> None:
    d = CACHE / name
    d.mkdir(parents=True, exist_ok=True)
    n = len(flow_list)
    shape = (n, FRAME_H, FRAME_W, 2)

    mm = np.memmap(d / "flow.f16", dtype=np.float16, mode="w+", shape=shape)
    for i, f in enumerate(flow_list):
        mm[i] = f.astype(np.float16)
    mm.flush()
    del mm

    np.save(d / "scalars.npy", np.asarray(scalars, dtype=np.float32))
    np.save(d / "occupancy.npy", np.asarray(occupancy, dtype=np.float32))
    np.save(d / "labels.npy", np.asarray(labels, dtype=np.int8))
    meta = {"name": name, "n_frames": n, "flow_shape": list(shape)}
    if extra:
        meta.update(extra)
    (d / "meta.json").write_text(json.dumps(meta, indent=2))


def _cached_names(prefix: str = "ucsd__") -> list[str]:
    return sorted(
        p.name for p in CACHE.iterdir()
        if p.is_dir() and p.name.startswith(prefix) and (p / "scalars.npy").exists()
    )


def _calibrate_and_finalise(names: list[str]) -> None:
    """Derive the shared quantization ranges, then write every clip's bits.

    One set of ranges for the whole corpus, computed after every clip's raw
    descriptors exist.  Per-clip or per-subset calibration would rescale away
    exactly the differences between clips that the density classes encode.
    """
    if not names:
        return

    if CALIBRATE_SCALARS:
        pool = np.concatenate([np.load(CACHE / n / "scalars.npy") for n in names])
        ranges = calibrate_ranges(pool)
        SCALAR_RANGES_FILE.write_text(json.dumps(
            {"percentiles": list(CALIBRATION_PERCENTILES),
             "names": list(SCALAR_NAMES),
             "ranges": [list(r) for r in ranges]}, indent=2))
        print("\n[calibration] quantization ranges from "
              f"{len(pool)} frames (p{CALIBRATION_PERCENTILES[0]:g}-p{CALIBRATION_PERCENTILES[1]:g}):")
        for nm, (lo, hi) in zip(SCALAR_NAMES, ranges):
            print(f"  {nm:13s} [{lo:.5f}, {hi:.5f}]")
    else:
        ranges = SCALAR_RANGES_PAPER
        print("\n[calibration] disabled; using the paper's stated ranges")

    for name in names:
        d = CACHE / name
        np.save(d / "bits.npy", scalars_to_bits(np.load(d / "scalars.npy"), ranges))


# ---------------------------------------------------------------------------
# Pass 1-2: background plates and the density proxy
# ---------------------------------------------------------------------------


def _backgrounds(subsets) -> dict[str, np.ndarray]:
    """One background plate per subset, from that subset's Train clips."""
    out = {}
    for subset in subsets:
        train = load_ucsd_train(subset)
        out[subset] = build_background(train, read_tif_bgr)
        print(f"[background] {subset}: median plate over "
              f"{sum(len(c.frame_paths[::BG_SAMPLE_STRIDE]) for c in train)} Train frames")
    return out


def clip_occupancy(clip: UcsdClip, background: np.ndarray) -> np.ndarray:
    """Smoothed per-frame occupancy for one clip, one value per source frame."""
    occ = np.array(
        [frame_occupancy(to_gray(resize_frame(read_tif_bgr(p))), background)
         for p in clip.frame_paths],
        dtype=np.float32,
    )
    return smooth_occupancy(occ)


def _occupancy_task(args):
    clip, background = args
    return clip.name, clip_occupancy(clip, background)


def _warn_on_stale_cache(about_to_write: set[str], thresholds: np.ndarray) -> None:
    """Warn about cached clips this run will not relabel.

    The density cuts are corpus-wide quantiles, so they depend on which clips
    the run saw.  Preprocessing one subset and then the other leaves the first
    subset labelled against cuts the second never used -- the two halves of the
    cache would disagree about where `moderate` ends and `dense` begins, and
    nothing downstream would notice.
    """
    stale = []
    for name in _cached_names():
        if name in about_to_write:
            continue
        meta = json.loads((CACHE / name / "meta.json").read_text())
        old = meta.get("density_thresholds")
        if old is not None and not np.allclose(old, thresholds, atol=1e-6):
            stale.append(name)
    if stale:
        print(f"\n[warning] {len(stale)} cached clips were labelled with different "
              "density cuts and are NOT being relabelled by this run:")
        print("           " + ", ".join(stale[:5]) + (" ..." if len(stale) > 5 else ""))
        print("           Their labels disagree with the ones written now. Delete")
        print("           cache/ and preprocess every subset in one run, or keep")
        print("           them out of training.\n")


# ---------------------------------------------------------------------------
# Pass 3: flow, descriptors, labels
# ---------------------------------------------------------------------------


def _process_frames(frames, desc: str, progress: bool = True):
    """Run the flow + descriptor pipeline over an iterable of BGR frames.

    Returns (flow_list, scalars).  The first frame has no predecessor, so the
    sequence starts at frame 1: N frames in gives N-1 flow fields, matching the
    paper's "119 optical flow frames from 120 frames" in Sec. 6.5.
    """
    flow_list, scalars = [], []
    prev_bgr = prev_gray = prev_flow = None

    it = tqdm(frames, desc=desc, unit="f", leave=False) if progress else frames
    for bgr in it:
        bgr = resize_frame(bgr)
        gray = to_gray(bgr)
        if prev_bgr is not None:
            flow = farneback_multichannel(prev_bgr, bgr)
            scalars.append(compute_scalars(flow, prev_flow, prev_gray, gray))
            flow_list.append(normalize_flow(flow))
            prev_flow = flow
        prev_bgr, prev_gray = bgr, gray

    return flow_list, scalars


def process_clip(
    clip: UcsdClip,
    occupancy: np.ndarray,
    thresholds: np.ndarray,
    keep_ratio: float = 1.0,
    progress: bool = True,
) -> tuple[str, np.ndarray]:
    """Flow + descriptors + labels for one clip, written to the cache.

    Flow frame i is computed from source frames (i, i+1) and inherits the later
    frame's annotation, so both the occupancy series and the anomaly flags are
    advanced by one to line up with it.
    """
    flow_list, scalars = _process_frames(
        (read_tif_bgr(p) for p in clip.frame_paths), clip.name, progress
    )

    occ = np.asarray(occupancy, dtype=np.float32)[1:1 + len(flow_list)]
    flags = clip.abnormal[1:1 + len(flow_list)]
    n = min(len(flow_list), len(occ), len(flags))
    flow_list, scalars, occ, flags = flow_list[:n], scalars[:n], occ[:n], flags[:n]
    labels = labels_from_occupancy(occ, flags, thresholds)

    if keep_ratio < 1.0:
        # Keep a contiguous head of whole windows so temporal structure and the
        # 12-frame overlap survive the subsampling.
        keep = min(n, max(SEQ_LEN, int(round(n * keep_ratio))))
        flow_list, scalars, occ, labels = (
            flow_list[:keep], scalars[:keep], occ[:keep], labels[:keep],
        )

    counts = np.bincount(np.asarray(labels), minlength=len(CLASSES))
    _write_clip(
        clip.cache_name, flow_list, scalars, labels, occ,
        extra={
            "source": "ucsd",
            "subset": clip.subset,
            "split": clip.split,
            "clip": clip.name,
            "density_thresholds": np.asarray(thresholds).tolist(),
            "class_counts": counts.tolist(),
        },
    )
    return clip.name, counts


def _process_task(args):
    clip, occupancy, thresholds, keep_ratio = args
    return process_clip(clip, occupancy, thresholds, keep_ratio, progress=False)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def preprocess_ucsd(
    subsets=UCSD_SUBSETS,
    splits=UCSD_SPLITS,
    max_clips: int | None = None,
    frame_budget: int = FRAME_BUDGET,
    workers: int = 1,
) -> None:
    clips = load_ucsd(subsets, splits)
    if max_clips:
        clips = clips[:max_clips]
    n_frames = sum(len(c.frame_paths) for c in clips)
    print(f"[ucsd] {len(clips)} clips, {n_frames} frames, "
          f"subsets={list(subsets)} splits={list(splits)}")

    backgrounds = _backgrounds(sorted({c.subset for c in clips}))

    # Pass 2: density proxy for every frame of every clip.
    occupancy: dict[str, np.ndarray] = {}
    if workers > 1:
        tasks = [(c, backgrounds[c.subset]) for c in clips]
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_occupancy_task, t) for t in tasks]
            for f in tqdm(as_completed(futures), total=len(futures),
                          desc="occupancy", unit="clip"):
                name, occ = f.result()
                occupancy[name] = occ
    else:
        for c in tqdm(clips, desc="occupancy", unit="clip"):
            occupancy[c.name] = clip_occupancy(c, backgrounds[c.subset])

    # Tertile cuts over non-anomalous frames only; anomalous frames are already
    # claimed by `risky`, so letting them into the quantiles would distort the
    # density grading of everything else.  Both series are advanced by one frame
    # so the quantiles are taken over exactly the population that gets labelled.
    normal_occ = np.concatenate(
        [occupancy[c.name][1:][~c.abnormal[1:len(occupancy[c.name])]] for c in clips]
    )
    thresholds = density_thresholds(normal_occ)
    print(f"[ucsd] {len(normal_occ)} non-anomalous frames; "
          f"occupancy tertile cuts: {thresholds.round(5).tolist()}")

    _warn_on_stale_cache({c.cache_name for c in clips}, thresholds)

    total_flow = n_frames - len(clips)
    keep_ratio = 1.0 if frame_budget in (0, None) else min(1.0, frame_budget / total_flow)
    print(f"[ucsd] {total_flow} flow frames available, keeping {keep_ratio:.1%}")

    # Pass 3: flow, descriptors, labels.
    results: dict[str, np.ndarray] = {}
    if workers > 1:
        tasks = [(c, occupancy[c.name], thresholds, keep_ratio) for c in clips]
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_process_task, t) for t in tasks]
            for f in tqdm(as_completed(futures), total=len(futures),
                          desc="flow", unit="clip"):
                name, counts = f.result()
                results[name] = counts
    else:
        for c in tqdm(clips, desc="flow", unit="clip"):
            name, counts = process_clip(c, occupancy[c.name], thresholds, keep_ratio)
            results[name] = counts

    for c in clips:
        counts = results[c.name]
        print(f"  {c.name:22s} {int(counts.sum()):5d} frames  " +
              "  ".join(f"{cls}={n}" for cls, n in zip(CLASSES, counts)))

    _calibrate_and_finalise(_cached_names())

    totals = np.zeros(len(CLASSES), dtype=np.int64)
    for n in _cached_names():
        totals += np.bincount(np.load(CACHE / n / "labels.npy"),
                              minlength=len(CLASSES))
    print("\n[ucsd] corpus class balance: " +
          "  ".join(f"{c}={t} ({t / max(totals.sum(), 1):.1%})"
                    for c, t in zip(CLASSES, totals)) +
          f"  (total {totals.sum()})")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subset", action="append", choices=list(UCSD_SUBSETS),
                    help="restrict to one subset; repeatable (default: both)")
    ap.add_argument("--split", action="append", choices=list(UCSD_SPLITS),
                    help="restrict to one split; repeatable (default: both)")
    ap.add_argument("--max-clips", type=int, default=None, help="cap clip count")
    ap.add_argument("--frame-budget", type=int, default=FRAME_BUDGET,
                    help="subsample to this many flow frames; 0 = keep all")
    ap.add_argument("--workers", type=int, default=1,
                    help="parallel worker processes (one clip per task)")
    args = ap.parse_args()

    configure_stdout()
    ensure_dirs()
    set_seeds()

    preprocess_ucsd(
        subsets=tuple(args.subset) if args.subset else UCSD_SUBSETS,
        splits=tuple(args.split) if args.split else UCSD_SPLITS,
        max_clips=args.max_clips,
        frame_budget=args.frame_budget,
        workers=args.workers,
    )
    print(f"\ncache written to {CACHE}")


if __name__ == "__main__":
    main()
