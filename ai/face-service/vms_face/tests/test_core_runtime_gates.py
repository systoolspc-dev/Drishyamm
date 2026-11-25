"""Per-camera runtime gates: motion gate, camera sharding, snapshot cache.

  * services/motion_gate.py -- may skip the detector only when the scene is
    static AND nothing is tracked, never more than max_skip frames in a row.
  * services/sharding.py -- camera -> shard ownership: stable, never the
    primary when it doesn't own cameras, balanced mode spreads evenly,
    sticky, agrees under races, falls back to hashing when Redis is down.
    A fake Redis stands in for the real one.
  * services/snapshot_cache.py -- rate-limited JPEG cache with a fake clock.

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_runtime_gates -v
"""
from __future__ import annotations

import asyncio
import contextlib
import types
import unittest
import uuid
from collections import Counter
from unittest import mock

import numpy as np
from fastapi import HTTPException

from vms_face.config import settings
from vms_face.services import sharding, snapshot_cache
from vms_face.services.motion_gate import MotionGate
from vms_face.services.snapshot_cache import SnapshotCache


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


class FakeClock:
    def __init__(self, t=1000.0):
        self.t = t

    def monotonic(self):
        return self.t

    def time(self):
        return 1_800_000_000.0 + self.t


# ── motion gate ────────────────────────────────────────────────────────────


def frame(v=0, h=240, w=320):
    return np.full((h, w, 3), v, dtype=np.uint8)


class MotionGateTest(unittest.TestCase):
    def setUp(self):
        cm = override(motion_gate_downscale_width=160, motion_gate_pixel_delta=26,
                      motion_gate_min_changed_frac=0.004, motion_gate_max_skip_frames=5)
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        self.g = MotionGate()

    def test_first_frame_always_detects(self):
        self.assertTrue(self.g.should_detect(frame(), 0))

    def test_static_empty_scene_is_skipped(self):
        self.g.should_detect(frame(), 0)
        self.assertFalse(self.g.should_detect(frame(), 0))

    def test_live_tracks_pin_the_detector_on(self):
        self.g.should_detect(frame(), 0)
        for _ in range(20):
            self.assertTrue(self.g.should_detect(frame(), 1))

    def test_skips_are_capped_then_a_full_detect_runs(self):
        self.g.should_detect(frame(), 0)
        results = [self.g.should_detect(frame(), 0) for _ in range(12)]
        self.assertEqual(results, [False] * 5 + [True] + [False] * 5 + [True])

    def test_motion_triggers_an_immediate_detect(self):
        self.g.should_detect(frame(), 0)
        self.assertFalse(self.g.should_detect(frame(), 0))
        moved = frame()
        moved[100:160, 100:180] = 200
        self.assertTrue(self.g.should_detect(moved, 0))

    def test_motion_resets_the_skip_counter(self):
        self.g.should_detect(frame(), 0)
        for _ in range(4):
            self.g.should_detect(frame(), 0)
        moved = frame(200)
        self.assertTrue(self.g.should_detect(moved, 0))
        self.assertEqual([self.g.should_detect(frame(200), 0) for _ in range(6)], [False] * 5 + [True])

    def test_sub_threshold_flicker_does_not_count_as_motion(self):
        self.g.should_detect(frame(100), 0)
        self.assertFalse(self.g.should_detect(frame(110), 0))      # delta 10 < 26

    def test_a_tiny_changed_area_does_not_count_as_motion(self):
        self.g.should_detect(frame(), 0)
        speck = frame()
        speck[0:2, 0:2] = 255
        self.assertFalse(self.g.should_detect(speck, 0))

    def test_resolution_change_forces_a_detect(self):
        self.g.should_detect(frame(), 0)
        self.assertTrue(self.g.should_detect(frame(h=480, w=320), 0))


# ── sharding ───────────────────────────────────────────────────────────────


