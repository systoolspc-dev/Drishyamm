"""
run_experiment.py — record a measurement against an experiment in
experiments/registry.yaml, with the provenance that makes it reproducible.

    python run_experiment.py --id Baseline --metrics data/eval/labels_20260902-113000.json [--note "…"] [--seed 42]
    python run_experiment.py --list

A record (data/experiments/<id>_<stamp>.json) holds:
    git commit          `git rev-parse HEAD` when the folder is inside a checkout, else "unknown"
                        (the worker container mounts the folder without .git; run from the host or pass --commit)
    dataset hashes      sha256 of data/train/ocr/train.csv and val.csv when present, and the counts of
                        records / review / labelled / labelled_audit files at that moment
    model fingerprints  sha256 of models/*.pt, models/ocr/model.onnx, models/ocr/plate_config.yaml, models/calibrator.json
    seed                --seed, else the registry entry's seed
    env                 every ANPR_* variable (password masked)
    metrics             the eval JSON copied in whole, its sha256, its `kind`, and the key numbers pulled out
                        (exact match / CER / ECE for labels; exact rates for ablation; hit rate / false plates
                        / fps for e2e; mAP50 for detector)

`--list` prints every registry entry with the latest recorded key metrics; an
experiment with no record shows NOT MEASURED — the registry never carries a
typed-in number.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "experiments", "registry.yaml")
OUT_DIR = os.path.join(HERE, "data", "experiments")
DATA_DIR = os.getenv("ANPR_DATA_DIR", os.path.join(HERE, "data"))


def sha256_file(path: str) -> str | None:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def git_commit(override: str | None = None) -> str:
    if override:
        return override
    try:
        r = subprocess.run(
            ["git", "-C", HERE, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0 and r.stdout.strip():
            dirty = subprocess.run(
                ["git", "-C", HERE, "status", "--porcelain", "--", HERE],
                capture_output=True,
                text=True,
                timeout=10,
            )
            return r.stdout.strip() + ("-dirty" if dirty.stdout.strip() else "")
    except Exception:  # noqa: BLE001
        pass
    return "unknown"


def dataset_hashes() -> dict:
    ocr = os.path.join(DATA_DIR, "train", "ocr")
    d = {
        "train_csv_sha256": sha256_file(os.path.join(ocr, "train.csv")),
        "val_csv_sha256": sha256_file(os.path.join(ocr, "val.csv")),
        "counts": {
            "records_json": len(glob.glob(os.path.join(DATA_DIR, "records", "*", "*", "*.json"))),
            "review_json": len(glob.glob(os.path.join(DATA_DIR, "review", "**", "*.json"), recursive=True)),
            "labelled_crops": len(glob.glob(os.path.join(DATA_DIR, "labelled", "*.jp*g"))),
            "labelled_audit_crops": len(glob.glob(os.path.join(DATA_DIR, "labelled_audit", "*.jp*g"))),
            "train_det_images": len(
                glob.glob(os.path.join(DATA_DIR, "train", "det", "images", "*", "*.jpg"))
            ),
        },
    }
    lab = os.path.join(DATA_DIR, "labelled_audit", "labels.csv")
    if os.path.exists(lab):
        d["labelled_audit_labels_sha256"] = sha256_file(lab)
    return d


def model_fingerprints() -> dict:
    mdir = os.path.join(HERE, "models")
    out = {}
    for p in sorted(glob.glob(os.path.join(mdir, "*.pt"))):
        out[os.path.relpath(p, HERE)] = sha256_file(p)
    for name in ("ocr/model.onnx", "ocr/plate_config.yaml", "calibrator.json"):
        p = os.path.join(mdir, name)
        out[f"models/{name}"] = sha256_file(p) if os.path.exists(p) else None
    ocr_env = os.getenv("ANPR_OCR_MODEL_DIR")
    if ocr_env and os.path.exists(os.path.join(ocr_env, "model.onnx")):
        out[f"{ocr_env}/model.onnx"] = sha256_file(os.path.join(ocr_env, "model.onnx"))
    out["ocr_readers_env"] = os.getenv("ANPR_OCR_READERS", "primary,cct-xs-v2-global-model")
    return out


def env_snapshot() -> dict:
    return {
        k: ("***" if "PASSWORD" in k or "SECRET" in k or "TOKEN" in k else v)
        for k, v in sorted(os.environ.items())
        if k.startswith("ANPR_")
    }


def load_registry(path: str) -> dict:
    try:
        import yaml
    except ImportError:
        sys.exit(
            "PyYAML is needed to read the registry (pip install pyyaml, or run inside the worker container)"
        )
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def key_metrics(m: dict) -> dict:
    """The headline numbers of an eval JSON, by its `kind`."""
    kind = m.get("kind")
    k: dict = {"kind": kind}
    try:
        if kind == "labels":
            h = m["summary"]["human"]
            k.update(
                {
                    "n_human_judged": h["judged"],
                    "exact_match_human": h["accuracy"],
                    "cer_human": h["cer"],
                    "ece_human": (m.get("reliability_human") or {}).get("ece"),
                }
            )
            c = m.get("confusions_human") or {}
            if c.get("n"):
                k["dropped_char_rate"] = c["n_dropped"] / c["n"]
        elif kind == "ablation":
            rows = {r["condition"]: r for r in m.get("table", [])}
            k.update({"n": m.get("n"), "dir": m.get("dir")})
            for c in (
                "none",
                "base",
                "enhanced_best_valid",
                "ensemble",
                "oracle_any_variant",
                "oracle_ensemble",
            ):
                if c in rows:
                    k[f"{c}_exact"] = rows[c]["exact_of_all"]
        elif kind == "e2e":
            s = m.get("summary") or {}
            t = m.get("throughput") or {}
            k.update(
                {
                    "video": os.path.basename(str(m.get("video"))),
                    "mode": m.get("mode"),
                    "e2e_exact_rate": s.get("exact_rate"),
                    "e2e_confirmed_rate": s.get("confirmed_rate"),
                    "e2e_false_plates": s.get("false_plates"),
                    "n_gt": s.get("n_gt"),
                    "effective_fps": t.get("effective_fps"),
                    "posted": len(m.get("posts") or []),
                }
            )
        elif kind == "detector":
            u = m.get("ultralytics") or {}
            op = m.get("operating_point") or {}
            k.update(
                {
                    "independent_gt": m.get("independent_gt"),
                    "detector_map50": u.get("map50"),
                    "detector_map50_95": u.get("map50_95"),
                    "recall_lt20px": ((op.get("buckets") or {}).get("<20px") or {}).get("recall"),
                    "fp_per_image": op.get("fp_per_image"),
                }
            )
    except (KeyError, TypeError):
        k["warning"] = "unrecognised metrics layout"
    return k


def record(args) -> str:
    reg = load_registry(args.registry)
    entries = {e["id"]: e for e in reg.get("experiments", [])}
    if args.id not in entries:
        sys.exit(f"unknown experiment id {args.id!r}; registry has: {', '.join(entries)}")
    entry = entries[args.id]
    if not os.path.exists(args.metrics):
        sys.exit(f"metrics file not found: {args.metrics}")
    with open(args.metrics, encoding="utf-8") as f:
        metrics = json.load(f)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rec = {
        "id": args.id,
        "title": entry.get("title"),
        "stamp": stamp,
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "note": args.note,
        "git_commit": git_commit(args.commit),
        "seed": args.seed if args.seed is not None else entry.get("seed"),
        "registry_entry": entry,
        "dataset": dataset_hashes(),
        "models": model_fingerprints(),
        "env": env_snapshot(),
        "metrics_file": os.path.abspath(args.metrics),
        "metrics_sha256": sha256_file(args.metrics),
        "metrics_kind": metrics.get("kind"),
        "key_metrics": key_metrics(metrics),
        "metrics": metrics,
    }
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"{args.id}_{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=1, ensure_ascii=False, default=str)
    print(
        f"recorded {args.id} ← {args.metrics} ({rec['metrics_kind']})  commit {rec['git_commit']}  seed {rec['seed']}"
    )
    print(
        "  dataset:",
        json.dumps(rec["dataset"]["counts"]),
        "train.csv",
        (rec["dataset"]["train_csv_sha256"] or "absent")[:12],
    )
    print(
        "  models :",
        ", ".join(f"{k}={(v or 'absent')[:12]}" for k, v in rec["models"].items() if k != "ocr_readers_env"),
    )
    print("  key    :", json.dumps(rec["key_metrics"], default=str))
    print(f"  → {path}")
    return path


def latest_records(out_dir: str) -> dict[str, list[dict]]:
    by_id: dict[str, list[dict]] = {}
    for p in sorted(glob.glob(os.path.join(out_dir, "*.json"))):
        try:
            with open(p, encoding="utf-8") as f:
                r = json.load(f)
            by_id.setdefault(r.get("id", "?"), []).append(
                {
                    "path": p,
                    "stamp": r.get("stamp"),
                    "kind": r.get("metrics_kind"),
                    "key": r.get("key_metrics") or {},
                    "commit": r.get("git_commit"),
                }
            )
        except Exception:  # noqa: BLE001
            continue
    return by_id


# registry metric name → the key_metrics field that measures it (same name when absent here)
ALIASES = {
    "ablation_best_valid_exact": "enhanced_best_valid_exact",
    "ablation_ensemble_exact": "ensemble_exact",
    "exact_11char": "exact_11char",
    "fp_per_negative_image": "fp_per_image",
}


def list_table(args) -> None:
    reg = load_registry(args.registry)
    recs = latest_records(args.out)
    print(f"experiment registry {args.registry}  (records in {args.out})\n")
    for e in reg.get("experiments", []):
        rs = recs.get(e["id"], [])
        print(f"{e['id']:<9} {e.get('title', '')}")
        print(f"          status: {e.get('status', '?')}   seed: {e.get('seed')}   records: {len(rs)}")
        for k, v in (e.get("metrics") or {}).items():
            field = ALIASES.get(k, k)
            hits = [r for r in rs if r["key"].get(field) is not None]
            if not hits:
                print(f"          {k:<32} {v}")
                continue
            for r in hits[-2:]:  # the latest one or two records that carry it
                val = r["key"][field]
                where = (
                    f" {r['key']['dir']}"
                    if r["key"].get("dir")
                    else (f" {r['key']['video']}" if r["key"].get("video") else "")
                )
                print(
                    f"          {k:<32} {val:.3f}" if isinstance(val, float) else f"          {k:<32} {val}",
                    f"  [{r['kind']} {r['stamp']}{where}, commit {str(r['commit'])[:12]}]",
                )
        for r in rs:
            km = {k: v for k, v in r["key"].items() if k not in ("kind", "dir", "video")}
            vals = ", ".join(f"{k}={v:.3f}" if isinstance(v, float) else f"{k}={v}" for k, v in km.items())
            print(f"          · {r['kind']:<9} {r['stamp']}  {vals}")
        print()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id", help="experiment id from the registry")
    ap.add_argument("--metrics", help="an eval JSON from data/eval/")
    ap.add_argument("--note", default="")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument(
        "--commit",
        default=os.getenv("ANPR_GIT_COMMIT"),
        help="git commit when git is not available (e.g. inside the container)",
    )
    ap.add_argument("--registry", default=REGISTRY)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        list_table(args)
        return
    if not (args.id and args.metrics):
        ap.error("--id and --metrics are required unless --list")
    record(args)


if __name__ == "__main__":
    main()
