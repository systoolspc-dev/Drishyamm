"""Adapter for the OmniFall benchmark (https://huggingface.co/datasets/simplexsigil2/omnifall).

WHY OmniFall: our combined model (GMDCSA + VideoDataset) was trained only on
STAGED single-fall clips, so it never saw a person *squatting*, *kneeling*,
*sitting down*, or *deliberately lying down* — and false-fires on those in real
CCTV (the bent-forward / occluded-legs failure). OmniFall fixes this THROUGH
DATA, not hand-tuned rules: it labels video with a 16-class temporal taxonomy
that explicitly separates the transient FALL event from the look-alike states:

    0 walk        1 FALL*       2 fallen      3 sit_down    4 sitting
    5 lie_down    6 lying       7 stand_up    8 standing    9 other
   10 kneel_down 11 kneeling   12 squat_down 13 squatting  14 crawl  15 jump

We keep the binary target the rest of the pipeline expects:
  * POSITIVE  = the `fall` (label 1) segments  -> real fall events (+ the couple
    seconds of `fallen` after, added downstream by prepare_dataset's
    CONFIRM_SECONDS tail, so the model keeps firing while the body is on the floor).
  * NEGATIVE  = every other frame, INCLUDING squat_down/squatting, kneel_down/
    kneeling, sit_down/sitting, lie_down/lying, standing, walk, jump, crawl.
    These are exactly the hard negatives that were false-firing.

Sub-datasets (HF configs) worth using:
  staged, precise labels (best hard negatives, multi-view/occlusion):
    mcfd  le2i  cmdfall  edf  occu   (also caucafall, up_fall)
  in-the-wild (real CCTV / YouTube falls) -- BEST kept for honest validation:
    of-itw   (the OOPS-Fall set)

Videos are NOT in the HF repo (only the annotations are). Obtain them separately
on the training box (see docs/OMNIFALL.md), then point --videos at the folder
holding them. This adapter reads the annotations from HF (small) and symlinks the
local videos into the shared data_raw/ layout, appending fall intervals to
annotations.csv so OmniFall trains alongside GMDCSA + VideoDataset.

Grouping (train/val split): OmniFall's per-row `subject` field is unreliable
(all 1 in mcfd/of-itw), so we derive an anti-leakage group key per dataset from
the video path -- all cameras/views of one scene/person share a group, so a fall
can't leak between train and val. Group tokens look like `mcfd3`, `cmd39`,
`itw7`, matching prepare_dataset's `^([a-zA-Z]+\\d+)_` subject regex.

Usage (run AFTER the gmdcsa24 + videodataset adapters so all share one data_raw):
    python -m src.data.omnifall --videos <omnifall video root> \
        --configs mcfd,le2i,cmdfall,edf,occu \
        --out data_raw --annotations annotations.csv
    # keep of-itw OUT of training; extract it separately for validation:
    python -m src.data.omnifall --videos <root> --configs of-itw \
        --out data_raw_val_itw --annotations annotations_itw.csv
"""
from __future__ import annotations
import argparse
import csv
import os
import re
from collections import defaultdict
from pathlib import Path

from src.data.datasets import VIDEO_EXTS

HF_REPO = "simplexsigil2/omnifall"
FALL_LABEL = 1  # index of `fall` in the 16-class taxonomy

# short, regex-safe (letters-only) code per dataset -> group tokens read cleanly
DATASET_CODE = {
    "mcfd": "mcfd", "le2i": "le2i", "cmdfall": "cmd", "edf": "edf",
    "occu": "occu", "caucafall": "cauca", "up_fall": "upf", "of-itw": "itw",
}


def _code(cfg: str) -> str:
    return DATASET_CODE.get(cfg, re.sub(r"[^a-z]", "", cfg.lower()) or "of")


def _scene_key(cfg: str, path: str) -> str:
    """Anti-leakage group key: everything filmed from the same scene/person must
    stay on one side of the train/val split. Derived from the video path because
    the `subject` field is degenerate in several sub-datasets."""
    base = path.strip("/")
    if cfg == "cmdfall":
        # 'colors/S39P1K5' -> subject 'S39' (S<subj>P<perf>K<kinect-cam>)
        tail = base.split("/")[-1]
        m = re.match(r"(S\d+)", tail)
        return m.group(1) if m else tail
    if cfg == "of-itw":
        # each YouTube clip is independent -> its own group
        return base
    # mcfd 'chute21/cam5' -> 'chute21'; le2i 'Coffee_room_01/video_1';
    # edf/occu 'jianjun/view1/rgb/...' -> 'jianjun'
    return base.split("/")[0]


