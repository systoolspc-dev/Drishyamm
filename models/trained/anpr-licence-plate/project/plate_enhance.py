"""
plate_enhance.py — restore a plate crop BEFORE OCR: motion deblur + lighting.

Why this exists: on real CCTV the plate the OCR sees is small, smeared by the
vehicle's motion, and either drowned in headlight glare / IR bloom or buried in
night noise. A recogniser trained on clean crops reads garbage from those.
Every technique here is classical (numpy + OpenCV, no weights) so it runs on
the same image as the rest of the stack and costs ~5-15 ms per crop.

What it does, in order, for one plate crop:

  1. ASSESS   — sharpness (variance of Laplacian), luminance, glare fraction,
                polarity (light-on-dark plates), and a cepstral estimate of the
                motion-blur kernel (length + direction). The cepstrum trick:
                a linear motion blur multiplies the spectrum by a sinc whose
                zeros leave a periodic "comb"; the log-spectrum's inverse FFT
                (the cepstrum) turns that comb into two sharp NEGATIVE peaks at
                ±L along the motion direction. Their distance is the blur
                length, their angle the blur direction, their prominence tells
                us whether to trust the estimate at all.
  2. LIGHT    — Scenario A (night): edge-preserving denoise, then a power-law
                gamma (O = I^γ, γ<1 expands the shadows) and a log curve
                (even steeper at black), then CLAHE — tile-wise histogram
                equalisation with the slope clipped, so contrast is raised
                LOCALLY instead of washing the whole crop out. Scenario B
                (glare / IR bloom): γ>1 highlight compression + black-hat
                stroke extraction. Both: single-scale Retinex for uneven
                illumination, inversion for negative-polarity plates.
                (skimage.exposure has the same primitives — adjust_gamma,
                adjust_log, equalize_adapthist; OpenCV's are used because
                they are ~20× faster on 100-px crops.)
  2c. BLOOM   — IR cameras at night: the retro-reflective plate throws the
                illuminator straight back, the field saturates and eats into
                the glyphs (GJ11CQ7992 → GJ11C0799 at 0.91). The test is made
                on the plate FIELD — the largest bright Otsu component — not
                the whole crop, because a detector crop is plate + a margin
                of black vehicle and the crop mean sits at 76–123 while the
                field is at 215. Flag = greyscale (channel spread < 6) AND a
                bright field (crop mean > 140, 120 when the caller says the
                scene is night, or field mean > 200) AND thin/fused strokes
                (glyph fraction of the field < 0.12 or median stroke width
                < 0.06·h by distance transform). Three extra variants:
                bloom_gamma (γ 2.0–2.6 darkening → CLAHE), bloom_thin
                (grey-level erosion = dilate the dark strokes 1–2 px, then
                unsharp), bloom_thresh (adaptive threshold → black glyphs on
                white, slight blur). Never on daytime plates: the greyscale
                and stroke tests are mandatory, a motion-blurred crop only
                qualifies when the caller says night=True (the smear thins
                strokes too, and by day the deblur variants matter more), and
                candidates(..., night=False) switches the path off outright.
                The extras are budgeted BY PRIOR against the standard
                variants, so a 0.95 wiener/rl_tv is never evicted by a 0.85
                bloom_* when the variant cap is tight.
  3. DEBLUR   — only when the assessment says the crop is blurred:
                • Wiener deconvolution with the estimated kernel (edge-tapered
                  so the borders don't ring — the MathWorks edgetaper idea),
                • Richardson-Lucy with total-variation regularisation
                  (Dey et al.), damped, a handful of iterations,
                • blind RL when there is no confident kernel: alternates image
                  and PSF updates from a line prior (the MathWorks deconvblind
                  recipe, with the PSF support constrained to a line).
  4. SUPER-RES (optional, off the critical path) — tiny crops go through the
                face-reconstruct service's Real-ESRGAN x2 endpoint.

`candidates()` returns SEVERAL restored variants of the same crop. The caller
OCRs each and lets the per-track voter (plate_votes.py) decide — a deblurred
image that reads better wins, one that rings and reads worse loses. Nothing
here has to be right on every crop; it only has to be right often enough that
the vote picks it up.

Forensic note (Amped-style): every variant is a hypothesis. The raw crop is
always variant #0 and is what gets stored as evidence; enhanced variants only
ever influence the READ, never the snapshot an officer sees.
"""

from __future__ import annotations

import base64
import math
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import cv2
import numpy as np

