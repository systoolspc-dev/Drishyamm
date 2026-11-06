from __future__ import annotations

import csv
from pathlib import Path

from vms_face.eval.types import GalleryRecord, ProbeRecord


def load_gallery(gallery_dir: Path) -> list[GalleryRecord]:
    """Filename convention: {person_id}__{free_text}.{jpg|png}
       e.g. alice__angle1.jpg, alice__angle2.jpg, bob__1.png

    Lines beginning with 'unknown__' are skipped (those are probe-only)."""
    records: list[GalleryRecord] = []
    for p in sorted(gallery_dir.iterdir()):
        if not p.is_file() or p.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp"}:
            continue
        stem = p.stem
        if stem.startswith("unknown__") or stem.startswith("unknown_"):
            continue
        person_id = stem.split("__", 1)[0]
        records.append(GalleryRecord(path=p, person_id=person_id))
    return records


def load_probes_from_manifest(manifest_csv: Path) -> list[ProbeRecord]:
    """CSV columns:
        path, true_person_id, [extra tag columns...]
       true_person_id may be empty (means 'unknown' / negative sample)."""
    records: list[ProbeRecord] = []
    with manifest_csv.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if "path" not in reader.fieldnames:
            raise ValueError("manifest CSV must have a 'path' column")
        for row in reader:
            path_value = (row.get("path") or "").strip()
            if not path_value:
                continue
            path = (manifest_csv.parent / path_value).resolve()
            true_id = (row.get("true_person_id") or "").strip()
            tags = {k: v for k, v in row.items() if k not in {"path", "true_person_id"} and v}
            records.append(ProbeRecord(path=path, true_person_id=true_id or None, tags=tags))
    return records


def load_probes_from_dir(probe_dir: Path) -> list[ProbeRecord]:
    """Fallback when no CSV is available. Filename convention:
       {true_id_or_unknown}__{tag1=v1}__{tag2=v2}__{free}.{jpg|png}
       e.g. alice__scenario=indoor__camera=cam01.jpg
            unknown__scenario=outdoor_night__camera=cam05.jpg"""
    records: list[ProbeRecord] = []
    for p in sorted(probe_dir.iterdir()):
        if not p.is_file() or p.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp"}:
            continue
        parts = p.stem.split("__")
        true_id = parts[0]
        tags: dict[str, str] = {}
        for part in parts[1:]:
            if "=" in part:
                k, v = part.split("=", 1)
                tags[k] = v
        if true_id.lower() in ("unknown", "neg", "negative"):
            true_id_value: str | None = None
        else:
            true_id_value = true_id
        records.append(ProbeRecord(path=p, true_person_id=true_id_value, tags=tags))
    return records
