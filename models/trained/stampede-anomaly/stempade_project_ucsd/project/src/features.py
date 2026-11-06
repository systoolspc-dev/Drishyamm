"""Optical flow and the four scalar motion descriptors.

Implements pipeline.md sections 3-5:
  eq. 1-2   multi-channel dense Farneback flow
  eq. 3-5   flow acceleration
  eq. 6     flow divergence
  eq. 7-13  scene change via SSIM
  eq. 14    motion entropy
  Sec. 5    8-bit quantization -> 32-bit binary vector per frame
"""
from __future__ import annotations

import cv2
import numpy as np

from config import (ENTROPY_BINS, FARNEBACK, FLOW_CLIP, FRAME_H, FRAME_W,
                    GRAY_WEIGHTS, SCALAR_BITS, SCALAR_RANGES, SOBEL_KSIZE,
                    SSIM_K1, SSIM_K2, SSIM_L)

# ---------------------------------------------------------------------------
# Frame handling
# ---------------------------------------------------------------------------


def resize_frame(bgr: np.ndarray) -> np.ndarray:
    """Resize to 224x224 with bilinear interpolation (paper Sec. 4.1)."""
    if bgr.shape[0] == FRAME_H and bgr.shape[1] == FRAME_W:
        return bgr
    return cv2.resize(bgr, (FRAME_W, FRAME_H), interpolation=cv2.INTER_LINEAR)


def to_gray(bgr: np.ndarray) -> np.ndarray:
    """Luminosity grayscale, Y = 0.299R + 0.587G + 0.114B, returned in [0, 1].

    Used only for the SSIM scene-change feature; the flow branch works on the
    separate colour channels (paper Sec. 4.2).
    """
    r_w, g_w, b_w = GRAY_WEIGHTS
    b, g, r = bgr[..., 0], bgr[..., 1], bgr[..., 2]
    gray = r_w * r.astype(np.float32) + g_w * g.astype(np.float32) + b_w * b.astype(np.float32)
    return gray / 255.0


# ---------------------------------------------------------------------------
# Optical flow  (eq. 1-2)
# ---------------------------------------------------------------------------


def _is_monochrome(bgr: np.ndarray) -> bool:
    """True when all three channels carry the same data."""
    return bool(
        np.array_equal(bgr[..., 0], bgr[..., 1])
        and np.array_equal(bgr[..., 1], bgr[..., 2])
    )


def farneback_multichannel(prev_bgr: np.ndarray, next_bgr: np.ndarray) -> np.ndarray:
    """Dense Farneback per RGB channel, averaged over the three channels.

    eq. (1)  v_c(x,y) = [u_c, v_c]^T   for c in {R, G, B}
    eq. (2)  v_avg    = (1/3) * sum_c v_c

    Returns float32 (H, W, 2).

    UCSD frames are grayscale, so their three channels are identical and eq. (2)
    reduces exactly to the single-channel flow -- averaging three copies of the
    same field returns that field.  The result is therefore computed once
    instead of three times, which is not an approximation and cuts the
    pipeline's dominant cost to a third.  Colour input still takes the full
    three-channel path.
    """
    if _is_monochrome(prev_bgr) and _is_monochrome(next_bgr):
        return cv2.calcOpticalFlowFarneback(
            prev_bgr[..., 0], next_bgr[..., 0], None, **FARNEBACK
        )

    acc = np.zeros((prev_bgr.shape[0], prev_bgr.shape[1], 2), dtype=np.float32)
    for c in range(3):
        acc += cv2.calcOpticalFlowFarneback(
            prev_bgr[..., c], next_bgr[..., c], None, **FARNEBACK
        )
    return acc / 3.0


def normalize_flow(flow: np.ndarray) -> np.ndarray:
    """Scale flow to [-1, 1] for the network input (paper Sec. 5.1)."""
    return np.clip(flow / FLOW_CLIP, -1.0, 1.0)


# ---------------------------------------------------------------------------
# Scalar descriptors
# ---------------------------------------------------------------------------


def flow_acceleration(flow_t: np.ndarray, flow_prev: np.ndarray) -> float:
    """eq. (3)-(5): mean L2 norm of the frame-to-frame flow difference."""
    d = flow_t - flow_prev
    return float(np.sqrt(d[..., 0] ** 2 + d[..., 1] ** 2).mean())


def flow_divergence(flow: np.ndarray) -> float:
    """eq. (6): du/dx + dv/dy via 3x3 Sobel, reduced to a frame-level scalar.

    [gap] The paper gives the per-pixel divergence field but never says how it
    is reduced to one number per frame.  Mean absolute divergence is used here:
    it is sign-independent, so expansion and contraction both register as
    instability rather than cancelling out.
    """
    du_dx = cv2.Sobel(flow[..., 0], cv2.CV_32F, 1, 0, ksize=SOBEL_KSIZE)
    dv_dy = cv2.Sobel(flow[..., 1], cv2.CV_32F, 0, 1, ksize=SOBEL_KSIZE)
    return float(np.abs(du_dx + dv_dy).mean())