class FakeRedis:
    def __init__(self):
        self.h: dict[str, dict[str, str]] = {}
        self.fail = False
        self.race_owner: str | None = None   # simulate another shard winning HSETNX

    def _m(self, key):
        if self.fail:
            raise ConnectionError("redis down")
        return self.h.setdefault(key, {})

    def hget(self, key, field):
        return self._m(key).get(field)

    def hdel(self, key, *fields):
        m = self._m(key)
        return sum(1 for f in fields if m.pop(f, None) is not None)

    def hvals(self, key):
        return list(self._m(key).values())

    def hkeys(self, key):
        return list(self._m(key).keys())

    def hgetall(self, key):
        return dict(self._m(key))

    def hsetnx(self, key, field, value):
        m = self._m(key)
        if self.race_owner is not None and field not in m:
            m[field] = self.race_owner
            return False
        if field in m:
            return False
        m[field] = str(value)
        return True


CAMS = [uuid.uuid5(uuid.NAMESPACE_URL, f"cam-{i}") for i in range(400)]


class ShardTopologyTest(unittest.TestCase):
    def test_single_shard_is_the_default_and_owns_everything(self):
        with override(ai_shard_count=1, ai_shard_index=0, ai_shard_peers=""):
            self.assertEqual(sharding.shard_count(), 1)
            self.assertTrue(sharding.is_primary())
            self.assertTrue(all(sharding.owns(c) for c in CAMS[:20]))
            self.assertEqual({sharding.owner_of(c) for c in CAMS[:20]}, {0})

    def test_count_falls_back_to_the_peer_list(self):
        with override(ai_shard_count=0, ai_shard_peers=" http://a:1/ , http://b:1,,http://c:1 "):
            self.assertEqual(sharding.peers(), ["http://a:1", "http://b:1", "http://c:1"])
            self.assertEqual(sharding.shard_count(), 3)
        with override(ai_shard_count=-2, ai_shard_peers=""):
            self.assertEqual(sharding.shard_count(), 1)

    def test_index_wraps_and_is_never_negative(self):
        with override(ai_shard_count=3, ai_shard_index=4):
            self.assertEqual(sharding.shard_index(), 1)
        with override(ai_shard_count=3, ai_shard_index=-1):
            self.assertEqual(sharding.shard_index(), 0)

    def test_primary_without_cameras_is_excluded(self):
        with override(ai_shard_count=4, ai_shard_primary_owns_cameras=False):
            self.assertEqual(sharding.camera_shards(), [1, 2, 3])
        with override(ai_shard_count=4, ai_shard_primary_owns_cameras=True):
            self.assertEqual(sharding.camera_shards(), [0, 1, 2, 3])
        with override(ai_shard_count=1, ai_shard_primary_owns_cameras=False):
            self.assertEqual(sharding.camera_shards(), [0])      # a lone shard must own cameras

    def test_peer_url_bounds(self):
        with override(ai_shard_peers="http://a,http://b"):
            self.assertEqual(sharding.peer_url(1), "http://b")
            self.assertIsNone(sharding.peer_url(2))
            self.assertIsNone(sharding.peer_url(-1))


class HashAssignmentTest(unittest.TestCase):
    def test_hash_owner_is_stable_and_matches_the_formula(self):
        with override(ai_shard_count=4, ai_shard_assignment="hash", ai_shard_primary_owns_cameras=True):
            for c in CAMS[:50]:
                self.assertEqual(sharding.owner_of(c), c.int % 4)
                self.assertEqual(sharding.owner_of(c), sharding.owner_of(c))

    def test_hash_never_picks_a_non_camera_primary(self):
        with override(ai_shard_count=4, ai_shard_assignment="hash", ai_shard_primary_owns_cameras=False):
            owners = Counter(sharding.owner_of(c) for c in CAMS)
        self.assertNotIn(0, owners)
        self.assertEqual(set(owners), {1, 2, 3})

    def test_exactly_one_shard_owns_each_camera(self):
        with override(ai_shard_count=3, ai_shard_assignment="hash", ai_shard_primary_owns_cameras=True):
            for c in CAMS[:30]:
                owners = []
                for i in range(3):
                    with override(ai_shard_index=i):
                        if sharding.owns(c):
                            owners.append(i)
                self.assertEqual(len(owners), 1)


