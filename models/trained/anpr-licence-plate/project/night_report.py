#!/usr/bin/env python
"""night_report.py — per-camera night-reading report from ANPR records + review crops.

Night = 19:00-06:00 IST (IST = UTC+5:30).  --date is an IST calendar date; the
night hours of that date are 00:00-05:59 and 19:00-23:59 of the SAME IST date,
day hours are 06:00-18:59.  Record folders are named by the worker's local
(= UTC) date, so every folder is scanned and each file is placed by its `ts`.

Inputs   data/records/<UTC date>/<camera>/<stem>.json   posted reads
             + <stem>.jpg (vehicle snapshot) + <stem>_plate.jpg (plate crop)
         data/review/<UTC date>/*.json (+ .jpg plate crop)   rejected reads (legacy flat data/review/*.json too)
Outputs  data/reports/night_<date>.json   per-camera numbers, verdicts, hour coverage
         data/reports/night_<date>.jpg    contact sheet, one night tile per camera
Usage    docker exec -w /srv/anpr trinetra-anpr-trainer python night_report.py --date 2026-08-28
"""

import argparse
import collections
import datetime as dt
import glob
import json
import os
import sys

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
NIGHT_HOURS = [h for h in range(24) if h >= 19 or h < 6]
DAY_HOURS = [h for h in range(6, 19)]
DARK_LUM = 25.0  # median crop luminance below this = scene is dark (verdict threshold)

VERDICT_READS = "reads at night"
VERDICT_DARK = "no night reads (dark: median crop lum < 25)"
VERDICT_LIT = "no night reads (lit scene / no traffic - check feed)"
VERDICT_NODATA = "no night data"


# ----------------------------------------------------------------------------- helpers
def parse_ts(s):
    """ISO timestamp (UTC unless it carries an offset) -> aware datetime in IST, or None."""
    if not s:
        return None
    try:
        t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(IST)


def is_night(t):
    return t.hour >= 19 or t.hour < 6


def median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2.0


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def rnd(x, nd=2):
    return None if x is None else round(float(x), nd)


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


# ----------------------------------------------------------------------------- loading
# Both loaders read EVERY file on disk once (the review dir is thousands of small files on a
# bind mount — scanning it twice doubles the run time); the caller filters by IST date.
def load_records(root):
    """All posted reads on disk.  Returns list of dicts with `t` = aware IST datetime."""
    out = []
    for jp in glob.glob(os.path.join(root, "records", "*", "*", "*.json")):
        rec = load_json(jp)
        if not isinstance(rec, dict):
            continue
        t = parse_ts(rec.get("ts") or rec.get("recorded_at"))
        if t is None:
            continue
        a = (rec.get("meta") or {}).get("assessment") or {}
        base = jp[:-5]
        cam = rec.get("camera_code") or os.path.basename(os.path.dirname(jp))
        out.append(
            {
                "kind": "read",
                "camera": cam,
                "camera_name": rec.get("camera_name"),
                "plate": rec.get("plate") or rec.get("raw"),
                "confidence": float(rec.get("confidence") or 0.0),
                "t": t,
                "night": is_night(t),
                "scenario": a.get("scenario") or "?",
                "flags": list(a.get("flags") or []),
                "mean_lum": None if a.get("mean_lum") is None else float(a["mean_lum"]),
                "h": a.get("h"),
                "w": a.get("w"),
                "motion_len": a.get("motion_len"),
                "vehicle_type": rec.get("vehicle_type") or (rec.get("meta") or {}).get("vehicle_type"),
                "json": jp,
                "vehicle_jpg": base + ".jpg" if os.path.exists(base + ".jpg") else None,
                "plate_jpg": base + "_plate.jpg" if os.path.exists(base + "_plate.jpg") else None,
            }
        )
    return out


def review_jsons(root):
    """Review files: data/review/<YYYY-MM-DD>/*.json (the worker's layout since
    2026-08-28, storage-perf spec §A.3) PLUS legacy flat data/review/*.json."""
    rd = os.path.join(root, "review")
    return glob.glob(os.path.join(rd, "*.json")) + glob.glob(os.path.join(rd, "????-??-??", "*.json"))


