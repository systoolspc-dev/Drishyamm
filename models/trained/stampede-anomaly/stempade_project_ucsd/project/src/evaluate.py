"""Stage 3: evaluation, reproducing the paper's Sec. 6 tables and figures.

    python src/evaluate.py --run <run_name>              # four-class, held-out clips
    python src/evaluate.py --run <run_name> --anomaly    # binary, vs UCSD's own GT
    python src/evaluate.py --run <run_name> --latency    # Table 8

Produces the confusion matrix (Fig. 9), one-vs-rest ROC curves (Fig. 10) and
the class-wise report (Table 7) over the held-out UCSD clips.

`--anomaly` is the readout worth trusting most.  Three of the four classes are
derived from a density proxy this project defines, but the `risky` class is
UCSD's own published frame-level annotation.  Collapsing the softmax to
risky-vs-rest and scoring it against that annotation measures the model against
real ground truth, with the Youden's J threshold sweep the paper uses in
Sec. 6.6.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import tensorflow as tf

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (ARTIFACTS, CACHE, CLASSES, NUM_CLASSES, SEQ_LEN,
                    configure_stdout, ensure_dirs, set_seeds)
from sequence import SequenceGenerator, build_index


def _load(run: str):
    d = ARTIFACTS / run
    path = d / "best.keras"
    if not path.exists():
        path = d / "final.keras"
    if not path.exists():
        raise SystemExit(f"no model in {d}")
    return tf.keras.models.load_model(path), d


def _predict(model, index, use_scalars: bool, batch_size: int = 8):
    gen = SequenceGenerator(index, batch_size, shuffle=False, use_scalars=use_scalars)
    probs = model.predict(gen, verbose=1)
    return probs, gen.labels


def _uses_scalars(model) -> bool:
    return any(i.name.startswith("scalars") for i in model.inputs)


def _clip_meta(name: str) -> dict:
    path = CACHE / name / "meta.json"
    return json.loads(path.read_text()) if path.exists() else {}


def in_domain(model, out_dir: Path) -> None:
    from sklearn.metrics import (classification_report, confusion_matrix,
                                 roc_auc_score, roc_curve)

    split = json.loads((out_dir / "split.json").read_text())
    index = build_index(split["val_clips"])
    if not index:
        raise SystemExit("validation clips produced no windows")

    probs, y = _predict(model, index, _uses_scalars(model))
    pred = probs.argmax(1)

    cm = confusion_matrix(y, pred, labels=range(NUM_CLASSES))
    print("\nConfusion matrix (rows = true, cols = predicted)  -- paper Fig. 9")
    print("            " + "".join(f"{c:>10s}" for c in CLASSES))
    for i, row in enumerate(cm):
        print(f"{CLASSES[i]:>11s} " + "".join(f"{v:10d}" for v in row))
    print(f"\ncorrect {int(np.trace(cm))} / {int(cm.sum())}")

    print("\nClass-wise performance -- paper Table 7")
    present = sorted(set(y.tolist()) | set(pred.tolist()))
    print(classification_report(
        y, pred, labels=present,
        target_names=[CLASSES[i] for i in present], digits=3, zero_division=0,
    ))

    aucs = {}
    for i, name in enumerate(CLASSES):
        yi = (y == i).astype(int)
        if yi.min() == yi.max():
            aucs[name] = None
            continue
        aucs[name] = float(roc_auc_score(yi, probs[:, i]))
    print("One-vs-rest ROC AUC -- paper Fig. 10")
    for k, v in aucs.items():
        print(f"  {k:9s} {'n/a (class absent)' if v is None else f'{v:.4f}'}")

    _plot_confusion(cm, out_dir / "confusion_matrix.png")
    _plot_roc(y, probs, out_dir / "roc_curves.png")

    (out_dir / "eval_in_domain.json").write_text(json.dumps(
        {"confusion_matrix": cm.tolist(), "auc": aucs,
         "accuracy": float((pred == y).mean())}, indent=2))


def anomaly(model, out_dir: Path, all_clips: bool = False) -> None:
    """Binary evaluation against UCSD's own annotation -- paper Sec. 6.6 protocol.

    The four-class head is collapsed to risky-vs-rest and scored against the
    frame-level anomaly flags in `Test/<subset>.m`, with the operating point
    picked by Youden's J.  Because `risky` is defined as exactly those flagged
    frames, this measures the model against real published ground truth rather
    than against the density proxy that grades the other three classes.

    Only Test clips carry the annotation, so Train clips are excluded unless
    --all-clips is given (in which case they contribute negatives only).
    """
    from sklearn.metrics import roc_auc_score, roc_curve

    split = json.loads((out_dir / "split.json").read_text())
    clips = split["val_clips"]
    if not all_clips:
        clips = [c for c in clips if _clip_meta(c).get("split") == "Test"]
    if not clips:
        raise SystemExit(
            "No annotated UCSD Test clips in the validation split.\n"
            "Pass --all-clips to score Train clips as negatives instead."
        )

    index = build_index(clips)
    if not index:
        raise SystemExit("the selected clips produced no windows")

    probs, y = _predict(model, index, _uses_scalars(model))

    risky = CLASSES.index("risky")
    score = probs[:, risky]
    y_bin = (y == risky).astype(int)

    if y_bin.min() == y_bin.max():
        raise SystemExit("the selected windows are single-class; cannot compute ROC")

    auc = roc_auc_score(y_bin, score)
    fpr, tpr, thr = roc_curve(y_bin, score)
    best = int(np.argmax(tpr - fpr))
    threshold = float(thr[best])

    pred = (score >= threshold).astype(int)
    tp = int(((pred == 1) & (y_bin == 1)).sum())
    fn = int(((pred == 0) & (y_bin == 1)).sum())
    tn = int(((pred == 0) & (y_bin == 0)).sum())
    fp = int(((pred == 1) & (y_bin == 0)).sum())

    print("\nAnomaly detection vs UCSD ground truth (held-out clips)")
    print(f"  clips             {len(clips)}")
    print(f"  windows           {len(y_bin)}  ({int(y_bin.sum())} abnormal)")
    print(f"  ROC AUC           {auc:.4f}")
    print(f"  Youden's J thresh {threshold:.4f}   (paper: 0.5512)")
    print(f"  recall (abnormal) {tp / max(tp + fn, 1):.3f}   {tp}/{tp + fn}")
    print(f"  recall (normal)   {tn / max(tn + fp, 1):.3f}   {tn}/{tn + fp}")

    (out_dir / "eval_anomaly.json").write_text(json.dumps(
        {"clips": clips, "auc": float(auc), "threshold": threshold,
         "tp": tp, "fn": fn, "tn": tn, "fp": fp}, indent=2))


def latency(model, out_dir: Path, n: int = 20) -> None:
    """End-to-end latency, comparable to paper Table 8.

    Measures flow extraction + descriptors + inference, which is what the paper
    reports (0.173 s per 16-frame window, 12.77 FPS, CPU).
    """
    import cv2

    from features import (compute_scalars, farneback_multichannel,
                          normalize_flow, resize_frame, scalars_to_bits, to_gray)

    # UCSD frames are grayscale, so the synthetic ones are too: replicating one
    # channel keeps the flow stage on the same code path the real pipeline takes.
    rng = np.random.default_rng(0)
    frames = [np.repeat(rng.integers(0, 255, (240, 320, 1), dtype=np.uint8), 3, axis=2)
              for _ in range(SEQ_LEN + 1)]
    use_scalars = _uses_scalars(model)

    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        flows, scal = [], []
        prev_bgr = prev_gray = prev_flow = None
        for f in frames:
            bgr = resize_frame(f)
            gray = to_gray(bgr)
            if prev_bgr is not None:
                fl = farneback_multichannel(prev_bgr, bgr)
                scal.append(compute_scalars(fl, prev_flow, prev_gray, gray))
                flows.append(normalize_flow(fl))
                prev_flow = fl
            prev_bgr, prev_gray = bgr, gray

        x = {"flow": np.asarray(flows, np.float32)[None]}
        if use_scalars:
            x["scalars"] = scalars_to_bits(np.asarray(scal, np.float32))[None]
        model.predict(x, verbose=0)
        times.append(time.perf_counter() - t0)

    per_seq = float(np.mean(times[1:] or times))   # drop the warm-up run
    print("\nInference latency -- paper Table 8")
    print(f"  per {SEQ_LEN}-frame sequence  {per_seq:.3f} s   (paper: 0.173 s)")
    print(f"  per frame                {per_seq / SEQ_LEN:.3f} s   (paper: 0.078 s)")
    print(f"  throughput               {SEQ_LEN / per_seq:.2f} FPS  (paper: 12.77 FPS)")
    (out_dir / "latency.json").write_text(json.dumps(
        {"seconds_per_sequence": per_seq, "fps": SEQ_LEN / per_seq}, indent=2))


def _plot_confusion(cm: np.ndarray, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(5.5, 5))
    ax.imshow(cm, cmap="Blues")
    ax.set_xticks(range(NUM_CLASSES), CLASSES, rotation=45, ha="right")
    ax.set_yticks(range(NUM_CLASSES), CLASSES)
    ax.set_xlabel("predicted")
    ax.set_ylabel("true")
    ax.set_title("Confusion matrix (validation)")
    for i in range(NUM_CLASSES):
        for j in range(NUM_CLASSES):
            ax.text(j, i, int(cm[i, j]), ha="center", va="center",
                    color="white" if cm[i, j] > cm.max() / 2 else "black")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def _plot_roc(y: np.ndarray, probs: np.ndarray, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from sklearn.metrics import roc_auc_score, roc_curve

    fig, ax = plt.subplots(figsize=(5.5, 5))
    for i, name in enumerate(CLASSES):
        yi = (y == i).astype(int)
        if yi.min() == yi.max():
            continue
        fpr, tpr, _ = roc_curve(yi, probs[:, i])
        ax.plot(fpr, tpr, label=f"{name} (AUC {roc_auc_score(yi, probs[:, i]):.4f})")
    ax.plot([0, 1], [0, 1], "k--", lw=0.8)
    ax.set_xlabel("false positive rate")
    ax.set_ylabel("true positive rate")
    ax.set_title("One-vs-rest ROC (validation)")
    ax.legend(loc="lower right", fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, help="run name under artifacts/")
    ap.add_argument("--anomaly", action="store_true",
                    help="binary risky-vs-rest against UCSD's own annotation")
    ap.add_argument("--all-clips", action="store_true",
                    help="--anomaly: include Train clips as negatives")
    ap.add_argument("--latency", action="store_true")
    args = ap.parse_args()

    configure_stdout()
    ensure_dirs()
    set_seeds()
    model, out_dir = _load(args.run)

    if args.anomaly:
        anomaly(model, out_dir, args.all_clips)
    elif args.latency:
        latency(model, out_dir)
    else:
        in_domain(model, out_dir)


if __name__ == "__main__":
    main()
