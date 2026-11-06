"""
anpr_metrics.py — pure metric functions shared by the ANPR evaluation scripts
(eval_labels.py, eval_e2e.py, ablation_preprocess.py, eval_detector.py).

No numpy, no cv2, no I/O: everything here is a plain function over Python
lists so it can be unit-tested (tests/test_metrics.py) and imported from any
image. The rules these functions encode are the honesty rules of the whole
evaluation suite:

  * A plate is RIGHT only when the WHOLE normalised string is equal. There is
    no partial credit in `exact_match`; partial credit lives in `cer` and is
    always reported next to it, never instead of it.
  * "Normalised" = upper-case, A–Z0–9 only (`normalize_plate`). Raw OCR text
    and normalised text are different things; callers keep both.
  * Anything that cannot be computed returns None (never 0.0, never a guess),
    so the caller can print "NOT MEASURED — <reason>".

Contents
  strings   normalize_plate, levenshtein, cer, exact_match, plate_error_rate,
            char_class, substitutions, length_delta, confusion_summary
  binomial  wilson_interval
  calib.    reliability_table, ece, threshold_sweep
  boxes     iou, match_boxes, precision_recall, average_precision, ap_at_iou,
            bucket_of
  misc      mean, format_table
"""

from __future__ import annotations

import math
import re
from collections import Counter

_NON_ALNUM = re.compile(r"[^A-Z0-9]")


# ═══════════════════════════════════════════════════════════════════════════
# strings
# ═══════════════════════════════════════════════════════════════════════════


def normalize_plate(s) -> str:
    """Upper-case A–Z0–9 only. 'gj-01 ab 1234' → 'GJ01AB1234'; None → ''."""
    return _NON_ALNUM.sub("", str(s or "").upper())


def levenshtein(a: str, b: str) -> int:
    """Edit distance (insert / delete / substitute, unit cost)."""
    a, b = str(a or ""), str(b or "")
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


def cer(read, truth, normalise: bool = True) -> float | None:
    """Character error rate = levenshtein(read, truth) / len(truth).
    None when the truth is empty (nothing to compare against). A missing read
    scores 1.0 (every character wrong), not None — an empty read IS a result."""
    r = normalize_plate(read) if normalise else str(read or "")
    t = normalize_plate(truth) if normalise else str(truth or "")
    if not t:
        return None
    return levenshtein(r, t) / len(t)


def exact_match(read, truth, normalise: bool = True) -> bool:
    """The whole normalised string is equal. Empty truth → False (no truth, no
    match). Empty read → False."""
    r = normalize_plate(read) if normalise else str(read or "")
    t = normalize_plate(truth) if normalise else str(truth or "")
    return bool(t) and r == t


def plate_error_rate(pairs) -> float | None:
    """1 − exact-match rate over (read, truth) pairs. None for no pairs."""
    pairs = list(pairs)
    if not pairs:
        return None
    return 1.0 - sum(1 for r, t in pairs if exact_match(r, t)) / len(pairs)


def char_class(c: str) -> str:
    """'L' letter slot, 'D' digit slot, '?' anything else."""
    if c.isalpha():
        return "L"
    if c.isdigit():
        return "D"
    return "?"


def substitutions(read, truth) -> list[tuple[int, str, str]]:
    """Per-position (pos, truth_char, read_char) mismatches for SAME-LENGTH
    pairs. Different lengths → [] (alignment would be a guess; those pairs are
    counted as dropped / inserted instead — see length_delta)."""
    r, t = normalize_plate(read), normalize_plate(truth)
    if not t or len(r) != len(t):
        return []
    return [(i, tc, rc) for i, (tc, rc) in enumerate(zip(t, r)) if tc != rc]


def length_delta(read, truth) -> int:
    """len(read) − len(truth) on normalised strings: <0 dropped, >0 inserted."""
    return len(normalize_plate(read)) - len(normalize_plate(truth))


