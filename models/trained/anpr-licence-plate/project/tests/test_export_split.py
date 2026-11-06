"""export_labels: the train/val split is by PLATE (group split).

The promote gate measures on val; a per-sighting split let the same plate —
the same vehicle at the same camera minutes apart, or on two days — sit on
both sides, so part of "val accuracy" was the train set being recognised.
These tests pin the invariants of group_split: deterministic, a plate is
never split, borrowing moves whole plates, and a larger val_frac only ever
ADDS plates to val.

Run inside the worker container from the anpr_worker folder:
    python -m pytest tests/test_export_split.py -q
"""

from __future__ import annotations

import os
import random
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.dirname(HERE) not in sys.path:  # conftest.py does this too; harmless twice
    sys.path.insert(0, os.path.dirname(HERE))

from export_labels import (
    _plate_key,
    cap_auto_share,
    default_val_target,
    effective_val_frac,
    group_split,  # noqa: E402
    split_hash,
    split_report,
    stable_split,
)

PLATE = lambda r: r["plate_text"]  # noqa: E731
HUMAN = lambda r: r["_src"] == "human"  # noqa: E731


def rows_of(spec, tag="") -> list[dict]:
    """spec: [(plate, source, n_rows)] → export-style rows, unique image paths."""
    out = []
    for plate, src, n in spec:
        out.extend(
            {"image_path": f"images/{plate}-{src}-{tag}{i}.jpg", "plate_text": plate, "_src": src}
            for i in range(n)
        )
    return out


def plates(n, seed=0) -> list[str]:
    rng = random.Random(seed)
    return [
        f"GJ{rng.randint(1, 38):02d}{rng.choice('ABCDEFGHJKLMNPRSTUVWXYZ')}{rng.choice('ABCDEFGHJKLMNPRSTUVWXYZ')}{1000 + i}"
        for i in range(n)
    ]


def sides(rows, splits) -> dict[str, set]:
    """plate → the set of sides its rows landed on (None counted as its own side)."""
    out: dict[str, set] = {}
    for r, s in zip(rows, splits):
        out.setdefault(PLATE(r), set()).add(s)
    return out


def mixed_set(seed=1) -> list[dict]:
    """60 plates: some with several human crops, some human + auto, some auto-only."""
    rng = random.Random(seed)
    spec = []
    for i, p in enumerate(plates(60, seed)):
        kind = i % 4
        if kind == 0:
            spec.append((p, "human", rng.randint(1, 4)))
        elif kind == 1:
            spec += [(p, "human", 1), (p, "auto", rng.randint(1, 3))]
        elif kind == 2:
            spec.append((p, "auto", rng.randint(1, 3)))
        else:
            spec.append((p, "human", 1))
    return rows_of(spec)


# ── stable_split: the hash and its meaning are unchanged ─────────────────────


def test_stable_split_unchanged():
    assert split_hash("GJ01AB1234") == pytest.approx(0.693016, abs=1e-6)  # recorded 2026-09-02
    assert split_hash("GJ32K9055") == pytest.approx(0.655855, abs=1e-6)
    assert stable_split("GJ01AB1234", 0.70) == "val" and stable_split("GJ01AB1234", 0.69) == "train"
    assert stable_split("GJ32K9055", 0.66) == "val" and stable_split("GJ32K9055", 0.65) == "train"
    assert all(0.0 <= split_hash(p) < 1.0 for p in plates(200))


def test_plate_key():
    assert _plate_key("gj-01 ab.1234") == "GJ01AB1234"
    assert _plate_key(None) == "" and _plate_key("") == ""


# ── group_split invariants ───────────────────────────────────────────────────


def test_group_split_is_deterministic_and_order_independent():
    rows = mixed_set()
    a = group_split(rows, PLATE, 0.2, val_ok=HUMAN)
    b = group_split(rows, PLATE, 0.2, val_ok=HUMAN)
    assert a == b and len(a) == len(rows)
    shuffled = list(rows)
    random.Random(7).shuffle(shuffled)
    by_path = dict(zip((r["image_path"] for r in shuffled), group_split(shuffled, PLATE, 0.2, val_ok=HUMAN)))
    assert [by_path[r["image_path"]] for r in rows] == a


