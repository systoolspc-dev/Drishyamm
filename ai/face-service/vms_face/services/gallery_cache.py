"""Gallery cache — L2 hot set and L3 local gallery in front of Qdrant.

Why
---
Every 1:N today is a network round-trip to Qdrant with a tenant filter — the
documented worst case for HNSW (filtered traversal visits other tenants'
nodes and can make points unreachable). At our gallery sizes brute force in
RAM is both faster and exact: 50,000 identities x 512-d float32 is 100 MB and
one matmul, ~1 ms on a server core. Qdrant remains the source of truth, the
forensic index, and the fallback whenever this cache is stale.

Tiers
-----
  L3 LocalGallery  — per-tenant matrices loaded by scrolling the enrolled
                     collection; reloaded on a timer and on `vms.gallery.changed`.
  L2 HotSet        — identities seen recently per camera and per tenant. Always
                     maintained (its hit-rate metric is how we decide whether the
                     edge fast path is worth it); used as the answer only when
                     `gallery_cache_hot_fast_path` is on.

Search results use the exact dict shape QdrantStore.search returns, so
FaceMatcher does not know which tier answered.
"""
from __future__ import annotations

import asyncio
import random
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import numpy as np

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.core.metrics import (
    GALLERY_HOT_HITRATE,
    GALLERY_LOOKUPS,
    GALLERY_REFRESH_LATENCY,
    GALLERY_REFRESHES,
    GALLERY_SIZE,
    GALLERY_SHADOW_MISMATCH,
)
from vms_face.infra.qdrant import QdrantStore

log = get_logger(__name__)


# ── L3: local gallery ──────────────────────────────────────────────────────


@dataclass(slots=True)
class _Shard:
    """One tenant's slice of the gallery. Row i of every array is one point."""

    point_ids: list[str]
    person_ids: list[str | None]
    payloads: list[dict[str, Any]]
    mat: np.ndarray                     # (N, D) float32, rows L2-normed — or None in int8 mode
    q8: np.ndarray | None               # (N, D) int8
    scale: np.ndarray | None            # (N,) float32 per-row dequant scale
    # person_id -> row indices, for hot-set restricted search
    rows_by_person: dict[str, list[int]]

    @property
    def size(self) -> int:
        return len(self.point_ids)