def load_review(root):
    """All rejected reads (review crops) on disk."""
    out = []
    for jp in review_jsons(root):
        rec = load_json(jp)
        if not isinstance(rec, dict):
            continue
        t = parse_ts(rec.get("ts"))
        if t is None:
            continue
        a = rec.get("assessment") or (rec.get("meta") or {}).get("assessment") or {}
        top = rec.get("top") or []
        conf = None
        if top and isinstance(top[0], (list, tuple)) and len(top[0]) > 1:
            try:
                conf = float(top[0][1])
            except Exception:
                conf = None
        base = jp[:-5]
        cam = rec.get("camera") or rec.get("camera_code") or os.path.basename(jp).split("_1")[0]
        out.append(
            {
                "kind": "reject",
                "camera": cam,
                "camera_name": rec.get("camera_name"),
                "plate": rec.get("consensus"),
                "confidence": conf if conf is not None else 0.0,
                "t": t,
                "night": is_night(t),
                "scenario": a.get("scenario") or "?",
                "flags": list(a.get("flags") or []),
                "mean_lum": None if a.get("mean_lum") is None else float(a["mean_lum"]),
                "h": a.get("h"),
                "w": a.get("w"),
                "motion_len": a.get("motion_len"),
                "vehicle_type": rec.get("vehicle_type"),
                "json": jp,
                "vehicle_jpg": None,
                "plate_jpg": base + ".jpg" if os.path.exists(base + ".jpg") else None,
            }
        )
    return out


def data_gaps(all_ts, min_gap_min=30):
    """Silences longer than min_gap_min between consecutive timestamps (reads + rejects, all dates).
    Any camera producing a reject counts as 'worker alive', so a gap here means the worker was
    down / not ingesting — not merely 'no traffic'."""
    ts = sorted(all_ts)
    gaps = []
    for a, b in zip(ts, ts[1:]):
        m = (b - a).total_seconds() / 60.0
        if m >= min_gap_min:
            gaps.append(
                {
                    "from_ist": a.strftime("%Y-%m-%d %H:%M"),
                    "to_ist": b.strftime("%Y-%m-%d %H:%M"),
                    "minutes": int(round(m)),
                    "_a": a,
                    "_b": b,
                }
            )
    return gaps


# ----------------------------------------------------------------------------- analysis
def acceptance(reads, rejects):
    n = reads + rejects
    return None if n == 0 else round(reads / n, 3)


def verdict_for(night_reads, night_rejects, night_reject_lum_med):
    if night_reads > 0:
        return VERDICT_READS
    if night_rejects == 0:
        return VERDICT_NODATA
    if night_reject_lum_med is not None and night_reject_lum_med < DARK_LUM:
        return VERDICT_DARK
    return VERDICT_LIT


GREY_SPREAD = 6.0  # mean |B-R| below this = effectively greyscale crop (IR / mono mode), per spec 5


def grey_stats(items, cap=80):
    """(fraction of crops that are greyscale, n crops measured) over the plate jpgs of `items`.
    Greyscale night crops mean the camera is in IR / monochrome mode; colour crops mean a lit scene."""
    try:
        import cv2
        import numpy as np
    except Exception:
        return None, 0
    n = g = 0
    for it in items[:cap]:
        p = it.get("plate_jpg")
        if not p:
            continue
        img = cv2.imread(p)
        if img is None or img.ndim != 3:
            continue
        spread = float(np.mean(np.abs(img[..., 0].astype(np.int16) - img[..., 2].astype(np.int16))))
        n += 1
        g += 1 if spread < GREY_SPREAD else 0
    return (g / n if n else None), n


def night_mode(grey_frac):
    if grey_frac is None:
        return None
    if grey_frac >= 0.6:
        return "ir/greyscale"
    if grey_frac <= 0.4:
        return "colour"
    return "mixed"