@pytest.mark.parametrize("val_frac", [0.0, 0.05, 0.12, 0.32, 0.5, 1.0])
def test_same_plate_rows_are_never_separated(val_frac):
    rows = mixed_set()
    for val_ok in (None, HUMAN):
        for plate, s in sides(rows, group_split(rows, PLATE, val_frac, val_ok=val_ok)).items():
            assert s in ({"train"}, {"val"}, {"val", None}, {None}), (plate, s)  # never train AND val
            if val_ok is None:
                assert None not in s  # nothing excluded


def test_without_val_ok_and_min_val_it_is_stable_split_per_plate():
    rows = mixed_set()
    assert group_split(rows, PLATE, 0.3, min_val=0) == [stable_split(PLATE(r), 0.3) for r in rows]


def test_val_ok_rule_auto_never_in_val_and_val_plates_do_not_leak():
    rows = mixed_set()
    splits = group_split(rows, PLATE, 1.0, val_ok=HUMAN)  # every eligible plate → val
    for r, s in zip(rows, splits):
        if r["_src"] == "auto":
            assert s != "val"
    val_plates = {PLATE(r) for r, s in zip(rows, splits) if s == "val"}
    for r, s in zip(rows, splits):
        if PLATE(r) in val_plates:
            assert s == (
                "val" if r["_src"] == "human" else None
            )  # the auto crop is excluded, not moved to train
        else:
            assert s == "train" and r["_src"] == "auto"  # auto-only plates never reach val
    assert val_plates == {PLATE(r) for r in rows if r["_src"] == "human"}


def test_excluded_rows_do_not_count_towards_min_val():
    # one human plate with 5 auto near-duplicates; val_frac puts nothing in val by hash
    rows = rows_of(
        [("MH01AA0001", "human", 1), ("MH01AA0001", "auto", 5)] + [(p, "human", 1) for p in plates(8, 3)]
    )
    splits = group_split(rows, PLATE, 0.0, min_val=3, val_ok=HUMAN)
    assert splits.count("val") >= 3
    for r, s in zip(rows, splits):
        if r["_src"] == "auto":
            assert s in ("train", None)


def test_borrowing_moves_whole_plates_in_hash_order():
    spec = [("GJ01AB1000", "human", 4)] + [(p, "human", 1) for p in plates(6, 5)]
    rows = rows_of(spec)  # 10 rows, none in val by hash (val_frac 0)
    splits = group_split(rows, PLATE, 0.0, min_val=3)
    by_plate = sides(rows, splits)
    assert all(len(s) == 1 for s in by_plate.values())  # whole plates
    assert splits.count("val") >= 3
    val_plates = {p for p, s in by_plate.items() if s == {"val"}}
    order = sorted(by_plate, key=lambda p: (split_hash(p), p))
    assert val_plates == set(
        order[: len(val_plates)]
    )  # a prefix in hash order: the plates nearest the threshold


def test_borrowing_respects_the_train_floor():
    rows = rows_of(
        [(p, "human", 1) for p in plates(7, 9)]
    )  # 7 rows: borrow once (train 7 > 6), then stop at 6
    splits = group_split(rows, PLATE, 0.0, min_val=3)
    assert splits.count("val") == 1 and splits.count("train") == 6
    rows6 = rows_of([(p, "human", 1) for p in plates(6, 9)])  # 6 rows: nothing to borrow from
    assert group_split(rows6, PLATE, 0.0, min_val=3) == ["train"] * 6
    assert group_split(rows, PLATE, 0.0, min_val=0) == ["train"] * 7


def test_borrowing_only_takes_eligible_plates():
    rows = rows_of([(p, "auto", 2) for p in plates(10, 11)])  # nothing officer-verified at all
    assert group_split(rows, PLATE, 0.5, min_val=3, val_ok=HUMAN) == ["train"] * 20


