"""Unit tests for anpr_metrics.py — toy inputs with hand-computed answers.

Run inside the worker container from the anpr_worker folder:
    python -m pytest tests/test_metrics.py -q
"""

from __future__ import annotations

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.dirname(HERE) not in sys.path:  # conftest.py does this too; harmless twice
    sys.path.insert(0, os.path.dirname(HERE))

import anpr_metrics as m  # noqa: E402


# ── strings ──────────────────────────────────────────────────────────────────


def test_normalize_plate():
    assert m.normalize_plate("gj-01 ab 1234") == "GJ01AB1234"
    assert m.normalize_plate(None) == ""
    assert m.normalize_plate(" GJ01AB1234\n") == "GJ01AB1234"


@pytest.mark.parametrize(
    "a,b,d",
    [
        ("", "", 0),
        ("abc", "", 3),
        ("", "abc", 3),
        ("kitten", "sitting", 3),
        ("GJ01AB1234", "GJ01AB1234", 0),
        ("GJ01AB1234", "GJ01AB123", 1),
        ("GJ01AB1Z34", "GJ01AB1234", 1),
        ("GJ01AB1234", "GJ10AB1234", 2),
    ],
)
def test_levenshtein(a, b, d):
    assert m.levenshtein(a, b) == d


def test_cer():
    assert m.cer("GJ01AB1Z34", "GJ01AB1234") == pytest.approx(0.1)
    assert m.cer("", "GJ01AB1234") == pytest.approx(1.0)  # an empty read is a result, every char wrong
    assert m.cer("GJ01AB1234", "") is None  # no truth → cannot compute
    assert m.cer("gj01ab1234", "GJ-01-AB-1234") == 0.0  # normalised before comparing


def test_exact_match_is_whole_string_only():
    assert m.exact_match("gj-01 ab 1234", "GJ01AB1234")
    assert not m.exact_match("GJ01AB123", "GJ01AB1234")  # 9 of 10 right is WRONG
    assert not m.exact_match("GJ01AB12345", "GJ01AB1234")  # a superstring is WRONG
    assert not m.exact_match("", "GJ01AB1234")
    assert not m.exact_match("GJ01AB1234", "")  # no truth, no match


def test_plate_error_rate():
    pairs = [
        ("GJ01AB1234", "GJ01AB1234"),
        ("GJ01AB1Z34", "GJ01AB1234"),
        ("MH12DE1433", "MH12DE1433"),
        ("", "KA01MJ7788"),
    ]
    assert m.plate_error_rate(pairs) == pytest.approx(0.5)
    assert m.plate_error_rate([]) is None


def test_substitutions_and_length_delta():
    assert m.substitutions("GJ01AB1Z34", "GJ01AB1234") == [(7, "2", "Z")]
    assert m.substitutions("GJ01AB123", "GJ01AB1234") == []  # different length: no alignment guess
    assert m.length_delta("GJ01AB123", "GJ01AB1234") == -1
    assert m.length_delta("GJ01AB12345", "GJ01AB1234") == 1


def test_confusion_summary():
    pairs = [
        ("GJ01AB1234", "GJ01AB1234"),  # right
        ("GJ01AB1Z34", "GJ01AB1234"),  # digit slot read as letter: 2→Z
        ("GJ0IAB1234", "GJ01AB1234"),  # digit slot: 1→I
        ("CJ01AB1234", "GJ01AB1234"),  # letter slot: G→C
        ("GJ01AB123", "GJ01AB1234"),  # dropped
        ("GJ01AB12345", "GJ01AB1234"),  # inserted
        ("GJ01AB1234", ""),  # no truth: ignored
    ]
    s = m.confusion_summary(pairs)
    assert s["n"] == 6 and s["n_wrong"] == 5
    assert s["n_same_len"] == 3 and s["n_dropped"] == 1 and s["n_inserted"] == 1
    assert s["subs"]["2→Z"] == 1 and s["subs"]["1→I"] == 1 and s["subs"]["G→C"] == 1
    assert s["class_matrix"]["D→L"] == 2 and s["class_matrix"]["L→L"] == 1
    assert s["by_slot_class"]["D"] == 2 and s["by_slot_class"]["L"] == 1
    assert s["by_position"][7] == 1 and s["by_position"][3] == 1 and s["by_position"][0] == 1


# ── binomial ─────────────────────────────────────────────────────────────────


