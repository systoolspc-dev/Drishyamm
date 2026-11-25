"""Face tracker (services/face_tracker.py): SORT-style IOUTracker.

Everything downstream keys off the tracker's ids -- the identity latch, the
embedding pool, footfall counting, the investigation indexer, ReID links --
so the lifecycle must be exact: born on an unmatched detection, kept on an
IoU match, coasted on a miss, dropped only once miss_count > max_age and
reported exactly once in `dropped_last_step`.

Pure NumPy/SciPy; no models, no GPU.

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_tracker -v
"""
from __future__ import annotations

import unittest

import numpy as np

from vms_face.infra.insightface_runtime import FaceObservation
from vms_face.services.face_tracker import IOUTracker, _bbox_to_z, _iou_matrix, _x_to_bbox


def obs(x1, y1, x2, y2, emb=None, score=0.9) -> FaceObservation:
    return FaceObservation(
        bbox=np.array([x1, y1, x2, y2], dtype=np.float32),
        det_score=score,
        landmark_5=None,
        embedding=None if emb is None else np.asarray(emb, dtype=np.float32),
        yaw_deg=None,
        pitch_deg=None,
        age=None,
        gender=None,
    )


def tracker(max_age=3, min_hits=3, appearance_weight=0.0) -> IOUTracker:
    return IOUTracker(iou_threshold=0.3, max_age=max_age, min_hits=min_hits,
                      appearance_weight=appearance_weight, appearance_alpha=0.7)


BOX = (100, 100, 160, 170)
FAR = (500, 400, 560, 470)


class BoxMathTest(unittest.TestCase):
    def test_bbox_state_roundtrip(self):
        b = np.array([10, 20, 70, 140], dtype=np.float32)
        np.testing.assert_allclose(_x_to_bbox(_bbox_to_z(b)), b, atol=1e-3)

    def test_iou_identity_disjoint_and_half(self):
        a = np.array([[0, 0, 10, 10]], dtype=np.float32)
        b = np.array([[0, 0, 10, 10], [20, 20, 30, 30], [5, 0, 15, 10]], dtype=np.float32)
        iou = _iou_matrix(a, b)[0]
        self.assertAlmostEqual(iou[0], 1.0, places=5)
        self.assertEqual(iou[1], 0.0)
        self.assertAlmostEqual(iou[2], 50 / 150, places=5)

    def test_iou_of_empty_sets_has_the_right_shape(self):
        self.assertEqual(_iou_matrix(np.zeros((0, 4)), np.zeros((3, 4))).shape, (0, 3))
        self.assertEqual(_iou_matrix(np.zeros((2, 4)), np.zeros((0, 4))).shape, (2, 0))


