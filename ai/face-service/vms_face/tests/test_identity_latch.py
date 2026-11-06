"""Identity latch state machine — pure logic, deterministic clock.

Run inside the ai container (no GPU, no Redis needed):

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_identity_latch -v
"""
from __future__ import annotations

import unittest

import numpy as np

from vms_face.services.identity_latch import (
    IdentityLatch,
    LatchConfig,
    LatchState,
    RecentIdentityBank,
    Verdict,
)

CFG = LatchConfig(
    confirm_k=2,
    confirm_n=3,
    candidate_gap_sec=0.5,
    reverify_sec=12.0,
    quality_jump=0.10,
    unlatch_after=3,
    max_unknown_queries=3,
    unknown_retry_sec=20.0,
)


def hit(pid: str, sim: float = 0.7, at: float = 0.0) -> Verdict:
    return Verdict(person_id=pid, name=f"Name-{pid}", similarity=sim, ambiguous=False, at=at)


def miss(at: float = 0.0) -> Verdict:
    return Verdict(person_id=None, name=None, similarity=0.2, ambiguous=False, at=at)


def ambiguous(at: float = 0.0) -> Verdict:
    return Verdict(person_id=None, name=None, similarity=0.5, ambiguous=True, at=at)


def fresh() -> IdentityLatch:
    return IdentityLatch(config=CFG)


class TestConverge(unittest.TestCase):
    def test_new_track_embeds_and_publishes_first_template(self):
        l = fresh()
        self.assertTrue(l.should_embed(0.0, 0.5).ok)
        d = l.should_publish(0.0, pool_changed=True, quality=0.5, hits=1, min_hits=3)
        self.assertFalse(d.ok)
        self.assertEqual(d.reason, "immature")
        d = l.should_publish(0.0, pool_changed=True, quality=0.5, hits=3, min_hits=3)
        self.assertTrue(d.ok)
        self.assertEqual(d.reason, "first_template")
        l.note_published(0.0, 0.5)
        self.assertIs(l.state, LatchState.CANDIDATE)

    def test_candidate_rate_limited_and_needs_pool_change(self):
        l = fresh()
        l.should_publish(0.0, pool_changed=True, quality=0.5, hits=3, min_hits=3)
        l.note_published(0.0, 0.5)
        # same pool → no query
        self.assertFalse(l.should_publish(0.1, pool_changed=False, quality=0.5, hits=4, min_hits=3).ok)
        # changed pool but inside the gap → no query
        d = l.should_publish(0.1, pool_changed=True, quality=0.5, hits=4, min_hits=3)
        self.assertFalse(d.ok)
        self.assertEqual(d.reason, "candidate_gap")
        # after the gap → query
        self.assertTrue(l.should_publish(0.6, pool_changed=True, quality=0.5, hits=4, min_hits=3).ok)

    def test_first_hit_is_provisional_second_confirms(self):
        l = fresh()
        l.note_face(0.0)
        b, a, r = l.apply_verdict(hit("A"), 1.0)
        self.assertEqual((b, a, r), (LatchState.NEW, LatchState.CANDIDATE, "provisional"))
        shown = l.display()
        self.assertEqual((shown.name, shown.state), ("Name-A", "provisional"))
        self.assertEqual(l.provisional_at, 1.0)
        b, a, r = l.apply_verdict(hit("A"), 2.0)
        self.assertEqual((b, a, r), (LatchState.CANDIDATE, LatchState.LATCHED, "confirmed"))
        self.assertEqual(l.display().state, "confirmed")
        self.assertEqual(l.latched_at, 2.0)


class TestLatched(unittest.TestCase):
    def latched(self, t: float = 2.0) -> IdentityLatch:
        l = fresh()
        l.apply_verdict(hit("A"), t - 1.0)
        l.apply_verdict(hit("A"), t)
        l.note_published(t, 0.6)
        self.assertIs(l.state, LatchState.LATCHED)
        return l

    def test_no_embed_while_latched_until_timer(self):
        l = self.latched(2.0)
        d = l.should_embed(3.0, 0.6)
        self.assertFalse(d.ok)
        self.assertEqual(d.reason, "identity_latched")
        d = l.should_embed(2.0 + 12.0, 0.6)
        self.assertTrue(d.ok)
        self.assertEqual(d.reason, "reverify_timer")

    def test_quality_jump_reopens(self):
        l = self.latched(2.0)
        self.assertFalse(l.should_embed(3.0, 0.65).ok)
        d = l.should_embed(3.0, 0.71)
        self.assertTrue(d.ok)
        self.assertEqual(d.reason, "quality_jump")

    def test_uncertain_forces_one_verify(self):
        l = self.latched(2.0)
        l.uncertain = True
        self.assertEqual(l.should_embed(3.0, 0.6).reason, "uncertain")
        self.assertTrue(l.should_publish(3.0, pool_changed=False, quality=0.6, hits=9, min_hits=3).ok)
        l.note_published(3.0, 0.6)
        self.assertFalse(l.uncertain)

    def test_reverify_same_person_holds(self):
        l = self.latched(2.0)
        b, a, r = l.apply_verdict(hit("A", 0.8), 15.0)
        self.assertEqual(r, "reverified")
        self.assertEqual(l.last_verified_at, 15.0)
        self.assertEqual(l.confidence, 0.8)

    def test_one_miss_does_not_unlatch_three_do(self):
        l = self.latched(2.0)
        self.assertEqual(l.apply_verdict(miss(), 3.0)[2], "miss_held")
        self.assertEqual(l.display().state, "confirmed")
        self.assertEqual(l.apply_verdict(miss(), 4.0)[2], "miss_held")
        b, a, r = l.apply_verdict(miss(), 5.0)
        self.assertEqual((a, r), (LatchState.CANDIDATE, "unlatched"))
        self.assertEqual(l.display().state, "unknown")

    def test_identity_change_needs_k_agreeing(self):
        l = self.latched(2.0)
        # votes: [A, A] → B once = held
        b, a, r = l.apply_verdict(hit("B"), 3.0)
        self.assertEqual(r, "disagreement_held")
        self.assertEqual(l.person_id, "A")
        # votes: [A, B, B] → agreeing(B) = 2 = K → swap
        b, a, r = l.apply_verdict(hit("B"), 4.0)
        self.assertEqual(r, "identity_change")
        self.assertIs(l.state, LatchState.LATCHED)
        self.assertEqual(l.person_id, "B")
        self.assertEqual(l.transitions, 1)