# ── tunables (env-overridable, all have sane CCTV defaults) ─────────────────
TARGET_H = int(os.getenv("ANPR_ENH_TARGET_H", "96"))  # OCR-side crop height
MAX_UPSCALE = float(os.getenv("ANPR_ENH_MAX_UPSCALE", "4"))
BLUR_VAR_MIN = float(os.getenv("ANPR_ENH_BLUR_VAR", "120"))  # Laplacian var below → "blurry"
MOTION_MIN_Z = float(os.getenv("ANPR_ENH_MOTION_Z", "3.5"))  # cepstral peak prominence to trust (floor)
# Margin relative to the √(2 ln n) noise extreme. NEGATIVE on purpose: on a
# 48-px crop the floor is ≈4.0 and a real 14-px blur only reached z=4.0, so
# the deconvolution variants never ran. Deconvolving costs two OCR reads
# and the vote discards a bad variant — being generous here is right.
MOTION_MARGIN = float(os.getenv("ANPR_ENH_MOTION_MARGIN", "-0.6"))
MOTION_MIN_LEN = float(os.getenv("ANPR_ENH_MOTION_MIN_LEN", "2.5"))
MAX_VARIANTS = int(os.getenv("ANPR_ENH_MAX_VARIANTS", "6"))
# Ablation 2026-09-02 (ablation_preprocess.py, 149 officer-labelled + 154 audit-labelled
# crops, each variant read ALONE): a plain cubic resize read 54.4 % / 51.9 % of the
# plates exactly, the gamma+CLAHE "base" 51.7 % / 46.8 %, log_clahe 25 % / 10 % of
# the dark crops it fired on, wiener 14 % / 17 %, blind_rl 0 / 0 (85 ms each) and the
# two-row split 3.8 % / 3.3 % of the 26 / 30 crops it fired on. So the base variant
# is the resize (deskewed), the three losers are not generated, and the row split
# needs a squarer crop. Every knob keeps the old behaviour one env edit away.
BASE_MODE = os.getenv("ANPR_ENH_BASE", "resize").strip().lower()  # resize | clahe (pre-audit)
DROP_VARIANTS = {
    v.strip() for v in os.getenv("ANPR_ENH_DROP", "log_clahe,wiener,blind_rl").split(",") if v.strip()
}
TWO_ROW_MAX_ASPECT = float(
    os.getenv("ANPR_ENH_TWO_ROW_MAX_ASPECT", "2.4")
)  # was 3.2: fired on 20 % of single-row plates
WIENER_K = float(os.getenv("ANPR_ENH_WIENER_K", "0.02"))  # noise-to-signal; Amped's "noise" slider
RL_ITERS = int(os.getenv("ANPR_ENH_RL_ITERS", "12"))
RL_TV = float(os.getenv("ANPR_ENH_RL_TV", "0.004"))
BLIND_ITERS = int(os.getenv("ANPR_ENH_BLIND_ITERS", "8"))
SR_URL = os.getenv("ANPR_SR_URL", "").strip()  # e.g. http://face-reconstruct:8002/api/upscale
SR_MAX_H = int(os.getenv("ANPR_SR_MAX_H", "40"))  # only crops shorter than this go to SR
SR_TIMEOUT = float(os.getenv("ANPR_SR_TIMEOUT", "2.5"))
# IR bloom (see docstring 2c). Measured on the 2026-08-27 night crops: the
# bloom cameras' crop mean is 76–123 (dark vehicle margin) while the plate
# field is 185–232 — hence the field-luminance alternative to the crop gate.
BLOOM_ENABLED = os.getenv("ANPR_ENH_BLOOM", "1") == "1"
BLOOM_LUM = float(os.getenv("ANPR_ENH_BLOOM_LUM", "140"))  # crop mean, scene unknown
BLOOM_LUM_NIGHT = float(os.getenv("ANPR_ENH_BLOOM_LUM_NIGHT", "120"))  # crop mean when night=True
BLOOM_FIELD_LUM = float(os.getenv("ANPR_ENH_BLOOM_FIELD_LUM", "200"))  # plate-field mean (999 = off)
BLOOM_CHROMA = float(os.getenv("ANPR_ENH_BLOOM_CHROMA", "6"))  # mean (max−min) channel spread
BLOOM_GLYPH_FRAC = float(os.getenv("ANPR_ENH_BLOOM_GLYPH_FRAC", "0.12"))
BLOOM_STROKE_REL = float(os.getenv("ANPR_ENH_BLOOM_STROKE_REL", "0.06"))  # × crop height
BLOOM_REQUIRE_THIN = (
    os.getenv("ANPR_ENH_BLOOM_REQUIRE_THIN", "1") == "1"
)  # 0 = grey + bright field is enough (diagnostic)
# 0.85, not the 0.95 the spec proposed: eval_night.py on 120 night crops
# (2026-08-28) found no gain — rule-valid 55/120 off and on, hand-truth 1/5
# both ways — and with the gate forced open bloom_thresh "won" with wrong or
# invented reads (GJ18BY7580 → GJ188713). Keep the hypotheses, trust them less.
BLOOM_PRIOR = float(os.getenv("ANPR_ENH_BLOOM_PRIOR", "0.85"))

_EPS = 1e-6


# ═══════════════════════════════════════════════════════════════════════════
# 1. ASSESSMENT
# ═══════════════════════════════════════════════════════════════════════════