class BalancedAssignmentTest(unittest.TestCase):
    def setUp(self):
        self.r = FakeRedis()
        self.clock = FakeClock()
        patches = [
            mock.patch.object(sharding, "_redis", self.r),
            mock.patch.object(sharding, "_cache", {}),
            mock.patch.object(sharding, "time", self.clock),
            mock.patch.object(sharding, "log", mock.Mock()),      # keep test output quiet
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        cm = override(ai_shard_count=4, ai_shard_index=1, ai_shard_assignment="balanced",
                      ai_shard_primary_owns_cameras=False)
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)

    def owners_map(self):
        return self.r.h.get(sharding._OWNERS_KEY, {})

    def test_cameras_are_spread_evenly(self):
        for c in CAMS[:43]:
            sharding.owner_of(c)
        counts = Counter(int(v) for v in self.owners_map().values())
        self.assertEqual(set(counts), {1, 2, 3})
        self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)

    def test_first_assignment_on_an_empty_map_goes_to_the_hash_owner(self):
        c = CAMS[0]
        expected = sharding._hash_owner(c)
        self.assertEqual(sharding.owner_of(c), expected)

    def test_assignment_is_sticky(self):
        c = CAMS[5]
        first = sharding.owner_of(c)
        for d in CAMS[6:30]:
            sharding.owner_of(d)
        sharding._cache.clear()
        self.assertEqual(sharding.owner_of(c), first)

    def test_lost_race_adopts_the_winner(self):
        self.r.race_owner = "3"
        self.assertEqual(sharding.owner_of(CAMS[0]), 3)

    def test_stale_owner_from_a_bigger_layout_is_reassigned(self):
        self.r.h[sharding._OWNERS_KEY] = {str(CAMS[0]): "9"}
        owner = sharding.owner_of(CAMS[0])
        self.assertIn(owner, (1, 2, 3))
        self.assertEqual(self.owners_map()[str(CAMS[0])], str(owner))

    def test_lookups_are_cached_for_ten_seconds(self):
        c = CAMS[1]
        owner = sharding.owner_of(c)
        self.r.h[sharding._OWNERS_KEY][str(c)] = "3" if owner != 3 else "2"
        self.assertEqual(sharding.owner_of(c), owner)            # still cached
        self.clock.t += 11
        self.assertNotEqual(sharding.owner_of(c), owner)         # re-read

    def test_redis_down_falls_back_to_hashing(self):
        self.r.fail = True
        for c in CAMS[:10]:
            self.assertEqual(sharding.owner_of(c), sharding._hash_owner(c))

    def test_release_frees_the_slot(self):
        c = CAMS[2]
        sharding.owner_of(c)
        sharding.release(c)
        self.assertNotIn(str(c), self.owners_map())
        self.assertNotIn(str(c), sharding._cache)

    def test_release_and_prune_survive_redis_errors(self):
        sharding.owner_of(CAMS[0])
        self.r.fail = True
        sharding.release(CAMS[0])
        self.assertEqual(sharding.prune(set()), 0)
        self.assertEqual(sharding.assignments(), {})

    def test_prune_drops_cameras_that_no_longer_exist(self):
        for c in CAMS[:6]:
            sharding.owner_of(c)
        keep = {str(c) for c in CAMS[:2]}
        self.assertEqual(sharding.prune(keep), 4)
        self.assertEqual(set(self.owners_map()), keep)

    def test_assignments_reports_the_map(self):
        sharding.owner_of(CAMS[0])
        self.assertEqual(sharding.assignments(), {str(CAMS[0]): sharding.owner_of(CAMS[0])})

    def test_single_shard_never_touches_redis(self):
        self.r.fail = True
        with override(ai_shard_count=1):
            self.assertEqual(sharding.owner_of(CAMS[0]), 0)
            self.assertEqual(sharding.prune(set()), 0)
            sharding.release(CAMS[0])


