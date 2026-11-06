"""Static-object suppression tests — the chair-is-not-a-head layer."""
import numpy as np

from headcount.static_suppress import StaticBoxSuppressor, iou

CHAIR = np.array([100, 100, 160, 170], dtype=np.float32)   # a stable headrest box


def _sup(**kw):
    defaults = dict(iou_thr=0.6, min_span_sec=120.0, min_hits=8, stale_sec=45.0)
    defaults.update(kw)
    return StaticBoxSuppressor(**defaults)


def test_iou_sanity():
    assert iou(CHAIR, CHAIR) == 1.0
    assert iou(CHAIR, CHAIR + 1000) == 0.0
    assert 0.3 < iou(CHAIR, CHAIR + 10) < 1.0


def test_stable_box_gets_suppressed_after_span_and_hits():
    s = _sup()
    t = 0.0
    keep = [True]
    for _ in range(12):                    # 12 inferences over 165s
        keep = s.update(np.array([CHAIR]), t)
        t += 15.0
    assert keep == [False]                 # chair no longer counted
    assert s.suppressed_count == 1


def test_moving_box_is_never_suppressed():
    s = _sup()
    t, box = 0.0, CHAIR.copy()
    for _ in range(20):
        keep = s.update(np.array([box]), t)
        assert keep == [True]              # a moving head keeps counting
        box = box + 80                     # moves far each time → new entries
        t += 15.0
    assert s.suppressed_count == 0


def test_short_lived_box_not_suppressed():
    s = _sup()
    keep = s.update(np.array([CHAIR]), 0.0)
    keep = s.update(np.array([CHAIR]), 10.0)   # only 10s / 2 hits
    assert keep == [True]


def test_motion_in_region_rehabilitates():
    s = _sup()
    t = 0.0
    for _ in range(12):
        s.update(np.array([CHAIR]), t)
        t += 15.0
    assert s.suppressed_count == 1

    # Someone walks into the chair region: thumbnails differ there.
    fw, fh = 640, 360
    prev = np.zeros((90, 160), dtype=np.uint8)
    cur = prev.copy()
    # chair box scaled into 160x90: x*0.25, y*0.25 → region ~(25..40, 25..43)
    cur[25:43, 25:40] = 200
    n = s.rehabilitate(prev, cur, fw, fh)
    assert n == 1
    assert s.suppressed_count == 0
    # and the next detection at that spot counts again
    keep = s.update(np.array([CHAIR]), t)
    assert keep == [True]


def test_stale_entries_age_out():
    s = _sup()
    s.update(np.array([CHAIR]), 0.0)
    s.update(np.array([]).reshape(0, 4), 100.0)   # not seen for 100s > stale_sec
    assert len(s.entries) == 0