def _l2(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def _quantize_rows(mat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-row symmetric int8: q = round(v / s * 127), s = max|v| per row.
    Dot products come back as int32 and are rescaled by (s_a * s_b / 127^2).
    With L2-normed 512-d rows, s ~ 0.1-0.3, so the quantisation step is
    ~1e-3 — well under the margins we decide on."""
    scale = np.abs(mat).max(axis=1).astype(np.float32)
    scale[scale <= 0] = 1.0
    q = np.round(mat / scale[:, None] * 127.0).astype(np.int8)
    return q, scale


class LocalGallery:
    """Read-mostly, swapped atomically on refresh. Searches never lock."""

    def __init__(self, store: QdrantStore, *, storage: str = "float32", rescore_k: int = 32) -> None:
        self._store = store
        self._storage = storage if storage in ("float32", "int8") else "float32"
        self._rescore_k = max(1, int(rescore_k))
        self._shards: dict[str, _Shard] = {}
        self.loaded_at: float = 0.0
        self.version: int = 0
        self._refresh_lock = asyncio.Lock()

    # ── state ──────────────────────────────────────────────────────────────

    @property
    def storage(self) -> str:
        return self._storage

    def is_fresh(self, now: float | None = None) -> bool:
        if self.loaded_at <= 0:
            return False
        now = time.monotonic() if now is None else now
        return (now - self.loaded_at) <= float(settings.gallery_cache_max_stale_sec)

    def size(self, tenant_id: str | uuid.UUID | None = None) -> int:
        if tenant_id is not None:
            s = self._shards.get(str(tenant_id))
            return s.size if s else 0
        return sum(s.size for s in self._shards.values())

    def person_ids(self, tenant_id: str | uuid.UUID) -> set[str]:
        s = self._shards.get(str(tenant_id))
        return set(s.rows_by_person.keys()) if s else set()

    # ── load ───────────────────────────────────────────────────────────────

    async def refresh(self, *, trigger: str = "timer") -> bool:
        """Scroll the whole enrolled collection and rebuild every shard. Returns
        True on success. Concurrent callers coalesce on the lock."""
        if self._refresh_lock.locked():
            # A reload is already in flight; the caller's intent is satisfied by it.
            async with self._refresh_lock:
                return self.loaded_at > 0
        async with self._refresh_lock:
            t0 = time.perf_counter()
            try:
                rows = await self._scroll_all()
            except Exception as e:  # noqa: BLE001
                GALLERY_REFRESHES.labels(trigger=trigger, outcome="error").inc()
                log.warning("gallery cache reload failed", err=str(e), trigger=trigger)
                return False
            shards = self._build(rows)
            self._shards = shards            # atomic swap (dict assignment)
            self.loaded_at = time.monotonic()
            self.version += 1
            elapsed = time.perf_counter() - t0
            GALLERY_REFRESH_LATENCY.observe(elapsed)
            GALLERY_REFRESHES.labels(trigger=trigger, outcome="ok").inc()
            for tid, s in shards.items():
                GALLERY_SIZE.labels(tenant_id=tid).set(s.size)
            log.info(
                "gallery cache loaded",
                vectors=sum(s.size for s in shards.values()),
                tenants=len(shards),
                storage=self._storage,
                seconds=round(elapsed, 3),
                trigger=trigger,
                version=self.version,
            )
            return True

    async def _scroll_all(
        self, tenant_id: str | uuid.UUID | None = None
    ) -> list[tuple[str, dict[str, Any], np.ndarray]]:
        """Every enrolled point (optionally one tenant's) as (id, payload, vector).
        Shared with the /edge/gallery/snapshot route, which serves one tenant."""
        client = self._store.client
        out: list[tuple[str, dict[str, Any], np.ndarray]] = []
        offset = None
        dim = int(settings.qdrant_vector_size)
        scroll_filter = None
        if tenant_id is not None:
            from qdrant_client.http.models import FieldCondition, Filter, MatchValue

            scroll_filter = Filter(
                must=[FieldCondition(key="tenant_id", match=MatchValue(value=str(tenant_id)))]
            )
        while True:
            points, offset = await client.scroll(
                collection_name=self._store.collection,
                scroll_filter=scroll_filter,
                limit=1024,
                offset=offset,
                with_payload=True,
                with_vectors=True,
            )
            for p in points:
                vec = p.vector
                if isinstance(vec, dict):          # named vectors — take the first
                    vec = next(iter(vec.values()), None)
                if vec is None:
                    continue
                arr = np.asarray(vec, dtype=np.float32).reshape(-1)
                if arr.size != dim:
                    continue
                out.append((str(p.id), dict(p.payload or {}), arr))
            if offset is None:
                break
        return out

    def _build(self, rows: list[tuple[str, dict[str, Any], np.ndarray]]) -> dict[str, _Shard]:
        by_tenant: dict[str, list[tuple[str, dict[str, Any], np.ndarray]]] = {}
        for pid, payload, vec in rows:
            tid = str(payload.get("tenant_id") or "")
            if not tid:
                continue
            by_tenant.setdefault(tid, []).append((pid, payload, vec))
        shards: dict[str, _Shard] = {}
        for tid, items in by_tenant.items():
            mat = np.stack([_l2(v) for _, _, v in items]).astype(np.float32)
            person_ids = [p.get("person_id") for _, p, _ in items]
            rows_by_person: dict[str, list[int]] = {}
            for i, pid in enumerate(person_ids):
                if pid:
                    rows_by_person.setdefault(str(pid), []).append(i)
            if self._storage == "int8":
                q8, scale = _quantize_rows(mat)
                shards[tid] = _Shard(
                    point_ids=[pid for pid, _, _ in items],
                    person_ids=person_ids,
                    payloads=[p for _, p, _ in items],
                    mat=None,  # type: ignore[arg-type]
                    q8=q8,
                    scale=scale,
                    rows_by_person=rows_by_person,
                )
            else:
                shards[tid] = _Shard(
                    point_ids=[pid for pid, _, _ in items],
                    person_ids=person_ids,
                    payloads=[p for _, p, _ in items],
                    mat=mat,
                    q8=None,
                    scale=None,
                    rows_by_person=rows_by_person,
                )
        return shards

    # ── search ─────────────────────────────────────────────────────────────

    def search(
        self,
        *,
        tenant_id: str | uuid.UUID,
        vector: list[float] | np.ndarray,
        top_k: int = 5,
        score_threshold: float | None = None,
        restrict_person_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Exact cosine 1:N over one tenant. Same result shape as
        QdrantStore.search: [{point_id, score, payload}] sorted by score desc."""
        shard = self._shards.get(str(tenant_id))
        if shard is None or shard.size == 0:
            return []
        q = _l2(np.asarray(vector, dtype=np.float32).reshape(-1))

        rows: np.ndarray | None = None
        if restrict_person_ids is not None:
            idx: list[int] = []
            for pid in restrict_person_ids:
                idx.extend(shard.rows_by_person.get(pid, ()))
            if not idx:
                return []
            rows = np.asarray(sorted(set(idx)), dtype=np.int64)

        if shard.mat is not None:
            mat = shard.mat if rows is None else shard.mat[rows]
            scores = mat @ q
        else:
            # int8 path: integer dot, rescale, then rescore the head of the
            # ranking with dequantised rows (cheap; keeps ties honest).
            assert shard.q8 is not None and shard.scale is not None
            q8, qs = _quantize_rows(q[None, :])
            sub_q8 = shard.q8 if rows is None else shard.q8[rows]
            sub_sc = shard.scale if rows is None else shard.scale[rows]
            raw = sub_q8.astype(np.int32) @ q8[0].astype(np.int32)
            scores = raw.astype(np.float32) * (sub_sc * float(qs[0]) / (127.0 * 127.0))
            k = min(self._rescore_k, scores.size)
            head = np.argpartition(-scores, k - 1)[:k]
            deq = sub_q8[head].astype(np.float32) * (sub_sc[head][:, None] / 127.0)
            deq = deq / np.maximum(np.linalg.norm(deq, axis=1, keepdims=True), 1e-9)
            scores = scores.copy()
            scores[head] = deq @ q

        k = min(max(1, int(top_k)), scores.size)
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        out: list[dict[str, Any]] = []
        for j in top:
            s = float(scores[j])
            if score_threshold is not None and s < score_threshold:
                continue
            i = int(j) if rows is None else int(rows[j])
            out.append({
                "point_id": uuid.UUID(shard.point_ids[i]),
                "score": s,
                "payload": shard.payloads[i],
            })
        return out


# ── L2: hot set ───────────────────────────────────────────────────────────


class HotSet:
    """Recently-seen identities per camera and per tenant, LRU by last-seen.

    Cheap to maintain on every hit; its value is (a) the hit-rate metric that
    tells us whether an edge fast path would pay, and (b) the restricted
    candidate set itself when the fast path is enabled."""

    def __init__(self, *, window_sec: float, max_per_key: int = 512) -> None:
        self._window = max(1.0, float(window_sec))
        self._max = max(1, int(max_per_key))
        self._by_key: dict[str, OrderedDict[str, float]] = {}

    @staticmethod
    def _key(tenant_id: Any, camera_id: Any | None) -> str:
        return f"{tenant_id}|{camera_id if camera_id is not None else '*'}"

    def touch(self, tenant_id: Any, camera_id: Any | None, person_id: str, now: float) -> None:
        for key in (self._key(tenant_id, camera_id), self._key(tenant_id, None)):
            d = self._by_key.setdefault(key, OrderedDict())
            d[person_id] = now
            d.move_to_end(person_id)
            while len(d) > self._max:
                d.popitem(last=False)

    def candidates(self, tenant_id: Any, camera_id: Any | None, now: float) -> set[str]:
        cutoff = now - self._window
        out: set[str] = set()
        for key in (self._key(tenant_id, camera_id), self._key(tenant_id, None)):
            d = self._by_key.get(key)
            if not d:
                continue
            # Evict from the cold end, then collect.
            while d and next(iter(d.values())) < cutoff:
                d.popitem(last=False)
            out.update(d.keys())
        return out


# ── Manager: wires L2 + L3 + refresh + invalidation ───────────────────────


class GalleryCacheManager:
    def __init__(self, store: QdrantStore) -> None:
        self.gallery = LocalGallery(
            store,
            storage=str(settings.gallery_cache_storage),
            rescore_k=int(settings.gallery_cache_int8_rescore_k),
        )
        self.hot = HotSet(window_sec=float(settings.gallery_cache_hot_window_sec))
        self._store = store
        self._stop = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        self._invalidate = asyncio.Event()

    async def start(self) -> None:
        ok = await self.gallery.refresh(trigger="startup")
        if not ok:
            log.warning("gallery cache: initial load failed; serving from qdrant until it succeeds")
        self._tasks.append(asyncio.create_task(self._timer_loop(), name="gallery-cache-timer"))
        self._tasks.append(asyncio.create_task(self._invalidate_loop(), name="gallery-cache-invalidate"))
        self._tasks.append(asyncio.create_task(self._changes_subscriber(), name="gallery-cache-changes"))

    async def aclose(self) -> None:
        self._stop.set()
        self._invalidate.set()
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()

    def request_reload(self) -> None:
        self._invalidate.set()

    # ── lookups ────────────────────────────────────────────────────────────

    async def search(
        self,
        *,
        tenant_id: uuid.UUID,
        vector: list[float],
        camera_id: uuid.UUID | None,
        top_k: int,
        score_threshold: float | None,
        confident_threshold: float,
    ) -> tuple[list[dict[str, Any]], str]:
        """Returns (results, tier). Falls back to Qdrant when stale. The
        results contract is identical across tiers."""
        now = time.monotonic()
        if not self.gallery.is_fresh(now):
            GALLERY_LOOKUPS.labels(tier="qdrant", outcome="stale_fallback").inc()
            res = await self._store.search(
                tenant_id=tenant_id, vector=vector, top_k=top_k, score_threshold=score_threshold,
            )
            return res, "qdrant"

        hot_ids = self.hot.candidates(tenant_id, camera_id, now)
        if settings.gallery_cache_hot_fast_path and hot_ids:
            res = self.gallery.search(
                tenant_id=tenant_id, vector=vector, top_k=top_k,
                score_threshold=score_threshold, restrict_person_ids=hot_ids,
            )
            if res and res[0]["score"] >= confident_threshold:
                GALLERY_LOOKUPS.labels(tier="hot", outcome="hit").inc()
                return res, "hot"

        res = self.gallery.search(
            tenant_id=tenant_id, vector=vector, top_k=top_k, score_threshold=score_threshold,
        )
        GALLERY_LOOKUPS.labels(tier="local", outcome="hit" if res else "miss").inc()

        # Hot-set hit-rate accounting: was the eventual answer already hot?
        if res:
            top_person = res[0]["payload"].get("person_id")
            if top_person:
                GALLERY_HOT_HITRATE.labels(
                    outcome="in_hot" if str(top_person) in hot_ids else "not_in_hot"
                ).inc()
        else:
            GALLERY_HOT_HITRATE.labels(outcome="no_match").inc()

        # Rollout safety: shadow-compare against Qdrant at a sampled rate.
        rate = float(settings.gallery_cache_shadow_check_rate)
        if rate > 0 and random.random() < rate:
            asyncio.create_task(self._shadow_check(tenant_id, vector, top_k, score_threshold, res))
        return res, "local"

    def note_hit(self, tenant_id: uuid.UUID, camera_id: uuid.UUID | None, person_id: str) -> None:
        self.hot.touch(tenant_id, camera_id, str(person_id), time.monotonic())

    async def _shadow_check(self, tenant_id, vector, top_k, score_threshold, cached) -> None:
        try:
            ref = await self._store.search(
                tenant_id=tenant_id, vector=vector, top_k=top_k, score_threshold=score_threshold,
            )
        except Exception:
            return
        a = cached[0]["payload"].get("person_id") if cached else None
        b = ref[0]["payload"].get("person_id") if ref else None
        if a != b:
            GALLERY_SHADOW_MISMATCH.inc()
            log.warning(
                "gallery cache shadow mismatch",
                cached_person=a, qdrant_person=b,
                cached_score=round(cached[0]["score"], 4) if cached else None,
                qdrant_score=round(ref[0]["score"], 4) if ref else None,
                cache_version=self.gallery.version,
            )

    # ── background loops ───────────────────────────────────────────────────

    async def _timer_loop(self) -> None:
        interval = max(1.0, float(settings.gallery_cache_refresh_sec))
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
                return
            except asyncio.TimeoutError:
                pass
            await self.gallery.refresh(trigger="timer")

    async def _invalidate_loop(self) -> None:
        debounce = max(0.0, float(settings.gallery_cache_invalidate_debounce_sec))
        while not self._stop.is_set():
            await self._invalidate.wait()
            if self._stop.is_set():
                return
            # Coalesce a burst (bulk enrolment) into one reload.
            await asyncio.sleep(debounce)
            self._invalidate.clear()
            await self.gallery.refresh(trigger="invalidate")

    async def _changes_subscriber(self) -> None:
        from vms_face.infra.redis_bus import get_bus

        channel = get_bus().gallery_changed_channel()
        backoff = 0.5
        while not self._stop.is_set():
            pubsub = get_bus().client.pubsub()
            try:
                await pubsub.subscribe(channel)
                backoff = 0.5
                while not self._stop.is_set():
                    msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if msg is None:
                        continue
                    self._invalidate.set()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("gallery-changed subscriber error; reconnecting", err=str(e))
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)
            finally:
                try:
                    await pubsub.unsubscribe(channel)
                except Exception:
                    pass
                try:
                    await pubsub.aclose()
                except Exception:
                    try:
                        await pubsub.close()
                    except Exception:
                        pass
