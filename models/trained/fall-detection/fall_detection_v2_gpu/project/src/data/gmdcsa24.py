"""Adapter for the GMDCSA24 dataset (Alam et al., 2024, v2.0).

Layout in the wild:
    <root>/Subject N/Fall/*.mp4   + Subject N/Fall.csv
    <root>/Subject N/ADL/*.mp4    + Subject N/ADL.csv

The CSV "Classes" column carries frame-accurate intervals, e.g.
    Falling (SW)[3.4 to 6]; Sitting[0 to 3.4]
We parse every "Falling ...[a to b]" span to get exact fall_start/fall_end.

This script builds the pipeline's expected layout WITHOUT copying gigabytes:
    data_raw/fall/s{N}_{name}.mp4   (symlinks)
    data_raw/adl/s{N}_{name}.mp4    (symlinks)
    annotations.csv                 (video, fall_start_sec, fall_end_sec)

Filenames are subject-prefixed (s1_, s2_, ...) so training can split by SUBJECT
(hold out whole people) — the honest test of generalization.

Usage:
    python -m src.data.gmdcsa24 --root "/path/to/GMDCSA24.../GMDCSA24..." \
        --out data_raw --annotations annotations.csv
"""
from __future__ import annotations
import argparse
import csv
import re
from pathlib import Path

# Handles "[3.4 to 6]", "[2.3 6]" (missing 'to'), and "[2.3-6]" variants.
FALL_INTERVAL = re.compile(
    r"Falling[^\[]*\[\s*([0-9.]+)\s*(?:to|-)?\s+([0-9.]+)\s*\]", re.IGNORECASE)


def _fall_span(line: str):
    """Return (start, end) covering all 'Falling[a to b]' spans in a CSV line."""
    spans = FALL_INTERVAL.findall(line)
    if not spans:
        return None
    starts = [float(a) for a, _ in spans]
    ends = [float(b) for _, b in spans]
    return min(starts), max(ends)


def _link(src: Path, dst: Path):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.symlink_to(src.resolve())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True,
                    help="folder that directly contains 'Subject 1' ... 'Subject 4'")
    ap.add_argument("--out", type=Path, default=Path("data_raw"))
    ap.add_argument("--annotations", type=Path, default=Path("annotations.csv"))
    args = ap.parse_args()

    subjects = sorted(p for p in args.root.iterdir()
                      if p.is_dir() and p.name.lower().startswith("subject"))
    if not subjects:
        raise SystemExit(f"no 'Subject N' folders under {args.root}")

    ann_rows = []
    n_fall = n_adl = n_annot = 0

    for subj in subjects:
        sid = "s" + re.sub(r"\D", "", subj.name)   # "Subject 2" -> "s2"

        # --- Fall videos (+ parse intervals) ---
        fall_csv = subj / "Fall.csv"
        spans = {}
        if fall_csv.exists():
            for line in fall_csv.read_text().splitlines()[1:]:
                if not line.strip():
                    continue
                name = line.split(",")[0].strip()
                span = _fall_span(line)
                if span:
                    spans[name] = span
        for v in sorted((subj / "Fall").glob("*.mp4")):
            out_name = f"{sid}_{v.name}"
            _link(v, args.out / "fall" / out_name)
            n_fall += 1
            if v.name in spans:
                s, e = spans[v.name]
                ann_rows.append((out_name, s, e))
                n_annot += 1
            else:
                print(f"  ! no fall interval parsed for {subj.name}/{v.name}")

        # --- ADL videos (all negative) ---
        for v in sorted((subj / "ADL").glob("*.mp4")):
            _link(v, args.out / "adl" / f"{sid}_{v.name}")
            n_adl += 1

    with open(args.annotations, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["video", "fall_start_sec", "fall_end_sec"])
        w.writerows(ann_rows)

    print(f"\nLinked {n_fall} fall + {n_adl} adl videos into {args.out}/")
    print(f"Wrote {n_annot} fall intervals -> {args.annotations}")
    print(f"Subjects: {[s.name for s in subjects]}")


if __name__ == "__main__":
    main()