class LifecycleTest(unittest.TestCase):
    def test_first_detection_births_a_new_track(self):
        t = tracker()
        out = t.step([obs(*BOX)])
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].is_new)
        self.assertEqual(out[0].track.track_id, "t00000001")
        self.assertEqual(out[0].track.hits, 1)
        self.assertEqual(t.active_track_count, 1)

    def test_same_place_next_frame_keeps_the_id(self):
        t = tracker()
        tid = t.step([obs(*BOX)])[0].track.track_id
        out = t.step([obs(102, 101, 162, 171)])
        self.assertEqual(len(out), 1)
        self.assertFalse(out[0].is_new)
        self.assertEqual(out[0].track.track_id, tid)
        self.assertEqual(out[0].track.hits, 2)
        self.assertEqual(out[0].track.miss_count, 0)

    def test_far_detection_is_a_new_track_not_a_jump(self):
        t = tracker()
        a = t.step([obs(*BOX)])[0].track.track_id
        out = t.step([obs(*FAR)])
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].is_new)
        self.assertNotEqual(out[0].track.track_id, a)
        self.assertEqual(t.active_track_count, 2)       # the first one coasts

    def test_two_people_keep_their_own_ids(self):
        t = tracker()
        first = {tf.track.track_id: tuple(tf.observation.bbox) for tf in t.step([obs(*BOX), obs(*FAR)])}
        for dx in (3, 6, 9):
            out = t.step([obs(FAR[0] + dx, FAR[1], FAR[2] + dx, FAR[3]), obs(BOX[0] + dx, BOX[1], BOX[2] + dx, BOX[3])])
            by_id = {tf.track.track_id: tf.observation.bbox for tf in out}
            self.assertEqual(set(by_id), set(first))
            for tid, b0 in first.items():
                self.assertLess(abs(by_id[tid][0] - b0[0]), 50, "ids swapped between people")

    def test_track_survives_misses_up_to_max_age(self):
        t = tracker(max_age=3)
        tid = t.step([obs(*BOX)])[0].track.track_id
        for expected_miss in (1, 2, 3):
            self.assertEqual(t.step([]), [])
            self.assertEqual(t.dropped_last_step, [])
            self.assertEqual(t.get_track(tid).miss_count, expected_miss)
        out = t.step([obs(*BOX)])
        self.assertEqual(out[0].track.track_id, tid, "re-detected within max_age keeps the id")
        self.assertEqual(out[0].track.miss_count, 0)

    def test_track_is_dropped_once_miss_count_exceeds_max_age(self):
        t = tracker(max_age=3)
        tid = t.step([obs(*BOX)])[0].track.track_id
        for _ in range(3):
            t.step([])
        t.step([obs(*FAR)])                              # keeps step() off its empty fast path
        self.assertEqual([d.track_id for d in t.dropped_last_step], [tid])
        self.assertIsNone(t.get_track(tid))
        self.assertEqual(t.active_track_count, 1)

    def test_dropped_list_is_replaced_on_the_next_step(self):
        t = tracker(max_age=1)
        t.step([obs(*BOX)])
        t.step([obs(*FAR)])
        t.step([obs(*FAR)])
        self.assertEqual(len(t.dropped_last_step), 1)
        t.step([obs(*FAR)])
        self.assertEqual(t.dropped_last_step, [])

    @unittest.expectedFailure
    def test_dropped_track_is_reported_exactly_once_even_in_an_empty_scene(self):
        # SUSPECTED BUG (face_tracker.py step(): early `return []` when there
        # are no tracks and no observations skips `self.dropped_last_step = ...`).
        # The orchestrator re-banks / the investigate meter re-counts the same
        # dead track on every following empty frame. Remove expectedFailure
        # once fixed.
        t = tracker(max_age=1)
        t.step([obs(*BOX)])
        t.step([])
        t.step([])                                      # drops the only track
        self.assertEqual(len(t.dropped_last_step), 1)
        t.step([])                                      # nothing alive, nothing seen
        self.assertEqual(t.dropped_last_step, [])

    def test_ids_are_unique_and_never_reused_after_a_drop(self):
        t = tracker(max_age=1)
        seen: list[str] = []
        for i in range(30):
            x = (i % 5) * 200
            for tf in t.step([obs(x, 600 * (i % 2), x + 50, 600 * (i % 2) + 60)]):
                if tf.is_new:
                    seen.append(tf.track.track_id)
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(seen, sorted(seen))
        self.assertTrue(all(s.startswith("t") and len(s) == 9 for s in seen))

    def test_empty_step_with_no_tracks_is_a_noop(self):
        t = tracker()
        self.assertEqual(t.step([]), [])
        self.assertEqual(t.active_track_count, 0)

    def test_confirmation_needs_min_hits(self):
        t = tracker(min_hits=3)
        tid = t.step([obs(*BOX)])[0].track.track_id
        self.assertFalse(t.is_confirmed(tid))
        t.step([obs(*BOX)])
        self.assertFalse(t.is_confirmed(tid))
        t.step([obs(*BOX)])
        self.assertTrue(t.is_confirmed(tid))
        self.assertFalse(t.is_confirmed("t99999999"))

    def test_age_counts_every_predicted_frame(self):
        t = tracker(max_age=10)
        tid = t.step([obs(*BOX)])[0].track.track_id
        t.step([])
        t.step([obs(*BOX)])
        self.assertEqual(t.get_track(tid).age, 2)


