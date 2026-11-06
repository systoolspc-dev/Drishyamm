"""
export_labels.py — turn what officers marked (and what the voter was sure of)
into TRAINING SETS. Step 1 of the retraining loop.

    officer ✓/✗ in Find-a-Vehicle  ─┐
    confident reads (auto-labels)  ─┼─►  /anpr/labels/export  ─►  this script
                                                                    │
        data/train/ocr/{images,train.csv,val.csv}   ◄───────────────┤  fast-plate-ocr format
        data/train/det/{images,labels}/{train,val} + data.yaml  ◄───┤  YOLO format (from records/*_frame.jpg)
        data/labelled/<PLATE>_<id>.jpg              ◄───────────────┘  eval_enhance.py --labelled

Human labels are authoritative: a 'wrong' label with a true plate teaches the
OCR the truth; 'not_plate' teaches the detector a negative. Auto-labels are
the anpr_labels rows POST /anpr/labels/auto wrote (source 'auto', weight
0.5: confirmed reads with ≥ 6 frames, agreement ≥ 0.95, both readers agreed,
strict format, no human ✗ on the plate) — they grow the set where nobody
clicks, and a human label always overrides them.

Weights and the split:
  * auto-labels go to TRAIN only; val is human-only, so "the model got
    better" is always measured on what officers verified. Below 8 human
    labels val would be meaningless, so the old shared stable split is used
    (val ≥ 3, borrowed from train).
  * fast-plate-ocr's annotations CSV takes only image_path / plate_text
    (/plate_region) — no sample weights — so the 1.0 : 0.5 weight ratio is
    realised by writing every human row ×2 into train.csv. train_meta.csv
    beside it records source / weight / split / split_key / copies per crop.
  * the split is by PLATE, not by sighting (group_split): every crop of a
    plate — the same vehicle at the same camera minutes apart, or on two
    days — lands on one side, so val never holds a near-duplicate of a train
    crop. The per-sighting split did, and that inflated the promote gate's
    val accuracy. The detector set splits by the same key.
  * auto-labels NEVER enter val, and they may fill at most
    ANPR_TRAIN_AUTO_MAX_SHARE (0.5) of the weighted real train rows (human
    copies 1.0 each after duplication, auto 0.5 each): the reader's own
    confident reads must not dominate its own fine-tune (confirmation bias).
    Past the cap the lowest-confidence auto rows are dropped
    (train_meta.csv split = dropped_auto_cap); synthetic plates are outside it.

Run from the host (backend on localhost:5000) or inside a container:
    python export_labels.py --backend http://localhost:5000
    python export_labels.py --no-auto            # humans only
    python export_labels.py --pseudo             # + the endpoint's ad-hoc pseudo-labels
                                                 #   (unlabelled conf ≥ 0.9 reads; the old flywheel)
"""

from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import json
import os
import re
import shutil
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from plate_rules import is_valid_plate, validate_or_correct  # noqa: E402


def login(backend: str, email: str, password: str, tries: int = 4) -> str:
    for i in range(tries):
        r = requests.post(
            f"{backend}/api/auth/login", json={"email": email, "password": password}, timeout=20
        )
        if r.status_code in (409, 429) and i < tries - 1:  # back-to-back logins in the trainer cycle
            time.sleep(2.0 * (i + 1))
            continue
        r.raise_for_status()
        return r.json()["token"]
    raise RuntimeError("login failed")


def fetch(backend: str, token: str, path: str, **params):
    r = requests.get(
        f"{backend}{path}", headers={"Authorization": f"Bearer {token}"}, params=params, timeout=60
    )
    r.raise_for_status()
    return r


