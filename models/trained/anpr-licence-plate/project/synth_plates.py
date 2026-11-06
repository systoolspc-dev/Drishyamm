"""
synth_plates.py — synthetic Indian plates that look like OUR cameras' mistakes.

Ten officer labels don't move a recogniser; ten labels plus five thousand
synthetic plates that oversample the confusions those labels revealed do.
This generator:

  • renders one-row (and some two-row) Indian plates — standard, no-series,
    Bharat series — with the state/district mix the cameras actually see
    (per-camera code histograms from the records) and character frequencies
    BOOSTED for the confusion pairs reported by /anpr/labels/stats
    (8↔B, 0↔D, 1↔I, 5↔S …);
  • degrades them the way our feeds do: motion kernels with (length, angle)
    SAMPLED from the worker's own cepstral estimates on live traffic, night
    gamma, glare, JPEG, resolution downscaled to the crop heights we really
    get (median 42 px), mild perspective and rotation;
  • writes images + a CSV in fast-plate-ocr format for export_labels.py to mix
    into the training set (val stays 100 % real).

    python synth_plates.py --n 3000 --confusions '[["8","B",12],["0","D",7]]'
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
import random

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover
    Image = ImageDraw = ImageFont = None

import plate_enhance as enh
from plate_rules import STATE_CODES

LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
DIGITS = "0123456789"
# The recogniser's character slots (v2 models: 10). Longer plates exist in the
# real world (3-letter series) but the model has no slot to put them in, and
# fast-plate-ocr refuses to train on them — see ANPR_SYSTEM.md, known limits.
MAX_LEN = int(os.getenv("ANPR_OCR_MAX_SLOTS", "10"))
GJ_DISTRICTS = [
    "01",
    "05",
    "06",
    "03",
    "18",
    "27",
    "11",
    "12",
    "21",
    "24",
    "38",
    "10",
    "02",
    "16",
    "15",
    "07",
    "23",
    "09",
    "13",
    "14",
]


def _fonts() -> list[str]:
    cands = []
    try:
        import matplotlib

        d = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
        cands += [
            os.path.join(d, f)
            for f in ("DejaVuSans-Bold.ttf", "DejaVuSansMono-Bold.ttf", "DejaVuSansCondensed-Bold.ttf")
        ]
    except Exception:  # noqa: BLE001
        pass
    cands += [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    ]
    return [c for c in cands if os.path.exists(c)]


# ── what the cameras see: kernels, sizes, codes from the records ─────────────


def sample_pool(records_dir: str) -> dict:
    kernels, heights, codes = [], [], {}
    for jp in glob.glob(os.path.join(records_dir, "*", "*", "*.json")):
        try:
            rec = json.load(open(jp, encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        a = (rec.get("meta") or {}).get("assessment") or {}
        if a.get("h"):
            heights.append(int(a["h"]))
        if a.get("motion_z", 0) >= 4 and a.get("motion_len", 0) >= 2.5:
            kernels.append((float(a["motion_len"]), float(a["motion_deg"])))
        p = rec.get("plate") or ""
        if len(p) >= 4 and p[:2] in STATE_CODES and p[2:4].isdigit():
            codes[p[:4]] = codes.get(p[:4], 0) + 1
    return {
        "kernels": kernels or [(4, 0), (7, 3), (10, -5), (14, 8)],
        "heights": heights or [30, 36, 42, 50, 60, 80],
        "codes": codes or {"GJ01": 5, "GJ05": 3, "GJ06": 3, "GJ18": 2, "GJ27": 2},
    }


# ── plate text with confusion-aware sampling ────────────────────────────────


def _boost(alphabet: str, confusions: list, base: float = 1.0) -> list[float]:
    w = {c: base for c in alphabet}
    for pair in confusions:
        a, b, n = pair[0], pair[1], float(pair[2]) if len(pair) > 2 else 1.0
        for c in (a, b):
            if c in w:
                w[c] += 0.5 * math.log1p(n)
    tot = sum(w.values())
    return [w[c] / tot for c in alphabet]


def make_text(rng: random.Random, pool: dict, confusions: list, max_len: int = MAX_LEN) -> tuple[str, str]:
    """→ (plate text, layout: 'std' | 'nos' | 'bh')

    Never longer than `max_len` (the recogniser's character slots, 10 on the v2
    models): a 3-letter-series plate like GJ01ABC1234 is 11 characters, which
    the model cannot emit — training on it only teaches it a truncation."""
    pl = _boost(LETTERS, confusions)
    pd = _boost(DIGITS, confusions)
    r = rng.random()
    if r < 0.08:
        yy = f"{rng.randint(21, 26):02d}"
        num = "".join(rng.choices(DIGITS, pd, k=4))
        k_suf = [k for k in (1, 2, 2) if 8 + k <= max_len] or [1]
        suf = "".join(rng.choices(LETTERS, pl, k=rng.choice(k_suf)))
        return f"{yy}BH{num}{suf}", "bh"
    codes, weights = zip(*pool["codes"].items())
    code = (
        rng.choices(codes, weights)[0]
        if rng.random() < 0.85
        else (rng.choice(sorted(STATE_CODES)) + rng.choice(GJ_DISTRICTS))
    )
    num = "".join(rng.choices(DIGITS, pd, k=4))
    if r < 0.14:
        return f"{code}{num}", "nos"
    k_ser = [k for k in (1, 2, 2, 2, 3) if len(code) + k + 4 <= max_len] or [1]
    series = "".join(rng.choices(LETTERS, pl, k=rng.choice(k_ser)))
    return f"{code}{series}{num}", "std"


# ── rendering ───────────────────────────────────────────────────────────────


def _painted_text(d, xy, text: str, f, rng: random.Random, fill, H: int) -> None:
    """Hand-painted look (autos, tempos, tractors): every glyph placed by eye —
    baseline wobble, uneven stroke width (the brush re-drawn with small
    offsets), slightly varying size and spacing, ink that is not quite black."""
    x, y = xy
    ink = tuple(max(0, min(255, c + rng.randint(-25, 25))) for c in fill)
    for ch in text:
        size = f.size + rng.randint(-int(H * 0.06), int(H * 0.06))
        fc = ImageFont.truetype(f.path, max(12, size))
        bb = d.textbbox((0, 0), ch, font=fc)
        wob = rng.uniform(-0.05, 0.05) * H
        strokes = rng.choice([1, 2, 2, 3])  # thicker = more brush passes
        for s in range(strokes):
            dx, dy = (rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5)) if s else (0.0, 0.0)
            d.text((x + dx - bb[0], y + wob + dy - bb[1]), ch, fill=ink, font=fc)
        x += (bb[2] - bb[0]) + rng.uniform(0.02, 0.12) * H  # uneven spacing


def render_plate(
    text: str, font_path: str, rng: random.Random, two_row: bool = False, style: str | None = None
) -> np.ndarray:
    """Clean plate: white/yellow field, dark glyphs, thin border, optional IND strip.
    style 'painted' = hand-painted (no border, no IND strip, wobbly brush glyphs) —
    the single biggest OCR domain gap on autos / tempos / tractors."""
    H = 160
    n = len(text)
    W = int(H * (2.6 if two_row else min(5.4, 1.1 + 0.42 * n)))
    if style is None:
        style = "painted" if rng.random() < 0.22 else "printed"
    bg = (245, 245, 235) if rng.random() < 0.8 else (250, 210, 60)  # private white / commercial yellow
    if style == "painted":
        # painted plates: yellow (commercial autos) far more often, field a bit dirty
        bg = (250, 205, 50) if rng.random() < 0.6 else (235, 235, 225)
        bg = tuple(max(0, c - rng.randint(0, 30)) for c in bg)
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    if style == "painted":
        fill = (25, 25, 35) if rng.random() < 0.85 else (160, 20, 20)  # black, sometimes red paint
        if rng.random() < 0.4:  # crude hand-drawn border
            d.rectangle(
                [rng.randint(1, 5), rng.randint(1, 5), W - rng.randint(2, 6), H - rng.randint(2, 6)],
                outline=fill,
                width=rng.choice([1, 2, 2, 4]),
            )
        f = ImageFont.truetype(font_path, int(H * (0.40 if two_row else 0.60)))
        if two_row:
            split = len(text) - 4
            for i, row in enumerate((text[:split], text[split:])):
                bb = d.textbbox((0, 0), row, font=f)
                _painted_text(d, ((W - (bb[2] - bb[0])) // 2, 10 + i * (H // 2)), row, f, rng, fill, H)
        else:
            bb = d.textbbox((0, 0), text, font=f)
            tw = bb[2] - bb[0] + 0.07 * H * len(text)
            while tw > W - 16 and f.size > 24:
                f = ImageFont.truetype(font_path, f.size - 4)
                bb = d.textbbox((0, 0), text, font=f)
                tw = bb[2] - bb[0] + 0.07 * H * len(text)
            _painted_text(d, (int((W - tw) / 2), int((H - (bb[3] - bb[1])) / 2)), text, f, rng, fill, H)
        return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    d.rectangle([2, 2, W - 3, H - 3], outline=(40, 40, 40), width=3)
    if rng.random() < 0.5:
        d.rectangle([4, 4, int(W * 0.09), H - 5], fill=(30, 70, 200))
        d.text((8, H // 2 - 8), "IND", fill=(255, 255, 255), font=ImageFont.truetype(font_path, 16))
    x0 = int(W * 0.12)
    if two_row:
        split = len(text) - 4
        rows = [text[:split], text[split:]]
        size = int(H * 0.40)
        f = ImageFont.truetype(font_path, size)
        for i, row in enumerate(rows):
            bbox = d.textbbox((0, 0), row, font=f)
            tw = bbox[2] - bbox[0]
            d.text(((W - tw) // 2 - bbox[0], 8 + i * (H // 2) - bbox[1] + 4), row, fill=(20, 20, 20), font=f)
    else:
        size = int(H * 0.62)
        f = ImageFont.truetype(font_path, size)
        bbox = d.textbbox((0, 0), text, font=f)
        tw = bbox[2] - bbox[0]
        while tw > W - x0 - 10 and size > 20:
            size -= 4
            f = ImageFont.truetype(font_path, size)
            bbox = d.textbbox((0, 0), text, font=f)
            tw = bbox[2] - bbox[0]
        d.text(
            (x0 + (W - x0 - tw) // 2 - bbox[0], (H - (bbox[3] - bbox[1])) // 2 - bbox[1]),
            text,
            fill=(20, 20, 20),
            font=f,
        )
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def degrade(img: np.ndarray, rng: random.Random, pool: dict) -> tuple[np.ndarray, dict]:
    """Our cameras' degradations, in the order they happen in the world."""
    h, w = img.shape[:2]
    p: dict = {}
    # perspective / rotation (mounting angle)
    ang = rng.uniform(-6, 6)
    p["rot"] = round(ang, 1)
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    img = cv2.warpAffine(img, M, (w, h), borderMode=cv2.BORDER_REPLICATE)
    if rng.random() < 0.5:
        dx = rng.uniform(-0.08, 0.08) * w
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst = np.float32([[dx, 0], [w - dx, 0], [w + dx * 0.5, h], [-dx * 0.5, h]])
        img = cv2.warpPerspective(
            img, cv2.getPerspectiveTransform(src, dst), (w, h), borderMode=cv2.BORDER_REPLICATE
        )
    # motion blur sampled from live traffic (kernel length is relative to the
    # real crop height it was measured on; scale to this render's height)
    if rng.random() < 0.6:
        L, deg = rng.choice(pool["kernels"])
        L = L * (h / 42.0) * rng.uniform(0.7, 1.3)
        img = cv2.filter2D(img, -1, enh.motion_psf(max(2.0, L), deg), borderType=cv2.BORDER_REPLICATE)
        p["motion"] = (round(L, 1), round(deg, 1))
    # lighting: night gamma / glare
    r = rng.random()
    if r < 0.3:
        g = rng.uniform(1.6, 2.6)
        img = (255 * (img / 255.0) ** g).astype(np.uint8)
        p["night_gamma"] = round(g, 2)
    elif r < 0.45:
        img = cv2.convertScaleAbs(img, alpha=rng.uniform(1.2, 1.6), beta=rng.uniform(20, 60))
        p["glare"] = True
    if rng.random() < 0.15:
        img = 255 - img
        p["inverted"] = True
    # IR night cameras (corp8_03/06/07 measured 2026-08-28): greyscale, the
    # retro-reflective field blown out to ~230-245 with a soft glow, strokes of
    # normal width, more sensor noise. The recogniser — not the restoration —
    # is what fails there (Q→0, dropped digits), so it needs to SEE this domain.
    elif rng.random() < 0.18:
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        g = 255.0 - (255.0 - g) * rng.uniform(0.55, 0.8)  # lift the field, keep strokes dark
        glow = cv2.GaussianBlur(np.clip(g - 160, 0, 255), (0, 0), rng.uniform(2.0, 4.0))
        g = np.clip(g + glow * rng.uniform(0.25, 0.6), 0, 255).astype(np.uint8)
        img = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
        p["ir_bloom"] = True
    # resolution: down to a real crop height, sensor noise, JPEG, back up
    th = int(rng.choice(pool["heights"]) * rng.uniform(0.8, 1.2))
    th = max(16, min(120, th))
    scale = th / h
    small = cv2.resize(img, (max(24, int(w * scale)), th), interpolation=cv2.INTER_AREA)
    if rng.random() < 0.7:
        sigma = rng.uniform(2, 9)
        small = np.clip(small.astype(np.float32) + np.random.normal(0, sigma, small.shape), 0, 255).astype(
            np.uint8
        )
        p["noise"] = round(sigma, 1)
    q = rng.randint(35, 85)
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, q])
    if ok:
        small = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    p["h"] = th
    p["jpeg_q"] = q
    return small, p


