"""
plate_verify.py — does the STRING the model produced actually look like the
PLATE in the picture? A second opinion that is independent of any OCR.

The OCR is a black box that maps pixels → text. Its mistakes are confident
("GJ11E7937" at 61 %). This verifier goes the other way: it RENDERS each
candidate string as a synthetic plate (bold near-monospace glyphs, same band
geometry as the crop) and measures how well that rendering correlates with
the real glyph mask, per character cell and overall. A wrong string renders
into shapes the crop does not contain, and scores low; the right string
scores high. The worker uses it three ways:

  • GATE      — a consensus whose rendering does not match the crop is not
                posted (it goes to review with the score attached),
  • TIE-BREAK — among the voter's top valid alternatives, prefer the one
                that matches the pixels when the voter itself is unsure,
  • EVIDENCE  — the per-character scores are stored with the sighting so an
                officer (and the retraining export) can see WHICH glyph the
                reader is unsure about.

Classical (masks + normalised cross-correlation), no training data needed;
`calibrate()` prints the score separation on the labelled crops so the gate
threshold is set from measurements, not guesses.
"""

from __future__ import annotations

import os
from functools import lru_cache

import cv2
import numpy as np

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover
    Image = ImageDraw = ImageFont = None

import plate_enhance as enh

_FONT_CANDIDATES = [
    os.getenv("ANPR_VERIFY_FONT", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
try:  # matplotlib ships DejaVu — present wherever ultralytics is
    import matplotlib

    _mpl = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
    _FONT_CANDIDATES += [
        os.path.join(_mpl, "DejaVuSansMono-Bold.ttf"),
        os.path.join(_mpl, "DejaVuSans-Bold.ttf"),
    ]
except Exception:  # noqa: BLE001
    pass

CELL_W, CELL_H = 32, 48  # canonical per-character cell
GLYPH_W, GLYPH_H = 24, 40  # every glyph (real or rendered) is normalised to its own box at this size
# Gate threshold. 0 = ADVISORY: scores are stored with every sighting and
# shown in review, nothing is blocked. Raise only after `python
# plate_verify.py data/labelled` shows true plates scoring clearly above
# wrong strings on YOUR cameras (see calibrate()).
MIN_SCORE = float(os.getenv("ANPR_VERIFY_MIN", "0"))


def font_path() -> str | None:
    for p in _FONT_CANDIDATES:
        if p and os.path.exists(p):
            return p
    return None


@lru_cache(maxsize=4)
def _font(size: int):
    fp = font_path()
    if fp is None or ImageFont is None:
        return None
    return ImageFont.truetype(fp, size)


# ── geometry ────────────────────────────────────────────────────────────────


def text_band(gray: np.ndarray, inverted: bool = False) -> tuple[int, int, int, int] | None:
    """Bounding box of the ink (glyphs) — trims plate border, screws, rim."""
    m = enh.text_mask(gray, inverted)
    h, w = m.shape
    rows = m.mean(1) / 255.0
    cols = m.mean(0) / 255.0
    r = np.where(rows > max(0.05, rows.max() * 0.2))[0]
    c = np.where(cols > max(0.03, cols.max() * 0.15))[0]
    if len(r) < 4 or len(c) < 8:
        return None
    y0, y1 = int(r[0]), int(r[-1]) + 1
    x0, x1 = int(c[0]), int(c[-1]) + 1
    if y1 - y0 < 6 or x1 - x0 < 12:
        return None
    return x0, y0, x1, y1


def _norm_glyph(mask: np.ndarray) -> np.ndarray | None:
    """Crop a binary glyph to its ink bounding box and resize to GLYPH_W×GLYPH_H
    → scale/translation invariant comparison. None if there is no ink."""
    ys, xs = np.where(mask > 0)
    if len(ys) < 6:
        return None
    g = mask[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    g = cv2.resize(g, (GLYPH_W, GLYPH_H), interpolation=cv2.INTER_AREA)
    return cv2.GaussianBlur(g.astype(np.float32) / 255.0, (0, 0), 1.5)


def segment_glyphs(mask: np.ndarray, expected: int) -> list[tuple[int, int]]:
    """Column-profile character segmentation of the text band → x-ranges.
    Runs of ink columns are glyphs; tiny gaps are joined (broken strokes),
    slivers are dropped (noise). If the count doesn't match `expected`
    (touching glyphs, dirt), fall back to equal cells."""
    h, w = mask.shape
    prof = mask.mean(0) / 255.0
    thr = max(0.04, prof.max() * 0.12)
    ink = prof > thr
    runs = []
    start = None
    for x, v in enumerate(ink):
        if v and start is None:
            start = x
        elif not v and start is not None:
            runs.append([start, x])
            start = None
    if start is not None:
        runs.append([start, w])
    merged: list[list[int]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= max(1, w // 120):
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    min_w = max(2, int(0.35 * w / max(expected, 1)) // 2)
    glyphs = [(a, b) for a, b in merged if b - a >= min_w]
    if len(glyphs) != expected:
        cw = w / expected
        glyphs = [(int(i * cw), int((i + 1) * cw)) for i in range(expected)]
    return glyphs


def crop_glyphs(gray: np.ndarray, n: int, inverted: bool = False) -> list[np.ndarray | None] | None:
    band = text_band(gray, inverted)
    if band is None:
        return None
    x0, y0, x1, y1 = band
    m = enh.text_mask(gray, inverted)[y0:y1, x0:x1]
    return [_norm_glyph(m[:, a:b]) for a, b in segment_glyphs(m, n)]


@lru_cache(maxsize=512)
def render_glyph(ch: str) -> np.ndarray | None:
    """One rendered glyph, normalised like the real ones."""
    f = _font(int(CELL_H * 0.9))
    canvas = np.zeros((CELL_H * 2, CELL_W * 3), np.uint8)
    if f is None:
        cv2.putText(canvas, ch, (10, CELL_H + 20), cv2.FONT_HERSHEY_DUPLEX, 1.6, 255, 4, cv2.LINE_AA)
    else:
        img = Image.new("L", (CELL_W * 3, CELL_H * 2), 0)
        ImageDraw.Draw(img).text((10, 10), ch, fill=255, font=f)
        canvas = np.array(img)
    return _norm_glyph(canvas)


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 1e-6 else 0.0


# ── scoring ─────────────────────────────────────────────────────────────────


def score(gray: np.ndarray, text: str, inverted: bool = False) -> tuple[float, list[float]]:
    """→ (overall, per-character NCC) of `text` rendered vs the crop's
    segmented glyphs. Each glyph weighs the same, so one wrong character
    costs 1/n — visible — instead of being averaged away."""
    text = "".join(ch for ch in str(text).upper() if ch.isalnum())
    if len(text) < 2:
        return 0.0, []
    glyphs = crop_glyphs(gray, len(text), inverted)
    if glyphs is None:
        return 0.0, []
    per = []
    for g, ch in zip(glyphs, text):
        ref = render_glyph(ch)
        per.append(round(_ncc(g, ref), 3) if (g is not None and ref is not None) else 0.0)
    return float(np.mean(per)), per


def compare(gray: np.ndarray, candidates: list[str], inverted: bool = False) -> list[dict]:
    """Score several candidate strings against one crop, best first."""
    out = []
    seen = set()
    for c in candidates:
        c = "".join(ch for ch in str(c or "").upper() if ch.isalnum())
        if not c or c in seen:
            continue
        seen.add(c)
        s, per = score(gray, c, inverted)
        out.append({"text": c, "score": round(s, 3), "per_char": per})
    out.sort(key=lambda d: -d["score"])
    return out


def two_row_score(
    gray_top: np.ndarray, gray_bottom: np.ndarray, text: str, inverted: bool = False, split: int | None = None
):
    """Two-row plates: score each row against its part of the string."""
    if split is None:
        split = len(text) - 4  # 'GJ01AB' | '1234' is the common layout
    s1, p1 = score(gray_top, text[:split], inverted)
    s2, p2 = score(gray_bottom, text[split:], inverted)
    n1, n2 = max(1, len(p1)), max(1, len(p2))
    return (s1 * n1 + s2 * n2) / (n1 + n2), p1 + p2


# ── calibration on labelled crops ───────────────────────────────────────────


def calibrate(labelled_dir: str, wrong_reads: dict[str, str] | None = None):
    """Print the score of the TRUE plate vs. plausible wrong strings on every
    labelled crop (data/labelled/PLATE_id.jpg). Choose ANPR_VERIFY_MIN where
    true scores sit above and wrong scores below."""
    import glob
    import re

    truths, wrongs = [], []
    for p in sorted(glob.glob(os.path.join(labelled_dir, "*.jp*g"))):
        m = re.match(r"^([A-Z0-9]{6,12})_", os.path.basename(p))
        if not m:
            continue
        truth = m.group(1)
        img = cv2.imread(p)
        if img is None:
            continue
        g = enh.to_gray(img)
        g, _ = enh.upscale(g)
        g = enh.clahe(enh.auto_gamma(g))
        inv = enh.looks_inverted(g)
        st, _ = score(g, truth, inv)
        # plausible wrong strings: swap two glyphs, shift a char, common confusions
        alts = [
            truth[:-1] + ("1" if truth[-1] != "1" else "7"),
            truth[0] + ("O" if truth[1] != "O" else "Q") + truth[2:],
            truth[:3] + truth[4:] + "0",
            (wrong_reads or {}).get(truth, ""),
        ]
        sw = [score(g, a, inv)[0] for a in alts if a and a != truth]
        truths.append(st)
        wrongs.extend(sw)
        print(f"{os.path.basename(p):32s} true={st:.3f}  wrong={[round(x, 2) for x in sw]}")
    if truths:
        print(f"\nTRUE : mean {np.mean(truths):.3f}  min {np.min(truths):.3f}")
    if wrongs:
        print(f"WRONG: mean {np.mean(wrongs):.3f}  max {np.max(wrongs):.3f}")
    if truths and wrongs:
        thr = (np.percentile(truths, 20) + np.percentile(wrongs, 80)) / 2
        print(f"suggested ANPR_VERIFY_MIN ≈ {thr:.2f}   (font: {font_path()})")


if __name__ == "__main__":
    import sys

    d = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "labelled")
    )
    print("font:", font_path())
    syn = enh._synthetic_plate("GJ01AB1234")
    for t in ("GJ01AB1234", "GJ01AB1Z34", "GJ11E7937", "MH02EK4082"):
        s, per = score(syn, t)
        print(f"synthetic crop vs {t:12s} score={s:.3f} per={per}")
    if os.path.isdir(d):
        calibrate(d)