def analyse(date, reads, rejects, now_ist, first_ts, last_ts, gaps):
    cams = collections.defaultdict(lambda: {"reads": [], "rejects": []})
    names = {}
    for r in reads:
        cams[r["camera"]]["reads"].append(r)
        names.setdefault(r["camera"], r.get("camera_name"))
    for r in rejects:
        cams[r["camera"]]["rejects"].append(r)
        names.setdefault(r["camera"], r.get("camera_name"))

    per_cam = {}
    for cam in sorted(cams):
        R = cams[cam]["reads"]
        X = cams[cam]["rejects"]
        nR = [r for r in R if r["night"]]
        dR = [r for r in R if not r["night"]]
        nX = [x for x in X if x["night"]]
        dX = [x for x in X if not x["night"]]
        night_lum_med = median([r["mean_lum"] for r in nR])
        night_rej_lum_med = median([x["mean_lum"] for x in nX])
        scen = collections.Counter(r["scenario"] for r in nR)
        rej_scen = collections.Counter(x["scenario"] for x in nX)
        flags = collections.Counter(f for r in nR for f in r["flags"])
        best = max(nR, key=lambda r: r["confidence"]) if nR else None
        best_rej = max(nX, key=lambda x: x["confidence"]) if nX else None
        gfrac, gn = grey_stats(sorted(nR + nX, key=lambda x: x["t"], reverse=True))
        verdict = verdict_for(len(nR), len(nX), night_rej_lum_med)
        scen_s = ",".join(f"{k}:{v}" for k, v in rej_scen.most_common()) or "-"
        if verdict == VERDICT_READS:
            detail = (
                f"{len(nR)} posted / {len(nX)} rejected at night; best {best['plate']} c={best['confidence']:.2f} "
                f"{best['scenario']} lum {fmt(best['mean_lum'], 0)}"
            )
        elif verdict == VERDICT_NODATA:
            detail = (
                "no posted reads and no rejected crops in the night window (no traffic seen, or feed down)"
            )
        elif verdict == VERDICT_DARK:
            detail = (
                f"{len(nX)} rejected night crops, median crop lum {fmt(night_rej_lum_med, 0)} < {DARK_LUM:.0f}: "
                f"scene dark"
            )
        else:
            detail = (
                f"{len(nX)} rejected night crops (scenarios {scen_s}), median crop lum {fmt(night_rej_lum_med, 0)}: "
                f"vehicles ARE detected, OCR fails - not blind"
            )
        per_cam[cam] = {
            "camera_name": names.get(cam),
            "day_reads": len(dR),
            "day_rejects": len(dX),
            "day_acceptance": acceptance(len(dR), len(dX)),
            "night_reads": len(nR),
            "night_rejects": len(nX),
            "night_acceptance": acceptance(len(nR), len(nX)),
            "night_conf_mean": rnd(mean([r["confidence"] for r in nR]), 3),
            "night_lum_median": rnd(night_lum_med, 1),  # crop luminance of posted night reads
            "night_reject_lum_median": rnd(night_rej_lum_med, 1),  # crop luminance of rejected night reads
            "night_scenarios": dict(scen),
            "night_reject_scenarios": dict(rej_scen),
            "night_flags": dict(flags),
            "night_inverted_frac": rnd(len([r for r in nR if "inverted" in r["flags"]]) / len(nR), 2)
            if nR
            else None,
            "night_hours_with_reads": sorted({r["t"].hour for r in nR}),
            "night_hours_with_rejects": sorted({x["t"].hour for x in nX}),
            "night_grey_frac": rnd(
                gfrac, 2
            ),  # share of night plate crops that are greyscale (mean |B-R| < 6)
            "night_grey_n": gn,
            "night_mode": night_mode(gfrac),  # 'ir/greyscale' | 'colour' | 'mixed' | None
            "verdict": verdict,
            "verdict_detail": detail,
            "contact": None,
        }
        pick = best or best_rej
        if pick:
            per_cam[cam]["contact"] = {
                "kind": pick["kind"],
                "plate": pick["plate"],
                "confidence": rnd(pick["confidence"], 3),
                "scenario": pick["scenario"],
                "mean_lum": rnd(pick["mean_lum"], 1),
                "h": pick["h"],
                "w": pick["w"],
                "ts_ist": pick["t"].strftime("%Y-%m-%d %H:%M:%S IST"),
                "vehicle_jpg": pick["vehicle_jpg"],
                "plate_jpg": pick["plate_jpg"],
            }

    # hours (IST) of the requested date
    hours = {}
    for h in range(24):
        hours[f"{h:02d}"] = {
            "reads": sum(1 for r in reads if r["t"].hour == h),
            "rejects": sum(1 for x in rejects if x["t"].hour == h),
            "window": "night" if h in NIGHT_HOURS else "day",
        }
    day_start = dt.datetime.combine(date, dt.time(0, 0), tzinfo=IST)
    hours_covered, hours_no_data, hours_future = [], [], []
    for h in range(24):
        k = f"{h:02d}"
        if hours[k]["reads"] + hours[k]["rejects"] > 0:
            hours_covered.append(k)
        elif day_start + dt.timedelta(hours=h) > now_ist:
            hours_future.append(k)
        else:
            hours_no_data.append(k)

    def tot(sel):
        r = sum(1 for x in reads if sel(x))
        j = sum(1 for x in rejects if sel(x))
        return {"reads": r, "rejects": j, "acceptance": acceptance(r, j)}

    totals = {
        "day": tot(lambda x: not x["night"]),
        "night": tot(lambda x: x["night"]),
        "all": tot(lambda x: True),
        "cameras_total": len(per_cam),
        "cameras_reading_at_night": sum(1 for c in per_cam.values() if c["night_reads"] > 0),
        "cameras_no_night_reads": sorted(c for c, v in per_cam.items() if v["night_reads"] == 0),
    }
    day_end = day_start + dt.timedelta(days=1)
    notes = []
    if first_ts is not None and first_ts > day_start:
        notes.append(
            f"earliest data on disk is {first_ts.strftime('%Y-%m-%d %H:%M IST')}; "
            f"hours of {date} before that cannot have data (worker not running / not yet recording)"
        )
    if last_ts is not None and last_ts < day_end:
        notes.append(f"latest data on disk is {last_ts.strftime('%Y-%m-%d %H:%M IST')}")
    # silences that overlap this IST date (worker down: no reads AND no rejects from any camera)
    gaps_today = []
    for g in gaps:
        if g["_a"] < day_end and g["_b"] > day_start:
            gaps_today.append({k: v for k, v in g.items() if not k.startswith("_")})
            notes.append(f"NO DATA from any camera {g['from_ist']} to {g['to_ist']} IST ({g['minutes']} min)")
    return {
        "date_ist": str(date),
        "night_window": "19:00-06:00 IST (hours 19-23 and 00-05 of the same IST date)",
        "generated_at_ist": now_ist.strftime("%Y-%m-%d %H:%M:%S IST"),
        "hours": hours,
        "hours_covered": hours_covered,
        "hours_no_data": hours_no_data,
        "hours_not_yet_occurred": hours_future,
        "night_hours_covered": [h for h in hours_covered if int(h) in NIGHT_HOURS],
        "night_hours_missing": [h for h in hours_no_data + hours_future if int(h) in NIGHT_HOURS],
        "data_gaps_over_30min": gaps_today,
        "coverage_notes": notes,
        "totals": totals,
        "cameras": per_cam,
    }