class ForwardTest(unittest.TestCase):
    def req(self, headers):
        return types.SimpleNamespace(headers=headers)

    def test_a_forwarded_request_is_never_forwarded_again(self):
        with self.assertRaises(HTTPException) as cm:
            asyncio.run(sharding.forward_to_owner(self.req({"x-ai-shard-hop": "2"}), CAMS[0]))
        self.assertEqual(cm.exception.status_code, 508)

    def test_missing_peer_entry_is_503_not_a_wrong_shard(self):
        with override(ai_shard_count=4, ai_shard_assignment="hash", ai_shard_peers="http://only-one"):
            cam = next(c for c in CAMS if sharding.owner_of(c) >= 1)
            with self.assertRaises(HTTPException) as cm:
                asyncio.run(sharding.forward_to_owner(self.req({}), cam))
        self.assertEqual(cm.exception.status_code, 503)


# ── snapshot cache ─────────────────────────────────────────────────────────


class SnapshotCacheTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        p = mock.patch.object(snapshot_cache, "time", self.clock)
        p.start()
        self.addCleanup(p.stop)
        cm = override(snapshot_cache_interval_sec=0.5, snapshot_cache_max_width=640)
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        self.c = SnapshotCache()
        self.f = np.random.default_rng(0).integers(0, 255, (360, 480, 3)).astype(np.uint8)

    def test_empty_frames_are_ignored(self):
        self.assertFalse(self.c.maybe_write("c1", None))
        self.assertFalse(self.c.maybe_write("c1", np.zeros((0, 0, 3), dtype=np.uint8)))
        self.assertEqual(self.c.get("c1"), (None, None))

    def test_first_frame_is_encoded_as_jpeg_with_metadata(self):
        self.assertTrue(self.c.maybe_write("c1", self.f))
        data, meta = self.c.get("c1")
        self.assertEqual(data[:2], b"\xff\xd8")
        self.assertEqual((meta["frame_w"], meta["frame_h"], meta["size_bytes"]), (480, 360, len(data)))

    def test_writes_are_rate_limited_per_camera(self):
        self.assertTrue(self.c.maybe_write("c1", self.f))
        self.clock.t += 0.3
        self.assertFalse(self.c.maybe_write("c1", self.f))
        self.assertTrue(self.c.maybe_write("c2", self.f))       # other camera unaffected
        self.clock.t += 0.25
        self.assertTrue(self.c.maybe_write("c1", self.f))

    def test_interval_never_drops_below_the_250ms_floor(self):
        with override(snapshot_cache_interval_sec=0.0):
            self.assertTrue(self.c.maybe_write("c1", self.f))
            self.clock.t += 0.2
            self.assertFalse(self.c.maybe_write("c1", self.f))
            self.clock.t += 0.06
            self.assertTrue(self.c.maybe_write("c1", self.f))

    def test_wide_frames_are_downscaled_keeping_aspect(self):
        wide = np.zeros((1080, 1920, 3), dtype=np.uint8)
        self.c.maybe_write("c1", wide)
        _, meta = self.c.get("c1")
        self.assertEqual((meta["frame_w"], meta["frame_h"]), (640, 360))

    def test_zero_max_width_keeps_full_size(self):
        with override(snapshot_cache_max_width=0):
            self.c.maybe_write("c1", np.zeros((1080, 1920, 3), dtype=np.uint8))
        self.assertEqual(self.c.get("c1")[1]["frame_w"], 1920)

    def test_forget_drops_the_frame_and_the_rate_limit(self):
        self.c.maybe_write("c1", self.f)
        self.c.forget("c1")
        self.assertEqual(self.c.get("c1"), (None, None))
        self.assertTrue(self.c.maybe_write("c1", self.f))       # no wait after forget
        self.c.forget("never-seen")                              # no error

    def test_get_returns_a_copy_of_the_metadata(self):
        self.c.maybe_write("c1", self.f)
        self.c.get("c1")[1]["frame_w"] = -1
        self.assertEqual(self.c.get("c1")[1]["frame_w"], 480)

    def test_singleton(self):
        self.assertIs(snapshot_cache.get_snapshot_cache(), snapshot_cache.get_snapshot_cache())


if __name__ == "__main__":
    unittest.main()