def ssim_global(img_a: np.ndarray, img_b: np.ndarray) -> float:
    """SSIM exactly as written in the paper, eq. (7)-(12).

    The paper's eq. (8)-(10) define the mean, variance and covariance over all
    pixels of the frame (N = H*W) rather than over a sliding Gaussian window,
    so this is a global SSIM, not the windowed Wang et al. formulation.  That is
    a faithful reading of the published equations.
    """
    a = img_a.reshape(-1).astype(np.float64)
    b = img_b.reshape(-1).astype(np.float64)
    mu_a, mu_b = a.mean(), b.mean()
    var_a, var_b = a.var(ddof=1), b.var(ddof=1)
    cov = ((a - mu_a) * (b - mu_b)).sum() / (a.size - 1)

    c1 = (SSIM_K1 * SSIM_L) ** 2
    c2 = (SSIM_K2 * SSIM_L) ** 2
    num = (2 * mu_a * mu_b + c1) * (2 * cov + c2)
    den = (mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2)
    return float(num / den) if den != 0 else 1.0


def scene_change(gray_prev: np.ndarray, gray_next: np.ndarray) -> float:
    """eq. (13): Change_t = 1 - SSIM(I_t, I_{t+1})."""
    return 1.0 - ssim_global(gray_prev, gray_next)


def motion_entropy(flow: np.ndarray) -> float:
    """eq. (14): Shannon entropy of the flow-magnitude histogram, 32 bins.

    The paper prints eq. (14) without the leading minus sign; Shannon entropy
    requires it, so it is applied here.
    """
    mag = np.sqrt(flow[..., 0] ** 2 + flow[..., 1] ** 2).reshape(-1)
    hist, _ = np.histogram(mag, bins=ENTROPY_BINS, range=(0.0, FLOW_CLIP))
    total = hist.sum()
    if total == 0:
        return 0.0
    p = hist.astype(np.float64) / total
    p = p[p > 0]
    return float(-(p * np.log2(p)).sum())


def compute_scalars(
    flow_t: np.ndarray,
    flow_prev: np.ndarray | None,
    gray_prev: np.ndarray,
    gray_next: np.ndarray,
) -> np.ndarray:
    """The four descriptors, in the fixed order used everywhere.

    Returns float32 (4,): acceleration, divergence, scene_change, entropy.
    """
    accel = 0.0 if flow_prev is None else flow_acceleration(flow_t, flow_prev)
    return np.array(
        [
            accel,
            flow_divergence(flow_t),
            scene_change(gray_prev, gray_next),
            motion_entropy(flow_t),
        ],
        dtype=np.float32,
    )


# ---------------------------------------------------------------------------
# Quantization / binarization  (paper Sec. 5)
# ---------------------------------------------------------------------------


def quantize(scalars: np.ndarray, ranges=None) -> np.ndarray:
    """Clip each scalar to its range and quantize to 8 bits.

    scalars: (..., 4) float  ->  (..., 4) uint8
    ranges:  sequence of (lo, hi) per feature; defaults to the paper's.
    [gap] The paper does not say what happens to out-of-range values; they are
    clipped here rather than wrapped.
    """
    ranges = ranges if ranges is not None else SCALAR_RANGES
    out = np.empty(scalars.shape, dtype=np.uint8)
    for i, (lo, hi) in enumerate(ranges):
        span = (hi - lo) or 1.0
        v = np.clip(scalars[..., i], lo, hi)
        out[..., i] = np.round((v - lo) / span * 255.0).astype(np.uint8)
    return out


def binarize(scalars_u8: np.ndarray) -> np.ndarray:
    """8-bit values -> 32-bit binary vector per frame (paper Sec. 5).

    (..., 4) uint8  ->  (..., 32) float32 of {0., 1.}, MSB first per feature.
    """
    bits = np.unpackbits(scalars_u8.astype(np.uint8), axis=-1, bitorder="big")
    return bits.astype(np.float32).reshape(*scalars_u8.shape[:-1], 4 * SCALAR_BITS)


def scalars_to_bits(scalars: np.ndarray, ranges=None) -> np.ndarray:
    """Convenience: raw float descriptors -> 32-bit binary representation."""
    return binarize(quantize(scalars, ranges))


def calibrate_ranges(scalars: np.ndarray, percentiles=None) -> list[tuple[float, float]]:
    """Empirical [p_lo, p_hi] per feature across a corpus of raw descriptors.

    scalars: (N, 4) float.  Percentiles rather than min/max so a single
    pathological frame cannot collapse the usable range.
    """
    from config import CALIBRATION_PERCENTILES

    lo_p, hi_p = percentiles or CALIBRATION_PERCENTILES
    out = []
    for i in range(scalars.shape[-1]):
        col = scalars[..., i]
        lo, hi = float(np.percentile(col, lo_p)), float(np.percentile(col, hi_p))
        if hi <= lo:
            hi = lo + 1e-6
        out.append((lo, hi))
    return out