class TestUnknown(unittest.TestCase):
    def test_negative_latch_after_n_misses(self):
        l = fresh()
        l.note_published(0.0, 0.5)
        self.assertEqual(l.apply_verdict(miss(), 1.0)[2], "miss")
        self.assertEqual(l.apply_verdict(miss(), 2.0)[2], "miss")
        b, a, r = l.apply_verdict(miss(), 3.0)
        self.assertEqual((a, r), (LatchState.UNKNOWN, "negative_latch"))
        d = l.should_embed(4.0, 0.5)
        self.assertFalse(d.ok)
        self.assertEqual(d.reason, "unknown_latched")

    def test_unknown_retries_on_timer_and_quality_jump(self):
        l = fresh()
        l.note_published(0.0, 0.5)
        for t in (1.0, 2.0, 3.0):
            l.apply_verdict(miss(), t)
        l.last_query_at = 3.0
        l.quality_at_last_query = 0.5
        self.assertFalse(l.should_embed(10.0, 0.55).ok)
        self.assertEqual(l.should_embed(10.0, 0.61).reason, "quality_jump")
        self.assertEqual(l.should_embed(3.0 + 20.0, 0.5).reason, "unknown_retry")

    def test_provisional_survives_ambiguous_but_not_clean_miss(self):
        l = fresh()
        l.apply_verdict(hit("A"), 1.0)
        self.assertEqual(l.display().state, "provisional")
        self.assertEqual(l.apply_verdict(ambiguous(), 2.0)[2], "ambiguous_held")
        self.assertEqual(l.display().state, "provisional")
        l.apply_verdict(miss(), 3.0)
        self.assertEqual(l.display().state, "unknown")

    def test_hit_after_unknown_reopens(self):
        l = fresh()
        l.note_published(0.0, 0.5)
        for t in (1.0, 2.0, 3.0):
            l.apply_verdict(miss(), t)
        self.assertIs(l.state, LatchState.UNKNOWN)
        b, a, r = l.apply_verdict(hit("Z"), 30.0)
        self.assertEqual((a, r), (LatchState.CANDIDATE, "provisional"))


class TestReassociation(unittest.TestCase):
    def test_adopt_is_provisional_and_one_verdict_confirms(self):
        l = fresh()
        l.adopt("A", "Name-A", 0.75, 5.0)
        self.assertEqual(l.display().state, "provisional")
        self.assertTrue(l.uncertain)
        self.assertTrue(l.should_publish(5.0, pool_changed=True, quality=0.5, hits=3, min_hits=3).ok)
        b, a, r = l.apply_verdict(hit("A"), 6.0)
        self.assertEqual((a, r), (LatchState.LATCHED, "confirmed"))

    def test_bank_claims_by_cosine_and_prunes(self):
        bank = RecentIdentityBank(ttl_sec=30.0, min_cosine=0.7, max_items=8)
        rng = np.random.default_rng(0)
        t_a = rng.standard_normal(512).astype(np.float32)
        t_a /= np.linalg.norm(t_a)
        dead = fresh()
        dead.apply_verdict(hit("A"), 0.0)
        dead.apply_verdict(hit("A"), 1.0)
        bank.remember(dead, t_a, now=10.0)
        self.assertEqual(len(bank), 1)
        # A near-identical template claims it; the winner is removed.
        near = t_a + 0.05 * rng.standard_normal(512).astype(np.float32)
        got = bank.claim(near, now=12.0)
        self.assertIsNotNone(got)
        self.assertEqual(got.person_id, "A")
        self.assertEqual(len(bank), 0)
        # A random template does not.
        bank.remember(dead, t_a, now=12.0)
        self.assertIsNone(bank.claim(rng.standard_normal(512).astype(np.float32), now=13.0))
        # TTL prunes.
        self.assertIsNone(bank.claim(near, now=12.0 + 31.0))
        self.assertEqual(len(bank), 0)

    def test_bank_ignores_unlatched_tracks(self):
        bank = RecentIdentityBank(ttl_sec=30.0, min_cosine=0.7)
        l = fresh()
        l.apply_verdict(hit("A"), 0.0)   # provisional only
        bank.remember(l, np.ones(512, dtype=np.float32), now=1.0)
        self.assertEqual(len(bank), 0)


if __name__ == "__main__":
    unittest.main()
