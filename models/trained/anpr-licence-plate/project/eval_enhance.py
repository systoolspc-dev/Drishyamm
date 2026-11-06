"""
eval_enhance.py — measure, don't vibe (R14). Does the restoration stage make
OCR read MORE plates correctly, and by how much?

Three ways to get ground truth:

  --labelled DIR    real crops with known plates: files named PLATE_anything.jpg
                    or a labels.csv (file,plate) in DIR.
  --synth DIR       self-labelled: take the SHARP, well-lit crops from DIR whose
                    raw OCR read is rule-valid (that read = truth), then degrade
                    each one with a KNOWN motion blur / noise / JPEG / darkness /
                    downscale and see whether the pipeline gets the truth back.
                    Because the blur is known, the cepstral estimator is scored
                    too (|ΔL|, |Δθ|).
  --builtin         synthetic Hershey-font plates only (sanity; OCR models are
                    trained on real plates so absolute numbers are low here).

Pipelines compared per crop:
  raw       OCR on the crop as detected (old worker behaviour: CLAHE + upscale)
  enhanced  OCR on every enhancement variant, best rule-valid read wins
  oracle    ANY variant read it right (headroom: what a perfect selector would get)

Metrics: exact-match rate, character error rate (Levenshtein / len), rule-valid
rate, ms per crop. Writes data/eval/<stamp>.json and prints a table.

Run inside the container from this folder, e.g.:
    python eval_enhance.py --synth data/crops/raw --n 150
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plate_enhance as enh  # noqa: E402
from plate_ocr import PlateOcr, clean_text  # noqa: E402
from plate_rules import validate_or_correct  # noqa: E402


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def old_preprocess(crop):
    """The pre-enhancement worker recipe: upscale small crops + CLAHE."""
    h, w = crop.shape[:2]
    if max(h, w) < 200:
        crop = cv2.resize(crop, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
    elif max(h, w) < 320:
        crop = cv2.resize(crop, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def pick(reads):
    """Single-frame decision: best rule-valid read by weight, else best read."""
    if not reads:
        return None
    reads = sorted(reads, key=lambda r: (r.valid, r.weight), reverse=True)
    r = reads[0]
    return r.corrected or r.text


class Bench:
    def __init__(self, ocr: PlateOcr, use_sr: bool):
        self.ocr = ocr
        self.use_sr = use_sr
        self.rows = []

    def run_one(self, crop, truth, extra=None):
        t0 = time.perf_counter()
        raw_reads = self.ocr.read_many([old_preprocess(crop)], ["raw"], [1.0])
        t1 = time.perf_counter()
        cands, a = enh.candidates(crop, use_sr=self.use_sr)
        enh_reads = self.ocr.read_many(
            [c.image for c in cands], [c.name for c in cands], [c.prior for c in cands]
        )
        rows = enh.split_two_line(enh.to_gray(cands[0].image), a.inverted) if cands else None
        if rows is not None:
            r2 = self.ocr.read_two_line(rows[0], rows[1])
            if r2 is not None:
                enh_reads.append(r2)
        t2 = time.perf_counter()
        raw = pick(raw_reads)
        best = pick(enh_reads)
        any_right = any((r.corrected or r.text) == truth for r in enh_reads)
        winner = None
        for r in sorted(enh_reads, key=lambda r: (r.valid, r.weight), reverse=True):
            winner = r.variant
            break
        self.rows.append(
            {
                "truth": truth,
                "raw": raw,
                "enhanced": best,
                "oracle": any_right,
                "raw_ok": raw == truth,
                "enh_ok": best == truth,
                "raw_cer": levenshtein(raw or "", truth) / max(1, len(truth)),
                "enh_cer": levenshtein(best or "", truth) / max(1, len(truth)),
                "raw_valid": validate_or_correct(raw or "") is not None,
                "enh_valid": validate_or_correct(best or "") is not None,
                "winner": winner,
                "scenario": a.scenario,
                "flags": a.flags(),
                "ms_raw": (t1 - t0) * 1000,
                "ms_enh": (t2 - t1) * 1000,
                "n_variants": len(cands),
                **(extra or {}),
            }
        )

    def report(self):
        n = len(self.rows)
        if not n:
            print("no samples")
            return {}

        def rate(k):
            return sum(1 for r in self.rows if r[k]) / n

        def mean(k):
            return float(np.mean([r[k] for r in self.rows]))

        summary = {
            "n": n,
            "raw_exact": rate("raw_ok"),
            "enh_exact": rate("enh_ok"),
            "oracle_exact": rate("oracle"),
            "raw_cer": mean("raw_cer"),
            "enh_cer": mean("enh_cer"),
            "raw_valid": rate("raw_valid"),
            "enh_valid": rate("enh_valid"),
            "ms_raw": mean("ms_raw"),
            "ms_enh": mean("ms_enh"),
            "variants": mean("n_variants"),
        }
        by_scn = {}
        for r in self.rows:
            d = by_scn.setdefault(r["scenario"], {"n": 0, "raw": 0, "enh": 0, "oracle": 0})
            d["n"] += 1
            d["raw"] += r["raw_ok"]
            d["enh"] += r["enh_ok"]
            d["oracle"] += r["oracle"]
        wins = {}
        for r in self.rows:
            if r["enh_ok"]:
                wins[r["winner"]] = wins.get(r["winner"], 0) + 1
        summary["by_scenario"] = by_scn
        summary["winning_variants"] = wins
        if any("blur_err" in r for r in self.rows):
            summary["blur_len_err_px"] = float(np.mean([r["blur_err"] for r in self.rows if "blur_err" in r]))
            summary["blur_deg_err"] = float(
                np.mean([r["blur_deg_err"] for r in self.rows if "blur_deg_err" in r])
            )
            summary["blur_detected"] = float(
                np.mean([r["blur_detected"] for r in self.rows if "blur_detected" in r])
            )
        print("\n=== enhancement A/B (n=%d) ===" % n)
        print("                 raw      enhanced   oracle")
        print(
            "exact match   %6.1f%%   %6.1f%%   %6.1f%%"
            % (100 * summary["raw_exact"], 100 * summary["enh_exact"], 100 * summary["oracle_exact"])
        )
        print("char error    %6.3f    %6.3f" % (summary["raw_cer"], summary["enh_cer"]))
        print("rule-valid    %6.1f%%   %6.1f%%" % (100 * summary["raw_valid"], 100 * summary["enh_valid"]))
        print(
            "ms / crop     %6.1f    %6.1f   (%.1f variants avg)"
            % (summary["ms_raw"], summary["ms_enh"], summary["variants"])
        )
        for s, d in sorted(by_scn.items(), key=lambda kv: -kv[1]["n"]):
            print(
                "  %-12s n=%-4d raw %5.1f%%  enh %5.1f%%  oracle %5.1f%%"
                % (s, d["n"], 100 * d["raw"] / d["n"], 100 * d["enh"] / d["n"], 100 * d["oracle"] / d["n"])
            )
        print("  winning variants:", dict(sorted(wins.items(), key=lambda kv: -kv[1])))
        if "blur_len_err_px" in summary:
            print(
                "  blur estimator: |ΔL| = %.2f px, |Δθ| = %.1f°, detected %.0f%%"
                % (summary["blur_len_err_px"], summary["blur_deg_err"], 100 * summary["blur_detected"])
            )
        return summary


def load_labelled(d: str):
    items = []
    csvp = os.path.join(d, "labels.csv")
    if os.path.exists(csvp):
        with open(csvp, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) >= 2 and not row[0].startswith("#"):
                    items.append((os.path.join(d, row[0]), clean_text(row[1])))
    else:
        for p in sorted(glob.glob(os.path.join(d, "*.jp*g")) + glob.glob(os.path.join(d, "*.png"))):
            m = re.match(r"^([A-Za-z0-9]{6,12})", os.path.basename(p))
            if m:
                items.append((p, clean_text(m.group(1))))
    return items


def degrade_random(crop, rng):
    """One random CCTV-style degradation with its parameters (for scoring)."""
    gray = enh.to_gray(crop)
    L = float(rng.uniform(4, 16))
    th = float(rng.uniform(-12, 12)) if rng.random() < 0.85 else float(rng.uniform(70, 110))
    gamma = float(rng.choice([0.0, 0.0, 1.8, 2.4]))  # 0 = leave brightness alone
    p = {
        "L": L,
        "deg": th,
        "noise": float(rng.uniform(2, 8)),
        "q": int(rng.integers(35, 80)),
        "gamma": gamma or None,
        "down": float(rng.choice([1.0, 1.0, 0.7, 0.5])),
    }
    out = enh.degrade(gray, L, th, noise_sigma=p["noise"], jpeg_q=p["q"], dark_gamma=p["gamma"])
    if p["down"] < 1.0:
        h, w = out.shape
        out = cv2.resize(
            out, (max(16, int(w * p["down"])), max(8, int(h * p["down"]))), interpolation=cv2.INTER_AREA
        )
    return cv2.cvtColor(out, cv2.COLOR_GRAY2BGR), p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labelled")
    ap.add_argument("--synth")
    ap.add_argument("--builtin", action="store_true")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--sr", action="store_true", help="also try the Real-ESRGAN endpoint (ANPR_SR_URL)")
    ap.add_argument("--out", default=os.path.join(HERE, "data", "eval"))
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    ocr = PlateOcr()
    print("OCR:", ocr.name, "gray" if ocr.gray else "rgb")
    bench = Bench(ocr, use_sr=args.sr)

    if args.labelled:
        items = load_labelled(args.labelled)[: args.n]
        print(f"labelled: {len(items)} crops")
        for p, truth in items:
            img = cv2.imread(p)
            if img is not None:
                bench.run_one(img, truth)

    if args.synth:
        files = sorted(glob.glob(os.path.join(args.synth, "*.jp*g")))
        print(f"synth: scanning {len(files)} crops for sharp, valid-reading originals")
        picked = 0
        for p in files:
            img = cv2.imread(p)
            if img is None:
                continue
            a = enh.assess(img)
            if a.is_blurry or a.has_motion or a.is_dark or a.h < 18:
                continue
            r = ocr.read_many([old_preprocess(img)])
            truth = validate_or_correct(r[0].text) if r else None
            if not truth or (r and r[0].conf < 0.8):
                continue
            for _ in range(2):
                deg, prm = degrade_random(img, rng)
                a2 = enh.assess(deg)
                scale = deg.shape[0] / img.shape[0]
                bench.run_one(
                    deg,
                    truth,
                    {
                        "blur_err": abs(a2.motion_len - prm["L"] * scale),
                        "blur_deg_err": min(
                            abs(a2.motion_deg - prm["deg"]) % 180, 180 - abs(a2.motion_deg - prm["deg"]) % 180
                        ),
                        "blur_detected": bool(a2.has_motion),
                        "params": prm,
                    },
                )
                picked += 1
            if picked >= args.n:
                break
        print(f"synth: {picked} degraded samples from real crops")

    if args.builtin or not (args.labelled or args.synth):
        plates = [
            "GJ01AB1234",
            "GJ05CD5678",
            "MH12DE1433",
            "GJ18BH0099",
            "KA01MJ7788",
            "DL8CAF1234",
            "GJ27AZ4321",
        ]
        for i in range(args.n):
            t = plates[i % len(plates)]
            clean = enh._synthetic_plate(t, h=int(rng.integers(44, 72)), w=int(rng.integers(180, 260)))
            deg, prm = degrade_random(cv2.cvtColor(clean, cv2.COLOR_GRAY2BGR), rng)
            a2 = enh.assess(deg)
            scale = deg.shape[0] / clean.shape[0]
            bench.run_one(
                deg,
                t,
                {
                    "blur_err": abs(a2.motion_len - prm["L"] * scale),
                    "blur_deg_err": min(
                        abs(a2.motion_deg - prm["deg"]) % 180, 180 - abs(a2.motion_deg - prm["deg"]) % 180
                    ),
                    "blur_detected": bool(a2.has_motion),
                    "params": prm,
                },
            )

    summary = bench.report()
    os.makedirs(args.out, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(args.out, f"{stamp}.json"), "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "rows": bench.rows, "args": vars(args)}, f, indent=1, default=str)
    print("wrote", os.path.join(args.out, f"{stamp}.json"))


if __name__ == "__main__":
    main()