@dataclass
class Assessment:
    h: int
    w: int
    sharpness: float  # variance of Laplacian (size-normalised)
    mean_lum: float  # 0..255
    contrast: float  # std of grey
    sat_frac: float  # fraction of pixels >= 250 → glare / IR bloom
    dark_frac: float  # fraction of pixels <= 15
    motion_len: float  # estimated motion-blur length, px (crop scale)
    motion_deg: float  # motion direction, degrees (image coords, y down)
    motion_z: float  # cepstral peak prominence (z-score)
    inverted: bool  # light text on dark background
    # plate-FIELD statistics for the bloom test (defaults keep older callers
    # that build an Assessment by hand working)
    chroma: float = 0.0  # mean (max−min) channel spread over the field; ≈0 = greyscale / IR
    field_lum: float = 0.0  # mean of the bright pixels inside the plate field
    field_frac: float = 0.0  # plate-field area / crop area
    glyph_frac: float = 0.0  # dark (glyph) fraction of the field
    stroke_rel: float = 0.0  # median glyph stroke width / crop height

    @property
    def is_dark(self) -> bool:
        return self.mean_lum < 70

    @property
    def is_glare(self) -> bool:
        return self.sat_frac > 0.12

    @property
    def is_blurry(self) -> bool:
        return self.sharpness < BLUR_VAR_MIN

    @property
    def has_motion(self) -> bool:
        # The z-score is the most negative of ~h·w/2 samples; pure noise
        # reaches ≈ sqrt(2·ln n) by chance, so the peak must clear that by a
        # margin — and a crop that is already sharp does not need deconvolving.
        n = max(16, (self.h * self.w) // 2)
        noise_floor = math.sqrt(2.0 * math.log(n))
        return (
            self.motion_z >= max(MOTION_MIN_Z, noise_floor + MOTION_MARGIN)
            and self.motion_len >= MOTION_MIN_LEN
        )

    @property
    def is_low_contrast(self) -> bool:
        # skimage.exposure.is_low_contrast uses a 5 % intensity-range rule;
        # std < 28 on 8-bit is the same idea on CCTV crops.
        return self.contrast < 28.0

    def is_bloom_for(self, night: bool | None = None) -> bool:
        """IR bloom test (docstring 2c). `night` is the scene flag when the
        caller has one: True relaxes the crop-mean gate to BLOOM_LUM_NIGHT,
        False switches the path off (a daytime plate is never bloomed), None
        uses the strict thresholds. Greyscale is mandatory; so are thin or
        fused strokes unless BLOOM_REQUIRE_THIN is off (diagnostics only).
        A motion-blurred field is not a bloomed one: the smear thins and
        lightens the strokes, so unless the caller says night=True the
        thin-stroke test would fire on exactly the crops where the deblur
        variants matter (a neutral-grey daytime plate with a 10-px smear
        gives chroma 0, glyph_frac 0.10)."""
        if night is False or self.chroma >= BLOOM_CHROMA or self.field_frac < 0.15:
            return False
        if self.has_motion and night is not True:
            return False
        bright = self.mean_lum > (BLOOM_LUM_NIGHT if night else BLOOM_LUM) or self.field_lum > BLOOM_FIELD_LUM
        if not bright or self.glyph_frac < 0.01:  # no glyphs found → nothing to thin
            return False
        thin = self.glyph_frac < BLOOM_GLYPH_FRAC or self.stroke_rel < BLOOM_STROKE_REL
        return thin or not BLOOM_REQUIRE_THIN

    @property
    def is_bloom(self) -> bool:
        return self.is_bloom_for(None)

    @property
    def scenario(self) -> str:
        """Dominant degradation — what the operator/UI should be told."""
        if self.is_glare:
            return "glare"
        if self.is_dark:
            return "night"
        if self.has_motion:
            return "motion"
        if self.is_blurry:
            return "defocus"
        if self.is_low_contrast:
            return "low_contrast"
        return "clean"

    def flags(self) -> list[str]:
        f = []
        if self.is_dark:
            f.append("dark")
        if self.is_glare:
            f.append("glare")
        if self.is_low_contrast:
            f.append("low_contrast")
        if self.is_blurry:
            f.append("blurry")
        if self.has_motion:
            f.append(f"motion{self.motion_len:.0f}px@{self.motion_deg:.0f}")
        if self.inverted:
            f.append("inverted")
        if self.is_bloom:
            f.append("bloom")
        return f

    def as_dict(self) -> dict:
        return {
            "h": self.h,
            "w": self.w,
            "sharpness": round(self.sharpness, 1),
            "mean_lum": round(self.mean_lum, 1),
            "sat_frac": round(self.sat_frac, 3),
            "motion_len": round(self.motion_len, 1),
            "motion_deg": round(self.motion_deg, 1),
            "motion_z": round(self.motion_z, 2),
            "inverted": self.inverted,
            "scenario": self.scenario,
            "flags": self.flags(),
            "chroma": round(self.chroma, 1),
            "field_lum": round(self.field_lum, 1),
            "glyph_frac": round(self.glyph_frac, 3),
            "stroke_rel": round(self.stroke_rel, 3),
            "bloom": self.is_bloom,
        }


def to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    if img.shape[2] == 1:
        return img[:, :, 0]
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def sharpness(gray: np.ndarray, norm_w: int = 160) -> float:
    """Variance of the Laplacian on a width-normalised copy so the number means
    the same thing for a 60 px and a 300 px crop."""
    h, w = gray.shape
    if w != norm_w:
        g = cv2.resize(gray, (norm_w, max(1, int(round(h * norm_w / w)))), interpolation=cv2.INTER_AREA)
    else:
        g = gray
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def estimate_motion_blur(gray: np.ndarray, min_len: float = 2.0, max_len: float | None = None):
    """Cepstral motion-blur estimate → (length_px, angle_deg, prominence_z).

    Returns (0, 0, 0) for crops too small to say anything. `prominence_z` is
    how far the most negative cepstral peak sits below the cepstrum's own
    noise floor (in standard deviations); ≥ ~3.5 is a real blur."""
    h, w = gray.shape
    if h < 12 or w < 24:
        return 0.0, 0.0, 0.0
    g = gray.astype(np.float32)
    g = (g - g.mean()) / (g.std() + _EPS)
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    spec = np.fft.fft2(g * win)
    logspec = np.log1p(np.abs(spec))
    cep = np.fft.fftshift(np.real(np.fft.ifft2(logspec)))
    cy, cx = h // 2, w // 2
    yy, xx = np.mgrid[0:h, 0:w]
    dy, dx = yy - cy, xx - cx
    r = np.hypot(dy, dx)
    max_len = max_len or (0.5 * max(h, w))
    # one half-plane: the blur peak is symmetric, so ±L are the same answer
    half = (dy > 0) | ((dy == 0) & (dx > 0))
    valid = half & (r >= min_len) & (r <= max_len)
    if valid.sum() < 16:
        return 0.0, 0.0, 0.0
    vals = cep[valid]
    i = int(np.argmin(vals))
    z = float((vals.mean() - vals[i]) / (vals.std() + 1e-9))
    py, px = int(dy[valid][i]), int(dx[valid][i])
    # The negative cepstral peak of an anti-aliased L-px line sits at ~L+1
    # (measured on synthetic blurs: +1.3 px mean bias) — take it back out.
    length = max(min_len, float(math.hypot(px, py)) - 1.0)
    # direction is only defined modulo 180° — report it in (-90, 90]
    angle = float(math.degrees(math.atan2(py, px)))
    angle = ((angle + 90.0) % 180.0) - 90.0
    return length, angle, z


def looks_inverted(gray: np.ndarray) -> bool:
    """Plates are normally a light field with dark glyphs: after Otsu, the
    bright class should be the majority. If the dark class dominates, the crop
    is light-on-dark (black/green plates, some IR exposures) — OCR both ways."""
    if gray.size < 64:
        return False
    thr, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = float((gray > thr).mean())
    return bright < 0.42


def field_stats(img: np.ndarray, gray: np.ndarray) -> tuple[float, float, float, float, float]:
    """Plate-FIELD statistics for the bloom test →
    (chroma, field_lum, field_frac, glyph_frac, stroke_rel).

    A detector crop is the plate plus a margin of vehicle, so whole-crop
    numbers describe the margin as much as the plate (corp8_06 IR crops:
    crop mean 76–88 while the field sits at 215). Otsu on the crop separates
    field from surround; closing the bright mask seals the glyph holes and the
    largest component is the plate field. Inside it:
      chroma      mean (max−min) channel spread — ≈0 on an IR image
      field_lum   mean of the bright (Otsu-high) pixels
      field_frac  field area / crop area
      glyph_frac  holes (Otsu-low pixels) / field area — the ink
      stroke_rel  median glyph stroke width / crop height; distance transform
                  of the hole mask, median over the ink ≈ w/4 → ×4"""
    h, w = gray.shape
    if gray.size < 64:
        return 0.0, float(gray.mean()) if gray.size else 0.0, 0.0, 0.0, 0.0
    _, bright = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = max(3, int(h * 0.15)) | 1
    closed = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(closed, 8)
    if n <= 1:
        field = np.ones(gray.shape, bool)
    else:
        field = lab == (1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])))
    area = int(field.sum())
    if area < 32:
        return 0.0, float(gray.mean()), 0.0, 0.0, 0.0
    hi = field & (bright > 0)
    field_lum = float(gray[hi].mean()) if hi.any() else float(gray[field].mean())
    holes = (field & (bright == 0)).astype(np.uint8)
    glyph_frac = float(holes.sum()) / area
    stroke_rel = 0.0
    if glyph_frac > 0:
        dt = cv2.distanceTransform(np.pad(holes, 1), cv2.DIST_L2, 3)[1:-1, 1:-1]
        stroke_rel = float(4.0 * np.median(dt[holes > 0])) / h
    chroma = 0.0
    if img.ndim == 3 and img.shape[2] == 3:
        f = img.astype(np.float32)
        chroma = float((f.max(2) - f.min(2))[field].mean())
    return chroma, field_lum, float(area) / gray.size, glyph_frac, stroke_rel


def assess(img: np.ndarray) -> Assessment:
    gray = to_gray(img)
    h, w = gray.shape
    mlen, mdeg, mz = estimate_motion_blur(gray)
    chroma, flum, ffrac, gfrac, srel = field_stats(img, gray)
    return Assessment(
        h=h,
        w=w,
        sharpness=sharpness(gray),
        mean_lum=float(gray.mean()),
        contrast=float(gray.std()),
        sat_frac=float((gray >= 250).mean()),
        dark_frac=float((gray <= 15).mean()),
        motion_len=mlen,
        motion_deg=mdeg,
        motion_z=mz,
        inverted=looks_inverted(gray),
        chroma=chroma,
        field_lum=flum,
        field_frac=ffrac,
        glyph_frac=gfrac,
        stroke_rel=srel,
    )


