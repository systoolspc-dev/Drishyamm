"""Adapter for the multi-view VideoDataset (subject/location/view fall dataset).

Layout in the wild:
    <root>/Fall/SBJ_<n>_LOC<l>/ACT<a>_<side>_<attempt>/<timestamp>.mp4
    <root>/ADL/  ... same structure
    (each activity folder also has metadata.json + a wearable-IMU .txt)

Fall activities are ACT1-12, ADL are ACT13-25, but the top-level Fall/ADL folder
is the authoritative label. Clips are ~1.9s, each already trimmed to the action,
so we label the WHOLE Fall clip as a fall (0..duration) and ADL clips as normal.

Builds the pipeline layout with symlinks, subject-prefixed so training can split
by SUBJECT (hold out whole people):
    data_raw/fall/v<subj>_L<loc>_<act>.mp4
    data_raw/adl/v<subj>_L<loc>_<act>.mp4

It PRESERVES any existing rows in annotations.csv (e.g. GMDCSA intervals from the
gmdcsa24 adapter) and appends whole-clip fall spans for its own clips, so both
datasets can share one data_raw/ and be extracted together.

Usage:
    # combine with GMDCSA: run the gmdcsa24 adapter first, then this
    python -m src.data.videodataset --root ~/Downloads/VideoDataset \
        --out data_raw --annotations annotations.csv
"""
from __future__ import annotations
import argparse
import csv
import re
from pathlib import Path


def _link(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.symlink_to(src.resolve())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True,
                    help="folder containing 'Fall' and 'ADL'")
    ap.add_argument("--out", type=Path, default=Path("data_raw"))
    ap.add_argument("--annotations", type=Path, default=Path("annotations.csv"))
    args = ap.parse_args()

    # preserve existing annotation rows (e.g. from the GMDCSA adapter)
    rows: dict[str, list] = {}
    if args.annotations.exists():
        with open(args.annotations) as f:
            r = csv.reader(f); next(r, None)
            for row in r:
                if row:
                    rows[row[0]] = row

    n_fall = n_adl = 0
    subjects = set()
    for label_dir, is_fall in [("Fall", True), ("ADL", False)]:
        base = args.root / label_dir
        if not base.exists():
            print(f"missing {base}, skipping"); continue
        for act_dir in sorted(base.glob("SBJ_*/ACT*")):
            if not act_dir.is_dir():
                continue
            mp4s = list(act_dir.glob("*.mp4"))
            if not mp4s:
                continue
            m = re.match(r"SBJ_(\d+)_LOC(\d+)", act_dir.parent.name)
            if not m:
                continue
            subj, loc = m.group(1), m.group(2)
            subjects.add(f"v{subj}")
            name = f"v{subj}_L{loc}_{act_dir.name}.mp4"   # e.g. v10_L3_ACT2_F_1.mp4
            _link(mp4s[0], args.out / ("fall" if is_fall else "adl") / name)
            if is_fall:
                rows[name] = [name, "0.0", "10.0"]         # whole short clip = fall
                n_fall += 1
            else:
                n_adl += 1

    with open(args.annotations, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["video", "fall_start_sec", "fall_end_sec"])
        w.writerows(rows.values())

    print(f"Linked {n_fall} fall + {n_adl} adl videos from VideoDataset")
    print(f"Subjects: {len(subjects)} ({', '.join(sorted(subjects))})")
    print(f"annotations.csv now holds {len(rows)} fall spans (incl. any preexisting)")


if __name__ == "__main__":
    main()
