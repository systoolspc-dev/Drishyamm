"""Stage 2: train the CNN-LSTM on the preprocessed UCSD cache.

    python src/train.py
    python src/train.py --no-scalars          # ablation (ii)
    python src/train.py --arch 3dcnn          # ablation (iii)

Training configuration follows paper Table 3 and Sec. 6.1: Adam @ 1e-3,
batch 8 sequences, categorical cross-entropy, 40 epochs, early stopping on
validation accuracy with patience 10 and best-weight restore.

Both the training and validation sets come from UCSD; whole clips are held out
for validation, stratified across subsets and Train/Test splits so the
validation set always contains anomaly-carrying (`risky`) clips.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import tensorflow as tf

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (ARTIFACTS, BATCH_SIZE, CACHE, CLASSES,
                    EARLY_STOPPING_MONITOR, EARLY_STOPPING_PATIENCE, EPOCHS,
                    LEARNING_RATE, SEED, VAL_FRACTION, configure_stdout,
                    ensure_dirs, set_seeds)
from model import build_baseline_3dcnn, build_model, compile_model
from sequence import (SequenceGenerator, build_index, clip_stratum,
                      list_cached_clips, split_by_clip)


def training_clips(cache_dir: Path = CACHE) -> list[str]:
    """Every cached UCSD clip.  UCSD is this project's only data source."""
    return [n for n in list_cached_clips(cache_dir) if n.startswith("ucsd__")]


def enable_gpu_memory_growth() -> None:
    """Paper Sec. 5.1: dynamic GPU allocation to avoid OOM."""
    for gpu in tf.config.list_physical_devices("GPU"):
        try:
            tf.config.experimental.set_memory_growth(gpu, True)
        except RuntimeError:
            pass


