"""Four-class label derivation from UCSD alone.

The paper classifies every frame into

    normal    low density, free movement
    moderate  medium density, slight congestion
    dense     high density, restricted movement
    risky     critical density, potential stampede conditions

from a hand annotation of 10,000 frames that was never published.  UCSD ships
only a *binary* frame-level annotation (normal vs anomalous), so the four
classes are rebuilt here from UCSD's own content by two rules:

  risky
      exactly the frames flagged in ``Test/<subset>.m``.  This is real ground
      truth, not a proxy, and it is honoured verbatim.

  normal / moderate / dense
      tertiles of a per-frame crowd-density proxy, taken over every frame that
      is *not* flagged anomalous.

The density proxy is foreground occupancy against a fixed background plate.
UCSD is a static camera, so a per-pixel median over the subset's Train clips
(which the UCSD README states are all normal) gives a clean empty-walkway
plate; the fraction of pixels that differ from it by more than
``FG_THRESHOLD``, after a morphological open, is the occupancy.

    [divergence from paper]  Two things about this are worth stating plainly.
    First, UCSD's anomalies are bicycles, skateboards, carts and wheelchairs on
    a pedestrian walkway — not crowd crushes.  Mapping them onto `risky`
    borrows UCSD's only ground truth for the paper's top class; it is the
    correct label for "this frame is abnormal", not for "this frame is a
    stampede".  Second, occupancy is a pixel-area measure under perspective, so
    a distant group registers lower than a near one.  Both are properties of
    the derivation, not of the model, and both are why the numbers this project
    produces are not comparable to the paper's 99.75%.

Measured on the corpus: 5,693 of 18,560 frames (30.7%) are flagged anomalous,
so the four classes come out at roughly 31 / 23 / 23 / 23 percent — close to
the paper's stated ~2,500 frames per class out of 10,000.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from config import (BG_SAMPLE_STRIDE, DENSITY_QUANTILES, FG_OPEN_KSIZE,
                    FG_THRESHOLD, OCCUPANCY_SMOOTH)
from features import resize_frame, to_gray


def _kernel() -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (FG_OPEN_KSIZE, FG_OPEN_KSIZE))


# ---------------------------------------------------------------------------
# Background plate
# ---------------------------------------------------------------------------


def build_background(
    clips, reader, stride: int = BG_SAMPLE_STRIDE
) -> np.ndarray:
    """Per-pixel median grayscale plate over a stride-sampled set of frames.

    `clips` are the subset's Train clips; `reader` turns a frame path into BGR.
    The median is taken at the pipeline's 224x224 working resolution so that
    Ped1 (238x158) and Ped2 (360x240) produce commensurable occupancies.

    A median rather than a mean: pedestrians move, so at any given pixel the
    empty walkway is the majority observation, and the median discards the
    minority of frames in which someone is standing there.  A mean would smear
    every passer-by into the plate.
    """
    frames = [p for c in clips for p in c.frame_paths[::stride]]
    if not frames:
        raise ValueError("no frames to build a background from")
    stack = np.stack([to_gray(resize_frame(reader(p))) for p in frames])
    return np.median(stack, axis=0).astype(np.float32)


# ---------------------------------------------------------------------------
# Density proxy
# ---------------------------------------------------------------------------


def frame_occupancy(gray: np.ndarray, background: np.ndarray) -> float:
    """Fraction of the frame occupied by foreground, in [0, 1].

    `gray` and `background` are both 224x224 luminosity images in [0, 1].
    """
    mask = (np.abs(gray - background) > FG_THRESHOLD).astype(np.uint8)
    return float(cv2.morphologyEx(mask, cv2.MORPH_OPEN, _kernel()).mean())


def smooth_occupancy(occ: np.ndarray, width: int = OCCUPANCY_SMOOTH) -> np.ndarray:
    """Running median over the occupancy series.

    Occupancy jitters frame to frame as pedestrians are partly swallowed by the
    threshold; density does not.  A median rather than a mean so that a single
    dropped frame cannot pull the series.
    """
    occ = np.asarray(occ, dtype=np.float32)
    if width < 2 or occ.size < width:
        return occ
    half = width // 2
    padded = np.pad(occ, half, mode="edge")
    view = np.lib.stride_tricks.sliding_window_view(padded, 2 * half + 1)
    return np.median(view, axis=-1).astype(np.float32)


# ---------------------------------------------------------------------------
# Thresholds and labels
# ---------------------------------------------------------------------------


def density_thresholds(
    occupancy: np.ndarray, quantiles=DENSITY_QUANTILES
) -> np.ndarray:
    """Corpus-wide tertile cuts, from non-anomalous frames only.

    Anomalous frames are already spoken for by `risky`, so including them would
    let UCSD's anomaly rate distort the density grading of everything else.
    """
    occ = np.asarray(occupancy, dtype=np.float32)
    if occ.size == 0:
        raise ValueError("no non-anomalous frames to derive density cuts from")
    return np.quantile(occ, quantiles).astype(np.float32)


def labels_from_occupancy(
    occupancy: np.ndarray, abnormal: np.ndarray, thresholds: np.ndarray
) -> np.ndarray:
    """Per-frame class ids: density grade for normal frames, `risky` for flagged.

    occupancy  (N,) float   smoothed density proxy
    abnormal   (N,) bool    UCSD's frame-level anomaly ground truth
    thresholds (2,) float   the tertile cuts from `density_thresholds`
    """
    occ = np.asarray(occupancy, dtype=np.float32)
    flags = np.asarray(abnormal, dtype=bool)
    if occ.shape != flags.shape:
        raise ValueError(f"occupancy {occ.shape} and abnormal {flags.shape} disagree")
    labels = np.digitize(occ, thresholds).astype(np.int8)   # 0, 1, 2
    labels[flags] = 3                                       # risky
    return labels
