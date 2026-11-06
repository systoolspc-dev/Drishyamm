"""Convert an Ultralytics NDJSON export into a YOLO detection dataset.

The NDJSON has one metadata line (type="dataset") followed by one line per
image (type="image"). Each image line carries its split and, if labelled, an
`annotations.boxes` list of [class_id, x_center, y_center, w, h] already in
normalized YOLO format.

Usage:
    python converter.py                      # labels + data.yaml only (fast, offline)
    python converter.py --images             # also download images from the CDN URLs
    python converter.py --images --workers 32
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def load_records(ndjson_path):
    """Yield parsed JSON objects from an NDJSON file, skipping blank lines."""
    with open(ndjson_path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as e:
                print(f"  ! skipping malformed line {line_no}: {e}", file=sys.stderr)


def write_labels(ndjson_path, out_dir):
    """Write YOLO label files + data.yaml. Returns (meta, images) for reuse."""
    out_dir = Path(out_dir)
    meta = None
    images = []

    splits = set()
    for rec in load_records(ndjson_path):
        rec_type = rec.get("type")
        if rec_type == "dataset":
            meta = rec
        elif rec_type == "image":
            images.append(rec)
            splits.add(rec.get("split", "train"))

    if meta is None:
        print("  ! no dataset metadata line found; class names may be incomplete",
              file=sys.stderr)
        meta = {}

    # Create images/<split> and labels/<split> directories.
    for split in splits:
        (out_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    written = 0
    for rec in images:
        split = rec.get("split", "train")
        stem = Path(rec["file"]).stem
        label_path = out_dir / "labels" / split / f"{stem}.txt"

        boxes = rec.get("annotations", {}).get("boxes", [])
        lines = []
        for box in boxes:
            cls, xc, yc, w, h = box  # class_id, then normalized xywh
            lines.append(f"{int(cls)} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}")

        # Background images (no boxes) still get an empty .txt file — YOLO treats
        # these as negative samples.
        label_path.write_text("\n".join(lines), encoding="utf-8")
        written += 1

    # Build data.yaml.
    class_names = meta.get("class_names", {})
    # Keys may be strings; sort numerically and emit as an id->name map.
    ordered = sorted(class_names.items(), key=lambda kv: int(kv[0]))
    names_block = "\n".join(f"  {int(k)}: {v}" for k, v in ordered)

    yaml_lines = [f"path: {out_dir.resolve().as_posix()}"]
    for split, key in (("train", "train"), ("val", "val"), ("test", "test")):
        if split in splits:
            yaml_lines.append(f"{key}: images/{split}")
    yaml_lines.append("")
    yaml_lines.append("names:")
    yaml_lines.append(names_block if names_block else "  0: object")
    (out_dir / "data.yaml").write_text("\n".join(yaml_lines) + "\n", encoding="utf-8")

    print(f"Wrote {written} label files.")
    for split in sorted(splits):
        n = sum(1 for i in images if i.get("split", "train") == split)
        print(f"  {split}: {n} images")
    print(f"Wrote {out_dir / 'data.yaml'}")
    return meta, images


def download_images(images, out_dir, workers):
    """Download each image URL into images/<split>/<file>, skipping existing files."""
    import urllib.request
    import urllib.error

    out_dir = Path(out_dir)
    tasks = []
    for rec in images:
        split = rec.get("split", "train")
        dest = out_dir / "images" / split / rec["file"]
        if dest.exists() and dest.stat().st_size > 0:
            continue
        tasks.append((rec["url"], dest))

    total = len(tasks)
    already = len(images) - total
    print(f"\nDownloading {total} images ({already} already present) "
          f"with {workers} workers...")

    done = 0
    failed = []

    def fetch(url, dest):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "yolo-converter"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return None
        except (urllib.error.URLError, OSError) as e:
            return f"{dest.name}: {e}"

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(fetch, url, dest): dest for url, dest in tasks}
        for fut in as_completed(futures):
            done += 1
            err = fut.result()
            if err:
                failed.append(err)
            if done % 100 == 0 or done == total:
                print(f"  {done}/{total} ({len(failed)} failed)", flush=True)

    if failed:
        print(f"\n{len(failed)} downloads failed. First few:", file=sys.stderr)
        for msg in failed[:10]:
            print(f"  ! {msg}", file=sys.stderr)
        print("Re-run with --images to retry only the missing files "
              "(existing files are skipped). Note: signed URLs eventually expire.",
              file=sys.stderr)
    else:
        print("All images downloaded.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ndjson", nargs="?", default="phone-and-no-phone.ndjson",
                    help="input NDJSON file")
    ap.add_argument("out", nargs="?", default="dataset",
                    help="output dataset directory")
    ap.add_argument("--images", action="store_true",
                    help="also download the image files from their CDN URLs")
    ap.add_argument("--workers", type=int, default=16,
                    help="parallel download workers (default 16)")
    args = ap.parse_args()

    if not Path(args.ndjson).exists():
        sys.exit(f"Input not found: {args.ndjson}")

    meta, images = write_labels(args.ndjson, args.out)

    if args.images:
        download_images(images, args.out, args.workers)
    else:
        print("\nLabels + data.yaml done. To also fetch the images, run:")
        print(f"    python converter.py {args.ndjson} {args.out} --images")


if __name__ == "__main__":
    main()