def _safe(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", path.strip("/")).strip("-")


def _find_video(videos_root: Path, cfg: str, path: str) -> Path | None:
    """Resolve an OmniFall annotation `path` to a real local video file.
    Tries the common layouts, then falls back to a recursive search by tail."""
    rels = [path, f"{cfg}/{path}"]
    for rel in rels:
        for ext in VIDEO_EXTS:
            cand = videos_root / f"{rel}{ext}"
            if cand.exists():
                return cand
    # fallback: recursive search, but the hit MUST end with the full annotation
    # path (scene + file). OmniFall basenames ('cam5') are NOT unique across
    # scenes, so matching on basename alone would attach the wrong video.
    norm = path.strip("/").replace("/", os.sep)
    stem = Path(path).name
    for ext in VIDEO_EXTS:
        for hit in videos_root.rglob(f"*{stem}{ext}"):
            if str(hit).endswith(norm + ext):
                return hit
    return None


# annotations pre-exported from HF so the training box needs NO network for them
# (only the videos are fetched externally). See omnifall_annotations/*.csv.
_ANN_DIR = Path(__file__).resolve().parents[2] / "omnifall_annotations"


def _load_segments(cfg: str):
    """Yield annotation rows for a config as dicts with the label NAME resolved.
    Prefers the bundled local CSV (offline); falls back to HuggingFace only if
    that config wasn't pre-exported."""
    local = _ANN_DIR / f"{cfg}.csv"
    if local.exists():
        with open(local) as f:
            for r in csv.DictReader(f):
                yield {"path": r["path"], "label": r["label"],
                       "start": float(r["start"]), "end": float(r["end"])}
        return

    print(f"  ({cfg}: no bundled annotations, fetching from HuggingFace)")
    from datasets import load_dataset

    ds = load_dataset(HF_REPO, cfg, split="train")
    names = ds.features["label"].names
    for r in ds:
        yield {"path": r["path"], "label": names[r["label"]],
               "start": float(r["start"]), "end": float(r["end"])}


def _link(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.symlink_to(src.resolve())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", type=Path, required=True,
                    help="root folder containing the OmniFall video files")
    ap.add_argument("--configs", default="mcfd,le2i,cmdfall,edf,occu",
                    help="comma-separated HF configs to ingest")
    ap.add_argument("--out", type=Path, default=Path("data_raw"))
    ap.add_argument("--annotations", type=Path, default=Path("annotations.csv"))
    ap.add_argument("--holdout-frac", type=float, default=0.0,
                    help="reserve this fraction of each config's SCENES as a "
                         "held-out validation split (e.g. 0.3). 0 = use all.")
    ap.add_argument("--part", choices=["all", "train", "val"], default="all",
                    help="with --holdout-frac: emit only the train part (scenes "
                         "NOT reserved) or the val part (the reserved scenes). "
                         "The split is deterministic, so train/val never overlap.")
    args = ap.parse_args()

    def _in_part(scene_idx: int) -> bool:
        """Deterministic scene-level train/val membership. val = every k-th scene
        in sorted order (~holdout_frac of them); train = the rest."""
        if args.part == "all" or args.holdout_frac <= 0:
            return True
        k = max(2, round(1.0 / args.holdout_frac))
        is_val = (scene_idx % k == 0)
        return is_val if args.part == "val" else (not is_val)

    # preserve existing annotation rows (GMDCSA/VideoDataset), dedupe by triple
    existing: list[list[str]] = []
    seen_rows: set[tuple] = set()
    if args.annotations.exists():
        with open(args.annotations) as f:
            rr = csv.reader(f); next(rr, None)
            for row in rr:
                if row:
                    existing.append(row)
                    seen_rows.add((row[0], row[1], row[2]))

    new_rows: list[list[str]] = []
    n_fall_vids = n_adl_vids = n_missing = 0
    groups: set[str] = set()

    for cfg in [c.strip() for c in args.configs.split(",") if c.strip()]:
        code = _code(cfg)
        # gather segments per video path
        by_path: dict[str, list] = defaultdict(list)
        for seg in _load_segments(cfg):
            by_path[seg["path"]].append(seg)

        # deterministic scene-key -> token map (sorted so it's reproducible)
        scene_keys = sorted({_scene_key(cfg, p) for p in by_path})
        token = {k: f"{code}{i + 1}" for i, k in enumerate(scene_keys)}
        allowed = {k for i, k in enumerate(scene_keys) if _in_part(i)}

        cfg_fall = cfg_adl = cfg_missing = 0
        for path, segs in sorted(by_path.items()):
            if _scene_key(cfg, path) not in allowed:
                continue  # scene belongs to the other train/val split
            src = _find_video(args.videos, cfg, path)
            if src is None:
                n_missing += 1; cfg_missing += 1
                continue
            grp = token[_scene_key(cfg, path)]
            groups.add(grp)
            name = f"{grp}_{_safe(path)}{src.suffix.lower()}"
            falls = [s for s in segs if s["label"] == "fall"]
            _link(src, args.out / ("fall" if falls else "adl") / name)
            if falls:
                n_fall_vids += 1; cfg_fall += 1
                for s in falls:
                    row = [name, f"{s['start']:.3f}", f"{s['end']:.3f}"]
                    if (row[0], row[1], row[2]) not in seen_rows:
                        seen_rows.add((row[0], row[1], row[2]))
                        new_rows.append(row)
            else:
                # pure hard-negative clip (walk/sit/squat/kneel/lie, no fall)
                n_adl_vids += 1; cfg_adl += 1
        note = f" [{cfg_missing} videos not found locally]" if cfg_missing else ""
        part = "" if args.part == "all" else f" ({args.part} split: {len(allowed)}/{len(scene_keys)} scenes)"
        print(f"  {cfg}: {cfg_fall} fall + {cfg_adl} adl clips, "
              f"{len(allowed)} groups{part}{note}")

    with open(args.annotations, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["video", "fall_start_sec", "fall_end_sec"])
        w.writerows(existing)
        w.writerows(new_rows)

    print(f"\nOmniFall: linked {n_fall_vids} fall + {n_adl_vids} adl videos "
          f"across {len(groups)} groups.")
    if n_missing:
        print(f"  NOTE: {n_missing} annotated videos were not found under "
              f"{args.videos} (download them, then re-run).")
    print(f"annotations.csv now holds {len(existing) + len(new_rows)} fall "
          f"intervals (incl. any preexisting).")


if __name__ == "__main__":
    main()