def generate(
    n: int, out_dir: str, confusions: list, records_dir: str, seed: int = 0, two_row_frac: float = 0.15
) -> str:
    rng = random.Random(seed)
    np.random.seed(seed)
    fonts = _fonts()
    if not fonts or Image is None:
        raise SystemExit("[synth] no TTF font / PIL available")
    pool = sample_pool(records_dir)
    img_dir = os.path.join(out_dir, "images")
    os.makedirs(img_dir, exist_ok=True)
    csv_path = os.path.join(out_dir, "synth.csv")
    rows = []
    for i in range(n):
        text, layout = make_text(rng, pool, confusions)
        two = layout != "bh" and rng.random() < two_row_frac
        clean = render_plate(text, rng.choice(fonts), rng, two_row=two)
        img, prm = degrade(clean, rng, pool)
        fn = f"synth_{seed}_{i:05d}.jpg"
        cv2.imwrite(os.path.join(img_dir, fn), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        rows.append({"image_path": f"images/{fn}", "plate_text": text})
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["image_path", "plate_text"])
        w.writeheader()
        w.writerows(rows)
    print(
        f"[synth] {n} plates → {csv_path}  (kernels sampled: {len(pool['kernels'])}, heights: {len(pool['heights'])}, codes: {len(pool['codes'])})"
    )
    return csv_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2000)
    ap.add_argument("--out", default=os.path.join(HERE, "data", "train", "ocr_synth"))
    ap.add_argument("--records", default=os.path.join(HERE, "data", "records"))
    ap.add_argument(
        "--confusions", default="[]", help='JSON list of [read, true, count] from /anpr/labels/stats'
    )
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    conf = [
        (c[0].split("→")[0], c[0].split("→")[1], c[1]) if isinstance(c[0], str) and "→" in c[0] else tuple(c)
        for c in json.loads(a.confusions)
    ]
    generate(a.n, a.out, conf, a.records, a.seed)