# ═══════════════════════════════════════════════════════════════════════════
# 2. LIGHTING
# ═══════════════════════════════════════════════════════════════════════════


def auto_gamma(gray: np.ndarray, target: float = 0.5) -> np.ndarray:
    """Pull the mean toward mid-grey: brightens night crops (gamma < 1),
    compresses glare (gamma > 1). Bounded so it never destroys contrast."""
    m = float(gray.mean()) / 255.0
    if m <= 0.0 or m >= 1.0:
        return gray
    gamma = float(np.clip(math.log(target) / math.log(max(m, 1e-3)), 0.35, 2.5))
    if abs(gamma - 1.0) < 0.05:
        return gray
    lut = ((np.arange(256) / 255.0) ** gamma * 255.0).astype(np.uint8)
    return cv2.LUT(gray, lut)


_LOG_LUT = (255.0 / math.log(256.0) * np.log1p(np.arange(256, dtype=np.float64))).astype(np.uint8)


def log_transform(gray: np.ndarray) -> np.ndarray:
    """O = c·log(1 + I). Expands the darkest tones far more aggressively than
    a gamma curve (the slope at black is 255/ln256 ≈ 46×), which is what pulls
    glyph edges out of a near-black night crop. Highlights are compressed, so
    it is only used on the night branch."""
    return cv2.LUT(gray, _LOG_LUT)


def denoise_night(gray: np.ndarray) -> np.ndarray:
    """Edge-preserving smoothing before any tone curve — night sensor noise
    would otherwise be stretched into speckle by gamma/log/CLAHE and then
    amplified again by deconvolution."""
    return cv2.bilateralFilter(gray, 5, 24, 5)


# CLAHE = local (tile-wise) histogram equalisation with the contrast slope
# clipped, i.e. skimage.exposure.equalize_adapthist(clip_limit≈0.01, 8×8
# tiles) — OpenCV's implementation is the same algorithm and ~20× faster.
# A cv2.CLAHE object keeps internal state and is NOT thread-safe; 30 camera
# threads share this module, so each thread gets its own pair.
_tls = threading.local()


def clahe(gray: np.ndarray, hard: bool = False) -> np.ndarray:
    pair = getattr(_tls, "clahe", None)
    if pair is None:
        pair = (
            cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)),
            cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8)),
        )
        _tls.clahe = pair
    return pair[1 if hard else 0].apply(gray)


def retinex(gray: np.ndarray, sigma: float | None = None) -> np.ndarray:
    """Single-scale Retinex: divide out the illumination (a wide Gaussian of
    the image) so a shadow across half the plate or a headlight hot-spot stops
    dominating the glyphs. Percentile-stretched back to 8-bit."""
    h, w = gray.shape
    sigma = sigma or max(4.0, max(h, w) / 8.0)
    g = gray.astype(np.float32) + 1.0
    illum = cv2.GaussianBlur(g, (0, 0), sigma) + 1.0
    r = np.log(g) - np.log(illum)
    lo, hi = np.percentile(r, 1.0), np.percentile(r, 99.0)
    if hi - lo < 1e-4:
        return gray
    r = np.clip((r - lo) / (hi - lo), 0, 1)
    return (r * 255.0).astype(np.uint8)


def blackhat_text(gray: np.ndarray) -> np.ndarray:
    """Dark-stroke extractor for washed-out plates: the black-hat transform
    keeps only features darker than their surroundings at glyph scale."""
    h = gray.shape[0]
    k = max(5, int(h * 0.5)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    bh = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)
    out = 255 - cv2.normalize(bh, None, 0, 255, cv2.NORM_MINMAX)
    return out.astype(np.uint8)


def unsharp(gray: np.ndarray, amount: float = 0.6, sigma: float = 1.2) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (0, 0), sigma)
    return cv2.addWeighted(gray, 1.0 + amount, blur, -amount, 0)


# ── Scenario C: IR bloom (docstring 2c). All three work on the RAW upscaled
# grey, not on `base`: auto_gamma pulls a dark-margin crop UP (γ<1), which is
# the opposite of what a saturated field needs.
def bloom_gamma(gray: np.ndarray, field_lum: float) -> tuple[np.ndarray, float]:
    """γ 2.0–2.6 darkening, steeper the brighter the field, then CLAHE: the
    saturated field comes down and the grey, half-filled strokes regain
    contrast. Returns (image, gamma)."""
    gamma = float(np.clip(2.0 + (field_lum - 195.0) / 90.0, 2.0, 2.6))
    lut = ((np.arange(256) / 255.0) ** gamma * 255.0).astype(np.uint8)
    return clahe(cv2.LUT(gray, lut)), gamma


def bloom_thin(gray: np.ndarray, scale: float) -> np.ndarray:
    """Grey-level erosion (min filter) of the bright field by ~1 source pixel
    — the dark strokes grow back the width the bloom ate — then unsharp."""
    r = int(np.clip(round(scale), 1, 3))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    return unsharp(cv2.erode(gray, k))


def bloom_thresh(gray: np.ndarray, scale: float) -> np.ndarray:
    """Adaptive (Gaussian-weighted local mean) threshold → black glyphs on a
    white field, then a slight blur so the recogniser sees anti-aliased
    edges rather than a bitmap."""
    block = max(11, int(gray.shape[0] * 0.35)) | 1
    src = cv2.GaussianBlur(gray, (0, 0), 0.8)
    bw = cv2.adaptiveThreshold(src, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 8)
    return cv2.GaussianBlur(bw, (0, 0), max(0.8, 0.5 * scale))


# ═══════════════════════════════════════════════════════════════════════════
# 2b. GEOMETRY — deskew + two-row split
# ═══════════════════════════════════════════════════════════════════════════


def text_mask(gray: np.ndarray, inverted: bool = False) -> np.ndarray:
    """Binary glyph mask (glyphs = 1) via Otsu; opened to drop speckle."""
    thr, m = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if inverted:
        m = 255 - m
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, k)


def skew_angle(gray: np.ndarray, inverted: bool = False) -> float:
    """Text-line skew from the second-order central moments of the glyph mask:
    θ = ½·atan2(2μ11, μ20 − μ02). Degrees, image coords, (-45, 45]."""
    m = text_mask(gray, inverted)
    h, w = m.shape
    # keep the central band — plate borders / screws skew the moments
    band = m[int(h * 0.12) : int(h * 0.88), int(w * 0.04) : int(w * 0.96)]
    mom = cv2.moments(band, binaryImage=True)
    if mom["m00"] < 50:
        return 0.0
    mu20, mu02, mu11 = mom["mu20"], mom["mu02"], mom["mu11"]
    if abs(mu20 - mu02) < 1e-6 and abs(mu11) < 1e-6:
        return 0.0
    theta = 0.5 * math.degrees(math.atan2(2.0 * mu11, mu20 - mu02))
    if theta > 45:
        theta -= 90
    if theta <= -45:
        theta += 90
    return float(theta)


