"""Tests for the pairwise 'talking' geometry (no model loading required)."""

from activity_monitor.activity import (
    ActivityAnalyzer, posture_state, WORKING, NOT_WORKING, UNKNOWN,
    NOSE, R_EAR, L_SHO, R_SHO, L_HIP, R_HIP,
)
from activity_monitor.config import ActivityConfig


def _analyzer(**kw):
    cfg = ActivityConfig(talking_convergence=0.20, talking_proximity=2.5, **kw)
    a = ActivityAnalyzer.__new__(ActivityAnalyzer)  # skip heavy __init__ (pose model)
    a.cfg = cfg
    return a


def _p(pid, cx, yaw, w=200, cy=300):
    return {"id": pid, "cx": cx, "cy": cy, "w": w, "yaw": yaw}


def _ids(pairs):
    return {i for pair in pairs for i in pair}


def test_facing_each_other_and_near_is_talking():
    a = _analyzer()
    pairs = a._talking_pairs([_p(1, 300, 0.4), _p(2, 500, -0.4)])
    assert pairs == [(1, 2)]


def test_facing_but_too_far_is_not_talking():
    a = _analyzer()
    assert a._talking_pairs([_p(1, 300, 0.4), _p(2, 1200, -0.4)]) == []


def test_both_looking_same_direction_is_not_talking():
    a = _analyzer()
    assert a._talking_pairs([_p(1, 300, 0.4), _p(2, 500, 0.4)]) == []


def test_looking_away_from_each_other_is_not_talking():
    a = _analyzer()
    assert a._talking_pairs([_p(1, 300, -0.4), _p(2, 500, 0.4)]) == []


def test_weak_turn_below_convergence_is_not_talking():
    a = _analyzer()
    assert a._talking_pairs([_p(1, 300, 0.1), _p(2, 500, -0.1)]) == []


def test_missing_face_is_skipped():
    a = _analyzer()
    assert a._talking_pairs([_p(1, 300, None), _p(2, 500, -0.4)]) == []


def test_pairs_are_sorted_and_unordered():
    a = _analyzer()
    # right-first input still yields a sorted (low, high) pair
    assert a._talking_pairs([_p(5, 500, -0.4), _p(2, 300, 0.4)]) == [(2, 5)]


def test_counts_includes_talking():
    people = [{"state": "talking"}, {"state": "talking"}, {"state": "working"}]
    c = ActivityAnalyzer.counts(people)
    assert c["talking"] == 2 and c["working"] == 1


def _kpts(idx):
    """Build a 17-keypoint list; idx maps keypoint index -> (x, y, conf)."""
    k = [[0.0, 0.0, 0.0] for _ in range(17)]
    for i, v in idx.items():
        k[i] = list(v)
    return k


# Image coords: y increases downward. Upright: nose above (smaller y) the shoulders.
def test_upright_seated_no_hips_is_working():
    # seated person, hips hidden by desk → still gets a verdict (not unknown)
    k = _kpts({NOSE: (100, 20, 1.0), L_SHO: (60, 100, 1.0), R_SHO: (140, 100, 1.0)})
    state, feats = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == WORKING and "head_lift" in feats


def test_head_down_slump_no_hips_is_not_working():
    # nose well below shoulders (head on desk); no hips needed
    k = _kpts({NOSE: (100, 200, 1.0), L_SHO: (60, 100, 1.0), R_SHO: (140, 100, 1.0)})
    state, _ = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == NOT_WORKING


def test_reclined_torso_with_hips_is_not_working():
    # head up but hips visible and torso reclined far off vertical
    k = _kpts({NOSE: (60, 20, 1.0),
               L_SHO: (40, 100, 1.0), R_SHO: (120, 100, 1.0),
               L_HIP: (200, 160, 1.0), R_HIP: (260, 160, 1.0)})
    state, feats = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == NOT_WORKING and feats["tilt"] > 28


def test_facing_away_uses_ear_when_no_nose():
    # back to camera: nose hidden, but an ear is visible → still classified (working)
    k = _kpts({R_EAR: (100, 20, 0.9), L_SHO: (60, 100, 1.0), R_SHO: (140, 100, 1.0)})
    state, feats = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == WORKING and "head_lift" in feats


def test_buried_head_strong_shoulders_is_not_working():
    # clear shoulders, only a faint ear (face buried in arms) → not_working
    k = _kpts({R_EAR: (100, 95, 0.35), L_SHO: (60, 100, 0.95), R_SHO: (140, 100, 0.97)})
    state, feats = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == NOT_WORKING and feats.get("face") == "hidden"


def test_hidden_face_but_weak_shoulders_is_unknown():
    # face hidden AND shoulders weak → distant/unclear, not a confident buried call
    k = _kpts({R_EAR: (100, 95, 0.2), L_SHO: (60, 100, 0.35), R_SHO: (140, 100, 0.35)})
    state, feats = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == UNKNOWN


def test_facing_away_strong_ear_not_flipped_to_buried():
    # back to camera but ear clearly visible (0.9) → normal path → working
    k = _kpts({R_EAR: (100, 20, 0.9), L_SHO: (60, 100, 1.0), R_SHO: (140, 100, 1.0)})
    state, _ = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == WORKING


def test_missing_shoulders_is_unknown():
    k = _kpts({NOSE: (100, 20, 1.0)})
    state, feats = posture_state(k, 0.30, tilt_max=28.0, head_down=-0.50)
    assert state == UNKNOWN and feats == {}


def test_conversations_derives_unique_pairs():
    people = [
        {"id": 1, "talking_with": [2]},
        {"id": 2, "talking_with": [1]},
        {"id": 3, "talking_with": []},
    ]
    assert ActivityAnalyzer.conversations(people) == [[1, 2]]
