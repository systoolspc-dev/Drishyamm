"""
eval_night.py — A/B the IR-BLOOM path of plate_enhance on last night's crops
(spec §5b: bloom, not darkness, is the #1 night failure — measure, don't vibe).

Inputs (read-only):
  data/records/<date>/*/<stem>.json + <stem>_plate.jpg   posted reads: plate (the READ),
                                                         confidence, meta.assessment
  data/review/*.jpg + .json                              rejected candidates; night = json ts
                                                         in 19:00–06:00 IST. The Unix ts in the
                                                         filename pre-filters so the bind mount is
                                                         not asked for 6 500 JSON reads.
Bounded to --max crops (default 300): every night record plus a per-camera round-robin
of the night review crops, so every camera is represented.

Configs per crop — same OCR ensemble, same one-frame TrackVotes the reader lab uses,
the assessment computed once and shared:
  off       today's behaviour: candidates(bloom=False)
  on        candidates(bloom=True, night=True)  — production once the worker passes the
            scene flag (relaxed crop-mean gate 120)
  on_day    candidates(bloom=True, night=None)  — strict thresholds, no scene flag
  on_loose  as `on` with the thin-stroke test waived (BLOOM_REQUIRE_THIN=0). DIAGNOSTIC:
            do the variants help IR crops at all, independent of the gate?

Reported per config: rule-valid read rate, agreement with the recorded read where the
record confidence ≥ 0.9 (the reference the task asks for — note the spec itself says the
0.91 record GJ11C0799 is wrong), agreement over all records, exact match on the hand-
labelled plates (TRUTH), mean consensus confidence, how often the bloom gate fired and a
bloom variant won, reads changed vs `off`, ms per crop; then a per-camera table and the
per-record before/after lines. Writes data/tmp/eval_night.json.

    docker exec -w /srv/anpr trinetra-anpr-trainer python eval_night.py [--max 300] [--date 2026-08-27]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plate_enhance as enh  # noqa: E402
from plate_ocr import PlateOcrEnsemble  # noqa: E402
from plate_rules import validate_or_correct  # noqa: E402
from plate_votes import TrackVotes  # noqa: E402

DATA = os.path.join(HERE, "data")
IST = timezone(timedelta(hours=5, minutes=30))
NIGHT_FROM, NIGHT_TO = 19, 6  # IST hours, [19:00, 06:00)

# Hand labels — plates a person can read off the stored crop (checked against the
# 2026-08-27 record crops; spec §5b confirms GJ11CQ7992 and 26BH9249H). Keyed cam/stem.
TRUTH = {
    "corp8_03/214123_GJ18B7758": "GJ18BY7580",
    "corp8_06/192327_GJ11C0799": "GJ11CQ7992",
    "corp8_06/192534_GJ11E0799": "GJ11CQ7992",
    "corp8_06/192558_GJ11C0799": "GJ11CQ7992",
    "corp8_10/195138_26BH9249H": "26BH9249H",
}

# name, candidates() kwargs, BLOOM_REQUIRE_THIN
CONFIGS = [
    ("off", {"bloom": False}, True),
    ("on", {"bloom": True, "night": True}, True),
    ("on_day", {"bloom": True, "night": None}, True),
    ("on_loose", {"bloom": True, "night": True}, False),
]


def ist_night(dt: datetime) -> bool:
    h = dt.astimezone(IST).hour
    return h >= NIGHT_FROM or h < NIGHT_TO


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_records(date: str) -> list[dict]:
    items = []
    for jp in sorted(glob.glob(os.path.join(DATA, "records", date, "*", "*.json"))):
        pj = jp[:-5] + "_plate.jpg"
        if not os.path.exists(pj):
            continue
        with open(jp, encoding="utf-8") as f:
            d = json.load(f)
        ts = parse_ts(d["ts"])
        if not ist_night(ts):
            continue
        cam = d.get("camera_code") or os.path.basename(os.path.dirname(jp))
        key = f"{cam}/{os.path.basename(jp)[:-5]}"
        items.append(
            {
                "key": key,
                "path": pj,
                "cam": cam,
                "kind": "record",
                "ref": d.get("plate"),
                "ref_conf": float(d.get("confidence") or 0.0),
                "ts": ts.isoformat(),
                "rec_assess": (d.get("meta") or {}).get("assessment"),
                "truth": TRUTH.get(key),
            }
        )
    return items


def load_review(budget: int) -> tuple[list[dict], int]:
    """Night review crops, per-camera round-robin up to `budget`. Returns (items, n_night_total)."""
    cands = []
    # dated layout data/review/<YYYY-MM-DD>/ (storage-perf spec §A.3) + legacy flat files
    jpgs = glob.glob(os.path.join(DATA, "review", "*.jpg")) + glob.glob(
        os.path.join(DATA, "review", "????-??-??", "*.jpg")
    )
    for p in sorted(jpgs):
        parts = os.path.basename(p).split("_")
        try:
            ts = datetime.fromtimestamp(int(parts[2]), tz=timezone.utc)
        except (IndexError, ValueError):
            continue
        if ist_night(ts):
            cands.append(("_".join(parts[:2]), p, ts))
    queues: dict[str, list] = {}
    for cam, p, ts in cands:
        queues.setdefault(cam, []).append((p, ts))
    picked = []
    while len(picked) < budget and any(queues.values()):
        for cam in sorted(queues):
            if queues[cam] and len(picked) < budget:
                picked.append((cam, *queues[cam].pop(0)))
    items = []
    for cam, p, ts in picked:
        d = {}
        try:
            with open(p[:-4] + ".json", encoding="utf-8") as f:
                d = json.load(f)
        except Exception:  # noqa: BLE001 — a crop without json still counts
            pass
        if d.get("ts"):
            ts = parse_ts(d["ts"])
            if not ist_night(ts):
                continue
        top = (d.get("top") or [[None, 0.0]])[0]
        items.append(
            {
                "key": f"{cam}/{os.path.basename(p)[:-4]}",
                "path": p,
                "cam": d.get("camera") or cam,
                "kind": "review",
                "ref": d.get("consensus"),
                "ref_conf": 0.0,
                "ts": ts.isoformat(),
                "rec_assess": d.get("assessment"),
                "truth": None,
                "review_top_w": float(top[1] or 0.0),
            }
        )
    return items, len(cands)


def run_one(ocr, crop, a, kw: dict, require_thin: bool, two_line: bool = True) -> dict:
    """One crop, one config: candidates → batched OCR (+ two-row path) → one-frame vote."""
    old = enh.BLOOM_REQUIRE_THIN
    enh.BLOOM_REQUIRE_THIN = require_thin
    try:
        t0 = time.perf_counter()
        cands, _ = enh.candidates(crop, use_sr=False, assessment=a, **kw)
        t1 = time.perf_counter()
        reads = ocr.read_many([c.image for c in cands], [c.name for c in cands], [c.prior for c in cands])
        if two_line and cands:
            rows = enh.split_two_line(enh.to_gray(cands[0].image), a.inverted)
            if rows is not None:
                r2 = ocr.read_two_line(rows[0], rows[1])
                if r2 is not None:
                    reads.append(r2)
        t2 = time.perf_counter()
    finally:
        enh.BLOOM_REQUIRE_THIN = old
    tv = TrackVotes()
    primary = tv.add_frame(0, list(reads))
    c = tv.consensus()
    text = c.text if c else None
    corrected = validate_or_correct(text) if text else None
    names = [x.name for x in cands]
    best_valid = max((r for r in reads if r.valid), key=lambda r: r.weight, default=None)
    return {
        "text": text,
        "read": corrected or text,
        "valid": corrected is not None,
        "conf": round(c.confidence(1), 3) if c else 0.0,
        "primary_conf": round(primary.conf, 3) if primary else 0.0,
        "winner": primary.variant if primary else None,
        "bloom_fired": any(n.startswith("bloom_") for n in names),
        "bloom_won": bool(primary and primary.variant.startswith("bloom_")),
        "best_valid": (best_valid.corrected or best_valid.text) if best_valid else None,
        "best_valid_variant": best_valid.variant if best_valid else None,
        "variants": names,
        "n_reads": len(reads),
        "ms": (t2 - t0) * 1000.0,
        "ms_enh": (t1 - t0) * 1000.0,
    }


def summarize(items: list[dict], results: dict[str, list[dict]]) -> dict:
    ref_idx = [i for i, it in enumerate(items) if it["kind"] == "record" and it["ref_conf"] >= 0.9]
    rec_idx = [i for i, it in enumerate(items) if it["kind"] == "record"]
    tru_idx = [i for i, it in enumerate(items) if it.get("truth")]
    out = {}
    for cfg, rs in results.items():
        n = len(rs)
        valid_conf = [r["conf"] for r in rs if r["valid"]]
        out[cfg] = {
            "n": n,
            "valid": sum(r["valid"] for r in rs),
            "valid_rate": sum(r["valid"] for r in rs) / max(1, n),
            "mean_conf": float(np.mean([r["conf"] for r in rs])) if rs else 0.0,
            "mean_conf_valid": float(np.mean(valid_conf)) if valid_conf else 0.0,
            "ref_n": len(ref_idx),
            "ref_agree": sum(rs[i]["read"] == items[i]["ref"] for i in ref_idx),
            "rec_n": len(rec_idx),
            "rec_agree": sum(rs[i]["read"] == items[i]["ref"] for i in rec_idx),
            "truth_n": len(tru_idx),
            "truth_exact": sum(rs[i]["read"] == items[i]["truth"] for i in tru_idx),
            "bloom_fired": sum(r["bloom_fired"] for r in rs),
            "bloom_won": sum(r["bloom_won"] for r in rs),
            "bloom_won_valid": sum(r["bloom_won"] and r["valid"] for r in rs),
            "changed_vs_off": sum(rs[i]["read"] != results["off"][i]["read"] for i in range(n)),
            "gained_valid_vs_off": sum(rs[i]["valid"] and not results["off"][i]["valid"] for i in range(n)),
            "lost_valid_vs_off": sum(results["off"][i]["valid"] and not rs[i]["valid"] for i in range(n)),
            "ms_per_crop": float(np.mean([r["ms"] for r in rs])) if rs else 0.0,
            "variants_avg": float(np.mean([len(r["variants"]) for r in rs])) if rs else 0.0,
        }
    return out


def per_camera(items: list[dict], results: dict[str, list[dict]]) -> dict:
    cams: dict[str, dict] = {}
    for i, it in enumerate(items):
        d = cams.setdefault(
            it["cam"],
            {
                "n": 0,
                "records": 0,
                "grey": 0,
                "cfg": {c: {"valid": 0, "conf": [], "fired": 0, "won": 0} for c in results},
            },
        )
        d["n"] += 1
        d["records"] += it["kind"] == "record"
        d["grey"] += it["assess"]["chroma"] < enh.BLOOM_CHROMA
        for cfg, rs in results.items():
            r = rs[i]
            x = d["cfg"][cfg]
            x["valid"] += r["valid"]
            x["conf"].append(r["conf"])
            x["fired"] += r["bloom_fired"]
            x["won"] += r["bloom_won"]
    for d in cams.values():
        for x in d["cfg"].values():
            x["conf"] = float(np.mean(x["conf"])) if x["conf"] else 0.0
    return dict(sorted(cams.items()))


def print_report(items, results, summary, cams, n_night_review):
    cfgs = list(results)
    n_rec = sum(1 for it in items if it["kind"] == "record")
    print(
        f"\n=== night bloom A/B: n={len(items)} crops ({n_rec} records + {len(items) - n_rec} of {n_night_review} night review crops) ==="
    )
    print("%-34s" % "metric" + "".join("%10s" % c for c in cfgs))

    def row(label, fn):
        print("%-34s" % label + "".join("%10s" % fn(summary[c]) for c in cfgs))

    row("rule-valid read", lambda s: "%d (%.1f%%)" % (s["valid"], 100 * s["valid_rate"]))
    row("mean consensus conf", lambda s: "%.3f" % s["mean_conf"])
    row("mean conf | valid", lambda s: "%.3f" % s["mean_conf_valid"])
    row(
        "agree w/ record (conf>=0.9, n=%d)" % summary[cfgs[0]]["ref_n"],
        lambda s: "%d/%d" % (s["ref_agree"], s["ref_n"]),
    )
    row(
        "agree w/ record (all, n=%d)" % summary[cfgs[0]]["rec_n"],
        lambda s: "%d/%d" % (s["rec_agree"], s["rec_n"]),
    )
    row(
        "hand-truth exact (n=%d)" % summary[cfgs[0]]["truth_n"],
        lambda s: "%d/%d" % (s["truth_exact"], s["truth_n"]),
    )
    row("bloom gate fired", lambda s: "%d" % s["bloom_fired"])
    row("bloom variant won / valid", lambda s: "%d / %d" % (s["bloom_won"], s["bloom_won_valid"]))
    row("reads changed vs off", lambda s: "%d" % s["changed_vs_off"])
    row(
        "valid gained / lost vs off",
        lambda s: "+%d / -%d" % (s["gained_valid_vs_off"], s["lost_valid_vs_off"]),
    )
    row("ms per crop (enh+ocr)", lambda s: "%.0f" % s["ms_per_crop"])
    row("variants avg", lambda s: "%.1f" % s["variants_avg"])

    print(
        "\n--- per camera: n (records) grey | valid off/on/on_loose | conf off/on/on_loose | fired on/on_loose | won on/on_loose"
    )
    for cam, d in cams.items():
        c = d["cfg"]
        print(
            "  %-9s n=%3d (%2d) grey=%3d | valid %3d/%3d/%3d | conf %.2f/%.2f/%.2f | fired %3d/%3d | won %2d/%2d"
            % (
                cam,
                d["n"],
                d["records"],
                d["grey"],
                c["off"]["valid"],
                c["on"]["valid"],
                c["on_loose"]["valid"],
                c["off"]["conf"],
                c["on"]["conf"],
                c["on_loose"]["conf"],
                c["on"]["fired"],
                c["on_loose"]["fired"],
                c["on"]["won"],
                c["on_loose"]["won"],
            )
        )

    print(
        "\n--- records: recorded(conf) truth | off -> on -> on_loose [winner] | field_lum chroma glyph stroke"
    )
    for i, it in enumerate(items):
        if it["kind"] != "record":
            continue
        a = it["assess"]
        cells = []
        for c in ("off", "on", "on_loose"):
            r = results[c][i]
            cells.append(
                "%s%s(%.2f)[%s]" % (r["read"] or "-", "" if r["valid"] else "?", r["conf"], r["winner"])
            )
        print(
            "  %-9s %-24s %-11s(%.2f) %-11s | %s | fl %3.0f ch %4.1f gf %.2f sw %.3f"
            % (
                it["cam"],
                it["key"].split("/")[1],
                it["ref"],
                it["ref_conf"],
                it["truth"] or "-",
                " -> ".join(cells),
                a["field_lum"],
                a["chroma"],
                a["glyph_frac"],
                a["stroke_rel"],
            )
        )

    changed = [
        (i, it)
        for i, it in enumerate(items)
        if it["kind"] == "review" and results["on_loose"][i]["read"] != results["off"][i]["read"]
    ]
    print(f"\n--- review crops whose read changed under on_loose ({len(changed)}), first 25: off -> on_loose")
    for i, it in changed[:25]:
        ro, rl = results["off"][i], results["on_loose"][i]
        print(
            "  %-9s %-40s %s%s(%.2f) -> %s%s(%.2f)[%s]"
            % (
                it["cam"],
                it["key"].split("/")[1][:40],
                ro["read"] or "-",
                "" if ro["valid"] else "?",
                ro["conf"],
                rl["read"] or "-",
                "" if rl["valid"] else "?",
                rl["conf"],
                rl["winner"],
            )
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="2026-08-27", help="records/<date> folder (UTC day of the night)")
    ap.add_argument("--max", type=int, default=300, help="crop budget (records first, then review)")
    ap.add_argument("--out", default=os.path.join(DATA, "tmp", "eval_night.json"))
    ap.add_argument("--no-two-line", action="store_true")
    args = ap.parse_args()

    records = load_records(args.date)
    review, n_night_review = load_review(max(0, args.max - len(records)))
    items = (records + review)[: args.max]
    print(
        f"records: {len(records)}  night review: {len(review)} of {n_night_review}  → {len(items)} crops",
        flush=True,
    )
    if not items:
        print("nothing to evaluate")
        return

    t0 = time.time()
    ocr = PlateOcrEnsemble.from_env()
    print(
        f"OCR: {ocr.name}  slots={ocr.slots}  constrained={ocr.constrained}  ({time.time() - t0:.0f}s)",
        flush=True,
    )
    print(
        "bloom thresholds: lum>%g (night>%g) or field>%g; chroma<%g; glyph<%g or stroke<%g·h; prior %g"
        % (
            enh.BLOOM_LUM,
            enh.BLOOM_LUM_NIGHT,
            enh.BLOOM_FIELD_LUM,
            enh.BLOOM_CHROMA,
            enh.BLOOM_GLYPH_FRAC,
            enh.BLOOM_STROKE_REL,
            enh.BLOOM_PRIOR,
        ),
        flush=True,
    )

    results: dict[str, list[dict]] = {c: [] for c, _, _ in CONFIGS}
    kept = []
    t0 = time.time()
    for k, it in enumerate(items):
        crop = cv2.imread(it["path"])
        if crop is None or crop.size == 0:
            continue
        a = enh.assess(crop)
        it["assess"] = a.as_dict()
        it["bloom_spec_crop_gate"] = bool(
            a.chroma < enh.BLOOM_CHROMA
            and a.mean_lum > enh.BLOOM_LUM_NIGHT
            and (a.glyph_frac < enh.BLOOM_GLYPH_FRAC or a.stroke_rel < enh.BLOOM_STROKE_REL)
        )
        for cfg, kw, thin in CONFIGS:
            results[cfg].append(run_one(ocr, crop, a, kw, thin, two_line=not args.no_two_line))
        kept.append(it)
        if (k + 1) % 25 == 0:
            print(f"  {k + 1}/{len(items)} crops, {time.time() - t0:.0f}s", flush=True)
    items = kept

    summary = summarize(items, results)
    summary["_spec_crop_mean_gate_fires"] = sum(it["bloom_spec_crop_gate"] for it in items)
    cams = per_camera(items, results)
    print_report(items, results, summary, cams, n_night_review)
    print(
        f"\n(spec's crop-mean gate alone — mean_lum>{enh.BLOOM_LUM_NIGHT:g} & grey & thin — would fire on "
        f"{summary['_spec_crop_mean_gate_fires']} of {len(items)} crops)"
    )

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    rows = []
    for i, it in enumerate(items):
        rows.append(
            {k: v for k, v in it.items() if k != "path"} | {"results": {c: results[c][i] for c in results}}
        )
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(
            {
                "args": vars(args),
                "ocr": ocr.name,
                "configs": [c for c, _, _ in CONFIGS],
                "thresholds": {
                    "lum": enh.BLOOM_LUM,
                    "lum_night": enh.BLOOM_LUM_NIGHT,
                    "field_lum": enh.BLOOM_FIELD_LUM,
                    "chroma": enh.BLOOM_CHROMA,
                    "glyph_frac": enh.BLOOM_GLYPH_FRAC,
                    "stroke_rel": enh.BLOOM_STROKE_REL,
                    "prior": enh.BLOOM_PRIOR,
                },
                "summary": summary,
                "per_camera": cams,
                "rows": rows,
            },
            f,
            indent=1,
            default=str,
        )
    print("wrote", args.out)


if __name__ == "__main__":
    main()