def confusion_summary(pairs) -> dict:
    """Character-level error anatomy over (read, truth) pairs where the truth
    is known. Returns counts, never rates, so the caller chooses denominators:
        n            pairs considered (truth non-empty)
        n_wrong      pairs that are not an exact match
        n_same_len   wrong pairs with equal length (substitution-only errors)
        n_dropped    wrong pairs with len(read) < len(truth)
        n_inserted   wrong pairs with len(read) > len(truth)
        subs         Counter 'T→R' over same-length wrong pairs
        class_matrix Counter 'L→L' / 'L→D' / 'D→L' / 'D→D' (truth class → read class)
        by_position  Counter position (0-based) of substitutions
        by_slot_class Counter 'L' / 'D': substitutions in letter vs digit slots (truth class)
    """
    out = {
        "n": 0,
        "n_wrong": 0,
        "n_same_len": 0,
        "n_dropped": 0,
        "n_inserted": 0,
        "subs": Counter(),
        "class_matrix": Counter(),
        "by_position": Counter(),
        "by_slot_class": Counter(),
    }
    for read, truth in pairs:
        t = normalize_plate(truth)
        if not t:
            continue
        out["n"] += 1
        if exact_match(read, truth):
            continue
        out["n_wrong"] += 1
        d = length_delta(read, truth)
        if d < 0:
            out["n_dropped"] += 1
        elif d > 0:
            out["n_inserted"] += 1
        else:
            out["n_same_len"] += 1
            for pos, tc, rc in substitutions(read, truth):
                out["subs"][f"{tc}→{rc}"] += 1
                out["class_matrix"][f"{char_class(tc)}→{char_class(rc)}"] += 1
                out["by_position"][pos] += 1
                out["by_slot_class"][char_class(tc)] += 1
    return out


# ═══════════════════════════════════════════════════════════════════════════
# binomial confidence
# ═══════════════════════════════════════════════════════════════════════════