def split_hash(key: str) -> float:
    """A key's fixed coordinate in [0, 1) (sha1): the same plate always lands
    at the same point whatever else is in the set."""
    return int(hashlib.sha1(key.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def stable_split(key: str, val_frac: float) -> str:
    return "val" if split_hash(key) < val_frac else "train"


def _plate_key(text) -> str:
    """A plate as a split key: upper-case alphanumerics only ('' for None)."""
    return re.sub(r"[^A-Z0-9]", "", str(text or "").upper())


def group_split(rows, key_fn, val_frac: float, min_val: int = 3, val_ok=None) -> list:
    """Assign 'train' / 'val' per row BY GROUP: rows with the same key_fn(row)
    (the plate) always land on the same side, so a plate seen at two cameras,
    on two days, or by two readers can never sit in both train and val — that
    near-duplicate leakage is what inflates the promote gate's val accuracy.

    * A group is in val iff stable_split(key, val_frac) says so: a plate stays
      in val once it is in val (the threshold only ever moves right), as before.
    * val_ok(row), optional, marks the rows that may be measured on (officer-
      verified crops). A group without one never goes to val; in a val group
      the rows that may not be there get None — EXCLUDED, not moved to train,
      because moving them would leak the plate.
    * If val ends with fewer than min_val rows, whole eligible groups are
      borrowed from train in split_hash order — the plates closest to the
      threshold, exactly the ones a larger val_frac would admit next, so the
      monotonic property survives — while train keeps more than 2 × min_val rows.
    Returns a list parallel to `rows` of 'train' / 'val' / None. Pure: same
    rows and arguments → same answer, in any row order.
    """
    keys = [key_fn(r) for r in rows]
    groups: dict[str, list[int]] = {}
    for i, k in enumerate(keys):
        groups.setdefault(k, []).append(i)
    ok = [True if val_ok is None else bool(val_ok(r)) for r in rows]
    eligible = {k: any(ok[i] for i in idx) for k, idx in groups.items()}
    in_val = {k for k in groups if eligible[k] and stable_split(k, val_frac) == "val"}

    def n_val():
        return sum(1 for k in in_val for i in groups[k] if ok[i])

    def n_train():
        return sum(len(idx) for k, idx in groups.items() if k not in in_val)

    for k in sorted((k for k in groups if eligible[k] and k not in in_val), key=lambda k: (split_hash(k), k)):
        if n_val() >= min_val or n_train() <= 2 * min_val:
            break
        in_val.add(k)
    return [("val" if ok[i] else None) if k in in_val else "train" for i, k in enumerate(keys)]


def split_report(name: str, keys_by_split: dict, n_excluded: int = 0) -> set:
    """Print the by-plate view of a split ({"train": [plate per row], "val": [...]})
    and shout if a plate sits on both sides — the invariant group_split
    guarantees; this catches a future edit that breaks it. Returns the leaked plates."""
    plates = {s: set(keys_by_split.get(s) or []) for s in ("train", "val")}
    leaked = plates["train"] & plates["val"]
    print(
        f"[export] {name} split by plate: "
        + " / ".join(
            f"{len(keys_by_split.get(s) or [])} {s} rows = {len(plates[s])} plates" for s in ("train", "val")
        )
        + (f"; {n_excluded} auto row(s) of val plates excluded (would leak)" if n_excluded else "")
    )
    if leaked:
        print(
            f"[export] !!! LEAK: {len(leaked)} plate(s) on BOTH sides of the {name} split "
            f"({', '.join(sorted(leaked)[:8])}{', …' if len(leaked) > 8 else ''}) — "
            f"val accuracy is not trustworthy; do not promote on it"
        )
    return leaked


def default_val_target() -> int:
    """Val crops to aim for: comfortably above train_ocr's promote gate
    (ANPR_TRAIN_MIN_VAL, 20) — max(24, 1.2 × gate) — or ANPR_TRAIN_VAL_TARGET."""
    env = os.getenv("ANPR_TRAIN_VAL_TARGET")
    if env and env.isdigit() and int(env) > 0:
        return int(env)
    gate = int(os.getenv("ANPR_TRAIN_MIN_VAL", "20"))
    return max(24, (12 * gate + 9) // 10)


def effective_val_frac(n_human: int, val_frac: float, val_frac_small: float, target_val: int = 24) -> float:
    """The val share as a FUNCTION of how many officer labels exist:
    target_val / n_human, clamped to [val_frac, val_frac_small]. Non-increasing
    in n_human, so the expected val count never falls under the promote gate
    as labels accumulate: 40 labels → 0.32, 150 → 0.16, 1000 → 0.12.
    The old rule was a step (0.32 below 120 labels, 0.12 above): at 150 labels
    it gave 16 val crops — under the 20-crop gate — precisely when labelling
    was going well."""
    lo, hi = min(val_frac, val_frac_small), max(val_frac, val_frac_small)
    if n_human <= 0:
        return hi
    return max(lo, min(hi, target_val / n_human))


def cap_auto_share(
    auto_rows, human_mass: float, max_share: float, weight_fn=lambda r: 0.5, conf_fn=lambda r: None
):
    """Keep only the auto rows that fit under `max_share` of the weighted real
    train mass — auto_mass / (human_mass + auto_mass) ≤ max_share, where
    human_mass = human copies × 1.0 (after --human-dup) and an auto row weighs
    weight_fn(row) (0.5). The reader's own confident reads must not dominate
    its own fine-tune (confirmation bias). Lowest confidence goes first
    (conf_fn; unknown confidence counts as lowest; ties keep the input order —
    a stable sort, so with no confidences at all the tail is dropped). Returns
    (kept, dropped), both in input order. With no human mass there is nothing
    to anchor a share to, so nothing is dropped: the promote gate refuses such
    a set anyway (val would be the reader's own output)."""
    auto_rows = list(auto_rows)
    if human_mass <= 0 or max_share >= 1.0:
        return auto_rows, []
    if max_share <= 0:
        return [], auto_rows
    budget = human_mass * max_share / (1.0 - max_share)  # auto mass allowed under the cap
    ranked = sorted(auto_rows, key=lambda r: -(conf_fn(r) if conf_fn(r) is not None else -1.0))
    kept_ids, mass = set(), 0.0
    for r in ranked:
        w = float(weight_fn(r))
        if mass + w > budget + 1e-9:
            break  # everything below this confidence goes
        mass += w
        kept_ids.add(id(r))
    return [r for r in auto_rows if id(r) in kept_ids], [r for r in auto_rows if id(r) not in kept_ids]


def plate_slots(explicit: int = 0) -> int:
    """How many characters the recogniser can emit (max_plate_slots in the
    model's plate config; v2 = 10). Anything longer is unlearnable for it."""
    if explicit:
        return int(explicit)
    env = os.getenv("ANPR_OCR_MAX_SLOTS")
    if env and env.isdigit():
        return int(env)
    for cfg in (
        os.path.join(HERE, "models", "ocr_base", "cct_s_v2_global_plate_config.yaml"),
        os.path.join(HERE, "models", "ocr", "plate_config.yaml"),
    ):
        try:
            with open(cfg, encoding="utf-8") as f:
                for line in f:
                    if line.strip().startswith("max_plate_slots:"):
                        return int(line.split(":", 1)[1].strip())
        except Exception:  # noqa: BLE001 — fall through to the safe default
            continue
    return 10


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default=os.getenv("ANPR_BACKEND_URL", "http://localhost:5000"))
    ap.add_argument("--email", default=os.getenv("ANPR_EMAIL", "<redacted>"))
    ap.add_argument("--password", default=os.getenv("ANPR_PASSWORD", "<redacted>"))
    ap.add_argument("--out", default=os.path.join(HERE, "data", "train"))
    ap.add_argument("--records", default=os.path.join(HERE, "data", "records"))
    ap.add_argument("--labelled-dir", default=os.path.join(HERE, "data", "labelled"))
    ap.add_argument("--no-auto", action="store_true", help="human labels only")
    ap.add_argument(
        "--pseudo",
        action="store_true",
        help="also take the export endpoint's ad-hoc pseudo-labels (unlabelled reads with conf ≥ 0.9 and "
        "agreement ≥ 0.95, weaker evidence than /labels/auto)",
    )
    ap.add_argument("--auto-min-conf", type=float, default=0.9)
    ap.add_argument("--auto-min-agreement", type=float, default=0.95)
    ap.add_argument("--val-frac", type=float, default=0.12, help="floor of the val share (large label sets)")
    ap.add_argument(
        "--val-frac-small",
        type=float,
        default=float(os.getenv("ANPR_TRAIN_VAL_FRAC_SMALL", "0.32")),
        help="ceiling of the val share while officer labels are scarce (the val set gates deployment)",
    )
    ap.add_argument(
        "--val-target",
        type=int,
        default=int(os.getenv("ANPR_TRAIN_VAL_TARGET", "0") or 0) or None,
        help="val crops to aim for: the share is val-target / officer labels, clamped to [--val-frac, --val-frac-small] "
        "(default max(24, 1.2 × ANPR_TRAIN_MIN_VAL) — always above train_ocr's --min-val gate)",
    )
    ap.add_argument(
        "--val-boost-below",
        type=int,
        default=int(os.getenv("ANPR_TRAIN_VAL_BOOST_BELOW", "120")),
        help="(superseded by --val-target; accepted so older callers keep working)",
    )
    ap.add_argument(
        "--min-human-val",
        type=int,
        default=int(os.getenv("ANPR_TRAIN_MIN_HUMAN_FOR_VAL", "8")),
        help="below this many human labels val falls back to the shared split",
    )
    ap.add_argument(
        "--human-dup",
        type=int,
        default=int(os.getenv("ANPR_TRAIN_HUMAN_DUP", "2")),
        help="copies of each human row in train.csv (weight 1.0 vs auto 0.5; fast-plate-ocr takes no weights)",
    )
    ap.add_argument(
        "--auto-max-share",
        type=float,
        default=float(os.getenv("ANPR_TRAIN_AUTO_MAX_SHARE", "0.5")),
        help="max share of the weighted real train rows (human copies 1.0, auto 0.5) that auto-labels may fill; "
        "past it the lowest-confidence auto rows are dropped (never val, never synthetic)",
    )
    ap.add_argument(
        "--synth",
        type=int,
        default=int(os.getenv("ANPR_TRAIN_SYNTH", "0")),
        help="add N confusion-targeted synthetic plates to TRAIN (never to val)",
    )
    ap.add_argument(
        "--slots",
        type=int,
        default=0,
        help="character slots the recogniser has (default: read max_plate_slots from the plate config)",
    )
    args = ap.parse_args()

    backend = args.backend.rstrip("/")
    token = login(backend, args.email, args.password)
    exp = fetch(
        backend,
        token,
        "/api/ai/anpr/labels/export",
        include_auto=1 if (args.pseudo and not args.no_auto) else 0,
        auto_min_conf=args.auto_min_conf,
        auto_min_agreement=args.auto_min_agreement,
    ).json()
    items = exp.get("items", [])
    if args.no_auto:
        items = [it for it in items if (it.get("source") or "human") == "human"]
    n_human_lab = sum(1 for it in items if (it.get("source") or "human") == "human")
    n_auto_lab = sum(1 for it in items if it.get("source") == "auto")
    print(
        f"[export] {n_human_lab} human labels, {n_auto_lab} auto-labels"
        + (" (incl. ad-hoc pseudo-labels)" if args.pseudo and not args.no_auto else "")
    )

    # ── OCR set ──
    ocr_dir = os.path.join(args.out, "ocr")
    img_dir = os.path.join(ocr_dir, "images")
    os.makedirs(img_dir, exist_ok=True)
    os.makedirs(args.labelled_dir, exist_ok=True)
    rows = {"train": [], "val": []}
    pending: list[dict] = []  # every trainable crop; its side is decided per PLATE below
    meta_rows: dict[str, dict] = {}  # image_path → source / weight / split / copies
    verdict_by_sid: dict[str, dict] = {}
    truth_by_sid: dict[str, str] = {}  # the detector set splits by the same plate
    scenario_by_path: dict[str, str] = {}
    n_img = 0
    n_human_trainable = sum(
        1
        for it in items
        if (it.get("source") or "human") == "human"
        and it.get("verdict") in ("correct", "wrong")
        and it.get("plate_true")
        and it.get("plate_snapshot_uri")
    )
    human_val = (
        n_human_trainable >= args.min_human_val
    )  # else: the old shared split (val ≥ 3 borrowed from train)
    # The val set decides whether a model may ship, and only officer-checked
    # crops can be in it — so while human labels are scarce, send a larger
    # share there. stable_split keeps a plate in val once it is in val (the
    # threshold only ever moves right), so raising the fraction never shuffles
    # the set: it just fills faster. The share is a FUNCTION of the label
    # count, never a step: the step at --val-boost-below turned 150 officer
    # labels into 16 val crops, under the 20-crop promote gate, exactly as
    # labelling picked up.
    val_target = args.val_target or default_val_target()
    val_frac = effective_val_frac(n_human_trainable, args.val_frac, args.val_frac_small, val_target)
    print(
        f"[export] val share {val_frac:.0%} = clamp({val_target} val crops wanted / {n_human_trainable} officer labels, "
        f"{min(args.val_frac, args.val_frac_small):.0%}..{max(args.val_frac, args.val_frac_small):.0%}) "
        f"→ ≈ {round(val_frac * n_human_trainable)} human val crops; the val set gates deployment "
        f"(train_ocr --min-val {os.getenv('ANPR_TRAIN_MIN_VAL', '20')})"
    )
    for it in items:
        sid = it.get("sighting_id") or hashlib.md5(json.dumps(it, sort_keys=True).encode()).hexdigest()
        verdict_by_sid[sid] = it
        truth = it.get("plate_true")
        uri = it.get("plate_snapshot_uri")
        if it["verdict"] not in ("correct", "wrong") or not truth or not uri:
            continue
        if not is_valid_plate(truth):
            # officers type fast: "MHO8C6000" (letter O) → the same position
            # rules the reader uses fix it to MH08C6000
            fixed = validate_or_correct(truth)
            if not fixed:
                print(f"[export] skip {sid}: truth {truth!r} is not a valid Indian plate")
                continue
            truth = fixed
        truth_by_sid[sid] = truth
        fn = f"{sid}.jpg"
        dst = os.path.join(img_dir, fn)
        if not os.path.exists(dst):
            try:
                r = fetch(backend, token, "/api/ai/anpr/media", uri=uri)
                with open(dst, "wb") as f:
                    f.write(r.content)
                n_img += 1
            except Exception as e:  # noqa: BLE001
                print(f"[export] media fetch failed for {sid}: {e}")
                continue
        src = it.get("source") or "human"
        weight = float(it.get("weight") if it.get("weight") is not None else (1.0 if src == "human" else 0.5))
        pending.append(
            {"image_path": f"images/{fn}", "plate_text": truth, "_src": src, "_conf": it.get("confidence")}
        )
        meta_rows[f"images/{fn}"] = {
            "image_path": f"images/{fn}",
            "plate_text": truth,
            "source": src,
            "weight": weight,
            "split": "",
            "split_key": truth,
            "copies": 1,
        }
        scenario_by_path[f"images/{fn}"] = (
            it.get("scenario") or (it.get("assessment") or {}).get("scenario") or "unknown"
        )
        if src == "human":
            shutil.copyfile(dst, os.path.join(args.labelled_dir, f"{truth}_{sid[:8]}.jpg"))
    # The side is decided per PLATE, not per sighting: the same vehicle at the
    # same camera minutes apart, or on two days, is a near-duplicate crop, and
    # the per-sighting split put such pairs on both sides — part of "val
    # accuracy" was the train set being recognised. Invariant: no plate on
    # both sides. Auto-labels never reach val once officers have labelled
    # enough (the promote gate measures on officer-verified crops only); an
    # auto crop of a plate that IS in val is excluded rather than sent to
    # train, which would leak the plate. A val set with < 3 rows is useless —
    # group_split borrows whole plates from train.
    splits = group_split(
        pending,
        key_fn=lambda r: r["plate_text"],
        val_frac=val_frac,
        min_val=3,
        val_ok=(lambda r: r["_src"] == "human") if human_val else None,
    )
    n_excluded = 0
    for r, split in zip(pending, splits):
        meta_rows[r["image_path"]]["split"] = split or "excluded"
        if split is None:
            n_excluded += 1
            continue
        rows[split].append(r)
    split_report(
        "OCR", {s: [r["plate_text"] for r in rows[s]] for s in ("train", "val")}, n_excluded=n_excluded
    )
    n_val_human = sum(1 for r in rows["val"] if r["_src"] == "human")
    n_train_human = sum(1 for r in rows["train"] if r["_src"] == "human")
    n_train_auto = len(rows["train"]) - n_train_human
    # weight 1.0 vs 0.5 with a trainer that takes no sample weights: human rows × args.human_dup in TRAIN
    if args.human_dup > 1:
        extra = [dict(r) for r in rows["train"] if r["_src"] == "human" for _ in range(args.human_dup - 1)]
        rows["train"].extend(extra)
        for r in extra:
            meta_rows[r["image_path"]]["copies"] = args.human_dup
    # Confirmation-bias guard: the reader's own confident reads (auto-labels)
    # may fill at most --auto-max-share of the weighted real train mass — 150
    # officer labels must not be fine-tuned under by hundreds of the model's
    # own reads. Lowest confidence goes first; val is untouched (it holds no
    # auto rows); synthetic plates are outside the cap.
    human_mass = float(sum(1 for r in rows["train"] if r["_src"] == "human"))  # copies count 1.0 each
    auto_rows = [r for r in rows["train"] if r["_src"] != "human"]
    kept_auto, dropped_auto = cap_auto_share(
        auto_rows,
        human_mass,
        args.auto_max_share,
        weight_fn=lambda r: meta_rows[r["image_path"]]["weight"],
        conf_fn=lambda r: r.get("_conf"),
    )
    if dropped_auto:
        gone = {id(r) for r in dropped_auto}
        rows["train"] = [r for r in rows["train"] if id(r) not in gone]
        for r in dropped_auto:
            meta_rows[r["image_path"]]["split"] = "dropped_auto_cap"
    auto_mass = sum(float(meta_rows[r["image_path"]]["weight"]) for r in kept_auto)
    auto_share = auto_mass / (human_mass + auto_mass) if human_mass + auto_mass else 0.0
    top_dropped = max((r["_conf"] for r in dropped_auto if r.get("_conf") is not None), default=None)
    print(
        f"[export] auto cap {args.auto_max_share:.0%}: dropped {len(dropped_auto)} of {len(auto_rows)} auto rows"
        + (f" (lowest confidence first, up to {top_dropped:.3f})" if top_dropped is not None else "")
        + f" → auto share {auto_share:.0%} of the weighted real train rows ({human_mass:.0f} human copies + {auto_mass:.1f} auto)"
        + (
            " — no officer labels in train, nothing to anchor the share to"
            if auto_rows and human_mass == 0
            else ""
        )
    )
    n_train_auto = len(kept_auto)
    n_real_train = len(rows["train"])
    # confusion-targeted synthetic plates: TRAIN only, never val (val must stay real)
    if args.synth > 0:
        try:
            stats = fetch(backend, token, "/api/ai/anpr/labels/stats").json()
            confusions = [
                (c[0].split("→")[0], c[0].split("→")[1], c[1])
                for c in stats.get("confusions", [])
                if "→" in c[0]
            ]
        except Exception:  # noqa: BLE001
            confusions = []
        import synth_plates

        synth_dir = os.path.join(args.out, "ocr_synth")
        synth_csv = synth_plates.generate(
            args.synth, synth_dir, confusions, args.records, seed=int(time.time()) % 10000
        )
        with open(synth_csv, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                rows["train"].append(
                    {"image_path": "../ocr_synth/" + r["image_path"], "plate_text": r["plate_text"]}
                )
        print(f"[export] + {args.synth} synthetic plates (confusions targeted: {confusions[:5]})")
    # The recogniser has a FIXED number of character slots (v2 = 10). A longer
    # plate — a legitimate 3-letter-series one such as GJ01ABC1234 — cannot be
    # represented at all, and fast-plate-ocr asserts on it ("Plates are longer
    # than max_plate_slots"), which used to kill the whole run. Drop those rows
    # and say how many: they are a MODEL capability gap (see ANPR_SYSTEM.md),
    # not a labelling error, and they must not silently poison a training set.
    slots = plate_slots(args.slots)
    over = {split: [r for r in rows[split] if len(r["plate_text"]) > slots] for split in ("train", "val")}
    n_over = sum(len(v) for v in over.values())
    if n_over:
        for split in ("train", "val"):
            rows[split] = [r for r in rows[split] if len(r["plate_text"]) <= slots]
        sample = sorted({r["plate_text"] for v in over.values() for r in v})[:5]
        print(
            f"[export] dropped {n_over} row(s) longer than the model's {slots} slots "
            f"(train {len(over['train'])}, val {len(over['val'])}; e.g. {', '.join(sample)}) — "
            f"{slots}-slot models cannot read those plates at all"
        )
    for split in ("train", "val"):
        with open(os.path.join(ocr_dir, f"{split}.csv"), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["image_path", "plate_text"], extrasaction="ignore")
            w.writeheader()
            w.writerows(rows[split])
    with open(os.path.join(ocr_dir, "train_meta.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f, fieldnames=["image_path", "plate_text", "source", "weight", "split", "split_key", "copies"]
        )
        w.writeheader()
        w.writerows(meta_rows.values())
    with open(os.path.join(ocr_dir, "val_meta.json"), "w", encoding="utf-8") as f:
        json.dump(
            {r["image_path"]: scenario_by_path.get(r["image_path"], "unknown") for r in rows["val"]},
            f,
            indent=1,
        )
    print(
        f"[export] OCR set: {n_real_train} real train rows = {n_train_human} human ×{max(1, args.human_dup)} + {n_train_auto} auto "
        f"(+{len(rows['train']) - n_real_train} synthetic) / {len(rows['val'])} val ({n_val_human} human, "
        f"{'human-only' if human_val else f'shared split: < {args.min_human_val} human labels'})  ({n_img} new crops) → {ocr_dir}"
    )

    # ── detector set (needs the frames the worker saved locally) ──
    det_dir = os.path.join(args.out, "det")
    for split in ("train", "val"):
        os.makedirs(os.path.join(det_dir, "images", split), exist_ok=True)
        os.makedirs(os.path.join(det_dir, "labels", split), exist_ok=True)
    n_pos = n_neg = n_skip = 0
    det_keys = {"train": [], "val": []}  # the plate each frame was split on
    for jp in glob.glob(os.path.join(args.records, "*", "*", "*.json")):
        try:
            rec = json.load(open(jp, encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        fr = rec.get("frame")
        sid = rec.get("sighting_id")
        if not fr or not sid:
            continue
        frame_path = os.path.join(os.path.dirname(jp), fr["file"])
        if not os.path.exists(frame_path):
            continue
        lab = verdict_by_sid.get(sid)
        meta = rec.get("meta") or {}
        if lab is None:
            # un-labelled: positive only when the voter was very sure
            if (
                float(rec.get("confidence") or 0) < args.auto_min_conf
                or float(meta.get("agreement") or 0) < args.auto_min_agreement
            ):
                n_skip += 1
                continue
            positive = True
        else:
            positive = lab["verdict"] in ("correct", "wrong")  # wrong OCR is still a real plate box
        # the same rule as the OCR set — by PLATE, so every frame of a plate is on one side:
        # the labelled truth, else the worker's read (a not-a-plate box keeps its misread as key)
        det_key = truth_by_sid.get(sid) or _plate_key(rec.get("plate")) or sid
        split = stable_split(det_key, val_frac)
        det_keys[split].append(det_key)
        img_dst = os.path.join(det_dir, "images", split, f"{sid}.jpg")
        if not os.path.exists(img_dst):
            shutil.copyfile(frame_path, img_dst)
        with open(os.path.join(det_dir, "labels", split, f"{sid}.txt"), "w") as f:
            if positive:
                cx, cy, w, h = fr["yolo"]
                f.write(f"0 {cx:.5f} {cy:.5f} {w:.5f} {h:.5f}\n")
                n_pos += 1
            else:
                n_neg += 1
    with open(os.path.join(det_dir, "data.yaml"), "w") as f:
        f.write(
            f"path: {os.path.abspath(det_dir)}\ntrain: images/train\nval: images/val\nnames:\n  0: plate\n"
        )
    split_report("detector", det_keys)
    print(
        f"[export] detector set: {n_pos} positives, {n_neg} negatives (not-a-plate), {n_skip} unlabelled low-confidence skipped → {det_dir}"
    )
    print(
        "[export] next: python train_ocr.py   |   python train_detector.py   |   python eval_enhance.py --labelled",
        args.labelled_dir,
    )


if __name__ == "__main__":
    main()
