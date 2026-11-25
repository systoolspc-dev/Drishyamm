"""Safe defaults (config/settings.py), the audit logger contract
(services/audit.py) and ReID helpers (services/reid.py).

  * Defaults that would open the system or start collecting data if they
    flipped (index off, dev bypass off, no baked-in secrets, legacy router
    closed, no sensitive-attribute classifiers) are pinned here, read from the
    field definitions so the container's own env doesn't mask a change.
  * Settings.assert_consistent() refuses the batched-detect + ArcFace combo.
  * audit.record() never raises into the business operation and truncates to
    the column sizes.
  * ReID: tenant + time-window scoped vector search, same-camera dedup,
    canonical/self-link handling, BFS bounded and tenant-scoped.

Fakes only: no Postgres, no Qdrant.

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_settings_audit_reid -v
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import unittest
import uuid
from unittest import mock

from pydantic import ValidationError
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError

from vms_face.config.settings import Settings
from vms_face.services import audit, reid

D = Settings.model_fields


def default(name):
    return D[name].default


def make(**kw) -> Settings:
    return Settings(_env_file=None, **kw)


class SafeDefaultsTest(unittest.TestCase):
    def test_investigation_index_and_measurement_are_off(self):
        self.assertIs(default("investigate_index_enabled"), False)
        self.assertIs(default("investigate_measure_enabled"), False)

    def test_optional_pipelines_are_off(self):
        self.assertIs(default("pipeline_person_detection_enabled"), False)
        self.assertIs(default("motion_gate_enabled"), False)
        self.assertIs(default("pipeline_batched_inference"), False)
        self.assertIs(default("vms_otel_enabled"), False)

    def test_auth_defaults_fail_closed(self):
        self.assertIs(default("vms_jwt_dev_bypass"), False)
        self.assertEqual(default("vms_jwt_secret"), "")            # no secret baked into the image
        self.assertEqual(default("vms_jwt_algorithm"), "HS256")
        self.assertLessEqual(default("vms_jwt_leeway_sec"), 60)
        self.assertEqual(default("legacy_api_key"), "")            # legacy router closed
        self.assertEqual(default("vms_camera_cred_key"), "")       # no baked key either

    def test_no_sensitive_attribute_classifier_is_on_by_default(self):
        sensitive = ("ethnic", "race", "religion", "caste", "emotion", "skin")
        for name, f in D.items():
            if any(s in name for s in sensitive) and isinstance(f.default, bool):
                self.assertFalse(f.default, name)

    def test_gender_is_only_asserted_on_a_clear_majority(self):
        self.assertGreaterEqual(default("attributes_min_agreement"), 0.6)
        self.assertGreaterEqual(default("backend_overlay_min_gender_conf"), default("attributes_min_agreement"))
        self.assertGreaterEqual(default("attributes_min_votes"), 2)
        self.assertLessEqual(default("attributes_min_votes"), default("attributes_max_votes"))

    def test_retention_windows_are_positive(self):
        for name in ("retention_event_days", "retention_snapshot_days", "retention_audit_log_days",
                     "investigate_retention_days"):
            self.assertGreater(default(name), 0, name)
        self.assertGreaterEqual(default("retention_audit_log_days"), default("retention_event_days"))

    def test_single_shard_and_quality_floor_defaults(self):
        self.assertEqual(default("ai_shard_count"), 1)
        self.assertGreater(default("track_pool_min_quality"), 0.0)

    def test_env_must_be_a_known_value(self):
        with self.assertRaises(ValidationError):
            make(vms_env="production")
        self.assertEqual(make(vms_env="prod").vms_env, "prod")

    def test_providers_cannot_be_empty(self):
        with self.assertRaises(ValidationError):
            make(insightface_providers="  ")
        self.assertEqual(make(insightface_providers="CUDA , ,CPU").providers_list, ["CUDA", "CPU"])


class AssertConsistentTest(unittest.TestCase):
    def test_batched_detect_with_bundled_arcface_is_refused(self):
        for backend in ("insightface", "insightface_arc", "arcface", "buffalo", " ArcFace ", "INSIGHTFACE"):
            with self.subTest(backend=backend), self.assertRaises(ValueError):
                make(pipeline_batched_inference=True, recognizer_backend=backend).assert_consistent()

    def test_batched_detect_with_a_standalone_recognizer_is_fine(self):
        make(pipeline_batched_inference=True, recognizer_backend="adaface").assert_consistent()

    def test_unbatched_is_fine_with_any_recognizer(self):
        for backend in ("insightface", "adaface"):
            make(pipeline_batched_inference=False, recognizer_backend=backend).assert_consistent()

    def test_threshold_follows_the_recognizer(self):
        s = make(recognizer_backend="insightface", insightface_rec_threshold=0.62, recognizer_adaface_threshold=0.35)
        self.assertEqual(s.effective_recognizer_threshold(), 0.62)
        self.assertEqual(s.effective_recognizer_threshold(" AdaFace "), 0.35)
        self.assertEqual(make(recognizer_backend="adaface", recognizer_adaface_threshold=0.4)
                         .effective_recognizer_threshold(), 0.4)

    def test_cors_list_parsing(self):
        self.assertEqual(make(api_cors_origins=" * ").cors_origins_list, ["*"])
        self.assertEqual(make(api_cors_origins="https://a, https://b,,").cors_origins_list, ["https://a", "https://b"])


# ── audit ──────────────────────────────────────────────────────────────────


class FakeSession:
    def __init__(self, fail=False):
        self.rows = []
        self.fail = fail

    def add(self, row):
        self.rows.append(row)

    async def flush(self):
        if self.fail:
            raise RuntimeError("db down")


TENANT = uuid.UUID("11111111-1111-1111-1111-111111111111")


class AuditTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(audit, "log", mock.Mock())   # quiet + inspectable
        self.log = p.start()
        self.addCleanup(p.stop)

    def test_record_writes_into_the_callers_session(self):
        s = FakeSession()
        asyncio.run(audit.record(actor="user:a", actor_kind="user", action="search_1n",
                                 tenant_id=TENANT, session=s))
        self.assertEqual(len(s.rows), 1)
        row = s.rows[0]
        self.assertEqual((row.actor, row.action, row.tenant_id), ("user:a", "search_1n", TENANT))
        self.assertEqual(row.metadata_json, {})

    def test_record_truncates_to_column_sizes(self):
        s = FakeSession()
        asyncio.run(audit.record(actor="a" * 500, actor_kind="k" * 50, action="x" * 100, target_type="t" * 100,
                                 target_id="i" * 500, reason="r" * 1000, session=s))
        row = s.rows[0]
        self.assertEqual([len(row.actor), len(row.actor_kind), len(row.action), len(row.target_type),
                          len(row.target_id), len(row.reason)], [128, 32, 64, 64, 128, 256])

    def test_record_never_raises_when_the_session_fails(self):
        asyncio.run(audit.record(actor="a", actor_kind="user", action="delete_person", session=FakeSession(fail=True)))
        self.log.warning.assert_called_once()

    def test_record_never_raises_when_its_own_session_fails(self):
        @contextlib.asynccontextmanager
        async def broken():
            raise RuntimeError("no db")
            yield  # pragma: no cover

        with mock.patch.object(audit, "session_scope", broken):
            asyncio.run(audit.record(actor="a", actor_kind="system", action="search_1n"))
        self.log.warning.assert_called_once()

    def test_record_never_raises_on_bad_arguments(self):
        asyncio.run(audit.record(actor=None, actor_kind="user", action="x", session=FakeSession()))  # type: ignore[arg-type]
        self.log.warning.assert_called_once()

    def test_human_search_is_attributed_to_the_operator_and_capped(self):
        s = FakeSession()
        asyncio.run(audit.record_search(tenant_id=TENANT, operator_id="alice",
                                        top_hits=[{"i": i} for i in range(25)], session=s))
        row = s.rows[0]
        self.assertEqual((row.actor, row.actor_kind, row.action), ("user:alice", "user", "search_1n"))
        self.assertEqual(len(row.metadata_json["top_hits"]), 10)

    def test_automated_match_is_attributed_to_the_system(self):
        s = FakeSession()
        pid = uuid.uuid4()
        asyncio.run(audit.record_match(tenant_id=TENANT, person_id=pid, similarity=0.71,
                                       camera_id=None, track_id="t1", session=s))
        row = s.rows[0]
        self.assertEqual((row.actor, row.actor_kind, row.target_id), ("system:match_worker", "system", str(pid)))
        self.assertEqual(row.metadata_json["camera_id"], None)

    def test_delete_and_enroll_carry_the_operator(self):
        s = FakeSession()
        pid = uuid.uuid4()
        asyncio.run(audit.record_delete(tenant_id=TENANT, person_id=pid, operator_id="bob", reason="dpdp", session=s))
        asyncio.run(audit.record_enroll(tenant_id=TENANT, person_id=pid, operator_id="bob", source="upload",
                                        qdrant_point_id="p1", session=s))
        self.assertEqual([r.action for r in s.rows], ["delete_person", "enroll"])
        self.assertTrue(all(r.actor == "user:bob" and r.tenant_id == TENANT for r in s.rows))


# ── reid ───────────────────────────────────────────────────────────────────

CAM_A = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000000")
CAM_B = uuid.UUID("bbbbbbbb-0000-0000-0000-000000000000")
NOW = dt.datetime(2026, 11, 25, 12, 0, tzinfo=dt.timezone.utc)
NOW_TS = int(NOW.timestamp())


class FakeAppearance:
    def __init__(self, hits):
        self.hits = hits
        self.kw = None

    async def search(self, **kw):
        self.kw = kw
        return self.hits


def hit(cam, ago, pid="p"):
    payload = {"occurred_at_ts": NOW_TS - ago if ago is not None else None}
    if cam is not None:
        payload["camera_id"] = str(cam)
    return {"id": pid, "score": 0.8, "payload": payload}


def matches(hits, **kw):
    store = FakeAppearance(hits)
    args = dict(tenant_id=TENANT, embedding=[0.1] * 4, camera_id=CAM_A, occurred_at=NOW,
                top_k=10, window_sec=600, threshold=0.55, same_camera_dedup_sec=30)
    args.update(kw)
    out = asyncio.run(reid.find_cross_camera_matches(store, **args))
    return out, store.kw


class CrossCameraMatchTest(unittest.TestCase):
    def test_search_is_tenant_and_time_window_scoped(self):
        _, kw = matches([])
        self.assertEqual(kw["tenant_id"], TENANT)
        self.assertEqual(kw["score_threshold"], 0.55)
        rng = kw["extra_must"][0]
        self.assertEqual(rng.key, "occurred_at_ts")
        self.assertEqual((rng.range.gte, rng.range.lte), (NOW_TS - 600, NOW_TS))

    def test_other_camera_hits_are_kept(self):
        out, _ = matches([hit(CAM_B, 5)])
        self.assertEqual(len(out), 1)

    def test_same_camera_inside_the_dedup_window_is_dropped(self):
        out, _ = matches([hit(CAM_A, 10), hit(CAM_A, 29)])
        self.assertEqual(out, [])

    def test_same_camera_older_than_the_dedup_window_is_kept(self):
        out, _ = matches([hit(CAM_A, 30), hit(CAM_A, 300)])
        self.assertEqual(len(out), 2)

    def test_hits_without_camera_or_with_unknown_time_on_same_camera_are_dropped(self):
        out, _ = matches([hit(None, 100), hit(CAM_A, None), {"id": "x", "payload": None}])
        self.assertEqual(out, [])

    def test_explicit_zero_threshold_is_honoured(self):
        _, kw = matches([], threshold=0.0)
        self.assertEqual(kw["score_threshold"], 0.0)


class _Result:
    def __init__(self, rowcount=1, rows=()):
        self.rowcount = rowcount
        self._rows = list(rows)

    def __iter__(self):
        return iter(self._rows)


class LinkSession:
    def __init__(self, rowcount=1, integrity=False):
        self.stmts = []
        self.rowcount = rowcount
        self.integrity = integrity
        self.rolled_back = False

    async def execute(self, stmt):
        self.stmts.append(stmt)
        if self.integrity:
            raise IntegrityError("insert", {}, Exception("dup"))
        return _Result(self.rowcount)

    async def flush(self):
        pass

    async def rollback(self):
        self.rolled_back = True


def link(session, a_at, b_at, a_track="t1", b_track="t2", a_cam=CAM_A, b_cam=CAM_B):
    return asyncio.run(reid.emit_track_link(
        session, tenant_id=TENANT, a_track_id=a_track, a_camera_id=a_cam, a_event_id=None, a_occurred_at=a_at,
        b_track_id=b_track, b_camera_id=b_cam, b_event_id=None, b_occurred_at=b_at, similarity=0.7))


def params(stmt):
    return stmt.compile(dialect=postgresql.dialect()).params


class EmitTrackLinkTest(unittest.TestCase):
    def test_older_sighting_becomes_side_a(self):
        s = LinkSession()
        self.assertTrue(link(s, NOW, NOW - dt.timedelta(seconds=60)))
        p = params(s.stmts[0])
        self.assertEqual((p["a_track_id"], p["a_camera_id"], p["b_track_id"]), ("t2", CAM_B, "t1"))
        self.assertEqual(p["tenant_id"], TENANT)

    def test_order_of_arguments_does_not_change_the_row(self):
        s1, s2 = LinkSession(), LinkSession()
        early, late = NOW - dt.timedelta(seconds=5), NOW
        link(s1, early, late)
        link(s2, late, early, a_track="t2", b_track="t1", a_cam=CAM_B, b_cam=CAM_A)
        keys = ("a_track_id", "a_camera_id", "b_track_id", "b_camera_id")
        self.assertEqual([params(s1.stmts[0])[k] for k in keys], [params(s2.stmts[0])[k] for k in keys])

    def test_self_link_is_refused_without_touching_the_db(self):
        s = LinkSession()
        self.assertFalse(link(s, NOW, NOW, a_track="t1", b_track="t1", a_cam=CAM_A, b_cam=CAM_A))
        self.assertEqual(s.stmts, [])

    def test_duplicate_returns_false(self):
        self.assertFalse(link(LinkSession(rowcount=0), NOW, NOW))

    def test_integrity_error_rolls_back_and_returns_false(self):
        s = LinkSession(integrity=True)
        self.assertFalse(link(s, NOW, NOW))
        self.assertTrue(s.rolled_back)


class GraphSession:
    """Answers expand_global_identity's per-node query from an edge list."""

    def __init__(self, edges):
        self.edges = edges
        self.queries = 0
        self.tenants = set()

    async def execute(self, stmt):
        self.queries += 1
        p = params(stmt)
        vals = list(p.values())
        self.tenants |= {v for v in vals if v == TENANT}
        tid = next(v for v in vals if isinstance(v, str))
        cid = next(v for v in vals if isinstance(v, uuid.UUID) and v != TENANT)
        return [e for e in self.edges if (e[0], e[1]) == (tid, cid) or (e[2], e[3]) == (tid, cid)]


