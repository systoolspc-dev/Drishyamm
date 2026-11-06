"""
train_ocr.py — fine-tune the plate recogniser on OUR crops. Step 2 of the loop.

Starts from fast-plate-ocr's pretrained `cct_s_v2_global.keras` (10 slots,
64×128 RGB — the same model the worker runs), continues training on
data/train/ocr (from export_labels.py), exports ONNX, and PROMOTES the new
model to models/ocr/ only if it beats the base model on the held-out val
crops — "measured, not vibes". The worker picks models/ocr/model.onnx up on
its next restart (ANPR_OCR_MODEL_DIR).

Needs the training extras (Keras 3 + TensorFlow ≈ 600 MB, one-off):
    pip install "fast-plate-ocr[train]"          # or: python train_ocr.py --install
Run inside the worker image (GPU), e.g.
    docker run --rm --gpus all -v "$PWD/trinetra-ai/app/anpr_worker:/srv/anpr" -w /srv/anpr \
        trinetra/anpr-worker:latest python train_ocr.py --install --epochs 30

Why a small learning rate + few epochs: we have hundreds of crops, the base
saw millions; we want it to learn Indian fonts, HSRP layouts and our cameras'
degradations without forgetting how to read plates in general.
"""

from __future__ import annotations

import argparse
import csv
import glob
import os
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

RELEASE = "https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates"
BASES = {
    "cct-s-v2": (
        "cct_s_v2_global.keras",
        "cct_s_v2_global_model_config.yaml",
        "cct_s_v2_global_plate_config.yaml",
    ),
    "cct-xs-v2": (
        "cct_xs_v2_global.keras",
        "cct_xs_v2_global_model_config.yaml",
        "cct_xs_v2_global_plate_config.yaml",
    ),
}


def download(url: str, dst: str):
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return dst
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    print(f"[train] downloading {os.path.basename(dst)} …")
    urllib.request.urlretrieve(url, dst)
    return dst


def count_rows(csv_path: str) -> int:
    with open(csv_path, newline="", encoding="utf-8") as f:
        return sum(1 for _ in csv.DictReader(f))


