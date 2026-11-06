"""
ablation_preprocess.py — which preprocessing step earns its place? Single-frame
OCR exact-match + CER on LABELLED plate crops, one condition at a time.

The audit question: the worker runs upscale → gamma → CLAHE → deskew, then up
to a dozen restoration hypotheses (inverted, log_clahe, retinex, blackhat,
wiener, rl_tv, rl_gauss, blind_rl, unsharp, bloom_*), reads them all and lets
the vote decide. Does any of that read MORE plates right than the raw crop,
and by how much? This script answers on crops a human labelled, reading each
variant ALONE so every step is scored on its own.

Conditions (per crop; the OCR is the worker's PRIMARY reader unless stated):
    none                 raw BGR crop → the OCR loader's own resize (no enhancement at all)
    resize_only          plate_enhance.upscale (cubic to 96 px high) — no CLAHE, no gamma
    base                 candidates()[0]: upscale → auto-gamma → CLAHE → deskew (the worker's variant #0)
    <variant>            each extra hypothesis plate_enhance.candidates(max_variants=12) produced,
                         read alone (inverted, log_clahe, retinex, blackhat, wiener, rl_tv, rl_gauss,
                         blind_rl, unsharp, bloom_gamma, bloom_thin, bloom_thresh); most are GATED on the
                         crop assessment, so each has an applicability count = crops that produced it
    two_line             the two-row split (bikes / trucks) read as top+bottom, when the split fires
    enhanced_best_valid  the worker's single-frame pick: every variant + two_line read in one batch,
                         best RULE-VALID read by weight (prior × OCR conf), else best read
    ensemble             the same pick over BOTH readers (PlateOcrEnsemble.from_env)
    oracle_any_variant   some variant of the primary reader read it right (headroom for a perfect selector)
    oracle_ensemble      some read of either reader was right

Numbers per condition: applicable n, exact n, exact % of applicable crops,
exact % of ALL crops (a variant that never fires cannot score), raw exact %
(the OCR's greedy text before plate_rules — shows how much the rules fix),
CER, rule-valid %, mean ms. Timing: OCR ms is a ONE-image read per variant;
prep ms is the variant's own preprocessing where it is separable (none /
resize_only), else the shared candidates() cost, reported once per crop.

Ground truth: DIR/labels.csv ("file,plate") or files named PLATE_anything.jpg.
Exact = whole normalised string equal (docs/ANPR_EVALUATION.md).

Run inside the worker container from this folder:
    python ablation_preprocess.py data/labelled [data/labelled_audit] [--max-variants 12]
Writes data/eval/ablation_<stamp>.json per directory.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
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
import anpr_metrics as M  # noqa: E402
import plate_enhance as enh  # noqa: E402
from plate_ocr import PlateOcr, PlateOcrEnsemble  # noqa: E402
from plate_rules import is_valid_plate  # noqa: E402

VARIANT_ORDER = [
    "inverted",
    "log_clahe",
    "retinex",
    "blackhat",
    "wiener",
    "rl_tv",
    "rl_gauss",
    "blind_rl",
    "unsharp",
    "esrgan",
    "bloom_gamma",
    "bloom_thin",
    "bloom_thresh",
]
FIXED_BEFORE = ["none", "resize_only", "base"]
FIXED_AFTER = ["two_line", "enhanced_best_valid", "ensemble", "oracle_any_variant", "oracle_ensemble"]
KEY_CONDITIONS = ["none", "resize_only", "base", "enhanced_best_valid", "ensemble", "oracle_any_variant"]


def load_labelled(d: str) -> list[tuple[str, str, str]]:
    """→ [(path, truth_normalised, truth_raw)] from labels.csv or PLATE_*.jpg names."""
    items = []
    csvp = os.path.join(d, "labels.csv")
    if os.path.exists(csvp):
        with open(csvp, newline="", encoding="utf-8") as f:
            for row in csv.reader(f):
                if (
                    len(row) >= 2
                    and row[0].strip()
                    and not row[0].startswith("#")
                    and row[0].strip().lower() != "file"
                ):
                    items.append((os.path.join(d, row[0].strip()), M.normalize_plate(row[1]), row[1]))
    else:
        for p in sorted(glob.glob(os.path.join(d, "*.jp*g")) + glob.glob(os.path.join(d, "*.png"))):
            m = re.match(r"^([A-Za-z0-9]{6,12})", os.path.basename(p))
            if m:
                items.append((p, M.normalize_plate(m.group(1)), m.group(1)))
    return items


def pick(reads):
    """The worker's single-frame decision: best rule-valid read by weight, else best read."""
    if not reads:
        return None
    return sorted(reads, key=lambda r: (r.valid, r.weight), reverse=True)[0]


def result(reads, truth: str, ms_prep, ms_ocr) -> dict:
    r = pick(reads)
    text = (r.corrected or r.text) if r else ""  # the string the worker would vote with (rule-corrected)
    raw = r.text if r else ""  # the OCR's greedy text before plate_rules
    return {
        "read": text,
        "raw": raw,
        "exact": M.exact_match(text, truth),
        "raw_exact": M.exact_match(raw, truth),
        "cer": M.cer(text, truth),
        "valid": bool(r and r.valid),
        "ms_prep": ms_prep,
        "ms_ocr": ms_ocr,
    }