class OverlayAndQualityTest(unittest.TestCase):
    def test_overlay_default_shows_only_tracks_matched_this_frame(self):
        t = tracker(max_age=5)
        t.step([obs(*BOX), obs(*FAR)])
        t.step([obs(*BOX)])
        self.assertEqual(len(t.tracks_for_overlay()), 1)
        self.assertEqual(len(t.tracks_for_overlay(max_miss=1)), 2)
        self.assertEqual(len(t.tracks()), 2)

    def test_update_quality_only_reports_improvements(self):
        t = tracker()
        tf = t.step([obs(*BOX)])[0]
        tid = tf.track.track_id
        self.assertTrue(t.update_quality(tid, 0.5, tf.observation))
        self.assertFalse(t.update_quality(tid, 0.4, tf.observation))
        self.assertFalse(t.update_quality(tid, 0.5, tf.observation))
        self.assertTrue(t.update_quality(tid, 0.6, tf.observation))
        self.assertEqual(t.get_track(tid).best_quality, 0.6)
        self.assertFalse(t.update_quality("nope", 1.0, tf.observation))


class AppearanceTest(unittest.TestCase):
    E1 = np.eye(8, dtype=np.float32)[0] * 3.0    # not unit length on purpose
    E2 = np.eye(8, dtype=np.float32)[1]

    def test_smooth_embedding_is_unit_norm(self):
        t = tracker(appearance_weight=0.5)
        tf = t.step([obs(*BOX, emb=self.E1)])[0]
        self.assertAlmostEqual(float(np.linalg.norm(tf.track.smooth_embedding)), 1.0, places=5)
        t.step([obs(*BOX, emb=self.E1 + self.E2)])
        self.assertAlmostEqual(float(np.linalg.norm(t.get_track(tf.track.track_id).smooth_embedding)), 1.0, places=5)

    def test_appearance_breaks_an_iou_tie(self):
        t = tracker(appearance_weight=0.5)
        tid = t.step([obs(100, 100, 160, 160, emb=self.E1)])[0].track.track_id
        # Two detections overlapping the track equally (shifted left/right).
        out = t.step([obs(80, 100, 140, 160, emb=self.E2), obs(120, 100, 180, 160, emb=self.E1)])
        kept = [tf for tf in out if tf.track.track_id == tid]
        self.assertEqual(len(kept), 1)
        np.testing.assert_allclose(kept[0].observation.bbox, [120, 100, 180, 160])

    def test_identical_appearance_cannot_override_the_iou_gate(self):
        t = tracker(appearance_weight=0.9)
        tid = t.step([obs(*BOX, emb=self.E1)])[0].track.track_id
        out = t.step([obs(*FAR, emb=self.E1)])
        self.assertTrue(out[0].is_new)
        self.assertNotEqual(out[0].track.track_id, tid)

    def test_update_appearance_normalises_and_ignores_bad_input(self):
        t = tracker()
        tid = t.step([obs(*BOX)])[0].track.track_id
        self.assertIsNone(t.get_track(tid).smooth_embedding)
        t.update_appearance(tid, np.zeros(8))
        self.assertIsNone(t.get_track(tid).smooth_embedding)
        t.update_appearance(tid, self.E1)
        np.testing.assert_allclose(t.get_track(tid).smooth_embedding, self.E1 / 3.0, atol=1e-6)
        t.update_appearance("unknown", self.E2)        # no error
        t.update_appearance(tid, self.E2)
        e = t.get_track(tid).smooth_embedding
        self.assertAlmostEqual(float(np.linalg.norm(e)), 1.0, places=5)
        self.assertGreater(e[0], e[1], "EWMA alpha=0.7 keeps most of the old appearance")


if __name__ == "__main__":
    unittest.main()
