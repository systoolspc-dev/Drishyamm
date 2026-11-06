from __future__ import annotations

import datetime as dt
import threading
import uuid
from typing import Any, Iterable

from qdrant_client import AsyncQdrantClient
from qdrant_client.http.exceptions import UnexpectedResponse
from qdrant_client.http.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PayloadSchemaType,
    PointStruct,
    Range,
    VectorParams,
)

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)


class QdrantStore:
    """Thin async wrapper around qdrant-client for face vectors.

    One instance per collection. The platform runs at least two:
      * `qdrant_collection_enrolled`   — small/hot enrolled gallery,
        replicated, low-latency search target.
      * `qdrant_collection_appearance` — large time-partitioned appearance
        log; one point per detection event, used for forensic search.

    Schema:
      - vector size = settings.qdrant_vector_size (default 512)
      - distance    = Cosine on L2-normed embeddings
      - payload     = {tenant_id, person_id, ...} for enrolled
                      {tenant_id, camera_id, occurred_at, person_id?, event_id} for appearance
      - tenant_id, person_id, camera_id, role indexed for fast filtering."""

    def __init__(self, collection: str) -> None:
        self._client = self._new_client()
        self._collection = collection

    @staticmethod
    def _new_client() -> AsyncQdrantClient:
        return AsyncQdrantClient(
            url=settings.qdrant_url,
            # Normalize "" (the dev default from compose) to None so we don't send
            # an empty api-key header when Qdrant auth is disabled.
            api_key=settings.qdrant_api_key or None,
            prefer_grpc=False,
        )

    def _reconnect(self) -> None:
        """Recreate the underlying client. The async client's httpx transport can
        end up 'closed' (e.g. bound to a torn-down event loop after a stream
        churn / restart); callers retry once through this so a process-wide
        singleton self-heals instead of 500-ing every read."""
        self._client = self._new_client()

    @property
    def client(self) -> AsyncQdrantClient:
        return self._client

    @property
    def collection(self) -> str:
        return self._collection

    async def ensure_collection(self) -> None:
        existing = None
        try:
            existing = await self._client.get_collection(self._collection)
        except (UnexpectedResponse, ValueError):
            log.info("creating qdrant collection", collection=self._collection)

        if existing is None:
            await self._client.create_collection(
                collection_name=self._collection,
                vectors_config=VectorParams(
                    size=settings.qdrant_vector_size,
                    distance=Distance[settings.qdrant_distance.upper()],
                ),
            )
        else:
            self._validate_collection_schema(existing)

        for field, schema in (
            ("tenant_id", PayloadSchemaType.KEYWORD),
            ("person_id", PayloadSchemaType.KEYWORD),
            ("camera_id", PayloadSchemaType.KEYWORD),
            ("role", PayloadSchemaType.KEYWORD),
            ("occurred_at_ts", PayloadSchemaType.INTEGER),
        ):
            try:
                await self._client.create_payload_index(self._collection, field_name=field, field_schema=schema)
            except UnexpectedResponse as e:
                # 4xx from Qdrant on this path almost always means "index already
                # exists" (the API doesn't expose a "create-if-not-exists" form).
                # We log at debug level — only fail loudly when the message
                # doesn't look like a duplicate-index condition.
                msg = str(e).lower()
                if "already exists" not in msg and "index" not in msg:
                    log.warning(
                        "qdrant payload index creation failed",
                        collection=self._collection,
                        field=field,
                        err=str(e),
                    )

    def _validate_collection_schema(self, info) -> None:
        """Sanity-check that a pre-existing collection still matches our
        configured vector size / distance. A mismatch here means the gallery
        will silently rank wrong; fail loudly instead of silently corrupting."""
        try:
            params = info.config.params.vectors
            actual_size = int(getattr(params, "size", 0))
            actual_distance = str(getattr(params, "distance", "")).upper()
        except AttributeError:
            log.warning(
                "qdrant collection info shape unexpected; skipping schema validation",
                collection=self._collection,
            )
            return
        expected_size = int(settings.qdrant_vector_size)
        expected_distance = settings.qdrant_distance.upper()
        if actual_size and actual_size != expected_size:
            raise RuntimeError(
                f"qdrant collection {self._collection!r} has vector size {actual_size}, "
                f"settings expects {expected_size}. Recreate the collection or roll back "
                f"the configuration change — partial migrations corrupt search results."
            )
        if actual_distance and actual_distance != expected_distance:
            raise RuntimeError(
                f"qdrant collection {self._collection!r} uses distance {actual_distance}, "
                f"settings expects {expected_distance}."
            )

    async def upsert(
        self,
        *,
        point_id: uuid.UUID,
        vector: list[float],
        tenant_id: uuid.UUID,
        person_id: uuid.UUID | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        full_payload: dict[str, Any] = {"tenant_id": str(tenant_id)}
        if person_id is not None:
            full_payload["person_id"] = str(person_id)
        if payload:
            full_payload.update(payload)
        await self._client.upsert(
            collection_name=self._collection,
            points=[PointStruct(id=str(point_id), vector=vector, payload=full_payload)],
        )

    async def upsert_batch(self, points: Iterable[PointStruct]) -> None:
        await self._client.upsert(collection_name=self._collection, points=list(points))

    async def point_exists(self, point_id: uuid.UUID) -> bool:
        points = await self._client.retrieve(
            collection_name=self._collection,
            ids=[str(point_id)],
            with_payload=False,
            with_vectors=False,
        )
        return bool(points)

    async def delete_points(self, point_ids: Iterable[uuid.UUID]) -> None:
        await self._client.delete(
            collection_name=self._collection,
            points_selector=[str(p) for p in point_ids],
        )

    async def delete_person(self, tenant_id: uuid.UUID, person_id: uuid.UUID) -> None:
        await self._client.delete(
            collection_name=self._collection,
            points_selector=Filter(
                must=[
                    FieldCondition(key="tenant_id", match=MatchValue(value=str(tenant_id))),
                    FieldCondition(key="person_id", match=MatchValue(value=str(person_id))),
                ]
            ),
        )

    async def delete_older_than(self, before: dt.datetime) -> int:
        """Time-based prune for the appearance collection. Returns the actual
        number of deleted points (computed via count(filter) before/after) so
        the retention metric isn't fictional."""
        ts = int(before.timestamp())
        flt = Filter(must=[FieldCondition(key="occurred_at_ts", range=Range(lt=ts))])
        try:
            pre = await self._client.count(
                collection_name=self._collection,
                count_filter=flt,
                exact=False,
            )
            pre_count = int(getattr(pre, "count", 0))
        except UnexpectedResponse as e:
            log.warning("delete_older_than count(pre) failed", collection=self._collection, err=str(e))
            pre_count = 0

        try:
            await self._client.delete(
                collection_name=self._collection,
                points_selector=flt,
            )
        except UnexpectedResponse as e:
            log.warning("delete_older_than failed", collection=self._collection, err=str(e))
            return 0

        try:
            post = await self._client.count(
                collection_name=self._collection,
                count_filter=flt,
                exact=False,
            )
            post_count = int(getattr(post, "count", 0))
        except UnexpectedResponse:
            post_count = 0
        return max(0, pre_count - post_count)

    async def search(
        self,
        *,
        tenant_id: uuid.UUID,
        vector: list[float],
        top_k: int = 5,
        score_threshold: float | None = None,
        extra_must: list[FieldCondition] | None = None,
    ) -> list[dict[str, Any]]:
        # qdrant-client ≥ 1.12 removed the legacy `.search()` method in favour
        # of `.query_points()`. Same contract: vector + filter + limit, results
        # have `id`/`score`/`payload`.
        must = [FieldCondition(key="tenant_id", match=MatchValue(value=str(tenant_id)))]
        if extra_must:
            must.extend(extra_must)
        flt = Filter(must=must)

        async def _do():
            return await self._client.query_points(
                collection_name=self._collection,
                query=vector,
                query_filter=flt,
                limit=top_k,
                score_threshold=score_threshold,
                with_payload=True,
            )

        try:
            response = await _do()
        except Exception as e:
            # Self-heal a closed async client (torn-down loop after stream churn /
            # restart). Recreate once and retry; otherwise surface the error.
            if "closed" in str(e).lower():
                log.warning("qdrant client was closed; reconnecting", collection=self._collection)
                self._reconnect()
                response = await _do()
            else:
                raise
        results = getattr(response, "points", response)  # tolerate both shapes
        return [
            {
                "point_id": uuid.UUID(str(r.id)),
                "score": float(r.score),
                "payload": dict(r.payload or {}),
            }
            for r in results
        ]

    async def close(self) -> None:
        await self._client.close()


# ──────────────────────────────────────────────────────────────────────────
# Per-collection singletons. Two named accessors: enrolled (gallery) and
# appearance (time-partitioned forensic log). The legacy `get_qdrant()`
# alias still works and routes to the enrolled gallery.

_lock = threading.Lock()
_stores: dict[str, QdrantStore] = {}


def get_qdrant_enrolled() -> QdrantStore:
    return _get_or_create(settings.qdrant_collection_enrolled)


def get_qdrant_appearance() -> QdrantStore:
    return _get_or_create(settings.qdrant_collection_appearance)


def get_qdrant() -> QdrantStore:
    """Legacy alias. Returns the enrolled gallery store."""
    return get_qdrant_enrolled()


def _get_or_create(collection: str) -> QdrantStore:
    existing = _stores.get(collection)
    if existing is not None:
        return existing
    with _lock:
        existing = _stores.get(collection)
        if existing is not None:
            return existing
        store = QdrantStore(collection)
        _stores[collection] = store
        return store


async def close_all() -> None:
    for store in list(_stores.values()):
        try:
            await store.close()
        except Exception:
            pass
    _stores.clear()
