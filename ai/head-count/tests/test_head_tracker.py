"""HeadTracker tests — count = confirmed persistent tracks (v2 semantics)."""
import numpy as np

from headcount.head_tracker import HeadTracker

HEAD = np.array([[100, 100, 140, 150]], dtype=np.float32)


def _t(**kw):
    d = dict(candidate_conf=0.5, strong_conf=0.65, confirm_hits=2,
             max_miss=2, miss_timeout_sec=6.0)
    d.update(kw)
    return HeadTracker(**d)


def test_weak_detection_needs_persistence_to_confirm():
    trk = _t()
    assert trk.update(HEAD, np.array([0.55]), 0.0) == 0     # tentative only
    assert trk.tentative_count == 1
    assert trk.update(HEAD, np.array([0.55]), 0.5) == 1     # 2nd hit → confirmed


def test_strong_detection_confirms_instantly():
    trk = _t()
    assert trk.update(HEAD, np.array([0.80]), 0.0) == 1


def test_single_flicker_never_counts():
    trk = _t()
    trk.update(HEAD, np.array([0.55]), 0.0)
    # detection disappears: 3 consecutive missed inferences → expired
    empty = np.zeros((0, 4), np.float32)
    for i in range(1, 4):
        trk.update(empty, np.zeros(0), i * 0.5)
    assert trk.confirmed_count == 0
    assert trk.tentative_count == 0


def test_brief_occlusion_coasts_without_dropping_count():
    trk = _t()
    trk.update(HEAD, np.array([0.8]), 0.0)
    empty = np.zeros((0, 4), np.float32)
    assert trk.update(empty, np.zeros(0), 0.5) == 1         # 1 miss → still counted
    assert trk.update(HEAD, np.array([0.8]), 1.0) == 1      # reacquired, same track
    assert len(trk.tracks) == 1


def test_person_leaving_drops_after_max_miss():
    trk = _t()
    trk.update(HEAD, np.array([0.8]), 0.0)
    empty = np.zeros((0, 4), np.float32)
    trk.update(empty, np.zeros(0), 0.5)                     # miss 1 — coast
    trk.update(empty, np.zeros(0), 1.0)                     # miss 2 — coast
    assert trk.update(empty, np.zeros(0), 1.5) == 0         # miss 3 > max_miss → gone


def test_moving_head_stays_one_track():
    trk = _t()
    box = HEAD.copy()
    trk.update(box, np.array([0.8]), 0.0)
    for i in range(1, 8):
        box = box + 12                                       # steady walk
        n = trk.update(box, np.array([0.8]), i * 0.4)
        assert n == 1
    assert len(trk.tracks) == 1                              # no duplicate tracks


def test_two_people_two_tracks():
    trk = _t()
    both = np.array([[100, 100, 140, 150], [400, 120, 440, 170]], dtype=np.float32)
    trk.update(both, np.array([0.8, 0.8]), 0.0)
    assert trk.update(both, np.array([0.8, 0.8]), 0.5) == 2


def test_coast_timeout_expires_even_without_updates():
    trk = _t(miss_timeout_sec=2.0)
    trk.update(HEAD, np.array([0.8]), 0.0)
    empty = np.zeros((0, 4), np.float32)
    assert trk.update(empty, np.zeros(0), 3.0) == 0          # wall-clock cap hit


# ── v2.1 safety fixes (external review round 2) ──────────────────────────

def _sup_params(**kw):
    d = dict(candidate_conf=0.5, strong_conf=0.65, confirm_hits=2,
             min_confirm_sep_sec=0.3, max_miss=2, miss_timeout_sec=6.0,
             static_min_hits=8, static_min_span_sec=120.0, move_release_ratio=0.35)
    d.update(kw)
    return HeadTracker(**d)


def test_burst_does_not_confirm_without_temporal_separation():
    trk = _sup_params()
    trk.update(HEAD, np.array([0.55]), 0.000)
    assert trk.update(HEAD, np.array([0.55]), 0.050) == 0   # 50ms burst — NOT confirmed
    assert trk.update(HEAD, np.array([0.55]), 0.400) == 1   # real span → confirmed