# ----------------------------------------------------------------------------- contact sheet
def contact_sheet(report, out_jpg):
    try:
        import cv2
        import numpy as np
    except Exception as e:  # pragma: no cover
        print(f"[contact sheet skipped: {e}]")
        return None
    W, LAB_H, VEH_H, PL_H = 320, 46, 240, 100
    FONT = cv2.FONT_HERSHEY_SIMPLEX

    def fit(img, w, h):
        canvas = np.zeros((h, w, 3), np.uint8)
        if img is None:
            return canvas
        ih, iw = img.shape[:2]
        s = min(w / iw, h / ih)
        nw, nh = max(1, int(iw * s)), max(1, int(ih * s))
        r = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_CUBIC if s > 1 else cv2.INTER_AREA)
        x0, y0 = (w - nw) // 2, (h - nh) // 2
        canvas[y0 : y0 + nh, x0 : x0 + nw] = r
        return canvas

    def text(img, s, y, scale=0.42, color=(255, 255, 255)):
        cv2.putText(img, s, (4, y), FONT, scale, color, 1, cv2.LINE_AA)

    tiles = []
    for cam, c in report["cameras"].items():
        lab = np.zeros((LAB_H, W, 3), np.uint8)
        veh = np.zeros((VEH_H, W, 3), np.uint8)
        pl = np.zeros((PL_H, W, 3), np.uint8)
        k = c.get("contact")
        v = c["verdict"]
        vcol = (
            (80, 220, 80)
            if v == VERDICT_READS
            else ((60, 60, 230) if v.startswith("no night reads") else (160, 160, 160))
        )
        text(
            lab,
            f"{cam}  n={c['night_reads']} rej={c['night_rejects']}  d={c['day_reads']}  {c['night_mode'] or ''}",
            17,
            0.46,
        )
        if k:
            tag = "READ" if k["kind"] == "read" else "REJECT"
            lum = "-" if k["mean_lum"] is None else f"{k['mean_lum']:.0f}"
            text(
                lab,
                f"{tag} {k['plate']} | c={k['confidence']:.2f} | {k['scenario']} | lum {lum} | h{k['h']}",
                36,
                0.40,
                (255, 255, 255) if tag == "READ" else (90, 170, 255),
            )
            vimg = cv2.imread(k["vehicle_jpg"]) if k.get("vehicle_jpg") else None
            pimg = cv2.imread(k["plate_jpg"]) if k.get("plate_jpg") else None
            veh = fit(vimg, W, VEH_H)
            if vimg is None:
                text(veh, "no vehicle snapshot (rejected read)", 120, 0.45, (120, 120, 120))
            pl = fit(pimg, W, PL_H)
            text(veh, k["ts_ist"][11:], VEH_H - 8, 0.4, (200, 200, 200))
        else:
            text(veh, v, 120, 0.45, (120, 120, 120))
        short = {
            VERDICT_READS: "reads at night",
            VERDICT_DARK: "no night reads: DARK",
            VERDICT_LIT: "no night reads: lit/no traffic",
            VERDICT_NODATA: "no night data",
        }[v]
        cv2.rectangle(veh, (0, 0), (W - 1, 20), (0, 0, 0), -1)
        text(veh, short, 15, 0.45, vcol)
        tiles.append(np.vstack([lab, veh, pl]))
    if not tiles:
        return None
    cols = 4 if len(tiles) > 4 else len(tiles)
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i : i + cols]) for i in range(0, len(tiles), cols)]
    hdr = np.zeros((28, cols * W, 3), np.uint8)
    text(
        hdr,
        f"night report {report['date_ist']} IST  night=19:00-06:00  "
        f"tiles: best-confidence night read per camera (REJECT = no posted night read, best rejected crop)  "
        f"lum = plate-crop mean luminance",
        19,
        0.45,
        (230, 230, 230),
    )
    sheet = np.vstack([hdr] + rows)
    cv2.imwrite(out_jpg, sheet, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return sheet.shape


# ----------------------------------------------------------------------------- printing
def fmt(x, nd=2):
    if x is None:
        return "-"
    if isinstance(x, float):
        return f"{x:.{nd}f}"
    return str(x)


def print_table(rep):
    print(
        f"\nNIGHT REPORT  date={rep['date_ist']} (IST)  night=19:00-06:00 IST  generated {rep['generated_at_ist']}"
    )
    print(f"hours (IST) with data      : {', '.join(rep['hours_covered']) or 'none'}")
    print(f"hours with NO data at all  : {', '.join(rep['hours_no_data']) or 'none'}")
    print(f"hours not yet occurred     : {', '.join(rep['hours_not_yet_occurred']) or 'none'}")
    print(
        f"night hours covered        : {', '.join(rep['night_hours_covered']) or 'none'}"
        f"   missing: {', '.join(rep['night_hours_missing']) or 'none'}"
    )
    for n in rep.get("coverage_notes") or []:
        print(f"note                       : {n}")
    print("\nreads / rejects per IST hour:")
    line = "  " + " ".join(f"{h:>7s}" for h in rep["hours"])
    print(line)
    print(
        "  "
        + " ".join(f"{rep['hours'][h]['reads']:>3d}/{rep['hours'][h]['rejects']:<3d}" for h in rep["hours"])
    )
    print(
        "  " + " ".join(f"{('N' if rep['hours'][h]['window']=='night' else 'D'):>7s}" for h in rep["hours"])
    )

    hdr = (
        f"{'camera':10s} {'day rd':>6s} {'day rej':>7s} {'day acc':>7s} | {'nt rd':>5s} {'nt rej':>6s} {'nt acc':>6s} "
        f"{'nt conf':>7s} {'nt lum':>6s} {'rej lum':>7s} {'mode':>12s}  {'night scenarios':28s} verdict"
    )
    print("\n" + hdr)
    print("-" * len(hdr))
    for cam, c in rep["cameras"].items():
        scen = (
            ",".join(f"{k}:{v}" for k, v in sorted(c["night_scenarios"].items(), key=lambda kv: -kv[1]))
            or "-"
        )
        print(
            f"{cam:10s} {c['day_reads']:6d} {c['day_rejects']:7d} {fmt(c['day_acceptance']):>7s} | "
            f"{c['night_reads']:5d} {c['night_rejects']:6d} {fmt(c['night_acceptance']):>6s} "
            f"{fmt(c['night_conf_mean']):>7s} {fmt(c['night_lum_median'],1):>6s} {fmt(c['night_reject_lum_median'],1):>7s} "
            f"{(c['night_mode'] or '-'):>12s}  {scen[:28]:28s} {c['verdict']}"
        )
    t = rep["totals"]
    print("-" * len(hdr))
    print(
        f"{'TOTAL':10s} {t['day']['reads']:6d} {t['day']['rejects']:7d} {fmt(t['day']['acceptance']):>7s} | "
        f"{t['night']['reads']:5d} {t['night']['rejects']:6d} {fmt(t['night']['acceptance']):>6s}"
    )
    print(
        f"\ncameras: {t['cameras_total']} seen, {t['cameras_reading_at_night']} read at night; "
        f"no night reads: {', '.join(t['cameras_no_night_reads']) or 'none'}"
    )
    print(
        "acceptance = reads / (reads + rejects).  nt lum = median plate-crop mean_lum of posted night reads; "
        "rej lum = same for rejected night crops.\nmode = night plate crops greyscale (IR/mono) or colour "
        f"(mean |B-R| < {GREY_SPREAD:.0f} = greyscale)."
    )
    print("\nverdict detail:")
    for cam, c in rep["cameras"].items():
        print(f"  {cam:10s} {c['verdict_detail']}")


# ----------------------------------------------------------------------------- main
def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="IST calendar date YYYY-MM-DD (default: yesterday IST)")
    ap.add_argument("--root", default=os.path.join(here, "data"), help="data root (records/, review/)")
    ap.add_argument("--out", default=None, help="output dir (default <root>/reports)")
    ap.add_argument("--no-sheet", action="store_true", help="skip the contact sheet")
    args = ap.parse_args()

    now_ist = dt.datetime.now(IST)
    date = dt.date.fromisoformat(args.date) if args.date else (now_ist - dt.timedelta(days=1)).date()
    out_dir = args.out or os.path.join(args.root, "reports")
    os.makedirs(out_dir, exist_ok=True)

    reads_all = load_records(args.root)
    rejects_all = load_review(args.root)
    all_ts = [x["t"] for x in reads_all] + [x["t"] for x in rejects_all]
    first = min(all_ts) if all_ts else None
    last = max(all_ts) if all_ts else None
    gaps = data_gaps(all_ts)
    reads = [r for r in reads_all if r["t"].date() == date]
    rejects = [x for x in rejects_all if x["t"].date() == date]
    rep = analyse(date, reads, rejects, now_ist, first, last, gaps)
    rep["sources"] = {
        "records_root": os.path.join(args.root, "records"),
        "review_root": os.path.join(args.root, "review"),
        "records_on_disk": len(reads_all),
        "review_on_disk": len(rejects_all),
        "records_on_date": len(reads),
        "review_on_date": len(rejects),
        "earliest_data_on_disk_ist": first.strftime("%Y-%m-%d %H:%M:%S IST") if first else None,
        "latest_data_on_disk_ist": last.strftime("%Y-%m-%d %H:%M:%S IST") if last else None,
        "all_data_gaps_over_30min": [{k: v for k, v in g.items() if not k.startswith("_")} for g in gaps],
    }

    out_json = os.path.join(out_dir, f"night_{date}.json")
    out_jpg = os.path.join(out_dir, f"night_{date}.jpg")
    rep["contact_sheet"] = None
    if not args.no_sheet:
        shape = contact_sheet(rep, out_jpg)
        rep["contact_sheet"] = out_jpg if shape else None
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=1, ensure_ascii=False)

    print_table(rep)
    print(f"\nwrote {out_json}")
    print(f"wrote {rep['contact_sheet'] or '(no contact sheet: no cameras with data)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