def evaluate(onnx_path: str | None, plate_cfg: str | None, hub: str | None, val_csv: str):
    """→ (exact-match acc, char acc, per-scenario {scenario: (ok, n)}) on the val CSV.
    Scenarios come from val_meta.json (written by export_labels.py) so a
    model that improves overall but regresses at night can be refused."""
    import json
    import cv2
    from fast_plate_ocr import LicensePlateRecognizer

    m = (
        LicensePlateRecognizer(hub)
        if hub
        else LicensePlateRecognizer(onnx_model_path=onnx_path, plate_config_path=plate_cfg)
    )
    mode = str(getattr(m.config, "image_color_mode", "rgb")).lower()
    base = os.path.dirname(val_csv)
    try:
        scen = json.load(open(os.path.join(base, "val_meta.json"), encoding="utf-8"))
    except Exception:  # noqa: BLE001
        scen = {}
    n = ok = 0
    char_ok = char_n = 0
    per: dict[str, list[int]] = {}
    with open(val_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            img = cv2.imread(os.path.join(base, row["image_path"]))
            if img is None:
                continue
            x = (
                cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                if mode.startswith("gray")
                else cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            )
            pred = m.run(x)[0]
            text = "".join(ch for ch in str(getattr(pred, "plate", pred)).upper() if ch.isalnum())
            truth = row["plate_text"]
            hit = text == truth
            n += 1
            ok += hit
            s = scen.get(row["image_path"], "unknown")
            per.setdefault(s, [0, 0])
            per[s][0] += hit
            per[s][1] += 1
            for a, b in zip(text.ljust(len(truth), "_"), truth):
                char_n += 1
                char_ok += a == b
    return (
        (ok / n if n else 0.0),
        (char_ok / char_n if char_n else 0.0),
        {k: (v[0], v[1]) for k, v in per.items()},
    )


def scenario_regression(base_per: dict, new_per: dict, min_n: int = 5, tol: float = 0.05) -> list[str]:
    """Scenarios (with ≥ min_n val samples) where the new model is worse by > tol."""
    bad = []
    for s, (bok, bn) in base_per.items():
        nok, nn = new_per.get(s, (0, 0))
        if bn >= min_n and nn >= min_n and (nok / nn) < (bok / bn) - tol:
            bad.append(f"{s}: {bok / bn:.2f} → {nok / nn:.2f}")
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data", "train", "ocr"))
    ap.add_argument("--base", choices=list(BASES), default="cct-s-v2")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--min-samples", type=int, default=40)
    ap.add_argument("--out", default=os.path.join(HERE, "models", "ocr"))
    ap.add_argument("--work", default=os.path.join(HERE, "data", "train", "ocr_runs"))
    ap.add_argument("--backend", default=os.getenv("KERAS_BACKEND", "tensorflow"))
    ap.add_argument("--install", action="store_true", help="pip install the training extras first")
    ap.add_argument("--force", action="store_true", help="promote even if val accuracy did not improve")
    ap.add_argument(
        "--min-val",
        type=int,
        default=int(os.getenv("ANPR_TRAIN_MIN_VAL", "20")),
        help="officer-checked val crops required before ANY promotion (below this, train and report only)",
    )
    args = ap.parse_args()

    train_csv, val_csv = os.path.join(args.data, "train.csv"), os.path.join(args.data, "val.csv")
    if not os.path.exists(train_csv):
        sys.exit(f"[train] no {train_csv} — run export_labels.py first")
    n_train, n_val = count_rows(train_csv), count_rows(val_csv)
    print(f"[train] {n_train} train / {n_val} val crops")
    if n_train < args.min_samples:
        sys.exit(f"[train] only {n_train} training crops (< {args.min_samples}) — label more reads first")

    if args.install:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--no-cache-dir", "fast-plate-ocr[train]"]
        )

    keras_f, model_cfg, plate_cfg = BASES[args.base]
    base_dir = os.path.join(HERE, "models", "ocr_base")
    keras_path = download(f"{RELEASE}/{keras_f}", os.path.join(base_dir, keras_f))
    model_cfg_path = download(f"{RELEASE}/{model_cfg}", os.path.join(base_dir, model_cfg))
    plate_cfg_path = download(f"{RELEASE}/{plate_cfg}", os.path.join(base_dir, plate_cfg))

    run_dir = os.path.join(args.work, time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(run_dir, exist_ok=True)
    env = {**os.environ, "KERAS_BACKEND": args.backend}
    # NOTE: `python -m fast_plate_ocr.cli.cli` imports the Click group and
    # exits 0 without running anything (no __main__ guard) — use the console
    # script the package installs (next to this interpreter).
    exe = shutil.which("fast-plate-ocr") or os.path.join(os.path.dirname(sys.executable), "fast-plate-ocr")
    if not os.path.exists(exe):
        sys.exit(
            "[train] fast-plate-ocr console script not found — pip install 'fast-plate-ocr[train]' (or --install)"
        )
    CLI = [exe]
    cmd = CLI + [
        "train",
        "--model-config-file",
        model_cfg_path,
        "--plate-config-file",
        plate_cfg_path,
        "--annotations",
        train_csv,
        "--val-annotations",
        val_csv,
        "--weights-path",
        keras_path,
        "--epochs",
        str(args.epochs),
        "--batch-size",
        str(min(args.batch, max(2, n_train // 2))),
        "--lr",
        str(args.lr),
        "--warmup-fraction",
        "0.1",
        "--early-stopping-patience",
        "10",
        "--validate-dataset",
        "warn",
        "--output-dir",
        run_dir,
    ]
    print("[train]", " ".join(cmd))
    subprocess.check_call(cmd, env=env)

    # the trainer writes <output-dir>/<timestamp>/{best,last}.keras — take best
    ckpts = sorted(
        glob.glob(os.path.join(run_dir, "**", "best.keras"), recursive=True), key=os.path.getmtime
    ) or sorted(glob.glob(os.path.join(run_dir, "**", "*.keras"), recursive=True), key=os.path.getmtime)
    if not ckpts:
        sys.exit(f"[train] no .keras checkpoint written under {run_dir}")
    best = ckpts[-1]
    print(f"[train] checkpoint: {best}")

    exp_dir = os.path.join(run_dir, "export")
    os.makedirs(exp_dir, exist_ok=True)
    cmd = CLI + [
        "export",
        "--model",
        best,
        "--plate-config-file",
        plate_cfg_path,
        "--format",
        "onnx",
        "--save-dir",
        exp_dir,
    ]
    print("[train]", " ".join(cmd))
    subprocess.check_call(cmd, env=env)
    onnx = sorted(glob.glob(os.path.join(exp_dir, "*.onnx")), key=os.path.getmtime)
    if not onnx:
        sys.exit("[train] export produced no .onnx")
    onnx = onnx[-1]

    hub_name = {"cct-s-v2": "cct-s-v2-global-model", "cct-xs-v2": "cct-xs-v2-global-model"}[args.base]
    # The baseline is the model that is actually RUNNING, not the stock hub
    # model (10 Sep 2026). Until now every fine-tune was scored against the
    # stock cct-s-v2, which reads these crops at ~9 %, so any run that cleared
    # that bar was promoted — including one worse than the fine-tune already
    # deployed. Once a fine-tune exists in --out, it is the bar to beat.
    deployed_onnx = os.path.join(args.out, "model.onnx")
    deployed_cfg = os.path.join(args.out, "plate_config.yaml")
    if os.path.exists(deployed_onnx) and os.path.exists(deployed_cfg):
        base_acc, base_char, base_per = evaluate(deployed_onnx, deployed_cfg, None, val_csv)
        base_label = f"deployed {deployed_onnx}"
    else:
        base_acc, base_char, base_per = evaluate(None, None, hub_name, val_csv)
        base_label = f"stock {hub_name}"
    new_acc, new_char, new_per = evaluate(onnx, plate_cfg_path, None, val_csv)
    print(f"[train] baseline: {base_label}")
    print(
        f"[train] VAL exact-match: base {base_acc:.3f} → fine-tuned {new_acc:.3f}   char acc: {base_char:.3f} → {new_char:.3f}"
    )
    for s in sorted(set(base_per) | set(new_per)):
        bo, bn = base_per.get(s, (0, 0))
        no, nn = new_per.get(s, (0, 0))
        print(
            f"[train]   scenario {s:12s} n={nn:3d}  base {bo / bn if bn else 0:.2f} → new {no / nn if nn else 0:.2f}"
        )
    regress = scenario_regression(base_per, new_per)
    # A val set of a handful of officer-checked crops cannot decide anything:
    # with n=3 a single crop moves exact-match by 0.33, so "better" is noise and
    # a worse reader could ship. Deploying a bad model is the one failure this
    # loop must never have — so below MIN_VAL we train and report, never promote.
    min_val = args.min_val
    if n_val < min_val and not args.force:
        print(
            f"[train] NOT promoted — only {n_val} officer-checked val crop(s); "
            f"need ≥ {min_val} for the comparison to mean anything "
            f"(base {base_acc:.3f} → fine-tuned {new_acc:.3f} on {n_val}). "
            f"Check reads in the console: every ✓/✗ grows this set."
        )
        return
    promote = (
        args.force or ((new_acc > base_acc) or (new_acc == base_acc and new_char > base_char)) and not regress
    )
    if not promote:
        why = f"regressed on {regress}" if regress else "no overall improvement"
        print(
            f"[train] NOT promoted — {why} (kept under {exp_dir}); label more reads, esp. the ones it gets wrong"
        )
        return
    os.makedirs(args.out, exist_ok=True)
    shutil.copyfile(onnx, os.path.join(args.out, "model.onnx"))
    shutil.copyfile(plate_cfg_path, os.path.join(args.out, "plate_config.yaml"))
    with open(os.path.join(args.out, "MODEL_CARD.txt"), "w") as f:
        f.write(
            f"fine-tuned {args.base} on {n_train} train / {n_val} val crops at {time.ctime()}\n"
            f"val exact-match {base_acc:.3f} -> {new_acc:.3f}, char {base_char:.3f} -> {new_char:.3f}\n"
            f"run: {run_dir}\n"
        )
    print(f"[train] PROMOTED → {args.out}/model.onnx  (restart anpr-worker to use it)")


if __name__ == "__main__":
    main()
