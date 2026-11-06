"""
auto_retrain.py — the AUTOMATION: the reader retrains itself on officer
labels and promotes a better model into the running worker, unattended.

    every CHECK_MIN minutes:
        auto_labels.py     → POST /anpr/labels/auto  (the pipeline's strongest confirmed reads become
                                                      half-weight labels; env ANPR_AUTO_LABELS=1)
        labels = GET /anpr/labels/stats          (how many verified/corrected reads exist; its `accuracy` is the
                                                  officer/auditor accuracy over HUMAN labels only — auto labels are
                                                  the reader's own reads; the mixed figure is `accuracy_all`)
        trainable = human labels × 1.0 + auto labels × 0.5   ("trainable_weighted")
        if trainable ≥ MIN_SAMPLES and (≥ NEW_LABELS new since the last run  or  INTERVAL_H hours passed):
            export_labels.py   → datasets
            train_ocr.py       → fine-tune, eval, PROMOTE to models/ocr/ only if better
            train_detector.py  → fine-tune, eval, PROMOTE to models/best_ft.pt only if better
        write data/train/status.json   (the UI's "Model training" card reads it via /anpr/training/status)

The worker's Models.watch() notices a promoted model within a minute and
swaps it in — no restart, no human. Every decision is logged and the val
numbers for base vs. new model are kept in the status file, so "the model
got better" is always a measured statement.

Runs as the compose service `anpr-trainer` (image trinetra/anpr-train).
    python auto_retrain.py --once      # one cycle, then exit (also env ANPR_TRAIN_ONCE=1)
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
import time
import traceback

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import auto_labels  # noqa: E402  — POST /anpr/labels/auto through the same login

STATUS = os.path.join(HERE, "data", "train", "status.json")
LOG = os.path.join(HERE, "data", "train", "auto_retrain.log")

BACKEND = os.getenv("ANPR_BACKEND_URL", "http://trinetra-backend:5000").rstrip("/")
EMAIL = os.getenv("ANPR_EMAIL", "<redacted>")
PASSWORD = os.getenv("ANPR_PASSWORD", "<redacted>")
CHECK_MIN = float(os.getenv("ANPR_TRAIN_CHECK_MIN", "15"))
MIN_SAMPLES = int(os.getenv("ANPR_TRAIN_MIN_SAMPLES", "40"))
NEW_LABELS = int(os.getenv("ANPR_TRAIN_NEW_LABELS", "20"))
INTERVAL_H = float(os.getenv("ANPR_TRAIN_INTERVAL_H", "6"))
EPOCHS = int(os.getenv("ANPR_TRAIN_EPOCHS", "30"))
DET_EPOCHS = int(os.getenv("ANPR_TRAIN_DET_EPOCHS", "30"))
DET_MIN = int(os.getenv("ANPR_TRAIN_DET_MIN_IMAGES", "60"))
RUN_ONCE = os.getenv("ANPR_TRAIN_ONCE", "0") == "1" or "--once" in sys.argv[1:]
AUTO_LABELS = os.getenv("ANPR_AUTO_LABELS", "1").strip().lower() not in ("0", "false", "no", "off")
AUTO_WEIGHT = 0.5  # an auto-label's share of a human label (anpr_labels.weight)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def log(msg: str):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} [auto-retrain] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def read_status() -> dict:
    try:
        with open(STATUS, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def write_status(**kw):
    st = read_status()
    st.update(kw)
    st["updated_at"] = now_iso()
    os.makedirs(os.path.dirname(STATUS), exist_ok=True)
    tmp = STATUS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, STATUS)
    return st


def label_stats(tok: str) -> dict:
    s = requests.get(
        f"{BACKEND}/api/ai/anpr/labels/stats", headers={"Authorization": f"Bearer {tok}"}, timeout=30
    )
    s.raise_for_status()
    return s.json()


ACCURACY_BASIS = "officer/auditor accuracy (human labels only); accuracy_all also counts auto labels"


def accuracy_fields(stats: dict) -> dict:
    """What status.json records about accuracy. `accuracy` is the
    officer/auditor accuracy — HUMAN labels only. An auto label is the
    reader's own confident read written back as 'correct', so a figure that
    includes them grades the model against itself; /labels/stats keeps that
    mixed value as `accuracy_all` and it is stored here for comparison,
    never as the headline."""
    return {
        "accuracy": stats.get("accuracy"),
        "accuracy_all": stats.get("accuracy_all"),
        "accuracy_basis": ACCURACY_BASIS,
    }


def accuracy_line(stats: dict) -> str:
    def pct(v):
        return f"{float(v):.1%}" if v is not None else "n/a"

    return (
        f"officer/auditor accuracy (human labels only) {pct(stats.get('accuracy'))}"
        f" over {stats.get('judged_human', '?')} judged; incl. auto labels {pct(stats.get('accuracy_all'))}"
    )


MIN_VAL = int(os.getenv("ANPR_TRAIN_MIN_VAL", "20"))


def count_csv_rows(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            return max(0, sum(1 for _ in f) - 1)  # minus the header
    except Exception:  # noqa: BLE001
        return 0


def run(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    out = (p.stdout or "") + (p.stderr or "")
    return p.returncode, out


def parse_train(out: str) -> dict:
    res = {"promoted": "PROMOTED" in out}
    for line in out.splitlines():
        if "VAL exact-match" in line:
            try:
                parts = line.replace("→", "->").split()
                # "[train] VAL exact-match: base 0.667 -> fine-tuned 0.667   char acc: 0.966 -> 0.966"
                res["base_acc"] = float(parts[parts.index("base") + 1])
                res["new_acc"] = float(parts[parts.index("fine-tuned") + 1])
                ci = parts.index("acc:")
                res["base_char"] = float(parts[ci + 1])
                res["new_char"] = float(parts[ci + 3])
            except (ValueError, IndexError):
                pass
        if "mAP50 on our val frames" in line:
            try:
                parts = line.replace("→", "->").split()
                res["det_base_map"] = float(parts[parts.index("base") + 1])
                res["det_new_map"] = float(parts[parts.index("fine-tuned") + 1])
            except (ValueError, IndexError):
                pass
    return res


SYNTH_PER_LABEL = float(os.getenv("ANPR_TRAIN_SYNTH_PER_LABEL", "15"))  # synthetic plates per real label
SYNTH_MAX = int(os.getenv("ANPR_TRAIN_SYNTH_MAX", "5000"))


def self_label(tok: str, user: dict) -> dict:
    """Step 0 of a cycle: the pipeline labels its own strongest reads (half
    weight). Never fatal — a failure just means this cycle trains on what
    officers gave."""
    if not AUTO_LABELS:
        return {"enabled": False}
    try:
        res = auto_labels.run(token=tok, user=user)
        t = res.get("totals") or {}
        line = auto_labels.summary(res)
        log(line)
        return {
            "enabled": True,
            "at": now_iso(),
            "inserted": int(t.get("inserted") or 0),
            "qualified": int(t.get("qualified") or 0),
            "scanned": int(t.get("scanned") or 0),
            "skipped": t.get("skipped") or {},
            "via": res.get("via"),
            "per_camera": {k: int(v.get("inserted") or 0) for k, v in (res.get("per_camera") or {}).items()},
            "line": line[:300],
        }
    except Exception as e:  # noqa: BLE001
        log(f"auto-labels failed (training on officer labels only): {e}")
        return {"enabled": True, "at": now_iso(), "error": str(e)[:300]}


def label_counts(stats: dict) -> dict:
    """Human and auto labels, and the weighted total the gates use:
    trainable_weighted = human trainable × 1.0 + auto trainable × 0.5.
    Reads the fields /labels/stats provides and derives them from
    per_source when talking to an older AI."""
    per_src = stats.get("per_source") or {}
    auto_src = per_src.get("auto") or {}
    labelled_human = int(
        stats.get("labelled_human") if stats.get("labelled_human") is not None else stats.get("labelled") or 0
    )
    labelled_auto = int(
        stats.get("labelled_auto") if stats.get("labelled_auto") is not None else auto_src.get("total") or 0
    )
    trainable_human = int(
        stats.get("trainable_human")
        if stats.get("trainable_human") is not None
        else stats.get("trainable") or 0
    )
    trainable_auto = int(
        stats.get("trainable_auto")
        if stats.get("trainable_auto") is not None
        else auto_src.get("correct") or 0
    )
    tw = stats.get("trainable_weighted")
    trainable_weighted = (
        round(float(tw), 2) if tw is not None else round(trainable_human + AUTO_WEIGHT * trainable_auto, 2)
    )
    return {
        "labelled": int(stats.get("labelled") or 0),
        "labelled_human": labelled_human,
        "labelled_auto": labelled_auto,
        "trainable_human": trainable_human,
        "trainable_auto": trainable_auto,
        "trainable_weighted": trainable_weighted,
    }


def cycle() -> None:
    st = read_status()
    try:
        tok, user = auto_labels.login(
            BACKEND, EMAIL, PASSWORD
        )  # ONE login per cycle (a second one in the same second draws a 409)
    except Exception as e:  # noqa: BLE001
        write_status(state="waiting", reason=f"backend unreachable: {e}", next_check_min=CHECK_MIN)
        log(f"backend unreachable: {e}")
        return
    al = self_label(tok, user)
    write_status(auto_labels=al)
    try:
        stats = label_stats(tok)
    except Exception as e:  # noqa: BLE001
        write_status(state="waiting", reason=f"backend unreachable: {e}", next_check_min=CHECK_MIN)
        log(f"backend unreachable: {e}")
        return
    lc = label_counts(stats)
    trainable = lc["trainable_weighted"]  # the number every gate below uses
    labelled = lc["labelled"]
    # the confidence calibrator is cheap — refit it every cycle from whatever labels exist
    rc_c, out_c = run([sys.executable, "train_calibrator.py", "--backend", BACKEND])
    cal_line = (out_c.strip().splitlines() or ["?"])[-1][:220]
    log(f"calibrator: {cal_line}")
    write_status(calibrator=cal_line, calibrator_promoted="PROMOTED" in out_c)
    last_trained_on = float(st.get("last_trained_on") or 0)
    last_run = st.get("last_run_at")
    hours_since = (time.time() - dt.datetime.fromisoformat(last_run).timestamp()) / 3600 if last_run else 1e9
    due = trainable >= MIN_SAMPLES and (
        trainable - last_trained_on >= NEW_LABELS or hours_since >= INTERVAL_H
    )
    mix = f"{lc['trainable_human']} human + {lc['trainable_auto']} auto × {AUTO_WEIGHT}"
    if not due:
        reason = (
            f"{trainable:g}/{MIN_SAMPLES} trainable labels ({mix})"
            if trainable < MIN_SAMPLES
            else f"{trainable - last_trained_on:g}/{NEW_LABELS} new labels since last run, {hours_since:.1f}h/{INTERVAL_H}h elapsed"
        )
        write_status(
            state="waiting",
            reason=reason,
            trainable=trainable,
            **lc,
            **accuracy_fields(stats),
            next_check_min=CHECK_MIN,
        )
        log(f"waiting — {reason}")
        return

    log(
        f"retraining on {trainable:g} weighted labels ({mix}; {labelled} labelled reads, {accuracy_line(stats)})"
    )
    write_status(state="training", trainable=trainable, **lc, **accuracy_fields(stats), started_at=now_iso())
    n_synth = int(min(SYNTH_MAX, SYNTH_PER_LABEL * trainable))
    rc, out = run([sys.executable, "export_labels.py", "--backend", BACKEND, "--synth", str(n_synth)])
    exp_lines = [l for l in out.strip().splitlines() if l.startswith("[export]")]
    for l in exp_lines[:1] + [l for l in exp_lines if "OCR set:" in l or "detector set:" in l]:
        log(l[:300])
    if rc != 0:
        write_status(state="error", stage="export", error=out[-800:], last_run_at=now_iso())
        return
    write_status(
        export=[l[:300] for l in exp_lines if "OCR set:" in l or "detector set:" in l or "labels" in l][:4]
    )

    # A promotion is decided on officer-checked crops only (auto-labels are the
    # reader's own output — measuring on them is circular). Below MIN_VAL the
    # comparison is noise and train_ocr refuses to promote anyway, so do not
    # spend ~20 min of the GPU the live reader is using: say what is missing.
    n_val = count_csv_rows(os.path.join(HERE, "data", "train", "ocr", "val.csv"))
    if n_val < MIN_VAL:
        reason = (
            f"{n_val}/{MIN_VAL} officer-checked val crops — training would run but could never "
            f"be trusted to deploy (one crop = {1 / max(n_val, 1):.0%} of the score). "
            f"Check reads in the console: every ✓/✗ grows this set."
        )
        write_status(
            state="waiting",
            reason=reason,
            trainable=trainable,
            **lc,
            val_crops=n_val,
            **accuracy_fields(stats),
            next_check_min=CHECK_MIN,
        )
        log(f"waiting — {reason}")
        return

    rc, out = run([sys.executable, "train_ocr.py", "--epochs", str(EPOCHS)])
    ocr_res = parse_train(out)
    log(f"OCR: rc={rc} {ocr_res}")
    if rc != 0:
        write_status(state="error", stage="train_ocr", error=out[-1200:], last_run_at=now_iso(), ocr=ocr_res)
        return

    det_res: dict = {"skipped": True}
    rc_d, out_d = run(
        [sys.executable, "train_detector.py", "--epochs", str(DET_EPOCHS), "--min-images", str(DET_MIN)]
    )
    if rc_d == 0:
        det_res = parse_train(out_d)
    else:
        det_res = {"skipped": True, "reason": (out_d.strip().splitlines() or ["?"])[-1][:200]}
    log(f"detector: rc={rc_d} {det_res}")

    write_status(
        state="idle",
        last_run_at=now_iso(),
        last_trained_on=trainable,
        trainable=trainable,
        **lc,
        ocr=ocr_res,
        detector=det_res,
        reason="done — "
        + (
            "OCR model promoted, worker hot-reloads within a minute"
            if ocr_res.get("promoted")
            else "no improvement over base; kept current model"
        ),
        next_check_min=CHECK_MIN,
    )


def main():
    log(
        f"started: check every {CHECK_MIN} min, train at ≥{MIN_SAMPLES} weighted labels (human 1.0, auto {AUTO_WEIGHT}; "
        f"auto-labels {'on' if AUTO_LABELS else 'off'}), ≥{NEW_LABELS} new or every {INTERVAL_H} h"
        + (" — single cycle" if RUN_ONCE else "")
    )
    while True:
        try:
            cycle()
        except Exception as e:  # noqa: BLE001
            log(f"cycle error: {e}\n{traceback.format_exc(limit=3)}")
            write_status(state="error", error=str(e)[:500])
        if RUN_ONCE:
            break
        time.sleep(CHECK_MIN * 60)


if __name__ == "__main__":
    main()
