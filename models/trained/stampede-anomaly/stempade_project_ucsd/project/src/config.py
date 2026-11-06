"""Central configuration for the stampede-detection pipeline.

This project is configured to use the **UCSD Anomaly Detection Dataset as its
only data source** — training, validation and evaluation all come from UCSD.

Every value that the paper states explicitly is marked  [paper]  and cited to the
section/table it comes from.  Values the paper leaves unspecified are marked
[gap] and carry the default this implementation chose.  Values that had to be
re-derived when the project moved to UCSD-only are marked [ucsd] and cite the
measurement they came from.  See ../pipeline.md and ../TRAINING.md.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DATASETS = ROOT / "datasets"

UCSD_ROOT = DATASETS / "ucsd" / "UCSD_Anomaly_Dataset.v1p2"
# Both pedestrian subsets are used.  They are two different fixed cameras on
# two different walkways; 98 clips and 18,560 frames in total.
UCSD_SUBSETS = ("UCSDped1", "UCSDped2")
# Train clips are all-normal by construction (UCSD README); Test clips carry the
# frame-level anomaly annotation in Test/<subset>.m.
UCSD_SPLITS = ("Train", "Test")

# Preprocessed flow / scalars / labels, and checkpoints / curves / reports.
# Both are overridable by environment variable so the code can stay on one
# filesystem while the data sits on another.  That matters when training under
# WSL against a checkout on /mnt/c: the flow cache is read as thousands of
# memmapped windows per epoch, and going over the 9p bridge for those starves
# the GPU, so the cache belongs on the Linux filesystem while the source tree
# does not have to move.
CACHE = Path(os.environ.get("STAMPEDE_CACHE") or ROOT / "cache")
ARTIFACTS = Path(os.environ.get("STAMPEDE_ARTIFACTS") or ROOT / "artifacts")

# --------------------------------------------------------------------------
# Frame preprocessing                                          [paper] Sec. 4.1
# --------------------------------------------------------------------------
FRAME_H = 224
FRAME_W = 224
RESIZE_INTERP = "bilinear"          # [paper] Sec. 4.1
# Luminosity grayscale, used for the SSIM scene-change feature and for the
# background model behind the density proxy.
GRAY_WEIGHTS = (0.299, 0.587, 0.114)   # [paper] Sec. 4.1  Y = .299R+.587G+.114B

# --------------------------------------------------------------------------
# Farneback dense optical flow
# --------------------------------------------------------------------------
# [gap] The paper names the algorithm (ref. 25) but gives no parameters.
# These are the OpenCV defaults.
FARNEBACK = dict(
    pyr_scale=0.5,
    levels=3,
    winsize=15,
    iterations=3,
    poly_n=5,
    poly_sigma=1.2,
    flags=0,
)

# --------------------------------------------------------------------------
# Scalar feature quantization                                  [paper] Sec. 4.5
# --------------------------------------------------------------------------
# Order is fixed everywhere: acceleration, divergence, scene_change, entropy.
SCALAR_NAMES = ("acceleration", "divergence", "scene_change", "entropy")
SCALAR_RANGES_PAPER = ((0.0, 1.0), (0.0, 1.0), (0.0, 1.0), (0.0, 4.0))  # [paper] Sec. 5
SCALAR_RANGES = SCALAR_RANGES_PAPER   # default; overridden by calibration below

# [ucsd] Measured over all 18,462 UCSD flow frames, the four descriptors occupy
# these p1-p99 ranges (at FLOW_CLIP = 3.0):
#   acceleration 0.065-0.232   divergence 0.089-0.292
#   scene_change 0.001-0.029   entropy    1.08-2.80
# so the paper's stated ranges spend most of the 8-bit budget on values that
# never occur -- and its [0, 4] entropy range would put every real frame in the
# bottom two thirds of the scale.  Calibration rescales each feature to its
# empirical [p1, p99] across the corpus; set to False to use the paper's ranges.
CALIBRATE_SCALARS = True
CALIBRATION_PERCENTILES = (1.0, 99.0)
SCALAR_RANGES_FILE = CACHE / "scalar_ranges.json"

ENTROPY_BINS = 32                    # [paper] Sec. 4.4
SOBEL_KSIZE = 3                      # [paper] Sec. 4.2 (eq. 6)
SSIM_K1, SSIM_K2 = 0.01, 0.03        # [gap] standard SSIM constants
SSIM_L = 1.0                         # dynamic range; frames are normalised to [0,1]
SCALAR_BITS = 8                      # [paper] -> 4 features x 8 bits = 32-bit vector

# --------------------------------------------------------------------------
# Sequence assembly                                            [paper] Sec. 4.6
# --------------------------------------------------------------------------
SEQ_LEN = 16                         # [paper] T = 16
SEQ_OVERLAP = 12                     # [paper] 12-frame overlap
SEQ_STRIDE = SEQ_LEN - SEQ_OVERLAP   # -> 4
# How a 16-frame window inherits a class from its frames.
#   "max"  - highest risk class present.  Safety-correct: a window containing
#            the onset of a crush is a risky window.  Skews the window-level
#            balance upward relative to the frame-level balance.
#   "mode" - most common class.  Preserves the frame-level balance, but can
#            average away an onset that occupies a minority of the window.
# [gap] The paper never says how it labelled a sequence given per-frame labels.
WINDOW_LABEL = "max"

FLOW_NORM_RANGE = (-1.0, 1.0)        # [paper] Sec. 5.1
# Flow components are clipped to +/- this many px/frame before scaling to
# [-1, 1].  [gap] The paper states the target range but not the scale factor.
# [ucsd] Measured over 234 UCSD flow fields, per-pixel flow magnitude has a
# median of 0.048 px/frame, a 99th percentile of 1.47 and a 99.9th of 2.92.
# FLOW_CLIP also sets the motion-entropy histogram span, so it was chosen by
# sweeping both criteria at once:
#   clip 1.5 -> entropy spread 1.45, 0.97% of pixels clipped
#   clip 2.0 -> entropy spread 1.54, 0.49% clipped
#   clip 3.0 -> entropy spread 1.56, 0.10% clipped   <- best on both axes
#   clip 4.0 -> entropy spread 1.52, 0.03% clipped
#   clip 20  -> entropy spread 0.78 and a median of 0.39 bits: a dead input,
#               which is what the paper's stated [0, 4] entropy range implies.
FLOW_CLIP = 3.0

# --------------------------------------------------------------------------
# Classes                                                      [paper] Sec. 4.1
# --------------------------------------------------------------------------
CLASSES = ("normal", "moderate", "dense", "risky")
NUM_CLASSES = len(CLASSES)

# --------------------------------------------------------------------------
# Label derivation from UCSD
# --------------------------------------------------------------------------
# [divergence from paper] The paper hand-annotated 10,000 frames into four
# density classes; that annotation was never published.  UCSD ships only a
# binary normal/anomalous frame annotation, so the four classes are rebuilt from
# UCSD alone by two rules:
#
#   risky                      <- frames flagged anomalous in Test/<subset>.m
#   normal / moderate / dense  <- tertiles of a per-frame crowd-density proxy,
#                                 over every frame NOT flagged anomalous
#
# See src/ucsd_labels.py for the derivation and TRAINING.md "Labels" for why.

# Background model: per-pixel median over every BG_SAMPLE_STRIDE-th frame of the
# subset's Train clips.  Train is all-normal and covers the empty walkway, and
# the camera is fixed, so the median is a clean background plate.  Built per
# subset, since Ped1 and Ped2 are different cameras.
BG_SAMPLE_STRIDE = 10

# Foreground = |frame - background| above this, on the [0, 1] grayscale scale.
# [ucsd] 20/255 sits above the sensor-noise floor (the median |I - bg| over
# background pixels is 3/255) and below pedestrian contrast; verified by
# rendering masks, which resolve individual pedestrians and merge only in
# genuinely dense groups.
FG_THRESHOLD = 20.0 / 255.0
FG_OPEN_KSIZE = 3            # morphological open, kills single-pixel speckle
OCCUPANCY_SMOOTH = 5         # temporal median filter over the occupancy series

# Tertile cuts on the corpus-wide occupancy of non-anomalous frames -> the three
# density grades.  Quantile cuts rather than absolute occupancy values because
# occupancy is not comparable across cameras in absolute terms; this reproduces
# the paper's roughly-balanced class distribution by construction.
DENSITY_QUANTILES = (1.0 / 3.0, 2.0 / 3.0)

# --------------------------------------------------------------------------
# Model                                                    [paper] Tables 1 & 2
# --------------------------------------------------------------------------
CNN_FILTERS = (32, 64, 128)          # [paper] Table 1
LSTM_UNITS = (256, 128)              # [paper] Table 2
DROPOUT = 0.3                        # [paper] Table 2
DENSE_UNITS = 64                     # [paper] Table 2
# [gap - required fix] Table 1 flattens to 100,352 and feeds the LSTM directly,
# which is ~103M parameters in LSTM-1 alone and cannot train on the reported
# hardware.  A projection layer is inserted after Flatten.  Set to 0 to
# reproduce the literal paper spec (expect OOM).
CNN_BOTTLENECK = 256

# --------------------------------------------------------------------------
# Training                                                     [paper] Table 3
# --------------------------------------------------------------------------
BATCH_SIZE = 8                       # [paper] Table 3 (8 sequences)
LEARNING_RATE = 1e-3                 # [paper] Table 3 (Adam)
LOSS = "categorical_crossentropy"    # [paper] Table 3
EPOCHS = 40                          # [paper] Table 5
EARLY_STOPPING_PATIENCE = 10         # [paper] Sec. 6.1
EARLY_STOPPING_MONITOR = "val_accuracy"
SEED = 42                            # [paper] "fixed random seed", value unstated

# Validation split is done by CLIP, never by random window: consecutive windows
# overlap by 12 of 16 frames, so a random split leaks between train and val.
# [gap] The paper does not state its split policy.
VAL_FRACTION = 0.2

# --------------------------------------------------------------------------
# Corpus size
# --------------------------------------------------------------------------
# [paper] trained on 10,000 frames.  UCSD yields 18,462 flow frames from its
# 18,560 frames (one frame is consumed per clip to start the flow series), and
# all of them are used by default: 0 means "every available frame".  Set a
# positive value to subsample down to the paper's corpus size, at roughly
# 196 KB of flow cache per frame (~3.5 GB for the full corpus).
FRAME_BUDGET = 0


def ensure_dirs() -> None:
    for d in (CACHE, ARTIFACTS):
        d.mkdir(parents=True, exist_ok=True)


def configure_stdout() -> None:
    """Make stdout UTF-8 safe.

    Keras 3's progress bar draws with Unicode box characters.  On Windows a
    redirected stdout defaults to cp1252, so `python src/train.py > log.txt`
    dies inside model.fit with a UnicodeEncodeError partway through epoch 1 --
    after the epoch's compute, which is the expensive part.  Reconfiguring to
    UTF-8 with replacement costs nothing and makes logging to a file work.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def set_seeds(seed: int = SEED) -> None:
    import random

    import numpy as np

    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    try:
        import tensorflow as tf

        tf.random.set_seed(seed)
    except ImportError:
        pass