def deskew(gray: np.ndarray, angle: float) -> np.ndarray:
    h, w = gray.shape
    M = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
    return cv2.warpAffine(gray, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def split_two_line(gray: np.ndarray, inverted: bool = False):
    """Detect a two-row plate (bikes / trucks: 'GJ 01 AB' over '1234') from
    the horizontal projection of the glyph mask. Returns (top, bottom) crops
    or None. Requires two clear ink bands separated by a quiet gap, each at
    least a quarter of the height — single-row plates never satisfy that."""
    h, w = gray.shape
    if (
        h < 24 or w / h > TWO_ROW_MAX_ASPECT
    ):  # a genuinely two-row plate is squarer than ~2.4:1 (audit 2026-09-02)
        return None
    m = text_mask(gray, inverted)
    prof = m[:, int(w * 0.05) : int(w * 0.95)].mean(1) / 255.0
    prof = np.convolve(prof, np.ones(3) / 3.0, mode="same")
    ink = prof > max(0.06, prof.max() * 0.25)
    bands = []
    start = None
    for i, v in enumerate(ink):
        if v and start is None:
            start = i
        elif not v and start is not None:
            bands.append((start, i))
            start = None
    if start is not None:
        bands.append((start, h))
    bands = [b for b in bands if b[1] - b[0] >= 0.18 * h]
    if len(bands) != 2:
        return None
    (a0, a1), (b0, b1) = bands
    if b0 - a1 < 0.04 * h:
        return None
    pad = max(2, int(0.06 * h))
    top = gray[max(0, a0 - pad) : min(h, a1 + pad), :]
    bottom = gray[max(0, b0 - pad) : min(h, b1 + pad), :]
    if top.shape[0] < 8 or bottom.shape[0] < 8:
        return None
    return top, bottom


# ═══════════════════════════════════════════════════════════════════════════
# 3. DECONVOLUTION (Wiener / Richardson-Lucy / blind RL)
# ═══════════════════════════════════════════════════════════════════════════


def motion_psf(length: float, angle_deg: float, size: int | None = None) -> np.ndarray:
    """Anti-aliased line kernel of `length` px at `angle_deg` (image coords).
    Drawn on an 8-bit canvas: cv2 silently ignores LINE_AA / shift on float
    images, which made the kernel a jagged 1-px staircase."""
    L = max(1.0, float(length))
    size = size or (int(math.ceil(L)) + 4)
    size |= 1
    k8 = np.zeros((size, size), np.uint8)
    c = size // 2
    rad = math.radians(angle_deg)
    dx, dy = math.cos(rad) * L / 2.0, math.sin(rad) * L / 2.0
    p1 = (int(round((c - dx) * 16)), int(round((c - dy) * 16)))
    p2 = (int(round((c + dx) * 16)), int(round((c + dy) * 16)))
    cv2.line(k8, p1, p2, 255, 1, cv2.LINE_AA, shift=4)
    k = k8.astype(np.float32)
    s = k.sum()
    if s <= 0:
        k[c, c] = 1.0
        s = 1.0
    return k / s


def _fit_psf(psf: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """Crop a PSF that is larger than the image (tiny crop, long blur) to the
    image size, keeping the centre — otherwise _otf's pad[:ph,:pw] = psf
    raises and takes the camera thread with it."""
    ph, pw = psf.shape
    H, W = shape
    if ph <= H and pw <= W:
        return psf
    h2, w2 = min(ph, H - (H + 1) % 2), min(pw, W - (W + 1) % 2)  # odd, ≤ image
    h2, w2 = max(1, h2), max(1, w2)
    y0, x0 = (ph - h2) // 2, (pw - w2) // 2
    k = psf[y0 : y0 + h2, x0 : x0 + w2].astype(np.float32)
    s = k.sum()
    return k / s if s > 0 else k


def gaussian_psf(sigma: float) -> np.ndarray:
    size = int(math.ceil(sigma * 6)) | 1
    size = max(size, 3)
    g = cv2.getGaussianKernel(size, sigma)
    return (g @ g.T).astype(np.float32)


def _otf(psf: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """PSF (centre at its middle) → optical transfer function for `shape`."""
    psf = _fit_psf(psf, shape)
    ph, pw = psf.shape
    H, W = shape
    pad = np.zeros((H, W), np.float32)
    pad[:ph, :pw] = psf
    pad = np.roll(pad, (-(ph // 2), -(pw // 2)), axis=(0, 1))
    return np.fft.fft2(pad)


def _conv(img: np.ndarray, otf: np.ndarray) -> np.ndarray:
    return np.real(np.fft.ifft2(np.fft.fft2(img) * otf))


def edgetaper(img: np.ndarray, psf: np.ndarray, otf: np.ndarray | None = None) -> np.ndarray:
    """Blend the borders toward their blurred version so circular deconvolution
    doesn't ring off the edges (MATLAB's edgetaper, simplified)."""
    h, w = img.shape
    psf = _fit_psf(psf, img.shape)
    kh, kw = psf.shape
    otf = _otf(psf, img.shape) if otf is None else otf
    blurred = _conv(img, otf)

    def taper(n: int, k: int) -> np.ndarray:
        k = int(min(k, max(1, n // 2 - 1)))
        t = np.ones(n, np.float32)
        if k > 0:
            ramp = np.linspace(0.0, 1.0, k + 2, dtype=np.float32)[1:-1]
            t[:k] = ramp
            t[-k:] = ramp[::-1]
        return t

    win = np.outer(taper(h, kh), taper(w, kw))
    return img * win + blurred * (1.0 - win)


def wiener(img: np.ndarray, psf: np.ndarray, K: float = WIENER_K) -> np.ndarray:
    """Wiener deconvolution: F = conj(H) / (|H|² + K) · G on an edge-tapered
    image. `K` is the noise-to-signal ratio — the single knob a forensic
    analyst tunes ("noise" in Amped); larger = smoother, less ringing."""
    otf = _otf(psf, img.shape)
    g = edgetaper(img, psf, otf)
    G = np.fft.fft2(g)
    Hc = np.conj(otf)
    F = (Hc / (np.abs(otf) ** 2 + K)) * G
    return np.clip(np.real(np.fft.ifft2(F)), 0.0, 1.0)


def richardson_lucy(img: np.ndarray, psf: np.ndarray, iters: int = RL_ITERS, tv: float = RL_TV) -> np.ndarray:
    """Richardson-Lucy with optional total-variation regularisation (Dey 2006).
    Multiplicative updates keep the estimate non-negative; TV keeps it from
    amplifying noise into speckle after a few iterations."""
    otf = _otf(psf, img.shape)
    otf_c = np.conj(otf)
    g = edgetaper(img, psf, otf)
    f = g.copy()
    for _ in range(iters):
        est = _conv(f, otf)
        ratio = g / (est + _EPS)
        f = f * _conv(ratio, otf_c)
        if tv > 0:
            gy, gx = np.gradient(f)
            mag = np.sqrt(gx * gx + gy * gy) + _EPS
            div = np.gradient(gx / mag, axis=1) + np.gradient(gy / mag, axis=0)
            f = f / np.clip(1.0 - tv * div, 0.2, None)
        f = np.clip(f, 0.0, 1.0)
    return f


def blind_rl(
    img: np.ndarray,
    psf0: np.ndarray,
    iters: int = BLIND_ITERS,
    inner: int = 2,
    support: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Blind Richardson-Lucy (Fish et al.): alternate PSF and image updates
    from an initial guess. `support` (same shape as psf0, 0/1) constrains
    where the PSF may live — a fattened line for motion blur — which is what
    keeps the estimate from drifting into a blob (the MathWorks example does
    the same with its PSF-constraint function)."""
    H, W = img.shape
    psf0 = _fit_psf(psf0, img.shape)
    if support is not None and support.shape != psf0.shape:
        support = _fit_psf(support, img.shape) > 0
        support = support.astype(np.float32)
    g = edgetaper(img, psf0)
    f = g.copy()
    k = psf0.astype(np.float32).copy()
    kh, kw = k.shape
    ys = (np.arange(kh) - kh // 2) % H
    xs = (np.arange(kw) - kw // 2) % W
    for _ in range(iters):
        # PSF update: k ← k · [(g / (f⊗k)) ⋆ f] / Σf
        F = np.fft.fft2(f)
        for _ in range(inner):
            kotf = _otf(k, (H, W))
            est = np.real(np.fft.ifft2(F * kotf))
            ratio = g / (est + _EPS)
            corr = np.real(np.fft.ifft2(np.fft.fft2(ratio) * np.conj(F)))
            k = k * corr[np.ix_(ys, xs)] / (f.sum() + _EPS)
            k = np.clip(k, 0.0, None)
            if support is not None:
                k = k * support
            k = k / (k.sum() + _EPS)
        # image update with the refreshed PSF
        kotf = _otf(k, (H, W))
        kotf_c = np.conj(kotf)
        for _ in range(inner):
            est = _conv(f, kotf)
            f = np.clip(f * _conv(g / (est + _EPS), kotf_c), 0.0, 1.0)
    return f, k


def line_support(psf_shape: tuple[int, int], angle_deg: float, fat: int = 1) -> np.ndarray:
    size = psf_shape[0]
    line = motion_psf(size - 2, angle_deg, size)
    m = (line > 0).astype(np.uint8)
    if fat > 0:
        m = cv2.dilate(m, np.ones((2 * fat + 1, 2 * fat + 1), np.uint8))
    return m.astype(np.float32)


# ═══════════════════════════════════════════════════════════════════════════
# 4. OPTIONAL SUPER-RESOLUTION (Real-ESRGAN via face-reconstruct)
# ═══════════════════════════════════════════════════════════════════════════


class _Breaker:
    """Tiny circuit breaker so a dead SR service costs one timeout per minute,
    not one per crop."""

    def __init__(self, cool: float = 60.0):
        self.cool = cool
        self.down_until = 0.0
        self.lock = threading.Lock()

    def ok(self) -> bool:
        return time.time() >= self.down_until

    def trip(self):
        with self.lock:
            self.down_until = time.time() + self.cool


_sr_breaker = _Breaker()


def super_resolve(bgr: np.ndarray) -> np.ndarray | None:
    """POST the crop to the SR endpoint; returns the x2 image or None."""
    if not SR_URL or not _sr_breaker.ok():
        return None
    try:
        import requests  # local import: keep this module importable without it

        ok, buf = cv2.imencode(".png", bgr)
        if not ok:
            return None
        r = requests.post(
            SR_URL, files={"file": ("crop.png", buf.tobytes(), "image/png")}, timeout=SR_TIMEOUT
        )
        if r.status_code != 200:
            _sr_breaker.trip()
            return None
        ctype = r.headers.get("content-type", "")
        if ctype.startswith("image/"):
            data = np.frombuffer(r.content, np.uint8)
        else:
            b64 = r.json().get("image_b64") or ""
            data = np.frombuffer(base64.b64decode(b64), np.uint8)
        out = cv2.imdecode(data, cv2.IMREAD_COLOR)
        return out
    except Exception:  # noqa: BLE001 — SR is optional, never fatal
        _sr_breaker.trip()
        return None


# ═══════════════════════════════════════════════════════════════════════════
# 5. CANDIDATE GENERATION
# ═══════════════════════════════════════════════════════════════════════════


@dataclass
class Candidate:
    name: str
    image: np.ndarray  # BGR uint8, OCR-ready
    prior: float = 1.0  # how much to trust a read from this variant
    note: dict = field(default_factory=dict)


def _bgr(gray: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def _f32(gray: np.ndarray) -> np.ndarray:
    return gray.astype(np.float32) / 255.0


def _u8(f: np.ndarray) -> np.ndarray:
    return (np.clip(f, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def upscale(
    gray: np.ndarray, target_h: int = TARGET_H, max_scale: float = MAX_UPSCALE
) -> tuple[np.ndarray, float]:
    h, w = gray.shape
    s = float(np.clip(target_h / max(1, h), 1.0, max_scale))
    if s <= 1.01:
        return gray, 1.0
    out = cv2.resize(gray, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_CUBIC)
    return out, s


def _budget(std: list[Candidate], extra: list[Candidate], max_variants: int) -> list[Candidate]:
    """Merge `extra` into the standard list within `max_variants` BY PRIOR:
    variant #0 (base) always stays; the remaining slots go to the highest-
    prior hypotheses of std[1:] + extra, ties keeping their original order
    (standard variants first). So the 0.95 wiener/rl_tv survive ahead of a
    0.85 bloom_*, and the extras only ever displace variants that are
    actually trusted less — with the worker's busy-frame cap of 3 a blurred
    crop keeps its deblur hypotheses instead of two bloom guesses."""
    if max_variants <= 0:
        return []
    base, pool = std[:1], std[1:] + extra
    room = max(0, max_variants - len(base))
    if len(pool) > room:
        keep = set(sorted(range(len(pool)), key=lambda i: (-pool[i].prior, i))[:room])
        pool = [c for i, c in enumerate(pool) if i in keep]
    return base + pool


# A variant that has not been built yet: (prior, build). build() → Candidate,
# or None when it cannot be made (super-resolution service down).
_Plan = tuple[float, Callable[[], "Candidate | None"]]


def _build_within(plan: list[_Plan], max_variants: int) -> list[Candidate]:
    """Build only what fits, chosen like `_budget`: plan[0] (base) always, the
    remaining slots to the highest priors (ties in plan order), the output in
    plan order. A variant that cannot be built gives its slot to the next one.
    Under the cap every variant is built, in order — identical to building
    them all; over it, a deconvolution that would be cut is never computed."""
    if max_variants <= 0 or not plan:
        return []
    built: dict[int, Candidate] = {}
    first = plan[0][1]()
    if first is not None:
        built[0] = first
    room = max_variants - len(built)
    for i in sorted(range(1, len(plan)), key=lambda i: (-plan[i][0], i)):
        if room <= 0:
            break
        c = plan[i][1]()
        if c is not None:
            built[i] = c
            room -= 1
    return [built[i] for i in sorted(built)]


def candidates(
    crop_bgr: np.ndarray,
    *,
    use_sr: bool = True,
    max_variants: int = MAX_VARIANTS,
    assessment: Assessment | None = None,
    night: bool | None = None,
    bloom: bool | None = None,
) -> tuple[list[Candidate], Assessment]:
    """Produce OCR-ready variants of one plate crop, most-trusted first.

    Variant #0 is always the lightly-normalised original ("base"). The rest are
    gated on the assessment so a sharp, well-lit plate costs ONE OCR call and a
    smeared night plate costs up to `max_variants`. Variants are planned first
    and only those that fit `max_variants` are built: the highest priors win
    (see `_build_within`), so a busy-frame cap never drops a 0.95 deblur for a
    0.8 blackhat, and never pays for a deconvolution it then discards.

    `night` is the caller's scene flag (worker: scene_lum < ANPR_NIGHT_LUM):
    True relaxes the IR-bloom gate, False disables it, None (default) keeps
    the strict thresholds. `bloom` overrides the module switch BLOOM_ENABLED
    (False = exactly the pre-bloom behaviour, for A/B runs)."""
    a = assessment or assess(crop_bgr)
    gray0 = to_gray(crop_bgr)
    up, s = upscale(gray0)

    # base: power-law gamma (γ<1 brightens night, γ>1 tames glare) → CLAHE.
    # Cheap, always. On a dark crop the noise is smoothed first.
    src = denoise_night(up) if a.is_dark else up
    # BASE_MODE "resize": the upscaled crop as is (measured best single step);
    # "clahe": the pre-audit gamma → CLAHE normalisation.
    lit = clahe(auto_gamma(src)) if BASE_MODE == "clahe" else src
    # geometry: rotate the text line level when it is visibly skewed (moments
    # deskew, §2 of the maths note). Everything downstream sees the level crop.
    # Only for single-row shapes: on a two-row plate the moments of the two
    # stacked rows report a bogus tilt, and rotating would break the row split.
    angle = 0.0
    if lit.shape[1] / max(1, lit.shape[0]) >= 2.2:
        angle = skew_angle(lit, a.inverted)
        if abs(angle) >= 2.5:
            lit = deskew(lit, angle)
        else:
            angle = 0.0

    plan: list[_Plan] = [
        (1.0, lambda: Candidate("base", _bgr(lit), 1.0, {"deskew_deg": round(angle, 1)} if angle else {}))
    ]

    if a.inverted:
        plan.append((0.9, lambda: Candidate("inverted", _bgr(255 - lit), 0.9)))

    # Scenario A — night: log curve digs deeper into the shadows than gamma.
    if a.is_dark and "log_clahe" not in DROP_VARIANTS:
        plan.append((0.9, lambda: Candidate("log_clahe", _bgr(clahe(log_transform(src))), 0.9)))

    # Uneven illumination (shadow across the plate, one headlight) / flat crops
    if a.is_dark or a.is_glare or a.is_low_contrast:
        plan.append((0.9, lambda: Candidate("retinex", _bgr(clahe(retinex(up))), 0.9)))

    # Scenario B — glare / IR bloom: compress highlights, keep only dark strokes.
    if a.is_glare:
        plan.append((0.8, lambda: Candidate("blackhat", _bgr(blackhat_text(auto_gamma(up))), 0.8)))

    # motion / focus blur
    if a.has_motion:
        # the crop was rotated by `angle` above → the blur direction rotates too
        psf = motion_psf(a.motion_len * s, a.motion_deg - angle)
        note = {"psf": "motion", "len": round(a.motion_len * s, 1), "deg": round(a.motion_deg - angle, 1)}
        if "wiener" not in DROP_VARIANTS:
            plan.append((0.95, lambda: Candidate("wiener", _bgr(_u8(wiener(_f32(lit), psf))), 0.95, note)))
        plan.append((0.95, lambda: Candidate("rl_tv", _bgr(_u8(richardson_lucy(_f32(lit), psf))), 0.95, note)))
    elif a.is_blurry:
        # No confident kernel: defocus guess + a blind line-prior estimate.
        sigma = float(np.clip(1.0 * s * (BLUR_VAR_MIN / max(a.sharpness, 1.0)) ** 0.25, 0.8, 3.0))
        plan.append(
            (
                0.85,
                lambda: Candidate(
                    "rl_gauss",
                    _bgr(_u8(richardson_lucy(_f32(lit), gaussian_psf(sigma), iters=8))),
                    0.85,
                    {"psf": "gauss", "sigma": round(sigma, 2)},
                ),
            )
        )
        if "blind_rl" not in DROP_VARIANTS:
            guess_len = max(3.0, 0.08 * lit.shape[1])
            psf0 = motion_psf(guess_len, 0.0)

            def _blind() -> Candidate:
                fb, _ = blind_rl(_f32(lit), psf0, support=line_support(psf0.shape, 0.0, fat=1))
                return Candidate("blind_rl", _bgr(_u8(fb)), 0.8, {"psf": "blind", "size": psf0.shape[0]})

            plan.append((0.8, _blind))
    else:
        plan.append((0.9, lambda: Candidate("unsharp", _bgr(unsharp(lit)), 0.9)))

    # super-resolution for tiny crops (optional external service)
    if use_sr and SR_URL and a.h < SR_MAX_H:

        def _sr() -> Candidate | None:
            sr = super_resolve(crop_bgr)
            if sr is None:
                return None
            g, _ = upscale(clahe(auto_gamma(to_gray(sr))))
            return Candidate("esrgan", _bgr(g), 0.95)

        plan.append((0.95, _sr))

    # Scenario C — IR bloom: three extra hypotheses competing by prior with
    # the standard variants (base is never dropped; a 0.95 deblur outranks a
    # 0.85 bloom). They start from the raw upscaled grey (deskewed like
    # base), not from `lit`.
    if (BLOOM_ENABLED if bloom is None else bloom) and a.is_bloom_for(night):
        raw = deskew(up, angle) if angle else up

        def _bloom_gamma() -> Candidate:
            bg, gamma = bloom_gamma(raw, a.field_lum)
            return Candidate("bloom_gamma", _bgr(bg), BLOOM_PRIOR, {"gamma": round(gamma, 2)})

        plan += [
            (BLOOM_PRIOR, _bloom_gamma),
            (
                BLOOM_PRIOR,
                lambda: Candidate(
                    "bloom_thin", _bgr(bloom_thin(raw, s)), BLOOM_PRIOR, {"erode_px": int(np.clip(round(s), 1, 3))}
                ),
            ),
            (BLOOM_PRIOR, lambda: Candidate("bloom_thresh", _bgr(bloom_thresh(raw, s)), BLOOM_PRIOR)),
        ]

    return _build_within(plan, max_variants), a


# ═══════════════════════════════════════════════════════════════════════════
# Self-test: synthesise a blur, check the estimator finds it, check Wiener/RL
# sharpen it. `python plate_enhance.py` — no models needed.
# ═══════════════════════════════════════════════════════════════════════════


def _synthetic_plate(
    text: str = "GJ01AB1234", h: int = 60, w: int = 220, thickness: int = 2, scale: float = 1.1
) -> np.ndarray:
    img = np.full((h, w), 235, np.uint8)
    cv2.putText(img, text, (8, int(h * 0.72)), cv2.FONT_HERSHEY_DUPLEX, scale, 20, thickness, cv2.LINE_AA)
    return img


def _synthetic_bloom(text: str = "GJ11CQ7992", h: int = 44, w: int = 150, pad: int = 10) -> np.ndarray:
    """IR-night look-alike: black vehicle margin, a field near saturation and
    glyphs the bloom has half filled (grey, 1-px strokes)."""
    field = np.full((h, w), 246, np.uint8)
    cv2.putText(field, text, (6, int(h * 0.72)), cv2.FONT_HERSHEY_SIMPLEX, 0.95, 100, 1, cv2.LINE_AA)
    img = np.full((h + 2 * pad, w + 2 * pad), 18, np.uint8)
    img[pad : pad + h, pad : pad + w] = field
    return img


def degrade(
    gray: np.ndarray,
    length: float,
    angle: float,
    noise_sigma: float = 4.0,
    jpeg_q: int | None = 70,
    dark_gamma: float | None = None,
) -> np.ndarray:
    psf = motion_psf(length, angle)
    f = cv2.filter2D(gray.astype(np.float32), -1, psf, borderType=cv2.BORDER_REPLICATE)
    if dark_gamma:
        f = 255.0 * (f / 255.0) ** dark_gamma
    if noise_sigma > 0:
        f = f + np.random.normal(0, noise_sigma, f.shape)
    out = np.clip(f, 0, 255).astype(np.uint8)
    if jpeg_q:
        ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, int(jpeg_q)])
        if ok:
            out = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    return out


if __name__ == "__main__":
    np.random.seed(0)
    clean = _synthetic_plate()
    print(f"clean sharpness={sharpness(clean):.0f}")
    errs = []
    for L, th in [(6, 0), (10, 0), (14, 8), (9, -12), (18, 3), (7, 90)]:
        blurred = degrade(clean, L, th)
        a = assess(blurred)
        t0 = time.perf_counter()
        # night=False: a daytime synthetic — the Hershey strokes are thinner
        # than a real plate's and would otherwise trip the bloom gate here
        cands, _ = candidates(
            cv2.cvtColor(blurred, cv2.COLOR_GRAY2BGR), use_sr=False, assessment=a, night=False
        )
        ms = (time.perf_counter() - t0) * 1000
        est = f"L={a.motion_len:4.1f} deg={a.motion_deg:6.1f} z={a.motion_z:4.1f}"
        sharp = {c.name: round(sharpness(to_gray(c.image))) for c in cands}
        errs.append(abs(a.motion_len - L))
        print(f"true L={L:2d} deg={th:4d} | est {est} | {ms:5.1f} ms | sharpness {sharp}")
    print(f"mean |L err| = {np.mean(errs):.2f} px")

    # BLOOM: the IR-night look-alike must trip the flag and get the three
    # variants within the budget; bloom=False / night=False must not; a
    # daytime plate (colour, or grey with normal strokes) must never trip it.
    bl = cv2.cvtColor(_synthetic_bloom(), cv2.COLOR_GRAY2BGR)
    ab = assess(bl)
    print(
        f"bloom synthetic: mean_lum={ab.mean_lum:.0f} field_lum={ab.field_lum:.0f} chroma={ab.chroma:.1f} "
        f"glyph_frac={ab.glyph_frac:.3f} stroke_rel={ab.stroke_rel:.3f} bloom={ab.is_bloom} flags={ab.flags()}"
    )
    assert ab.is_bloom and ab.is_bloom_for(True) and not ab.is_bloom_for(False), "bloom flag"
    t0 = time.perf_counter()
    cb, _ = candidates(bl, use_sr=False, assessment=ab, night=True)
    ms = (time.perf_counter() - t0) * 1000
    names = [c.name for c in cb]
    print(f"bloom variants ({ms:.1f} ms): {names}")
    assert (
        {"bloom_gamma", "bloom_thin", "bloom_thresh"} <= set(names)
        and names[0] == "base"
        and len(names) <= MAX_VARIANTS
    ), names
    for kw in ({"bloom": False}, {"night": False}):
        cx, _ = candidates(bl, use_sr=False, assessment=ab, **kw)
        assert not any(c.name.startswith("bloom_") for c in cx), f"{kw} must give the pre-bloom variants"
    c3, _ = candidates(bl, use_sr=False, assessment=ab, night=True, max_variants=3)
    assert len(c3) == 3 and c3[0].name == "base", [c.name for c in c3]
    tint = np.array([0.82, 0.93, 1.0], np.float32)  # warm daylight white
    ad = assess((cv2.cvtColor(clean, cv2.COLOR_GRAY2BGR).astype(np.float32) * tint).astype(np.uint8))
    ag = assess(_synthetic_plate(thickness=5, scale=1.3))  # grey, normal stroke weight
    print(
        f"daytime colour plate: chroma={ad.chroma:.1f} bloom={ad.is_bloom} | grey bold plate: "
        f"glyph_frac={ag.glyph_frac:.3f} stroke_rel={ag.stroke_rel:.3f} bloom={ag.is_bloom}"
    )
    assert not ad.is_bloom and not ag.is_bloom, "bloom must not fire on daytime plates"
    print("plate_enhance self-test OK")
