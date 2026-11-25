"""Per-track fusion and the quality gate in front of it.

  * services/track_attributes.py -- quality-weighted gender vote + age mean.
    A label is asserted only after min_votes AND min_agreement; a split vote
    stays None ("unknown" beats a flickering wrong M/F).
  * services/track_embedding_pool.py -- top-K by quality, quality floor,
    pooled = quality-weighted mean re-L2-normalised.
  * services/face_quality.py -- size / det score / pose / blur / brightness
    rejections, and a composite score that ranks better crops higher.

Synthetic frames only; no models.

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_track_fusion -v
"""
from __future__ import annotations

import contextlib
import random
import unittest

import numpy as np

from vms_face.config import settings
from vms_face.domain.enums import QualityReject
from vms_face.infra.insightface_runtime import FaceObservation
from vms_face.services.face_quality import FaceQualityGate, _safe_crop
from vms_face.services.track_attributes import TrackAttributes
from vms_face.services.track_embedding_pool import TrackEmbeddingPool


@contextlib.contextmanager
def override(**kw):
    old = {k: getattr(settings, k) for k in kw}
    for k, v in kw.items():
        setattr(settings, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(settings, k, v)


MALE, FEMALE = 1, 0


class TrackAttributesTest(unittest.TestCase):
    def setUp(self):
        cm = override(attributes_min_votes=3, attributes_max_votes=8, attributes_min_agreement=0.70)
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        self.a = TrackAttributes()

    def vote(self, gender, n=1, w=0.8, age=None):
        for _ in range(n):
            self.a.add_vote(gender, age, w)

    def test_no_votes_means_no_label(self):
        self.assertIsNone(self.a.gender_label())
        self.assertIsNone(self.a.gender_confidence())
        self.assertIsNone(self.a.age_estimate())
        self.assertTrue(self.a.needs_sample())

    def test_label_waits_for_min_votes(self):
        self.vote(MALE, 2)
        self.assertIsNone(self.a.gender_label())
        self.vote(MALE)
        self.assertEqual(self.a.gender_label(), "Male")
        self.assertEqual(self.a.gender_confidence(), 1.0)

    def test_female_label(self):
        self.vote(FEMALE, 3)
        self.assertEqual(self.a.gender_label(), "Female")

    def test_votes_are_weighted_by_quality_not_counted(self):
        self.vote(FEMALE, 2, w=0.9)
        self.vote(MALE, 2, w=0.1)
        self.assertEqual(self.a.gender_label(), "Female")       # 1.8 vs 0.2 = 90 %
        self.assertAlmostEqual(self.a.gender_confidence(), 0.9, places=3)

    def test_split_vote_stays_unknown(self):
        self.vote(MALE, 4)
        self.vote(FEMALE, 4)
        self.assertIsNone(self.a.gender_label())
        self.assertIsNone(self.a.gender_confidence())

    def test_agreement_just_below_the_floor_is_unknown(self):
        self.vote(MALE, 2, w=0.69)
        self.vote(FEMALE, 1, w=0.31 * 2)                         # 1.38 / 2.0 = 0.69
        self.assertIsNone(self.a.gender_label())

    def test_sampling_stops_at_max_votes(self):
        for i in range(8):
            self.assertTrue(self.a.needs_sample())
            self.vote(MALE if i % 2 else FEMALE)
        self.assertFalse(self.a.needs_sample())

    def test_sampling_stops_early_once_decisive(self):
        self.vote(MALE, 2)
        self.assertTrue(self.a.needs_sample())                  # decisive but below min_votes
        self.vote(MALE)
        self.assertFalse(self.a.needs_sample())

    def test_unsure_vote_keeps_sampling(self):
        self.vote(MALE, 2)
        self.vote(FEMALE, 1)
        self.assertTrue(self.a.needs_sample())

    def test_missing_gender_is_not_a_vote_but_age_still_counts(self):
        self.a.add_vote(None, 30.0, 1.0)
        self.assertEqual(self.a.votes, 0)
        self.assertEqual(self.a.age_estimate(), 30)

    def test_age_is_the_quality_weighted_mean_and_ignores_non_positive(self):
        self.a.add_vote(None, 20.0, 1.0)
        self.a.add_vote(None, 40.0, 3.0)
        self.a.add_vote(None, 0.0, 10.0)
        self.a.add_vote(None, -5.0, 10.0)
        self.assertEqual(self.a.age_estimate(), 35)

    def test_zero_or_negative_weight_is_floored_not_subtracted(self):
        self.vote(MALE, 3, w=-5.0)
        self.assertEqual(self.a.gender_label(), "Male")
        self.assertEqual(self.a.votes, 3)


def unit(*v):
    a = np.asarray(v, dtype=np.float32)
    return a / np.linalg.norm(a)


class EmbeddingPoolTest(unittest.TestCase):
    def test_top_k_must_be_positive(self):
        with self.assertRaises(ValueError):
            TrackEmbeddingPool(top_k=0)

    def test_empty_pool_has_no_pooled_embedding(self):
        p = TrackEmbeddingPool()
        self.assertIsNone(p.pooled())
        self.assertEqual((p.size, p.best_quality, p.worst_quality_in_pool), (0, 0.0, 0.0))

    def test_quality_floor_rejects_even_into_empty_slots(self):
        p = TrackEmbeddingPool(top_k=3, min_quality=0.3)
        self.assertFalse(p.would_admit(0.29))
        self.assertFalse(p.add(0.29, unit(1, 0)))
        self.assertEqual(p.size, 0)
        self.assertTrue(p.add(0.3, unit(1, 0)))

    def test_negative_floor_is_clamped_to_zero(self):
        p = TrackEmbeddingPool(top_k=2, min_quality=-1.0)
        self.assertFalse(p.add(-0.5, unit(1, 0)))
        self.assertTrue(p.add(0.0, unit(1, 0)))

    def test_keeps_only_the_k_best(self):
        p = TrackEmbeddingPool(top_k=3)
        for q in (0.5, 0.2, 0.9, 0.4, 0.7, 0.1):
            p.add(q, unit(q, 1 - q))
        self.assertEqual(p.size, 3)
        self.assertEqual(sorted(q for q, _, _ in p._heap), [0.5, 0.7, 0.9])
        self.assertEqual(p.best_quality, 0.9)
        self.assertEqual(p.worst_quality_in_pool, 0.5)

    def test_full_pool_needs_strictly_better_quality(self):
        p = TrackEmbeddingPool(top_k=2)
        p.add(0.5, unit(1, 0))
        p.add(0.6, unit(0, 1))
        self.assertFalse(p.would_admit(0.5))
        self.assertFalse(p.add(0.5, unit(1, 1)))
        self.assertTrue(p.add(0.51, unit(1, 1)))

    def test_add_reports_whether_the_pool_changed(self):
        p = TrackEmbeddingPool(top_k=1)
        self.assertTrue(p.add(0.5, unit(1, 0)))
        self.assertFalse(p.add(0.4, unit(0, 1)))
        np.testing.assert_allclose(p.pooled(), unit(1, 0))

    def test_would_admit_mirrors_add(self):
        rng = random.Random(7)
        p = TrackEmbeddingPool(top_k=4, min_quality=0.2)
        for _ in range(300):
            q = round(rng.random(), 2)
            predicted = p.would_admit(q)
            self.assertEqual(p.add(q, unit(rng.random() + 0.01, rng.random())), predicted)

    def test_pooled_is_unit_norm_and_quality_weighted(self):
        p = TrackEmbeddingPool(top_k=5)
        p.add(0.9, unit(1, 0))
        p.add(0.1, unit(0, 1))
        v = p.pooled()
        self.assertAlmostEqual(float(np.linalg.norm(v)), 1.0, places=5)
        self.assertGreater(v[0], v[1])
        np.testing.assert_allclose(v, unit(0.9, 0.1), atol=1e-6)

    def test_single_member_pool_returns_that_embedding_normalised(self):
        p = TrackEmbeddingPool()
        p.add(0.7, np.array([3.0, 4.0], dtype=np.float32))
        np.testing.assert_allclose(p.pooled(), [0.6, 0.8], atol=1e-6)

    def test_pooled_dtype_is_float32(self):
        p = TrackEmbeddingPool()
        p.add(0.7, np.array([1.0, 2.0], dtype=np.float64))
        self.assertEqual(p.pooled().dtype, np.float32)

    def test_cancelling_embeddings_pool_to_none_not_nan(self):
        p = TrackEmbeddingPool()
        p.add(0.5, unit(1, 0))
        p.add(0.5, unit(-1, 0))
        self.assertIsNone(p.pooled())

    def test_non_vector_embedding_is_refused(self):
        with self.assertRaises(ValueError):
            TrackEmbeddingPool().add(0.5, np.zeros((2, 2)))

    def test_reset_empties_the_pool(self):
        p = TrackEmbeddingPool()
        p.add(0.5, unit(1, 0))
        p.reset()
        self.assertEqual(p.size, 0)
        self.assertIsNone(p.pooled())


def fobs(bbox, det=0.9, yaw=None, pitch=None) -> FaceObservation:
    return FaceObservation(bbox=np.asarray(bbox, dtype=np.float32), det_score=det, landmark_5=None,
                           embedding=None, yaw_deg=yaw, pitch_deg=pitch, age=None, gender=None)


def gate(**kw) -> FaceQualityGate:
    base = dict(min_face_px=40, min_det_score=0.5, max_blur_var=20.0, max_yaw_deg=45.0,
                max_pitch_deg=30.0, min_brightness=40.0, max_brightness=220.0)
    base.update(kw)
    return FaceQualityGate(**base)


def textured(h=240, w=320, mean=128, seed=0):
    rng = np.random.default_rng(seed)
    f = rng.integers(mean - 60, mean + 60, size=(h, w, 3)).astype(np.uint8)
    return f


FACE = (100, 50, 200, 170)       # 100 x 120 px


class FaceQualityGateTest(unittest.TestCase):
    def test_sharp_mid_brightness_face_passes_with_a_score_in_0_1(self):
        v = gate().evaluate(textured(), fobs(FACE))
        self.assertTrue(v.passed)
        self.assertIsNone(v.rejected_for)
        self.assertGreater(v.score, 0.0)
        self.assertLessEqual(v.score, 1.0)

    def test_too_small_face_is_rejected(self):
        v = gate().evaluate(textured(), fobs((100, 50, 130, 170)))
        self.assertEqual((v.passed, v.rejected_for, v.score), (False, QualityReject.TOO_SMALL, 0.0))

    def test_low_detector_confidence_is_rejected(self):
        v = gate().evaluate(textured(), fobs(FACE, det=0.3))
        self.assertEqual(v.rejected_for, QualityReject.LOW_DET_SCORE)

    def test_extreme_yaw_or_pitch_is_rejected_either_direction(self):
        for kw in ({"yaw": 60}, {"yaw": -60}, {"pitch": 35}, {"pitch": -35}):
            with self.subTest(**kw):
                self.assertEqual(gate().evaluate(textured(), fobs(FACE, **kw)).rejected_for,
                                 QualityReject.EXTREME_POSE)

    def test_unknown_pose_is_not_a_rejection(self):
        self.assertTrue(gate().evaluate(textured(), fobs(FACE, yaw=None, pitch=None)).passed)

    def test_box_outside_the_frame_is_rejected_not_crashing(self):
        v = gate().evaluate(textured(), fobs((1000, 1000, 1100, 1120)))
        self.assertEqual(v.rejected_for, QualityReject.TOO_SMALL)

    def test_flat_crop_is_blurry(self):
        flat = np.full((240, 320, 3), 128, dtype=np.uint8)
        v = gate().evaluate(flat, fobs(FACE))
        self.assertEqual(v.rejected_for, QualityReject.BLURRY)
        self.assertEqual(v.blur_var, 0.0)

    def test_blur_check_can_be_disabled(self):
        flat = np.full((240, 320, 3), 128, dtype=np.uint8)
        self.assertTrue(gate(max_blur_var=0.0).evaluate(flat, fobs(FACE)).passed)

    def test_too_dark_and_too_bright_are_rejected(self):
        dark = np.full((240, 320, 3), 10, dtype=np.uint8)
        bright = np.full((240, 320, 3), 250, dtype=np.uint8)
        for frame in (dark, bright):
            v = gate(max_blur_var=0.0).evaluate(frame, fobs(FACE))
            self.assertEqual(v.rejected_for, QualityReject.LOW_BRIGHTNESS)

    def test_higher_detector_confidence_scores_higher(self):
        f = textured()
        lo = gate().evaluate(f, fobs(FACE, det=0.6)).score
        hi = gate().evaluate(f, fobs(FACE, det=0.99)).score
        self.assertGreater(hi, lo)

    def test_bigger_face_scores_higher(self):
        f = textured(480, 640)
        small = gate().evaluate(f, fobs((100, 100, 150, 160))).score
        big = gate().evaluate(f, fobs((100, 100, 260, 290))).score
        self.assertGreater(big, small)

    def test_safe_crop_clamps_to_the_frame(self):
        f = textured(100, 100)
        self.assertEqual(_safe_crop(f, np.array([-20, -20, 50, 60])).shape[:2], (60, 50))
        self.assertEqual(_safe_crop(f, np.array([50, 50, 40, 60])).size, 0)


if __name__ == "__main__":
    unittest.main()