def report_devices(require_gpu: bool) -> None:
    """Print the compute device, and refuse to start on CPU when told to.

    TensorFlow falls back to CPU silently, and this model is ~40x slower there,
    so a fallback that goes unnoticed costs a day.  Worse, "a GPU is listed" is
    not the same as "a GPU can run kernels": on an architecture newer than the
    CUDA kernels in the installed wheel, TF enumerates the device happily and
    then fails on the first launch.  So --require-gpu actually executes an op
    and checks the result, rather than trusting the device list.
    """
    gpus = tf.config.list_physical_devices("GPU")
    print(f"devices: {len(gpus)} GPU(s) visible" + (f" -> {gpus}" if gpus else ""))
    for g in gpus:
        try:
            d = tf.config.experimental.get_device_details(g)
            print(f"  {d.get('device_name', '?')}, compute capability "
                  f"{d.get('compute_capability', '?')}")
        except Exception:
            pass

    if not require_gpu:
        if not gpus:
            print("  running on CPU (pass --require-gpu to make this an error)")
        return

    if not gpus:
        raise SystemExit(
            "--require-gpu was given but TensorFlow sees no GPU.\n"
            f"  tf.__version__ = {tf.__version__}, built with CUDA = "
            f"{tf.test.is_built_with_cuda()}\n"
            "On native Windows this is expected: TensorFlow dropped Windows CUDA\n"
            "support after 2.10.  Run under WSL2 with tensorflow[and-cuda]."
        )

    try:
        with tf.device("/GPU:0"):
            probe = tf.reduce_sum(tf.random.normal((512, 512)) @ tf.random.normal((512, 512)))
            ok = bool(np.isfinite(float(probe.numpy())))
    except Exception as e:
        raise SystemExit(
            f"--require-gpu was given and a GPU is visible, but it cannot run "
            f"kernels:\n  {type(e).__name__}: {str(e)[:300]}\n"
            "This usually means the installed TensorFlow's CUDA kernels predate "
            "your GPU's\narchitecture.  Install a TensorFlow built against a "
            "newer CUDA toolkit."
        ) from e
    if not ok:
        raise SystemExit("--require-gpu: GPU probe returned a non-finite result.")
    print("  GPU probe OK (matmul executed on /GPU:0)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    ap.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    ap.add_argument("--lr", type=float, default=LEARNING_RATE)
    ap.add_argument("--val-fraction", type=float, default=VAL_FRACTION)
    ap.add_argument("--no-scalars", action="store_true",
                    help="ablation (ii): drop the scalar descriptor branch")
    ap.add_argument("--arch", default="cnn_lstm", choices=["cnn_lstm", "3dcnn"])
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--run-name", default=None)
    ap.add_argument("--loader-workers", type=int, default=0,
                    help="parallel batch-loading workers; 0 = load in-process. "
                         "Each batch is ~13 MB of flow read from the memmaps, so "
                         "on a fast GPU the loader, not the model, is the limit.")
    ap.add_argument("--max-queue-size", type=int, default=10,
                    help="batches prefetched ahead of the model")
    ap.add_argument("--require-gpu", action="store_true",
                    help="refuse to start unless a GPU is present AND can run "
                         "kernels; prevents a silent ~40x-slower CPU fallback")
    args = ap.parse_args()

    configure_stdout()
    ensure_dirs()
    set_seeds(args.seed)
    enable_gpu_memory_growth()
    report_devices(args.require_gpu)

    use_scalars = not args.no_scalars and args.arch == "cnn_lstm"
    run = args.run_name or f"{args.arch}{'' if use_scalars else '_noscalar'}_{datetime.now():%Y%m%d_%H%M%S}"
    out = ARTIFACTS / run
    out.mkdir(parents=True, exist_ok=True)

    clips = training_clips()
    if not clips:
        raise SystemExit(
            "No UCSD clips in cache. Run:\n"
            "  python src/preprocess.py"
        )

    train_clips, val_clips = split_by_clip(clips, args.val_fraction, args.seed)
    print(f"clips: {len(train_clips)} train / {len(val_clips)} val "
          "(split by clip and stratified by subset/split, never by window)")
    for label, names in (("train", train_clips), ("val", val_clips)):
        strata: dict[str, int] = {}
        for n in names:
            strata[clip_stratum(n)] = strata.get(clip_stratum(n), 0) + 1
        print(f"  {label:5s} " + "  ".join(f"{k}={v}" for k, v in sorted(strata.items())))
    print(f"  val clips: {val_clips}")

    train_idx = build_index(train_clips)
    val_idx = build_index(val_clips)
    print(f"windows: {len(train_idx)} train / {len(val_idx)} val")

    for split, idx in (("train", train_idx), ("val", val_idx)):
        counts = np.bincount([l for _, _, l in idx], minlength=len(CLASSES))
        print(f"  {split:5s} " + "  ".join(f"{c}={n}" for c, n in zip(CLASSES, counts)))

    if not val_idx:
        raise SystemExit("Validation split is empty; lower --val-fraction or cache more clips.")

    # Keras 3 takes these on the PyDataset itself, not on fit().
    loader = {}
    if args.loader_workers > 0:
        loader = dict(workers=args.loader_workers, use_multiprocessing=True,
                      max_queue_size=args.max_queue_size)
        print(f"loader: {args.loader_workers} workers, "
              f"queue {args.max_queue_size}")

    train_gen = SequenceGenerator(train_idx, args.batch_size, shuffle=True,
                                  use_scalars=use_scalars, seed=args.seed, **loader)
    val_gen = SequenceGenerator(val_idx, args.batch_size, shuffle=False,
                                use_scalars=use_scalars, seed=args.seed, **loader)

    model = build_baseline_3dcnn() if args.arch == "3dcnn" else build_model(use_scalars=use_scalars)
    compile_model(model, args.lr)
    model.summary()

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor=EARLY_STOPPING_MONITOR,
            patience=EARLY_STOPPING_PATIENCE,
            restore_best_weights=True,
            verbose=1,
        ),
        tf.keras.callbacks.ModelCheckpoint(
            filepath=str(out / "best.keras"),
            monitor=EARLY_STOPPING_MONITOR,
            save_best_only=True,
            verbose=1,
        ),
        tf.keras.callbacks.CSVLogger(str(out / "history.csv")),
    ]

    history = model.fit(
        train_gen,
        validation_data=val_gen,
        epochs=args.epochs,
        callbacks=callbacks,
        verbose=1,
    )

    model.save(out / "final.keras")
    hist = {k: [float(x) for x in v] for k, v in history.history.items()}
    (out / "history.json").write_text(json.dumps(hist, indent=2))
    (out / "split.json").write_text(json.dumps(
        {"train_clips": train_clips, "val_clips": val_clips}, indent=2))

    best_epoch = int(np.argmax(hist.get("val_accuracy", [0]))) + 1
    print(f"\nbest epoch: {best_epoch}")
    print(f"  val_accuracy {max(hist.get('val_accuracy', [0])):.4f}")
    print(f"artifacts -> {out}")
    print(f"\nnext:  python src/evaluate.py --run {run}")


if __name__ == "__main__":
    main()