class ExpandIdentityTest(unittest.TestCase):
    CHAIN = [("t1", CAM_A, "t2", CAM_B), ("t2", CAM_B, "t3", CAM_A), ("t3", CAM_A, "t4", CAM_B)]

    def expand(self, edges, depth=5, seed=("t1", CAM_A)):
        s = GraphSession(edges)
        out = asyncio.run(reid.expand_global_identity(s, tenant_id=TENANT, seed_track_id=seed[0],
                                                      seed_camera_id=seed[1], max_depth=depth))
        return set(out), s

    def test_whole_component_is_returned_including_the_seed(self):
        out, s = self.expand(self.CHAIN)
        self.assertEqual(out, {("t1", CAM_A), ("t2", CAM_B), ("t3", CAM_A), ("t4", CAM_B)})
        self.assertEqual(s.tenants, {TENANT})

    def test_depth_bounds_the_walk(self):
        out, _ = self.expand(self.CHAIN, depth=1)
        self.assertEqual(out, {("t1", CAM_A), ("t2", CAM_B)})

    def test_same_track_id_on_another_camera_is_a_different_node(self):
        out, _ = self.expand([("t1", CAM_B, "t9", CAM_A)])
        self.assertEqual(out, {("t1", CAM_A)})

    def test_cycles_terminate(self):
        cyc = self.CHAIN + [("t4", CAM_B, "t1", CAM_A)]
        out, s = self.expand(cyc, depth=50)
        self.assertEqual(len(out), 4)
        self.assertLessEqual(s.queries, 4)


if __name__ == "__main__":
    unittest.main()
