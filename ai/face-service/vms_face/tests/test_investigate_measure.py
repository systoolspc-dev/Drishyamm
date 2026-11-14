"""I-1 phase 0 meter + person box tracker — pure logic, fake clock.

Run inside the ai container (no GPU, no Redis, no Postgres needed):

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_investigate_measure -v
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from vms_face.investigate.box_tracker import BoxTracker, iou
from vms_face.investigate.measure import TrackMeter


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def tf(track_id: str):
    """Stand-in for TrackedFace: the meter only reads .track.track_id."""
    return SimpleNamespace(track=SimpleNamespace(track_id=track_id), is_new=False)


def dead(track_id: str, hits: int):
    return SimpleNamespace(track_id=track_id, hits=hits)


def box(x: float, y: float = 100.0, w: float = 80.0, h: float = 200.0):
    return (x, y, x + w, y + h, 0.9)


class IouTest(unittest.TestCase):
    def test_identical_and_disjoint(self):
        self.assertAlmostEqual(iou(box(0), box(0)), 1.0)
        self.assertEqual(iou(box(0), box(500)), 0.0)


class BoxTrackerTest(unittest.TestCase):
    def test_walking_person_is_one_track(self):
        clock = Clock()
        bt = BoxTracker(max_gap_s=1.0, clock=clock)
        for i in range(20):              # 4 s walk, small steps
            bt.step([box(100 + i * 5)])
            clock.t += 0.2
        self.assertEqual(bt.active_count, 1)
        self.assertEqual(bt.closed, [])

    def test_track_closes_after_gap(self):
        clock = Clock()
        bt = BoxTracker(max_gap_s=1.0, clock=clock)
        for i in range(10):
            bt.step([box(100 + i * 5)])
            clock.t += 0.2
        clock.t += 1.5
        bt.step([])
        self.assertEqual(len(bt.closed), 1)
        tr = bt.closed[0]
        self.assertEqual(tr.hits, 10)
        self.assertAlmostEqual(tr.duration, 1.8, places=5)
        self.assertEqual(bt.active_count, 0)

    def test_two_people_stay_separate(self):
        clock = Clock()
        bt = BoxTracker(clock=clock)
        for i in range(5):
            live = bt.step([box(100 + i * 5), box(600 - i * 5)])
            clock.t += 0.2
        self.assertEqual(len({t.track_id for t in live}), 2)
        self.assertEqual(bt.active_count, 2)


class TrackMeterTest(unittest.TestCase):
    def meter(self, clock, **kw):
        kw.setdefault("min_seconds", 1.0)
        kw.setdefault("min_hits", 3)
        kw.setdefault("log_interval_s", 10**9)
        kw.setdefault("person_max_gap_s", 1.0)
        return TrackMeter("cam-1", clock=clock, **kw)

    def test_face_track_duration_and_kept(self):
        clock = Clock()
        m = self.meter(clock)
        for _ in range(10):              # seen for 2 s
            m.face_step([tf("t1")], [])
            clock.t += 0.2
        m.face_step([], [dead("t1", hits=10)])
        snap = m.snapshot()
        self.assertEqual(snap["totals"]["face"]["closed"], 1)
        self.assertEqual(snap["totals"]["face"]["kept"], 1)
        self.assertEqual(snap["open"]["face"], 0)

    def test_flicker_is_junk(self):
        clock = Clock()
        m = self.meter(clock)
        m.face_step([tf("t1")], [])      # one frame only
        clock.t += 0.1
        m.face_step([], [dead("t1", hits=1)])
        face = m.snapshot()["totals"]["face"]
        self.assertEqual((face["closed"], face["kept"], face["junk"]), (1, 0, 1))

    def test_long_but_few_hits_is_junk(self):
        clock = Clock()
        m = self.meter(clock)
        m.face_step([tf("t1")], [])
        clock.t += 5
        m.face_step([tf("t1")], [])
        m.face_step([], [dead("t1", hits=2)])
        self.assertEqual(m.snapshot()["totals"]["face"]["kept"], 0)

    def test_person_tracks_counted(self):
        clock = Clock()
        m = self.meter(clock)
        for i in range(10):
            m.person_step([box(100 + i * 5)])
            clock.t += 0.2
        clock.t += 2
        m.person_step([])
        snap = m.snapshot()
        self.assertTrue(snap["person_detection_ran"])
        self.assertEqual(snap["totals"]["person"]["kept"], 1)

    def test_close_counts_open_tracks(self):
        clock = Clock()
        m = self.meter(clock)
        for i in range(10):
            m.face_step([tf("t1")], [])
            m.person_step([box(100 + i * 5)])
            clock.t += 0.2
        m.close()
        snap = m.snapshot()
        self.assertEqual(snap["totals"]["face"]["kept"], 1)
        self.assertEqual(snap["totals"]["person"]["kept"], 1)
        self.assertEqual(snap["open"], {"face": 0, "person": 0})

    def test_window_resets_after_log(self):
        clock = Clock()
        m = self.meter(clock, log_interval_s=60)
        for _ in range(10):
            m.face_step([tf("t1")], [])
            clock.t += 0.2
        m.face_step([], [dead("t1", hits=10)])
        clock.t += 61
        m.face_step([], [])              # triggers the log + window reset
        self.assertEqual(m._window["face"].closed, 0)
        self.assertEqual(m.snapshot()["totals"]["face"]["kept"], 1)

    def test_projection_per_day(self):
        clock = Clock()
        m = self.meter(clock)
        for _ in range(10):
            m.face_step([tf("t1")], [])
            clock.t += 0.2
        m.face_step([], [dead("t1", hits=10)])
        clock.t = 1000.0 + 3600          # one hour in, one kept track
        self.assertEqual(m.snapshot()["kept_per_day_projection"]["face"], 24)


if __name__ == "__main__":
    unittest.main()