def _bgr(gray: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


class Ablation:
    def __init__(self, primary: PlateOcr, ensemble: PlateOcrEnsemble, max_variants: int):
        self.ocr = primary
        self.ens = ensemble
        self.max_variants = max_variants
        self.rows: list[dict] = []

    def run_one(self, path: str, crop: np.ndarray, truth: str, truth_raw: str) -> None:
        pc = time.perf_counter
        res: dict[str, dict] = {}
        # none: the raw crop, resized by the OCR loader only
        t0 = pc()
        reads = self.ocr.read_many([crop], ["none"], [1.0])
        res["none"] = result(reads, truth, 0.0, (pc() - t0) * 1000)
        # resize_only: cubic upscale to the OCR-side height, nothing else
        t0 = pc()
        up, _ = enh.upscale(enh.to_gray(crop))
        img = _bgr(up)
        t1 = pc()
        reads = self.ocr.read_many([img], ["resize_only"], [1.0])
        res["resize_only"] = result(reads, truth, (t1 - t0) * 1000, (pc() - t1) * 1000)
        # the worker's variants (base = #0)
        t0 = pc()
        cands, a = enh.candidates(crop, use_sr=False, max_variants=self.max_variants)
        ms_cands = (pc() - t0) * 1000
        per_variant_reads = []
        for c in cands:
            t1 = pc()
            reads = self.ocr.read_many([c.image], [c.name], [c.prior])
            res[c.name] = result(reads, truth, ms_cands if c.name == "base" else None, (pc() - t1) * 1000)
            per_variant_reads.extend(reads)
        # two-row split (the worker adds this read to the same frame's vote)
        rows2 = enh.split_two_line(enh.to_gray(cands[0].image), a.inverted) if cands else None
        two_reads = []
        if rows2 is not None:
            t1 = pc()
            r2 = self.ocr.read_two_line(rows2[0], rows2[1])
            two_reads = [r2] if r2 is not None else []
            res["two_line"] = result(two_reads, truth, None, (pc() - t1) * 1000)
        # enhanced_best_valid: ONE batched read of all variants (the worker's real single-frame cost) + two_line
        t1 = pc()
        batch = self.ocr.read_many(
            [c.image for c in cands], [c.name for c in cands], [c.prior for c in cands]
        )
        ms_batch = (pc() - t1) * 1000
        res["enhanced_best_valid"] = result(batch + two_reads, truth, ms_cands, ms_batch)
        # ensemble: both readers over the same batch (+ two_line from reader 0)
        t1 = pc()
        ens_reads = self.ens.read_many(
            [c.image for c in cands], [c.name for c in cands], [c.prior for c in cands]
        )
        ms_ens = (pc() - t1) * 1000
        res["ensemble"] = result(ens_reads + two_reads, truth, ms_cands, ms_ens)
        # oracles: did ANY hypothesis read it right?
        any_primary = any(M.exact_match(r.corrected or r.text, truth) for r in per_variant_reads + two_reads)
        any_ens = any_primary or any(M.exact_match(r.corrected or r.text, truth) for r in ens_reads)
        res["oracle_any_variant"] = {
            "read": truth if any_primary else "",
            "raw": "",
            "exact": any_primary,
            "raw_exact": None,
            "cer": 0.0 if any_primary else None,
            "valid": None,
            "ms_prep": None,
            "ms_ocr": None,
        }
        res["oracle_ensemble"] = {
            "read": truth if any_ens else "",
            "raw": "",
            "exact": any_ens,
            "raw_exact": None,
            "cer": 0.0 if any_ens else None,
            "valid": None,
            "ms_prep": None,
            "ms_ocr": None,
        }
        self.rows.append(
            {
                "file": os.path.basename(path),
                "truth": truth,
                "truth_raw": truth_raw,
                "truth_strict_valid": is_valid_plate(truth),
                "h": int(crop.shape[0]),
                "w": int(crop.shape[1]),
                "scenario": a.scenario,
                "flags": a.flags(),
                "variants": [c.name for c in cands],
                "ms_candidates": ms_cands,
                "conditions": res,
            }
        )

    # ── report ──
    def condition_names(self) -> list[str]:
        seen = {n for r in self.rows for n in r["conditions"]}
        mid = [v for v in VARIANT_ORDER if v in seen]
        extra = sorted(
            n for n in seen if n not in VARIANT_ORDER and n not in FIXED_BEFORE and n not in FIXED_AFTER
        )
        return [n for n in FIXED_BEFORE if n in seen] + mid + extra + [n for n in FIXED_AFTER if n in seen]

    def table(self) -> list[dict]:
        n_all = len(self.rows)
        out = []
        for name in self.condition_names():
            rs = [r["conditions"][name] for r in self.rows if name in r["conditions"]]
            n = len(rs)
            exact = sum(1 for x in rs if x["exact"])
            raw_ok = [x["raw_exact"] for x in rs if x["raw_exact"] is not None]
            valid = [x["valid"] for x in rs if x["valid"] is not None]
            out.append(
                {
                    "condition": name,
                    "applicable": n,
                    "exact": exact,
                    "exact_of_applicable": exact / n if n else None,
                    "exact_of_all": exact / n_all if n_all else None,
                    "raw_exact": (sum(raw_ok) / len(raw_ok)) if raw_ok else None,
                    "cer": M.mean(x["cer"] for x in rs),
                    "valid": (sum(valid) / len(valid)) if valid else None,
                    "ms_prep": M.mean(x["ms_prep"] for x in rs),
                    "ms_ocr": M.mean(x["ms_ocr"] for x in rs),
                }
            )
        return out

    def by_scenario(self) -> dict:
        out: dict[str, dict] = {}
        for r in self.rows:
            d = out.setdefault(r["scenario"], {"n": 0, **{k: 0 for k in KEY_CONDITIONS}})
            d["n"] += 1
            for k in KEY_CONDITIONS:
                if k in r["conditions"] and r["conditions"][k]["exact"]:
                    d[k] += 1
        return out

    def report(self, title: str) -> dict:
        n = len(self.rows)
        print(
            f"\n=== preprocessing ablation — {title} — n={n} crops, OCR primary {self.ocr.name}, ensemble {self.ens.name} ==="
        )
        if not n:
            print("NOT MEASURED — no labelled crops found")
            return {}
        tbl = self.table()
        cols = [
            ("condition", "condition"),
            ("applicable", "n"),
            ("exact", "exact"),
            ("exact_of_applicable", "exact%/n"),
            ("exact_of_all", "exact%/all"),
            ("raw_exact", "raw exact%"),
            ("cer", "CER"),
            ("valid", "valid%"),
            ("ms_prep", "prep ms"),
            ("ms_ocr", "ocr ms"),
        ]
        print(M.format_table(tbl, cols, pct={"exact_of_applicable", "exact_of_all", "raw_exact", "valid"}))
        print(
            "  exact%/n = of the crops that produced the variant; exact%/all = of all crops (a gated variant that never fires scores 0)"
        )
        print(
            "  raw exact% = the OCR's greedy text before plate_rules; prep ms for base = the whole candidates() call (shared by every variant)"
        )
        n_invalid = sum(1 for r in self.rows if not r["truth_strict_valid"])
        if n_invalid:
            print(
                f"  note: {n_invalid} truth label(s) are not strict-format Indian plates (kept as labelled): "
                + ", ".join(r["truth"] for r in self.rows if not r["truth_strict_valid"])
            )
        scn = self.by_scenario()
        print("\n  by scenario (exact counts):  " + "  ".join(f"{k}" for k in KEY_CONDITIONS))
        for s, d in sorted(scn.items(), key=lambda kv: -kv[1]["n"]):
            print(
                f"    {s:<13} n={d['n']:<4}" + "  ".join(f"{d[k]:>{max(4, len(k))}}" for k in KEY_CONDITIONS)
            )
        return {"table": tbl, "by_scenario": scn}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "dirs", nargs="+", help="labelled crop directories (labels.csv 'file,plate' or PLATE_*.jpg)"
    )
    ap.add_argument("--max-variants", type=int, default=12)
    ap.add_argument("--n", type=int, default=0, help="limit crops per directory (0 = all)")
    ap.add_argument("--out", default=os.path.join(HERE, "data", "eval"))
    args = ap.parse_args()

    primary = PlateOcr()
    ensemble = PlateOcrEnsemble.from_env()
    print(
        f"OCR primary: {primary.name} ({'gray' if primary.gray else 'rgb'}, {primary.slots} slots, constrained={primary.constrained}); "
        f"ensemble: {ensemble.name}; max_variants={args.max_variants}"
    )
    os.makedirs(args.out, exist_ok=True)
    for d in args.dirs:
        if not os.path.isdir(d):
            print(f"\n{d}: NOT MEASURED — directory does not exist (skipped)")
            continue
        items = load_labelled(d)
        if args.n:
            items = items[: args.n]
        ab = Ablation(primary, ensemble, args.max_variants)
        skipped = 0
        for p, truth, truth_raw in items:
            img = cv2.imread(p)
            if img is None or not truth:
                skipped += 1
                continue
            ab.run_one(p, img, truth, truth_raw)
        if skipped:
            print(f"{d}: {skipped} file(s) unreadable or without a truth — skipped")
        rep = ab.report(d)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = os.path.join(args.out, f"ablation_{os.path.basename(os.path.normpath(d))}_{stamp}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "kind": "ablation",
                    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "dir": d,
                    "n": len(ab.rows),
                    "ocr_primary": primary.name,
                    "ocr_ensemble": ensemble.name,
                    "max_variants": args.max_variants,
                    **rep,
                    "rows": ab.rows,
                },
                f,
                indent=1,
                ensure_ascii=False,
                default=str,
            )
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