def test_stationary_HUMAN_is_never_demoted_to_furniture():
    """The round-2 critical fix: a person who WALKED IN then sits perfectly
    still for arbitrarily long must keep counting."""
    trk = _sup_params()
    box = np.array([[400, 200, 440, 250]], dtype=np.float32)
    t = 0.0
    trk.update(box, np.array([0.8]), t, in_motion=True)
    # walks across the room — arrival context: the scene is IN MOTION, so even
    # if fast movement breaks association, every segment is motion-born.
    for _ in range(5):
        box = box - 60; t += 0.5
        trk.update(box, np.array([0.8]), t, in_motion=True)
    # then sits PERFECTLY still for 10 minutes of heartbeats (scene static)
    for _ in range(60):
        t += 10.0
        n = trk.update(box, np.array([0.8]), t, in_motion=False)
    assert n == 1                       # still counted
    assert trk.static_count == 0        # never flagged furniture


def test_never_moved_box_becomes_furniture_and_count_drops():
    trk = _sup_params()
    t = 0.0
    n = 1
    for _ in range(13):                 # chair detected every 15s, never moves
        n = trk.update(HEAD, np.array([0.57]), t)
        t += 15.0
    assert n == 0                       # flagged static → excluded
    assert trk.static_count == 1
    assert trk.last_keep == [False]     # and not drawn


def test_sitting_in_the_chair_rehabilitates_the_spot():
    trk = _sup_params()
    t = 0.0
    for _ in range(13):
        trk.update(HEAD, np.array([0.57]), t); t += 15.0
    assert trk.static_count == 1
    # person sits: detection shifts well off the headrest's birth position
    person = HEAD + np.array([[30, -25, 30, -25]], dtype=np.float32)
    t += 10.0
    n = trk.update(person, np.array([0.8]), t)
    assert trk.static_count == 0        # displacement cleared the flag
    assert n == 1                       # the person counts


def test_area_gate_rejects_impossible_association():
    trk = _sup_params()
    trk.update(HEAD, np.array([0.8]), 0.0)
    giant = np.array([[80, 80, 400, 400]], dtype=np.float32)   # 25x the area
    trk.update(giant, np.array([0.8]), 0.5)
    assert len(trk.tracks) == 2         # NOT matched to the head track


# ── round-3 evidence model + Camera-16 fixes ─────────────────────────────

def test_headdown_weak_detection_counts_with_persistence():
    """Camera 16 live failure: head-down pose scores ~0.45. With the lower
    candidate floor it must count after persisting (2 hits / 0.3s)."""
    trk = _sup_params(candidate_conf=0.42)
    trk.update(HEAD, np.array([0.45]), 0.0)
    assert trk.update(HEAD, np.array([0.45]), 0.5) == 1


def test_furniture_born_during_motion_eventually_drops():
    """Round-3 review: arrival protection must EXPIRE — a chair first detected
    while someone walked past cannot stay protected forever."""
    trk = _sup_params(candidate_conf=0.42)
    t = 0.0
    n = 1
    for _ in range(40):                       # 600s of stable weak detections
        n = trk.update(HEAD, np.array([0.55]), t, in_motion=(t == 0.0))
        t += 15.0
    assert n == 0                             # protection expired → furniture
    assert trk.static_count == 1


def test_region_activity_keeps_seated_human_counted():
    """A seated phone-scroller barely displaces their head box, but their
    hands/head trip region micro-motion — the stillness clock must reset."""
    trk = _sup_params(candidate_conf=0.42)
    fw, fh = 640, 360
    quiet = np.zeros((90, 160), dtype=np.uint8)
    busy = quiet.copy(); busy[25:43, 25:40] = 200   # activity inside HEAD's region
    t, n = 0.0, 0
    for i in range(40):                       # 600s, weak conf, no displacement
        n = trk.update(HEAD, np.array([0.5]), t)
        if i % 4 == 0:                        # micro-motion every ~60s
            trk.note_region_activity(quiet, busy, fw, fh, now=t)
        t += 15.0
    assert n == 1                             # still counted after 10 minutes
    assert trk.static_count == 0