def test_wilson_interval():
    assert m.wilson_interval(0, 0) is None
    lo, hi = m.wilson_interval(30, 40)
    assert 0.0 <= lo <= 0.75 <= hi <= 1.0
    lo0, hi0 = m.wilson_interval(0, 10)
    assert lo0 == 0.0 and 0.0 < hi0 < 0.35
    lo1, hi1 = m.wilson_interval(10, 10)
    assert 0.65 < lo1 < 1.0 and hi1 == 1.0


# ── calibration ──────────────────────────────────────────────────────────────


def test_reliability_and_ece_perfectly_calibrated():
    # bin [0.7,0.8): 10 samples at 0.75, 7 correct → gap 0.05 ... build a zero-gap toy instead
    confs = [0.75] * 4 + [0.25] * 4
    corrects = [True, True, True, False] + [True, False, False, False]
    table = m.reliability_table(confs, corrects, n_bins=4)
    assert (
        table[3]["n"] == 4
        and table[3]["accuracy"] == pytest.approx(0.75)
        and table[3]["gap"] == pytest.approx(0.0)
    )
    assert table[1]["n"] == 4 and table[1]["accuracy"] == pytest.approx(0.25)
    assert m.ece(confs, corrects, n_bins=4) == pytest.approx(0.0)


def test_ece_overconfident():
    confs = [0.9] * 10
    corrects = [True] * 5 + [False] * 5
    assert m.ece(confs, corrects, n_bins=10) == pytest.approx(0.4)
    assert m.ece([], [], n_bins=10) is None
    t = m.reliability_table([1.0], [True], n_bins=10)
    assert t[9]["n"] == 1  # 1.0 lands in the last bin


def test_threshold_sweep():
    values = [0.9, 0.8, 0.6, 0.4, None]
    corrects = [True, True, False, False, True]
    rows = m.threshold_sweep(values, corrects, [0.5, 0.7, 0.95])
    assert rows[0]["n"] == 4  # the None sample is excluded from N
    assert (
        rows[0]["kept"] == 3
        and rows[0]["coverage"] == pytest.approx(0.75)
        and rows[0]["precision"] == pytest.approx(2 / 3)
    )
    assert rows[1]["kept"] == 2 and rows[1]["precision"] == pytest.approx(1.0)
    assert rows[2]["kept"] == 0 and rows[2]["precision"] is None


# ── boxes ────────────────────────────────────────────────────────────────────


def test_iou():
    assert m.iou((0, 0, 10, 10), (0, 0, 10, 10)) == pytest.approx(1.0)
    assert m.iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert m.iou((0, 0, 10, 10), (5, 0, 15, 10)) == pytest.approx(1 / 3)
    assert m.iou((0, 0, 0, 0), (0, 0, 10, 10)) == 0.0  # degenerate box


def test_match_boxes_greedy():
    gts = [(0, 0, 10, 10), (100, 100, 120, 110)]
    preds = [
        (1, 1, 11, 11),
        (0, 0, 10, 10),
        (50, 50, 60, 60),
    ]  # dup on gt0 (lower score wins nothing), one FP
    scores = [0.6, 0.9, 0.8]
    r = m.match_boxes(preds, scores, gts, 0.5)
    assert [(pi, gi) for pi, gi, _ in r["matches"]] == [(1, 0)]  # highest score takes gt0; the dup becomes FP
    assert sorted(r["fp"]) == [0, 2]
    assert r["fn"] == [1]
    p, rec = m.precision_recall(len(r["matches"]), len(r["fp"]), len(r["fn"]))
    assert p == pytest.approx(1 / 3) and rec == pytest.approx(0.5)
    assert m.precision_recall(0, 0, 0) == (None, None)


def test_average_precision_toy():
    # ranked by score: TP, TP, FP, TP with 4 GT → precision env 1,1,.75 → AP = .25+.25+.25*.75
    assert m.average_precision([0.9, 0.8, 0.7, 0.6], [True, True, False, True], 4) == pytest.approx(0.6875)
    assert m.average_precision([0.9, 0.8], [True, True], 2) == pytest.approx(1.0)
    assert m.average_precision([0.9, 0.8], [False, False], 2) == pytest.approx(0.0)
    assert m.average_precision([], [], 0) is None
    assert m.average_precision([], [], 3) == 0.0  # GT exists, nothing predicted


def test_ap_at_iou_end_to_end():
    preds = {"a": [((0, 0, 10, 10), 0.9), ((50, 50, 60, 60), 0.4)], "b": [((0, 0, 20, 20), 0.8)]}
    gts = {"a": [(0, 0, 10, 10)], "b": [(0, 0, 20, 20), (30, 30, 40, 40)]}
    r = m.ap_at_iou(preds, gts, 0.5)
    assert r["n_gt"] == 3 and r["tp"] == 2 and r["fp"] == 1 and r["fn"] == 1
    assert r["precision"] == pytest.approx(2 / 3) and r["recall"] == pytest.approx(2 / 3)
    # ranking: .9 TP, .8 TP, .4 FP → precision 1,1,.667; recall 1/3,2/3,2/3 → AP = 2/3
    assert r["ap"] == pytest.approx(2 / 3)


