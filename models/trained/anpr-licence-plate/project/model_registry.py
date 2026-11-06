"""
model_registry.py — WHICH weights produced a sighting.

Audit 2026-09-02: sightings carried no model versions at all, so a read taken
before an OCR fine-tune landed was indistinguishable from one taken after it,
and nobody could say which plate detector had drawn a given box. Every posted
read now carries a compact fingerprint of the weights in use (file name, size,
first 12 hex of the sha256) plus the human-readable version tags from
models/MODEL_REGISTRY.json — the file that documents, honestly, what each
shipped model is, where it came from and what it is known to get wrong.

Pure stdlib, no model loads: the worker calls describe_models() once at
start-up and again after a hot reload (Models.watch); sha256 of a 24 MB
checkpoint costs ~50 ms and is cached by (path, mtime, size).

    file_fingerprint(path)      → {"file", "bytes", "sha256_12"} | None
    describe_models(...)        → full description (registry entries included)
    compact(versions)           → what goes into meta.models (fingerprints + version tags)
    summary_line(versions)      → one log line
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import threading

# fast-plate-ocr keeps its hub downloads in ~/.cache/fast-plate-ocr/<model>/
# (fast_plate_ocr.inference.hub.MODEL_CACHE_DIR). Resolved here without
# importing the library so this module stays free of ML dependencies.
HUB_DIR = os.getenv("ANPR_OCR_HUB_DIR", os.path.join(os.path.expanduser("~"), ".cache", "fast-plate-ocr"))

_CACHE: dict[tuple, dict] = {}
_LOCK = threading.Lock()


def file_fingerprint(path: str | None) -> dict | None:
    """{"file": basename, "bytes": size, "sha256_12": first 12 hex} for an
    existing file, None when it is missing. Cached by (path, mtime, size) so
    a reload only re-hashes a file that actually changed."""
    if not path:
        return None
    try:
        stt = os.stat(path)
    except OSError:
        return None
    key = (os.path.abspath(path), int(stt.st_mtime_ns), int(stt.st_size))
    with _LOCK:
        hit = _CACHE.get(key)
    if hit is not None:
        return dict(hit)
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return None
    fp = {"file": os.path.basename(path), "bytes": int(stt.st_size), "sha256_12": h.hexdigest()[:12]}
    with _LOCK:
        for old in [k for k in _CACHE if k[0] == key[0] and k != key]:
            del _CACHE[old]  # a retrained file replaces its predecessor's entry
        _CACHE[key] = fp
    return dict(fp)


def load_registry(path: str | None) -> dict:
    """models/MODEL_REGISTRY.json → {name: entry}; {} when absent or unreadable
    (the registry is documentation — its absence must never stop a read)."""
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        models = d.get("models") if isinstance(d, dict) else None
        return dict(models) if isinstance(models, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _lib_version(dist: str) -> str | None:
    try:
        from importlib.metadata import version

        return version(dist)
    except Exception:  # noqa: BLE001
        return None


def hub_model_file(name: str, hub_dir: str | None = None) -> str | None:
    """The .onnx of a fast-plate-ocr hub model in the local cache, or None."""
    d = os.path.join(hub_dir or HUB_DIR, name)
    files = sorted(glob.glob(os.path.join(d, "*.onnx")))
    return files[0] if files else None


def describe_models(
    vehicle_pt: str,
    plate_pt: str,
    ocr_names: str,
    calibrator_path: str | None,
    registry_path: str | None,
    *,
    ocr_dir: str | None = None,
    hub_dir: str | None = None,
) -> dict:
    """Everything worth knowing about the weights in use.

    ocr_names is PlateOcrEnsemble.name ("cct-s-v2-global-model + cct-xs-v2-
    global-model", or "custom:ocr + …" for a fine-tune). Hub readers are
    fingerprinted from the local download cache; the custom reader from
    ocr_dir/model.onnx. The registry is filtered to the models in use."""
    readers = [s.strip() for s in str(ocr_names or "").split("+") if s.strip()]
    if ocr_dir is None:
        ocr_dir = os.getenv(
            "ANPR_OCR_MODEL_DIR", os.path.join(os.path.dirname(os.path.abspath(plate_pt)), "ocr")
        )
    custom_onnx = os.path.join(ocr_dir, "model.onnx")
    hub = {}
    for r in readers:
        if r.startswith("custom:"):
            continue
        fp = file_fingerprint(hub_model_file(r, hub_dir))
        if fp is not None:
            hub[r] = fp
    registry = load_registry(registry_path)
    in_use = {os.path.basename(vehicle_pt), os.path.basename(plate_pt), *readers}
    if calibrator_path:
        in_use.add(os.path.basename(calibrator_path))
    if any(r.startswith("custom:") for r in readers):
        in_use.add("model.onnx")
    used = {
        name: e
        for name, e in registry.items()
        if name in in_use or os.path.basename(str((e or {}).get("file", ""))) in in_use
    }
    return {
        "vehicle": file_fingerprint(vehicle_pt),
        "plate": file_fingerprint(plate_pt),
        "ocr": {
            "readers": ocr_names,
            "custom_dir": ocr_dir,
            "model_onnx": file_fingerprint(custom_onnx),
            "hub": hub,
        },
        "calibrator": file_fingerprint(calibrator_path),
        "registry": used,
        "registry_file": os.path.basename(registry_path) if registry_path and used else None,
        "libs": {
            k: v
            for k, v in (
                ("ultralytics", _lib_version("ultralytics")),
                ("fast_plate_ocr", _lib_version("fast-plate-ocr")),
                ("onnxruntime", _lib_version("onnxruntime") or _lib_version("onnxruntime-gpu")),
                ("torch", _lib_version("torch")),
            )
            if v
        },
    }


def compact(versions: dict | None) -> dict | None:
    """The per-sighting form: fingerprints and version tags only — the
    registry's prose stays on disk, not in every row."""
    if not versions:
        return None
    ocr = versions.get("ocr") or {}
    return {
        "vehicle": versions.get("vehicle"),
        "plate": versions.get("plate"),
        "ocr": {
            "readers": ocr.get("readers"),
            "model_onnx": ocr.get("model_onnx"),
            "hub": ocr.get("hub") or {},
        },
        "calibrator": versions.get("calibrator"),
        "registry": {name: (e or {}).get("version") for name, e in (versions.get("registry") or {}).items()},
        "libs": versions.get("libs") or {},
    }


def _tag(fp: dict | None) -> str:
    return f"{fp['file']}@{fp['sha256_12']}" if fp else "none"


def summary_line(versions: dict | None) -> str:
    if not versions:
        return "models: unknown"
    ocr = versions.get("ocr") or {}
    parts = [f"vehicle {_tag(versions.get('vehicle'))}", f"plate {_tag(versions.get('plate'))}"]
    if ocr.get("model_onnx"):
        parts.append(f"ocr custom {_tag(ocr['model_onnx'])}")
    for name, fp in (ocr.get("hub") or {}).items():
        parts.append(f"ocr {name}@{fp['sha256_12']}")
    parts.append(f"calibrator {_tag(versions.get('calibrator'))}")
    reg = versions.get("registry") or {}
    parts.append(
        f"registry {len(reg)} entr{'y' if len(reg) == 1 else 'ies'}"
        + (" (" + ", ".join(f"{n}={ (e or {}).get('version') }" for n, e in reg.items()) + ")" if reg else "")
    )
    return "; ".join(parts)


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.bin")
        with open(p, "wb") as fh:
            fh.write(b"trinetra")
        fp = file_fingerprint(p)
        assert fp == {
            "file": "x.bin",
            "bytes": 8,
            "sha256_12": hashlib.sha256(b"trinetra").hexdigest()[:12],
        }, fp
        assert file_fingerprint(os.path.join(d, "missing")) is None
        here = os.path.dirname(os.path.abspath(__file__))
        v = describe_models(
            os.path.join(here, "models", "yolov8n.pt"),
            os.path.join(here, "models", "best.pt"),
            "cct-s-v2-global-model + cct-xs-v2-global-model",
            os.path.join(here, "models", "calibrator.json"),
            os.path.join(here, "models", "MODEL_REGISTRY.json"),
        )
        print(summary_line(v))
        print(json.dumps(compact(v), indent=1))
    print("model_registry OK")
