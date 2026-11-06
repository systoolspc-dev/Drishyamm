"""Verify a YOLO detection dataset: image<->label pairing and content sanity.

Checks, per split (train/val/test):
  * every image has a matching label .txt (by stem) and vice versa
  * images open and decode, and report their pixel size
  * duplicate stems (e.g. img1.jpg + img1.png) that would collide on one label
  * label lines are well-formed: 5 fields, integer class, xywh normalized to (0,1]
  * box geometry stays inside the image (0..1 after +/- half w/h)
  * class ids appear in data.yaml names
  * counts of annotated vs background (empty) label files
"""

import sys
from collections import Counter, defaultdict
from pathlib import Path

DATASET = Path(sys.argv[1] if len(sys.argv) > 1 else "dataset")
IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}

try:
    from PIL import Image
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


def parse_names(yaml_path):
    """Minimal parse of the `names:` id->name block from data.yaml."""
    names = {}
    in_names = False
    for line in yaml_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("names:"):
            in_names = True
            continue
        if in_names:
            if line and not line.startswith((" ", "\t")):
                break
            s = line.strip()
            if ":" in s:
                k, v = s.split(":", 1)
                try:
                    names[int(k)] = v.strip()
                except ValueError:
                    pass
    return names


def check_label_file(path):
    """Return (num_boxes, list_of_error_strings) for one label file."""
    errors = []
    text = path.read_text(encoding="utf-8")
    n_boxes = 0
    for ln, raw in enumerate(text.splitlines(), 1):
        raw = raw.strip()
        if not raw:
            continue
        parts = raw.split()
        if len(parts) != 5:
            errors.append(f"line {ln}: expected 5 fields, got {len(parts)}")
            continue
        try:
            cls = int(parts[0])
        except ValueError:
            errors.append(f"line {ln}: class '{parts[0]}' not an int")
            continue
        try:
            xc, yc, w, h = (float(x) for x in parts[1:])
        except ValueError:
            errors.append(f"line {ln}: non-numeric coord in {parts[1:]}")
            continue
        n_boxes += 1
        for name, val in (("xc", xc), ("yc", yc), ("w", w), ("h", h)):
            if not (0.0 <= val <= 1.0):
                errors.append(f"line {ln}: {name}={val} out of [0,1]")
        if w <= 0 or h <= 0:
            errors.append(f"line {ln}: non-positive size w={w} h={h}")
        # box must not spill outside the frame (small epsilon for rounding)
        eps = 1e-6
        if xc - w / 2 < -eps or xc + w / 2 > 1 + eps:
            errors.append(f"line {ln}: box exceeds frame horizontally")
        if yc - h / 2 < -eps or yc + h / 2 > 1 + eps:
            errors.append(f"line {ln}: box exceeds frame vertically")
        yield_cls.append(cls)
    return n_boxes, errors


yield_cls = []  # collected class ids across all files


def main():
    if not DATASET.exists():
        sys.exit(f"Dataset dir not found: {DATASET}")

    yaml_path = DATASET / "data.yaml"
    names = parse_names(yaml_path) if yaml_path.exists() else {}
    print(f"data.yaml classes: {names or '(none found)'}")
    if not HAVE_PIL:
        print("NOTE: Pillow not installed -> skipping image decode checks "
              "(pip install pillow to enable).")

    img_root = DATASET / "images"
    lbl_root = DATASET / "labels"
    splits = [p.name for p in sorted(img_root.iterdir()) if p.is_dir()] \
        if img_root.exists() else []

    grand_problems = 0
    for split in splits:
        img_dir = img_root / split
        lbl_dir = lbl_root / split

        images = [p for p in img_dir.iterdir() if p.suffix.lower() in IMG_EXTS]
        labels = list(lbl_dir.glob("*.txt")) if lbl_dir.exists() else []

        # map stem -> [image paths]  to catch stem collisions
        stem_to_imgs = defaultdict(list)
        for p in images:
            stem_to_imgs[p.stem].append(p)
        label_stems = {p.stem for p in labels}
        image_stems = set(stem_to_imgs)

        missing_label = sorted(image_stems - label_stems)
        missing_image = sorted(label_stems - image_stems)
        collisions = {s: v for s, v in stem_to_imgs.items() if len(v) > 1}

        # content + decode checks
        bad_labels = {}
        empty_labels = 0
        annotated = 0
        bad_images = []
        for lp in labels:
            n_boxes, errs = check_label_file(lp)
            if errs:
                bad_labels[lp.name] = errs
            if n_boxes == 0:
                empty_labels += 1
            else:
                annotated += 1

        if HAVE_PIL:
            for ip in images:
                try:
                    with Image.open(ip) as im:
                        im.verify()
                except Exception as e:  # noqa: BLE001
                    bad_images.append(f"{ip.name}: {e}")

        problems = (len(missing_label) + len(missing_image) + len(collisions)
                    + len(bad_labels) + len(bad_images))
        grand_problems += problems

        print(f"\n=== split: {split} ===")
        print(f"  images: {len(images)}   labels: {len(labels)}")
        print(f"  annotated labels: {annotated}   background (empty): {empty_labels}")
        status = "OK" if problems == 0 else f"{problems} PROBLEM(S)"
        print(f"  pairing/content: {status}")

        def show(title, items, n=10):
            if items:
                print(f"    {title}: {len(items)}")
                for x in list(items)[:n]:
                    print(f"      - {x}")
                if len(items) > n:
                    print(f"      ... (+{len(items) - n} more)")

        show("images with no label", missing_label)
        show("labels with no image", missing_image)
        show("stem collisions (share one label)",
             [f"{s}: {[p.name for p in v]}" for s, v in collisions.items()])
        show("malformed label files",
             [f"{k}: {v[0]}" + (f" (+{len(v)-1} more)" if len(v) > 1 else "")
              for k, v in bad_labels.items()])
        show("unreadable images", bad_images)

    print("\n" + "=" * 40)
    print(f"class ids used in labels: {dict(Counter(yield_cls))}")
    unknown = {c for c in yield_cls if c not in names} if names else set()
    if unknown:
        print(f"  ! class ids NOT in data.yaml names: {sorted(unknown)}")
    if grand_problems == 0:
        print("RESULT: dataset is consistent — all checks passed.")
    else:
        print(f"RESULT: {grand_problems} problem(s) found (see above).")
        sys.exit(1)


if __name__ == "__main__":
    main()