@pytest.mark.parametrize("val_ok", [None, HUMAN])
def test_val_frac_monotone_val_only_ever_grows(val_ok):
    rows = mixed_set()
    previous: set = set()
    for frac in (0.0, 0.02, 0.05, 0.1, 0.12, 0.2, 0.32, 0.5, 0.8, 1.0):
        current = {
            PLATE(r) for r, s in zip(rows, group_split(rows, PLATE, frac, val_ok=val_ok)) if s == "val"
        }
        assert previous <= current, f"val_frac {frac} dropped {previous - current}"
        previous = current
    assert previous == {PLATE(r) for r in rows if val_ok is None or val_ok(r)}


def test_group_split_handles_empty_input():
    assert group_split([], PLATE, 0.12) == []


# ── the loud (non-fatal) check ───────────────────────────────────────────────


def test_split_report_shouts_on_a_leak(capsys):
    leaked = split_report(
        "OCR",
        {"train": ["GJ01AB1234", "GJ32AA0177", "GJ32AA0177"], "val": ["GJ32AA0177", "MH01ZZ0001"]},
        n_excluded=2,
    )
    out = capsys.readouterr().out
    assert leaked == {"GJ32AA0177"}
    assert "3 train rows = 2 plates / 2 val rows = 2 plates" in out and "2 auto row(s)" in out
    assert "!!! LEAK: 1 plate(s)" in out and "GJ32AA0177" in out


def test_split_report_quiet_when_clean(capsys):
    assert split_report("detector", {"train": ["A1", "A1"], "val": ["B2"]}) == set()
    assert "LEAK" not in capsys.readouterr().out


def test_end_to_end_no_plate_on_both_sides():
    rows = mixed_set(seed=42)
    splits = group_split(rows, PLATE, 0.32, val_ok=HUMAN)
    keys = {s: [PLATE(r) for r, sp in zip(rows, splits) if sp == s] for s in ("train", "val")}
    assert split_report("OCR", keys) == set()


# ── the val share as a function of the officer-label count ──────────────────


def test_effective_val_frac_clamp():
    assert effective_val_frac(40, 0.12, 0.32, 24) == pytest.approx(0.32)  # 24/40 = 0.6 → the ceiling
    assert effective_val_frac(150, 0.12, 0.32, 24) == pytest.approx(
        0.16
    )  # the case that broke: the step rule gave 0.12 → 16 crops
    assert effective_val_frac(1000, 0.12, 0.32, 24) == pytest.approx(0.12)  # the floor
    assert effective_val_frac(0, 0.12, 0.32, 24) == pytest.approx(0.32)  # nothing labelled yet: the ceiling
    assert effective_val_frac(75, 0.32, 0.12, 24) == pytest.approx(0.32)  # bounds in either order


def test_effective_val_frac_is_monotone_and_keeps_val_above_the_gate():
    fracs = [effective_val_frac(n, 0.12, 0.32, 24) for n in range(1, 2001)]
    assert all(a >= b for a, b in zip(fracs, fracs[1:]))  # never rises with more labels
    for n in range(75, 2001):  # once 24 crops are affordable, ≥ 24 expected
        assert n * effective_val_frac(n, 0.12, 0.32, 24) >= 24 - 1e-9
    assert (
        150 * 0.12 < 20 < 150 * effective_val_frac(150, 0.12, 0.32, 24)
    )  # old step rule vs the clamp at 150 labels


def test_default_val_target(monkeypatch):
    monkeypatch.delenv("ANPR_TRAIN_VAL_TARGET", raising=False)
    monkeypatch.setenv("ANPR_TRAIN_MIN_VAL", "20")
    assert default_val_target() == 24
    monkeypatch.setenv("ANPR_TRAIN_MIN_VAL", "40")
    assert default_val_target() == 48
    monkeypatch.setenv("ANPR_TRAIN_MIN_VAL", "10")
    assert default_val_target() == 24  # never below 24
    monkeypatch.setenv("ANPR_TRAIN_VAL_TARGET", "30")
    assert default_val_target() == 30


