"""Build an `eval_data/` set from the live system's own enrolled faces.

Turns `data/known_faces/` (files named `Full Name_N.JPG`) into the layout
`eval/harness.py` expects, using a **held-out split**: the first `--gallery-n`
images of each person are enrolled, the rest become probes. Persons with only
one image are enrolled but contribute no probe (nothing to hold out).

This measures the RECOGNIZER on real enrolled faces. It is deliberately honest
about what it is NOT: enrollment stills are cleaner than live CCTV crops, so
these numbers are an UPPER BOUND — treat them as a regression baseline and a
threshold-calibration aid, not as production accuracy. For production numbers,
add human-labelled CCTV crops as extra probes (see eval/README.md).

    python -m vms_face.eval.build_eval_data \
        --known-faces data/known_faces --out eval_data --gallery-n 3
"""
from __future__ import annotations

import argparse
import csv
import re
import shutil
from collections import defaultdict
from pathlib import Path

# "Aakash Baghel_1.JPG" -> ("Aakash Baghel", 1)
_NAME_RE = re.compile(r"^(?P<name>.+?)[_\-\s]*(?P<idx>\d+)?$")


def person_of(path: Path) -> tuple[str, int]:
    m = _NAME_RE.match(path.stem)
    if not m:
        return path.stem, 0
    return m.group("name").strip(), int(m.group("idx") or 0)


def slug(name: str) -> str:
    """Filesystem/manifest-safe person id (harness splits on '__')."""
    return re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()


def main() -> None:
    ap = argparse.ArgumentParser(description="Build eval_data from known_faces")
    ap.add_argument("--known-faces", default="data/known_faces")
    ap.add_argument("--out", default="eval_data")
    ap.add_argument("--gallery-n", type=int, default=3,
                    help="images per person to enrol; the rest become probes")
    args = ap.parse_args()

    src = Path(args.known_faces)
    if not src.is_dir():
        raise SystemExit(f"known-faces dir not found: {src}")

    out = Path(args.out)
    gal_dir, probe_dir = out / "gallery", out / "probe"
    for d in (gal_dir, probe_dir):
        d.mkdir(parents=True, exist_ok=True)

    by_person: dict[str, list[Path]] = defaultdict(list)
    for f in sorted(src.iterdir()):
        if f.suffix.lower() in (".jpg", ".jpeg", ".png"):
            by_person[person_of(f)[0]].append(f)

    rows: list[dict] = []
    n_gal = n_probe = 0
    for name, files in sorted(by_person.items()):
        files.sort(key=lambda p: person_of(p)[1])
        pid = slug(name)
        gallery, probes = files[: args.gallery_n], files[args.gallery_n:]
        for i, f in enumerate(gallery, 1):
            shutil.copy2(f, gal_dir / f"{pid}__{i}{f.suffix.lower()}")
            n_gal += 1
        for i, f in enumerate(probes, 1):
            dst = probe_dir / f"{pid}__heldout{i}{f.suffix.lower()}"
            shutil.copy2(f, dst)
            rows.append({"path": f"probe/{dst.name}", "true_person_id": pid,
                         "scenario": "enrollment_heldout", "camera": "n/a"})
            n_probe += 1

    with (out / "manifest.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["path", "true_person_id", "scenario", "camera"])
        w.writeheader()
        w.writerows(rows)

    singles = sum(1 for f in by_person.values() if len(f) <= args.gallery_n)
    print(f"persons          : {len(by_person)}")
    print(f"gallery images   : {n_gal}")
    print(f"probe images     : {n_probe}")
    print(f"no-probe persons : {singles}  (≤{args.gallery_n} images, all enrolled)")
    print(f"manifest         : {out / 'manifest.csv'}")
    if not rows:
        print("\nWARNING: no probes produced — lower --gallery-n.")
    print("\nNOTE: probes are enrollment stills, so results are an UPPER BOUND. "
          "Add labelled CCTV crops for production-representative numbers.")


if __name__ == "__main__":
    main()
