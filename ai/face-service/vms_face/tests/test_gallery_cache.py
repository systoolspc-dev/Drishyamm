"""Local gallery (L3) + hot set (L2): exactness against a numpy reference,
tenant isolation, the int8 path, and hot-set eviction. No Qdrant needed —
shards are built straight from synthetic rows.

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_gallery_cache -v
"""
from __future__ import annotations

import unittest
import uuid

import numpy as np

from vms_face.services.gallery_cache import HotSet, LocalGallery

D = 512


def _rows(rng, tenant: str, n_persons: int, per_person: int):
    rows = []
    centres = rng.standard_normal((n_persons, D)).astype(np.float32)
    for p in range(n_persons):
        pid = str(uuid.uuid4())
        for _ in range(per_person):
            v = centres[p] + 0.3 * rng.standard_normal(D).astype(np.float32)
            v /= np.linalg.norm(v)
            rows.append((str(uuid.uuid4()), {"tenant_id": tenant, "person_id": pid, "full_name": f"P{p}"}, v))
    return rows


class _NoStore:
    """LocalGallery only needs a store for refresh(); tests build shards directly."""
    collection = "test"
    client = None


def _gallery(storage: str, rows) -> LocalGallery:
    g = LocalGallery(_NoStore(), storage=storage, rescore_k=16)  # type: ignore[arg-type]
    g._shards = g._build(rows)
    g.loaded_at = 1.0
    return g


class TestLocalGallerySearch(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(42)
        self.t1, self.t2 = str(uuid.uuid4()), str(uuid.uuid4())
        self.rows = _rows(self.rng, self.t1, 200, 3) + _rows(self.rng, self.t2, 50, 3)

    def _reference(self, tenant, q):
        rows = [r for r in self.rows if r[1]["tenant_id"] == tenant]
        mat = np.stack([r[2] for r in rows])
        s = mat @ (q / np.linalg.norm(q))
        order = np.argsort(-s)
        return [(rows[i][1]["person_id"], float(s[i])) for i in order]

    def test_float32_matches_numpy_reference(self):
        g = _gallery("float32", self.rows)
        for _ in range(20):
            i = self.rng.integers(0, len(self.rows))
            q = self.rows[i][2] + 0.2 * self.rng.standard_normal(D).astype(np.float32)
            tenant = self.rows[i][1]["tenant_id"]
            got = g.search(tenant_id=tenant, vector=q, top_k=3)
            ref = self._reference(tenant, q)
            self.assertEqual(got[0]["payload"]["person_id"], ref[0][0])
            self.assertAlmostEqual(got[0]["score"], ref[0][1], places=5)
            self.assertEqual([r["payload"]["person_id"] for r in got], [p for p, _ in ref[:3]])

    def test_tenant_isolation(self):
        g = _gallery("float32", self.rows)
        q = self.rows[0][2]                        # belongs to t1
        got = g.search(tenant_id=self.t2, vector=q, top_k=1)
        self.assertTrue(all(r["payload"]["tenant_id"] == self.t2 for r in got))
        self.assertEqual(g.search(tenant_id=str(uuid.uuid4()), vector=q, top_k=1), [])

    def test_threshold_and_top_k(self):
        g = _gallery("float32", self.rows)
        q = self.rows[5][2]
        self.assertEqual(len(g.search(tenant_id=self.t1, vector=q, top_k=5)), 5)
        self.assertEqual(len(g.search(tenant_id=self.t1, vector=q, top_k=5, score_threshold=0.999)), 1)
        self.assertEqual(g.search(tenant_id=self.t1, vector=q, top_k=5, score_threshold=1.5), [])

    def test_restrict_to_person_ids(self):
        g = _gallery("float32", self.rows)
        q = self.rows[5][2]
        target = self.rows[100][1]["person_id"]
        got = g.search(tenant_id=self.t1, vector=q, top_k=3, restrict_person_ids={target})
        self.assertTrue(got)
        self.assertTrue(all(r["payload"]["person_id"] == target for r in got))
        self.assertEqual(g.search(tenant_id=self.t1, vector=q, top_k=3, restrict_person_ids={"nope"}), [])

    def test_int8_agrees_with_float32(self):
        g32 = _gallery("float32", self.rows)
        g8 = _gallery("int8", self.rows)
        disagreements = 0
        for _ in range(50):
            i = self.rng.integers(0, len(self.rows))
            q = self.rows[i][2] + 0.2 * self.rng.standard_normal(D).astype(np.float32)
            tenant = self.rows[i][1]["tenant_id"]
            a = g32.search(tenant_id=tenant, vector=q, top_k=1)[0]
            b = g8.search(tenant_id=tenant, vector=q, top_k=1)[0]
            if a["payload"]["person_id"] != b["payload"]["person_id"]:
                disagreements += 1
            self.assertLess(abs(a["score"] - b["score"]), 0.02)
        self.assertLessEqual(disagreements, 1)

    def test_size_and_person_ids(self):
        g = _gallery("float32", self.rows)
        self.assertEqual(g.size(self.t1), 600)
        self.assertEqual(g.size(self.t2), 150)
        self.assertEqual(g.size(), 750)
        self.assertEqual(len(g.person_ids(self.t1)), 200)


class TestHotSet(unittest.TestCase):
    def test_touch_candidates_and_window(self):
        h = HotSet(window_sec=10.0, max_per_key=8)
        h.touch("t", "cam1", "A", now=0.0)
        h.touch("t", "cam2", "B", now=5.0)
        # camera-local ∪ tenant-wide
        self.assertEqual(h.candidates("t", "cam1", now=6.0), {"A", "B"})
        self.assertEqual(h.candidates("t", "cam9", now=6.0), {"A", "B"})
        # A expires first
        self.assertEqual(h.candidates("t", "cam1", now=11.0), {"B"})
        self.assertEqual(h.candidates("other", "cam1", now=6.0), set())

    def test_lru_cap(self):
        h = HotSet(window_sec=100.0, max_per_key=4)
        for i in range(10):
            h.touch("t", "cam", f"P{i}", now=float(i))
        self.assertEqual(h.candidates("t", "cam", now=10.0), {"P6", "P7", "P8", "P9"})


if __name__ == "__main__":
    unittest.main()
