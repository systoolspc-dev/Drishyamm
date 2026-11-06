"""
eval_labels.py — the ANPR scorecard from what HUMANS said about posted reads.

Every officer / auditor verdict in anpr_labels is one ground-truth sample of
"the pipeline posted THIS string for THAT plate". This script turns those
samples into the numbers an audit asks for, and refuses to dress up numbers
it cannot support.

    HUMAN labels (officer ✓/✗ in Find-a-Vehicle, auditor labels from crops)
        → exact-match accuracy, CER, per camera / length / scenario / tier /
          frames / night, character confusions, dropped / inserted characters,
          reliability (confidence vs accuracy) + ECE, threshold sweeps
    AUTO labels (source='auto') are reported SEPARATELY and are NOT evidence
        of accuracy: they are the model's own confident reads written back as
        labels (POST /anpr/labels/auto — confirmed, ≥ 6 frames, agreement
        ≥ 0.95, both readers agreed). Their "accuracy" is 100 % by construction.

Sources (one login per run — the backend allows 10 logins per 15 min):
    --api                 (default) GET /api/ai/anpr/labels?limit=2000 +
                          GET /api/ai/anpr/labels/export (features per sighting)
                          + GET /api/ai/anpr/labels/stats (for the record)
    --from-json FILE      a pull saved earlier with --save-api FILE
    --csv FILE            plate_read,plate_true,verdict[,camera,confidence,frames,
                          agreement,length,top_weight,scenario,tier,night,source,note]

Enrichment: data/records/<date>/<cam>/*.json (the worker's evidence records)
are scanned for sighting_id → scene.night / ir, tier and features when the
API row has none. This is the ONLY source of the night flag — the label rows
do not carry the scene, only the crop assessment ('dark' flag), which is
reported as a separate proxy.

Honesty rules (docs/ANPR_EVALUATION.md):
  * exact = the whole normalised read equals the whole normalised truth;
  * raw strings are kept next to normalised ones in the output rows;
  * a bucket below --min-n is printed with its n but flagged 'small';
  * anything not computable prints "NOT MEASURED — <reason>".

Run inside the worker container from this folder:
    python eval_labels.py --api --save-api data/eval/labels_pull.json
    python eval_labels.py --from-json data/eval/labels_pull.json --min-n 8
    python eval_labels.py --csv my_labels.csv
Writes data/eval/labels_<stamp>.json.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import anpr_metrics as M  # noqa: E402

CONF_THRESHOLDS = [round(0.5 + 0.05 * i, 2) for i in range(10)]  # 0.50 … 0.95
FRAME_THRESHOLDS = [1, 2, 3, 4, 5, 6, 8]
FRAME_BUCKETS = [
    ("1", lambda n: n == 1),
    ("2", lambda n: n == 2),
    ("3-5", lambda n: 3 <= n <= 5),
    ("6+", lambda n: n >= 6),
]


# ═══════════════════════════════════════════════════════════════════════════
# sources
# ═══════════════════════════════════════════════════════════════════════════


def login_once(backend: str, email: str, password: str) -> str:
    import requests

    r = requests.post(f"{backend}/api/auth/login", json={"email": email, "password": password}, timeout=20)
    if r.status_code == 429:
        sys.exit("login rate-limited (10 per 15 min) — wait, or use --from-json on a saved pull")
    r.raise_for_status()
    return r.json()["token"]


def fetch_api(backend: str, token: str, limit: int) -> dict:
    import requests

    H = {"Authorization": f"Bearer {token}"}

    def get(path, **params):
        r = requests.get(f"{backend}{path}", headers=H, params=params, timeout=90)
        r.raise_for_status()
        return r.json()

    labels = get("/api/ai/anpr/labels", limit=limit)
    export = get(
        "/api/ai/anpr/labels/export", include_auto=0
    )  # anpr_labels rows only (human + auto), no ad-hoc pseudo-labels
    try:
        stats = get("/api/ai/anpr/labels/stats")
    except Exception as e:  # noqa: BLE001
        stats = {"error": str(e)[:200]}
    return {
        "pulled_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "backend": backend,
        "labels": labels.get("items", []),
        "export": export.get("items", []),
        "stats": stats,
    }


def scan_records(records_dir: str) -> dict[str, dict]:
    """sighting_id → what only the evidence record knows (scene.night/ir, tier, features)."""
    out: dict[str, dict] = {}
    if not records_dir or not os.path.isdir(records_dir):
        return out
    for jp in glob.glob(os.path.join(records_dir, "*", "*", "*.json")):
        try:
            with open(jp, encoding="utf-8") as f:
                rec = json.load(f)
        except Exception:  # noqa: BLE001
            continue
        sid = rec.get("sighting_id")
        if not sid:
            continue
        meta = rec.get("meta") or {}
        scene = meta.get("scene") or {}
        out[str(sid)] = {
            "night": scene.get("night"),
            "ir": scene.get("ir"),
            "lum": scene.get("lum"),
            "tier": rec.get("tier") or meta.get("tier"),
            "features": meta.get("features"),
            "frames": meta.get("frames"),
            "agreement": meta.get("agreement"),
            "top_weight": meta.get("top_weight"),
            "camera_code": rec.get("camera_code"),
            "assessment": meta.get("assessment"),
        }
    return out


def _labeller(source: str, note: str | None) -> str:
    if source == "auto":
        return "auto"
    return "auditor" if "audit" in (note or "").lower() else "officer"


def _num(v):
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def unify_api(pull: dict, recs: dict[str, dict]) -> list[dict]:
    feats_by_sid = {it.get("sighting_id"): it for it in pull.get("export", []) if it.get("sighting_id")}
    rows = []
    for l in pull.get("labels", []):
        sid = l.get("sighting_id")
        ex = feats_by_sid.get(sid, {})
        rec = recs.get(sid, {})
        feats = ex.get("features") or rec.get("features") or {}
        assessment = l.get("assessment") or ex.get("assessment") or rec.get("assessment") or {}
        source = (l.get("source") or "human").lower()
        verdict = (l.get("verdict") or "").lower()
        read_raw = l.get("plate_read")
        truth_raw = (
            l.get("plate_true") if l.get("plate_true") else (read_raw if verdict == "correct" else None)
        )
        rows.append(
            {
                "sighting_id": sid,
                "verdict": verdict,
                "source": source,
                "labeller": _labeller(source, l.get("note")),
                "read_raw": read_raw,
                "read": M.normalize_plate(read_raw),
                "truth_raw": truth_raw,
                "truth": M.normalize_plate(truth_raw) if truth_raw else "",
                "camera": l.get("camera_code") or rec.get("camera_code"),
                "confidence": _num(l.get("confidence")),
                "scenario": assessment.get("scenario") or ex.get("scenario"),
                "dark_flag": "dark" in (assessment.get("flags") or []),
                "crop_h": assessment.get("h"),
                "tier": feats.get("tier") or rec.get("tier"),
                "frames": feats.get("n_frames") if feats.get("n_frames") is not None else rec.get("frames"),
                "agreement": _num(
                    feats.get("agreement") if feats.get("agreement") is not None else rec.get("agreement")
                ),
                "top_weight": _num(
                    feats.get("top_weight") if feats.get("top_weight") is not None else rec.get("top_weight")
                ),
                "readers_agree": _num(feats.get("readers_agree")),
                "det_conf": _num(feats.get("det_conf")),
                "night": rec.get("night"),
                "ir": rec.get("ir"),
                "has_features": bool(feats),
                "has_record": bool(rec),
                "labelled_at": l.get("created_at"),
                "note": l.get("note"),
            }
        )
    return rows


def load_csv(path: str) -> list[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            verdict = (r.get("verdict") or "").strip().lower()
            read_raw = r.get("plate_read")
            truth_raw = r.get("plate_true") or (read_raw if verdict == "correct" else None)
            source = (r.get("source") or "human").strip().lower()
            night = (r.get("night") or "").strip().lower()
            rows.append(
                {
                    "sighting_id": r.get("sighting_id"),
                    "verdict": verdict,
                    "source": source,
                    "labeller": _labeller(source, r.get("note")),
                    "read_raw": read_raw,
                    "read": M.normalize_plate(read_raw),
                    "truth_raw": truth_raw,
                    "truth": M.normalize_plate(truth_raw) if truth_raw else "",
                    "camera": r.get("camera") or r.get("camera_code"),
                    "confidence": _num(r.get("confidence")),
                    "scenario": r.get("scenario") or None,
                    "dark_flag": None,
                    "crop_h": None,
                    "tier": r.get("tier") or None,
                    "frames": int(float(r["frames"])) if r.get("frames") not in (None, "") else None,
                    "agreement": _num(r.get("agreement")),
                    "top_weight": _num(r.get("top_weight")),
                    "readers_agree": None,
                    "det_conf": None,
                    "night": (
                        True
                        if night in ("1", "true", "night", "yes")
                        else False
                        if night in ("0", "false", "day", "no")
                        else None
                    ),
                    "ir": None,
                    "has_features": r.get("agreement") not in (None, ""),
                    "has_record": False,
                    "labelled_at": None,
                    "note": r.get("note"),
                }
            )
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# scoring
# ═══════════════════════════════════════════════════════════════════════════


def score(rows: list[dict]) -> None:
    for r in rows:
        r["judged"] = r["verdict"] in ("correct", "wrong")
        r["truth_known"] = bool(r["truth"])
        if r["truth_known"]:
            r["exact"] = M.exact_match(r["read"], r["truth"])
            r["cer"] = M.cer(r["read"], r["truth"])
        else:
            r["exact"] = False if r["verdict"] == "wrong" else None
            r["cer"] = None
        # the verdict and the strings disagree (officer typo, or 'wrong' with truth == read)
        r["inconsistent"] = r["truth_known"] and ((r["verdict"] == "correct") != r["exact"])
        r["plate_len"] = len(r["truth"]) if r["truth_known"] else (len(r["read"]) if r["read"] else None)


def summarise(rows: list[dict]) -> dict:
    judged = [r for r in rows if r["judged"]]
    exact = sum(1 for r in judged if r["exact"])
    with_truth = [r for r in judged if r["truth_known"]]
    wrong_with_truth = [r for r in with_truth if not r["exact"]]
    ci = M.wilson_interval(exact, len(judged))
    return {
        "n": len(rows),
        "judged": len(judged),
        "correct_verdicts": sum(1 for r in rows if r["verdict"] == "correct"),
        "wrong_verdicts": sum(1 for r in rows if r["verdict"] == "wrong"),
        "not_plate": sum(1 for r in rows if r["verdict"] == "not_plate"),
        "exact": exact,
        "accuracy": (exact / len(judged)) if judged else None,
        "accuracy_ci95": list(ci) if ci else None,
        "cer": M.mean(r["cer"] for r in with_truth),
        "cer_n": len(with_truth),
        "cer_among_wrong": M.mean(r["cer"] for r in wrong_with_truth),
        "wrong_without_truth": sum(1 for r in judged if r["verdict"] == "wrong" and not r["truth_known"]),
        "inconsistent": sum(1 for r in rows if r.get("inconsistent")),
        "with_features": sum(1 for r in rows if r["has_features"]),
        "with_record": sum(1 for r in rows if r["has_record"]),
    }


def breakdown(rows: list[dict], key_fn, min_n: int) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for r in rows:
        if not r["judged"]:
            continue
        groups.setdefault(str(key_fn(r)), []).append(r)
    out = []
    for k, g in groups.items():
        exact = sum(1 for r in g if r["exact"])
        ci = M.wilson_interval(exact, len(g))
        out.append(
            {
                "bucket": k,
                "n": len(g),
                "exact": exact,
                "accuracy": exact / len(g),
                "ci_lo": ci[0] if ci else None,
                "ci_hi": ci[1] if ci else None,
                "cer": M.mean(r["cer"] for r in g if r["truth_known"]),
                "small": len(g) < min_n,
            }
        )
    return sorted(out, key=lambda d: (-d["n"], d["bucket"]))


def frames_bucket(n) -> str:
    if n is None:
        return "n/a"
    for name, fn in FRAME_BUCKETS:
        if fn(int(n)):
            return name
    return "n/a"


def night_bucket(r) -> str:
    if r["night"] is True:
        return "night"
    if r["night"] is False:
        return "day"
    return "unknown (no record)"


def reliability(rows: list[dict]) -> dict:
    judged = [r for r in rows if r["judged"] and r["confidence"] is not None]
    confs = [r["confidence"] for r in judged]
    oks = [bool(r["exact"]) for r in judged]
    return {"n": len(judged), "table": M.reliability_table(confs, oks, 10), "ece": M.ece(confs, oks, 10)}


def sweeps(rows: list[dict]) -> dict:
    judged = [r for r in rows if r["judged"]]
    out = {}
    for key, thresholds in (
        ("confidence", CONF_THRESHOLDS),
        ("agreement", CONF_THRESHOLDS),
        ("top_weight", CONF_THRESHOLDS),
        ("frames", FRAME_THRESHOLDS),
    ):
        vals = [r.get(key) for r in judged]
        oks = [bool(r["exact"]) for r in judged]
        have = sum(1 for v in vals if v is not None)
        out[key] = {
            "n_with_value": have,
            "n_judged": len(judged),
            "rows": M.threshold_sweep(vals, oks, thresholds) if have else [],
        }
    return out


# ═══════════════════════════════════════════════════════════════════════════
# printing
# ═══════════════════════════════════════════════════════════════════════════


def pct(v) -> str:
    return "n/a" if v is None else f"{100 * v:.1f}%"


def print_summary(name: str, s: dict, note: str = "") -> None:
    ci = s["accuracy_ci95"]
    ci_s = f" [{100 * ci[0]:.1f}, {100 * ci[1]:.1f}]" if ci else ""
    print(f"\n== {name} ==" + (f"  {note}" if note else ""))
    print(
        f"  labels {s['n']}: correct {s['correct_verdicts']}, wrong {s['wrong_verdicts']}, not_plate {s['not_plate']}"
        f"  (features on {s['with_features']}, evidence record on {s['with_record']})"
    )
    if s["judged"]:
        print(
            f"  EXACT-MATCH accuracy  {pct(s['accuracy'])}{ci_s}   ({s['exact']}/{s['judged']} judged reads, Wilson 95% CI)"
        )
        if s["cer_n"]:
            print(
                f"  CER (mean over {s['cer_n']} reads with a known truth)  {s['cer']:.3f}"
                + (
                    f"   CER among wrong reads {s['cer_among_wrong']:.3f}"
                    if s["cer_among_wrong"] is not None
                    else ""
                )
            )
        else:
            print("  CER  NOT MEASURED — no read has a known truth string")
        if s["wrong_without_truth"]:
            print(
                f"  note: {s['wrong_without_truth']} 'wrong' verdict(s) carry no true plate → counted wrong, excluded from CER"
            )
        if s["inconsistent"]:
            print(
                f"  note: {s['inconsistent']} label(s) where the verdict and the strings disagree (scored by the strings)"
            )
    else:
        print("  accuracy  NOT MEASURED — no judged (correct/wrong) labels in this group")


def print_breakdown(title: str, rows: list[dict], min_n: int) -> None:
    print(f"\n-- {title} (human labels; buckets under n={min_n} marked *) --")
    if not rows:
        print("  NOT MEASURED — no judged labels")
        return
    for r in rows:
        flag = "*" if r["small"] else " "
        ci = f"[{100 * r['ci_lo']:.0f},{100 * r['ci_hi']:.0f}]" if r["ci_lo"] is not None else ""
        cer = f"{r['cer']:.3f}" if r["cer"] is not None else "n/a"
        print(
            f"  {flag} {r['bucket']:<24} n={r['n']:<4} exact {r['exact']:<4} acc {pct(r['accuracy']):>6} {ci:<9} cer {cer}"
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--api", action="store_true", help="pull from the backend (default)")
    src.add_argument("--from-json", help="a pull saved with --save-api")
    src.add_argument(
        "--csv", help="plate_read,plate_true,verdict[,camera,confidence,frames,agreement,length,...]"
    )
    ap.add_argument("--backend", default=os.getenv("ANPR_BACKEND_URL", "http://trinetra-backend:5000"))
    ap.add_argument("--email", default=os.getenv("ANPR_EMAIL", "<redacted>"))
    ap.add_argument("--password", default=os.getenv("ANPR_PASSWORD", "<redacted>"))
    ap.add_argument("--limit", type=int, default=2000)
    ap.add_argument(
        "--save-api", help="write the raw API pull here (re-use with --from-json; no extra logins)"
    )
    ap.add_argument(
        "--records",
        default=os.path.join(HERE, "data", "records"),
        help="evidence records dir for scene.night / tier ('' = skip)",
    )
    ap.add_argument("--min-n", type=int, default=5, help="buckets with fewer judged labels are marked small")
    ap.add_argument("--out", default=os.path.join(HERE, "data", "eval"))
    args = ap.parse_args()

    if args.csv:
        source = f"csv:{args.csv}"
        rows = load_csv(args.csv)
        pull = None
    else:
        if args.from_json:
            with open(args.from_json, encoding="utf-8") as f:
                pull = json.load(f)
            if isinstance(pull, list):  # a bare /labels items list
                pull = {"labels": pull, "export": []}
            elif "labels" not in pull and "items" in pull:  # a raw /labels response
                pull = {"labels": pull["items"], "export": []}
            source = f"json:{args.from_json}"
        else:
            token = login_once(args.backend.rstrip("/"), args.email, args.password)
            pull = fetch_api(args.backend.rstrip("/"), token, args.limit)
            source = f"api:{args.backend}"
            if args.save_api:
                os.makedirs(os.path.dirname(os.path.abspath(args.save_api)), exist_ok=True)
                with open(args.save_api, "w", encoding="utf-8") as f:
                    json.dump(pull, f, indent=1)
                print(f"saved API pull → {args.save_api}")
        recs = scan_records(args.records)
        print(f"records scanned: {len(recs)} sighting ids from {args.records or '(skipped)'}")
        rows = unify_api(pull, recs)

    score(rows)
    human = [r for r in rows if r["source"] != "auto"]
    officer = [r for r in human if r["labeller"] == "officer"]
    auditor = [r for r in human if r["labeller"] == "auditor"]
    auto = [r for r in rows if r["source"] == "auto"]

    print(
        f"\nANPR label scorecard — source {source} — {len(rows)} labels "
        f"({len(human)} human: {len(officer)} officer + {len(auditor)} auditor; {len(auto)} auto)"
    )
    summary = {
        "human": summarise(human),
        "officer": summarise(officer),
        "auditor": summarise(auditor),
        "auto": summarise(auto),
    }
    print_summary("HUMAN labels (officer + auditor) — the evidence of accuracy", summary["human"])
    print_summary("  officer labels (console ✓/✗)", summary["officer"])
    print_summary("  auditor labels (note 'audit…')", summary["auditor"])
    print_summary(
        "AUTO labels",
        summary["auto"],
        note="NOT evidence of accuracy: these are the model's own confident reads written back as labels",
    )

    # ── breakdowns (human only) ──
    bd = {
        "camera": breakdown(human, lambda r: r["camera"] or "?", args.min_n),
        "plate_length": breakdown(
            human, lambda r: r["plate_len"] if r["plate_len"] is not None else "?", args.min_n
        ),
        "scenario": breakdown(human, lambda r: r["scenario"] or "unknown", args.min_n),
        "tier": breakdown(human, lambda r: r["tier"] or "unknown (no features)", args.min_n),
        "frames": breakdown(human, lambda r: frames_bucket(r["frames"]), args.min_n),
        "night": breakdown(human, night_bucket, args.min_n),
        "dark_crop_proxy": breakdown(
            human,
            lambda r: ("dark crop" if r["dark_flag"] else "lit crop")
            if r["dark_flag"] is not None
            else "unknown",
            args.min_n,
        ),
    }
    print_breakdown("per camera", bd["camera"], args.min_n)
    print_breakdown("per plate length (of the truth)", bd["plate_length"], args.min_n)
    print_breakdown("per scenario (crop assessment)", bd["scenario"], args.min_n)
    print_breakdown("per tier (features.tier / record tier)", bd["tier"], args.min_n)
    print_breakdown("per frames bucket (features.n_frames)", bd["frames"], args.min_n)
    print_breakdown("per night (evidence record scene.night)", bd["night"], args.min_n)
    print_breakdown(
        "per dark-crop proxy (assessment flag 'dark', crop mean lum < 70)", bd["dark_crop_proxy"], args.min_n
    )

    # ── confusions (human, truth known) ──
    conf = M.confusion_summary((r["read"], r["truth"]) for r in human if r["judged"] and r["truth_known"])
    print("\n-- character confusions (human labels with a known truth; truth→read) --")
    if conf["n"] == 0:
        print("  NOT MEASURED — no labelled read has a truth string")
    else:
        n_w = conf["n_wrong"]
        print(
            f"  {conf['n']} reads with truth, {n_w} wrong: same-length {conf['n_same_len']}, "
            f"dropped chars {conf['n_dropped']} ({pct(conf['n_dropped'] / conf['n'])} of reads, "
            f"{pct(conf['n_dropped'] / n_w) if n_w else 'n/a'} of wrong), "
            f"inserted chars {conf['n_inserted']} ({pct(conf['n_inserted'] / conf['n'])} of reads)"
        )
        cm = conf["class_matrix"]
        print(
            f"  substitutions by slot class (truth→read): L→L {cm['L→L']}  L→D {cm['L→D']}  D→L {cm['D→L']}  D→D {cm['D→D']}"
            f"   | in letter slots {conf['by_slot_class']['L']}, in digit slots {conf['by_slot_class']['D']}"
        )
        top = conf["subs"].most_common(20)
        print("  top substitutions: " + (", ".join(f"{k} ×{v}" for k, v in top) if top else "none"))
        pos = sorted(conf["by_position"].items())
        print("  by position (0-based): " + (", ".join(f"{p}:{c}" for p, c in pos) if pos else "none"))

    # ── reliability (human) ──
    rel = reliability(human)
    print("\n-- reliability: confidence decile vs exact-match (human labels) --")
    if rel["n"] == 0:
        print("  NOT MEASURED — no judged human label carries a confidence")
    else:
        print(
            "  NOTE: labels are chosen by people, not sampled at random — this is the calibration of the reads officers looked at."
        )
        for b in rel["table"]:
            if b["n"]:
                print(
                    f"  [{b['lo']:.1f},{b['hi']:.1f})  n={b['n']:<4} mean conf {b['mean_conf']:.3f}  accuracy {pct(b['accuracy']):>6}  gap {b['gap']:+.3f}"
                )
        print(f"  ECE (10 bins, n={rel['n']}) = {rel['ece']:.3f}")

    # ── threshold sweeps (human) ──
    sw = sweeps(human)
    print("\n-- threshold sweeps: precision & coverage of human-judged reads kept at value >= t --")
    for key, d in sw.items():
        if not d["rows"]:
            print(f"  {key}: NOT MEASURED — no judged human label carries '{key}'")
            continue
        print(f"  {key} (value present on {d['n_with_value']}/{d['n_judged']} judged):")
        for r in d["rows"]:
            print(
                f"     >= {r['threshold']:<5} kept {r['kept']:<4} coverage {pct(r['coverage']):>6}  precision {pct(r['precision']):>6}"
            )

    # ── write ──
    os.makedirs(args.out, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(args.out, f"labels_{stamp}.json")
    conf_json = {k: (dict(v) if hasattr(v, "most_common") else v) for k, v in conf.items()}
    conf_json["by_position"] = {str(k): v for k, v in conf["by_position"].items()}
    out = {
        "kind": "labels",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": source,
        "min_n": args.min_n,
        "records_dir": args.records,
        "counts": {
            "labels": len(rows),
            "human": len(human),
            "officer": len(officer),
            "auditor": len(auditor),
            "auto": len(auto),
        },
        "summary": summary,
        "breakdowns_human": bd,
        "confusions_human": conf_json,
        "reliability_human": rel,
        "sweeps_human": sw,
        "api_stats": (pull or {}).get("stats") if pull else None,
        "note_auto": "auto labels are the model's own confident reads (POST /anpr/labels/auto) and are not evidence of accuracy",
        "rows": [
            {
                k: r.get(k)
                for k in (
                    "sighting_id",
                    "verdict",
                    "source",
                    "labeller",
                    "read_raw",
                    "read",
                    "truth_raw",
                    "truth",
                    "exact",
                    "cer",
                    "camera",
                    "confidence",
                    "scenario",
                    "tier",
                    "frames",
                    "agreement",
                    "top_weight",
                    "readers_agree",
                    "det_conf",
                    "night",
                    "ir",
                    "dark_flag",
                    "plate_len",
                    "inconsistent",
                    "labelled_at",
                )
            }
            for r in rows
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False, default=str)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