def test_bucket_of():
    edges, labels = [20, 30, 45], ["<20", "20-30", "30-45", ">=45"]
    assert m.bucket_of(19.9, edges, labels) == "<20"
    assert m.bucket_of(20, edges, labels) == "20-30"
    assert m.bucket_of(44.9, edges, labels) == "30-45"
    assert m.bucket_of(45, edges, labels) == ">=45"


def test_format_table_and_mean():
    assert m.mean([1, None, 3]) == pytest.approx(2.0)
    assert m.mean([]) is None
    txt = m.format_table(
        [{"k": "a", "v": 0.5}, {"k": "b", "v": None}], [("k", "key"), ("v", "val")], pct={"v"}
    )
    assert "50.0%" in txt and "n/a" in txt and txt.splitlines()[0].startswith("key")


# ── end-to-end scoring (eval_e2e.score_e2e is pure; importing eval_e2e loads no models) ──


def _post(plate, tier, t_best, t_post, wall, dedup=False):
    return {
        "plate": plate,
        "tier": tier,
        "conf": 0.9,
        "raw": plate,
        "frames": 3,
        "wall": wall,
        "video_t_best": t_best,
        "video_t_post": t_post,
        "dedup_by_worker": dedup,
    }


def test_score_e2e_toy():
    import eval_e2e

    posts = [
        _post("GJ01AB1234", "confirmed", 12.0, 14.0, 100.0),  # hit inside [10,15]
        _post(
            "GJ01AB1234", "possible", 13.0, 15.0, 101.0, dedup=True
        ),  # suppressed by REPOST_SECS → a duplicate
        _post("GJ05CD5679", "possible", 30.0, 31.0, 120.0),  # 1 edit from GJ05CD5678 inside its window
        _post("MH12ZZ9999", "confirmed", 50.0, 51.0, 140.0),  # nothing like it in the GT
        _post("GJ01AB1234", "confirmed", 80.0, 81.0, 170.0),  # right plate, far outside its window
    ]
    gt = [
        {"plate": "GJ01AB1234", "t_start": 10.0, "t_end": 15.0},
        {"plate": "GJ05CD5678", "t_start": 28.0, "t_end": 33.0},
        {"plate": "KA01MJ7788", "t_start": 60.0, "t_end": 65.0},
    ]
    sc = eval_e2e.score_e2e(posts, gt, tol=2.0, first_wall_at=lambda t: 95.0, video_span=120.0)
    s = sc["summary"]
    assert s["n_gt"] == 3 and s["hits"] == 1 and s["exact_rate"] == pytest.approx(1 / 3)
    assert s["confirmed_hits"] == 1 and s["near_misses"] == 1
    assert s["false_plates"] == 2 and s["false_plates_per_min"] == pytest.approx(1.0)
    assert s["posted_reads"] == 4 and s["posted_precision"] == pytest.approx(
        0.5
    )  # the deduped call is not a posted read
    g0, g1, g2 = sc["per_gt"]
    assert g0["hit"] and g0["confirmed_hit"] and g0["duplicates"] == 1 and g0["out_of_window"] == [80.0]
    assert (
        g0["latency_wall_s"] == pytest.approx(5.0)
        and g0["latency_video_s"] == pytest.approx(4.0)
        and g0["evidence_delay_s"] == pytest.approx(2.0)
    )
    assert not g1["hit"] and g1["near_miss"] and g1["near_reads"] == ["GJ05CD5679"]
    assert not g2["hit"] and not g2["near_miss"] and g2["latency_video_s"] is None
    kinds = {fp["plate"]: fp["kind"] for fp in sc["false_plates"]}
    assert kinds == {"GJ05CD5679": "near-miss of GJ05CD5678", "MH12ZZ9999": "spurious"}


def test_score_e2e_empty_gt_is_not_measured():
    import eval_e2e

    sc = eval_e2e.score_e2e([_post("GJ01AB1234", "confirmed", 1.0, 2.0, 10.0)], [], tol=5.0)
    assert sc["summary"]["exact_rate"] is None and sc["summary"]["n_gt"] == 0
    assert sc["summary"]["false_plates"] == 1  # every posted read is false against an empty GT