# ── the auto-label cap (confirmation bias) ───────────────────────────────────


def auto_rows(n, conf=lambda i: 0.90 + i / 1000.0) -> list[dict]:
    return [
        {
            "image_path": f"images/auto{i}.jpg",
            "plate_text": f"GJ01AA{1000 + i}",
            "_src": "auto",
            "_conf": conf(i),
        }
        for i in range(n)
    ]


CONF = lambda r: r["_conf"]  # noqa: E731
HALF = lambda r: 0.5  # noqa: E731


def share(human_mass, kept):
    auto_mass = 0.5 * len(kept)
    return auto_mass / (human_mass + auto_mass)


def test_cap_keeps_40_of_60_auto_for_10_human_rows_x2():
    rows = auto_rows(60)
    kept, dropped = cap_auto_share(rows, human_mass=10 * 2, max_share=0.5, weight_fn=HALF, conf_fn=CONF)
    assert len(kept) == 40 and len(dropped) == 20
    assert share(20, kept) == pytest.approx(0.5)
    assert max(CONF(r) for r in dropped) < min(CONF(r) for r in kept)  # lowest confidence went first
    assert (
        kept == [r for r in rows if r in kept] and dropped == rows[:20]
    )  # input order kept; the 20 least confident were the first 20
    assert share(20, rows) == pytest.approx(0.6)  # what it was before the cap


def test_cap_leaves_a_set_under_the_share_alone():
    rows = auto_rows(30)  # 15 / (20 + 15) = 0.43
    kept, dropped = cap_auto_share(rows, human_mass=20, max_share=0.5, weight_fn=HALF, conf_fn=CONF)
    assert kept == rows and dropped == []
    rows = auto_rows(40)  # exactly 0.5: allowed
    assert cap_auto_share(rows, 20, 0.5, HALF, CONF) == (rows, [])


def test_cap_other_shares_and_weights():
    rows = auto_rows(60)
    kept, _ = cap_auto_share(rows, human_mass=20, max_share=0.3, weight_fn=HALF, conf_fn=CONF)
    assert len(kept) == 17 and share(20, kept) <= 0.3 < share(
        20, kept + [rows[0]]
    )  # the largest set under 30 %
    kept, _ = cap_auto_share(rows, human_mass=20, max_share=0.5, weight_fn=lambda r: 1.0, conf_fn=CONF)
    assert len(kept) == 20  # heavier auto rows → fewer fit


def test_cap_unknown_confidence_goes_first_then_stable_tail():
    rows = auto_rows(10, conf=lambda i: None if i in (2, 7) else 0.95)  # two rows without a confidence
    kept, dropped = cap_auto_share(
        rows, human_mass=3, max_share=0.5, weight_fn=HALF, conf_fn=CONF
    )  # budget 3.0 → 6 rows
    assert [r["image_path"] for r in dropped] == [
        "images/auto2.jpg",
        "images/auto7.jpg",
        "images/auto8.jpg",
        "images/auto9.jpg",
    ]
    assert len(kept) == 6 and kept == [r for r in rows if r not in dropped]
    rows = auto_rows(10, conf=lambda i: None)  # no confidences at all: drop the tail
    kept, dropped = cap_auto_share(rows, human_mass=3, max_share=0.5, weight_fn=HALF, conf_fn=CONF)
    assert kept == rows[:6] and dropped == rows[6:]


def test_cap_edge_cases():
    rows = auto_rows(50)
    assert cap_auto_share(rows, human_mass=0, max_share=0.5, weight_fn=HALF, conf_fn=CONF) == (
        rows,
        [],
    )  # nothing to anchor to
    assert cap_auto_share(rows, human_mass=20, max_share=1.0, weight_fn=HALF, conf_fn=CONF) == (
        rows,
        [],
    )  # cap off
    assert cap_auto_share(rows, human_mass=20, max_share=0.0, weight_fn=HALF, conf_fn=CONF) == (
        [],
        rows,
    )  # no auto at all
    assert cap_auto_share([], human_mass=20, max_share=0.5) == ([], [])