def wilson_interval(k: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """Wilson score interval for a proportion k/n. None when n == 0.
    Small label sets (n = 40) have wide intervals — print them."""
    if n <= 0:
        return None
    p = k / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


# ═══════════════════════════════════════════════════════════════════════════
# calibration
# ═══════════════════════════════════════════════════════════════════════════


def reliability_table(confs, corrects, n_bins: int = 10) -> list[dict]:
    """Equal-width confidence bins over [0, 1]. Each row: lo, hi, n, mean_conf,
    accuracy (None when empty), gap = accuracy − mean_conf. Confidence 1.0 goes
    into the last bin."""
    rows = [
        {"lo": i / n_bins, "hi": (i + 1) / n_bins, "n": 0, "sum_conf": 0.0, "sum_ok": 0}
        for i in range(n_bins)
    ]
    for c, ok in zip(confs, corrects):
        if c is None:
            continue
        c = float(c)
        b = min(n_bins - 1, max(0, int(c * n_bins)))
        rows[b]["n"] += 1
        rows[b]["sum_conf"] += c
        rows[b]["sum_ok"] += 1 if ok else 0
    out = []
    for r in rows:
        n = r["n"]
        mc = r["sum_conf"] / n if n else None
        acc = r["sum_ok"] / n if n else None
        out.append(
            {
                "lo": r["lo"],
                "hi": r["hi"],
                "n": n,
                "mean_conf": mc,
                "accuracy": acc,
                "gap": (acc - mc) if n else None,
            }
        )
    return out


def ece(confs, corrects, n_bins: int = 10) -> float | None:
    """Expected calibration error = Σ_b (n_b / N) · |acc_b − conf_b|. None for no samples."""
    table = reliability_table(confs, corrects, n_bins)
    total = sum(r["n"] for r in table)
    if total == 0:
        return None
    return sum(r["n"] / total * abs(r["accuracy"] - r["mean_conf"]) for r in table if r["n"])


def threshold_sweep(values, corrects, thresholds, higher_is_better: bool = True) -> list[dict]:
    """For each threshold t: keep samples with value ≥ t (or ≤ t) → kept,
    coverage = kept / N, precision = correct among kept (None when nothing
    kept). Samples whose value is None are excluded from N."""
    pairs = [(float(v), bool(ok)) for v, ok in zip(values, corrects) if v is not None]
    n = len(pairs)
    out = []
    for t in thresholds:
        kept = [ok for v, ok in pairs if (v >= t if higher_is_better else v <= t)]
        out.append(
            {
                "threshold": t,
                "n": n,
                "kept": len(kept),
                "coverage": (len(kept) / n) if n else None,
                "precision": (sum(kept) / len(kept)) if kept else None,
            }
        )
    return out


# ═══════════════════════════════════════════════════════════════════════════
# boxes (x1, y1, x2, y2)
# ═══════════════════════════════════════════════════════════════════════════


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a[:4]
    bx1, by1, bx2, by2 = b[:4]
    iw = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    ih = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union if union > 0 else 0.0


def match_boxes(pred_boxes, pred_scores, gt_boxes, iou_thr: float = 0.5) -> dict:
    """Greedy one-to-one matching: predictions in descending score order, each
    takes the still-unmatched GT with the highest IoU if that IoU ≥ iou_thr.
    Returns {"matches": [(pred_i, gt_i, iou)], "fp": [pred_i], "fn": [gt_i]}."""
    order = sorted(range(len(pred_boxes)), key=lambda i: -float(pred_scores[i]))
    taken = set()
    matches, fp = [], []
    for pi in order:
        best_j, best_iou = -1, 0.0
        for gj, g in enumerate(gt_boxes):
            if gj in taken:
                continue
            v = iou(pred_boxes[pi], g)
            if v > best_iou:
                best_j, best_iou = gj, v
        if best_j >= 0 and best_iou >= iou_thr:
            taken.add(best_j)
            matches.append((pi, best_j, best_iou))
        else:
            fp.append(pi)
    fn = [gj for gj in range(len(gt_boxes)) if gj not in taken]
    return {"matches": matches, "fp": fp, "fn": fn}


def precision_recall(tp: int, fp: int, fn: int) -> tuple[float | None, float | None]:
    p = tp / (tp + fp) if (tp + fp) else None
    r = tp / (tp + fn) if (tp + fn) else None
    return p, r


def average_precision(scores, tps, n_gt: int) -> float | None:
    """AP as the area under the precision envelope over recall (VOC 2010+
    "all points"): sort by score desc, cumulate TP/FP, make precision
    monotone from the right, integrate over recall steps. None when n_gt == 0."""
    if n_gt <= 0:
        return None
    order = sorted(range(len(scores)), key=lambda i: -float(scores[i]))
    tp = fp = 0
    prec, rec = [], []
    for i in order:
        if tps[i]:
            tp += 1
        else:
            fp += 1
        prec.append(tp / (tp + fp))
        rec.append(tp / n_gt)
    if not prec:
        return 0.0
    # envelope
    for i in range(len(prec) - 2, -1, -1):
        prec[i] = max(prec[i], prec[i + 1])
    ap, prev_r = 0.0, 0.0
    for p, r in zip(prec, rec):
        ap += (r - prev_r) * p
        prev_r = r
    return ap


def ap_at_iou(preds_by_image: dict, gts_by_image: dict, iou_thr: float = 0.5) -> dict:
    """preds_by_image: {img: [(box, score), ...]}, gts_by_image: {img: [box, ...]}.
    → {"ap", "n_gt", "n_pred", "tp", "fp", "fn", "precision", "recall"} at the
    given IoU, using every prediction (precision / recall are at score ≥ 0)."""
    scores, tps = [], []
    n_gt = sum(len(v) for v in gts_by_image.values())
    tp = fp = 0
    for img in set(preds_by_image) | set(gts_by_image):
        preds = preds_by_image.get(img, [])
        gts = gts_by_image.get(img, [])
        m = match_boxes([p[0] for p in preds], [p[1] for p in preds], gts, iou_thr)
        hit = {pi for pi, _, _ in m["matches"]}
        for pi, (box, score) in enumerate(preds):
            scores.append(score)
            tps.append(pi in hit)
        tp += len(m["matches"])
        fp += len(m["fp"])
    fn = n_gt - tp
    p, r = precision_recall(tp, fp, fn)
    return {
        "ap": average_precision(scores, tps, n_gt),
        "n_gt": n_gt,
        "n_pred": len(scores),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": p,
        "recall": r,
        "iou_thr": iou_thr,
    }


def bucket_of(value: float, edges, labels) -> str:
    """edges ascending, len(labels) == len(edges) + 1. value < edges[0] → labels[0], …"""
    for e, lab in zip(edges, labels):
        if value < e:
            return lab
    return labels[-1]


# ═══════════════════════════════════════════════════════════════════════════
# misc
# ═══════════════════════════════════════════════════════════════════════════


def mean(xs) -> float | None:
    xs = [float(x) for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def fmt(v, kind: str = "auto") -> str:
    """Cell formatter: None → 'n/a', floats → 3 dp, 'pct' → 'xx.x%'."""
    if v is None:
        return "n/a"
    if kind == "pct":
        return f"{100 * float(v):.1f}%"
    if isinstance(v, float):
        return f"{v:.3f}"
    return str(v)


def format_table(rows: list[dict], cols: list[tuple[str, str]], pct: set | None = None) -> str:
    """Plain-text table. cols = [(key, header), ...]; keys in `pct` print as
    percentages. Widths fit the content; no external deps."""
    pct = pct or set()
    cells = [[fmt(r.get(k), "pct" if k in pct else "auto") for k, _ in cols] for r in rows]
    heads = [h for _, h in cols]
    widths = [max(len(h), *(len(c[i]) for c in cells)) if cells else len(h) for i, h in enumerate(heads)]
    line = "  ".join(h.ljust(w) for h, w in zip(heads, widths))
    sep = "  ".join("-" * w for w in widths)
    body = ["  ".join(c.ljust(w) for c, w in zip(row, widths)) for row in cells]
    return "\n".join([line, sep] + body)
