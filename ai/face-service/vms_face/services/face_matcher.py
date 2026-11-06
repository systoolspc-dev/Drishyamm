from __future__ import annotations

import datetime as dt
import time
import uuid
from typing import Any

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.core.metrics import (
    APPEARANCE_UPSERT_LATENCY,
    MATCH_LATENCY,
    MATCHES,
)
from vms_face.domain.schemas import FaceSearchHit, FaceSearchResponse, MatchResult
from vms_face.infra.qdrant import QdrantStore
from vms_face.services.gallery_cache import GalleryCacheManager

log = get_logger(__name__)


class FaceMatcher:
    """Wraps Qdrant ANN search for face embeddings (cosine similarity in the
    ArcFace / AdaFace 512-D space). Translates raw search hits into
    MatchResult / FaceSearchResponse DTOs and applies the configured
    similarity threshold.

    Dual-collection split:
      * `enrolled` is the gallery; `match_one()` queries it for live alerts.
      * `appearance` is an append-only forensic index; `log_appearance()`
        upserts every detection's pooled embedding so operators can later
        ask "show me this face across all cameras in the last week".
    """

    def __init__(
        self,
        enrolled: QdrantStore,
        appearance: QdrantStore | None = None,
        *,
        threshold: float | None = None,
        recognizer_name: str | None = None,
        gallery: GalleryCacheManager | None = None,
    ) -> None:
        self._enrolled = enrolled
        self._appearance = appearance
        # L2/L3 gallery cache. When present and fresh, match_one() answers
        # from RAM and Qdrant is only the fallback; the result contract is
        # identical, so the ambiguity guard below is tier-agnostic.
        self._gallery = gallery
        # Per-recognizer threshold: AdaFace and ArcFace cosines are NOT comparable,
        # so resolve the threshold against the active backend unless an explicit
        # override is passed in (e.g. tests, calibration tooling).
        if threshold is not None:
            self._threshold = threshold
        else:
            self._threshold = settings.effective_recognizer_threshold(recognizer_name)
        # Crowd ambiguity guard: minimum cosine gap between the top identity and
        # the nearest different identity before we assert the match.
        self._margin = max(0.0, float(getattr(settings, "match_top1_margin", 0.0)))

    @property
    def threshold(self) -> float:
        return self._threshold

    async def match_one(
        self,
        *,
        tenant_id: uuid.UUID,
        embedding: list[float],
        camera_id: uuid.UUID | None = None,
    ) -> MatchResult:
        t0 = time.perf_counter()
        # Pull a few neighbours (not just top-1) at a slightly lowered floor so the
        # ambiguity guard can see a rival identity sitting just under threshold.
        # Search unfloored and apply the threshold below. A floored search
        # returns nothing for a miss, so every miss was recorded as
        # similarity 0.000 and nobody could tell a near-miss (0.44: threshold
        # or face size) from a stranger (0.20). On the brute-force local tier
        # the floor saved nothing; on Qdrant it is a top-k query either way.
        floor = 0.0
        top_k = 3 if self._margin > 0 else 1
        tier = "qdrant"
        if self._gallery is not None:
            results, tier = await self._gallery.search(
                tenant_id=tenant_id,
                vector=embedding,
                camera_id=camera_id,
                top_k=top_k,
                score_threshold=floor,
                confident_threshold=self._threshold
                + float(settings.gallery_cache_hot_confident_margin),
            )
        else:
            results = await self._enrolled.search(
                tenant_id=tenant_id,
                vector=embedding,
                top_k=top_k,
                score_threshold=floor,
            )
        MATCH_LATENCY.observe(time.perf_counter() - t0)

        above = [r for r in results if r["score"] >= self._threshold]
        if not above:
            if camera_id is not None:
                MATCHES.labels(camera_id=str(camera_id), outcome="miss").inc()
            return MatchResult(
                person_id=None,
                similarity=results[0]["score"] if results else 0.0,
                tier=tier,
            )

        top = above[0]
        top_person = top["payload"].get("person_id")

        # Crowd ambiguity guard: if a DIFFERENT enrolled identity sits within the
        # margin of the top score, the match is a coin-flip — return unknown rather
        # than risk attributing the detection to the wrong person.
        if self._margin > 0 and top_person is not None:
            rival = next(
                (r for r in results if r["payload"].get("person_id") not in (None, top_person)),
                None,
            )
            if rival is not None and (top["score"] - rival["score"]) < self._margin:
                if camera_id is not None:
                    MATCHES.labels(camera_id=str(camera_id), outcome="ambiguous").inc()
                return MatchResult(
                    person_id=None, similarity=top["score"], ambiguous=True, tier=tier,
                )

        person_id = uuid.UUID(top_person) if top_person else None
        if camera_id is not None:
            MATCHES.labels(camera_id=str(camera_id), outcome="hit").inc()
        if self._gallery is not None and top_person:
            # Feed the L2 hot set: this identity is "around" on this camera now.
            self._gallery.note_hit(tenant_id, camera_id, str(top_person))
        return MatchResult(
            person_id=person_id,
            similarity=top["score"],
            qdrant_point_id=top["point_id"],
            tier=tier,
        )

    async def search(
        self,
        *,
        tenant_id: uuid.UUID,
        embedding: list[float],
        top_k: int = 5,
        threshold: float | None = None,
    ) -> FaceSearchResponse:
        thr = threshold if threshold is not None else self._threshold
        results = await self._enrolled.search(
            tenant_id=tenant_id,
            vector=embedding,
            top_k=top_k,
            score_threshold=thr,
        )
        hits = [
            FaceSearchHit(
                person_id=uuid.UUID(r["payload"]["person_id"]) if r["payload"].get("person_id") else None,
                qdrant_point_id=r["point_id"],
                similarity=r["score"],
                full_name=r["payload"].get("full_name"),
                role=r["payload"].get("role"),
            )
            for r in results
        ]
        return FaceSearchResponse(hits=hits)

    async def log_appearance(
        self,
        *,
        tenant_id: uuid.UUID,
        camera_id: uuid.UUID,
        embedding: list[float],
        occurred_at: dt.datetime,
        event_id: uuid.UUID,
        person_id: uuid.UUID | None,
        track_id: str | None,
        extra: dict[str, Any] | None = None,
    ) -> uuid.UUID | None:
        """Append the pooled embedding to the appearance log. Returns the new
        point_id, or None if the appearance log is disabled or writes failed."""
        if self._appearance is None or not settings.match_worker_appearance_log:
            return None
        point_id = uuid.uuid4()
        payload: dict[str, Any] = {
            "camera_id": str(camera_id),
            "event_id": str(event_id),
            "occurred_at": occurred_at.isoformat(),
            "occurred_at_ts": int(occurred_at.timestamp()),
        }
        if person_id is not None:
            payload["person_id"] = str(person_id)
        if track_id is not None:
            payload["track_id"] = track_id
        if extra:
            payload.update(extra)
        t0 = time.perf_counter()
        try:
            await self._appearance.upsert(
                point_id=point_id,
                vector=embedding,
                tenant_id=tenant_id,
                person_id=person_id,
                payload=payload,
            )
        except Exception as e:
            log.warning("appearance upsert failed", err=str(e), event_id=str(event_id))
            return None
        finally:
            APPEARANCE_UPSERT_LATENCY.observe(time.perf_counter() - t0)
        return point_id

    async def search_appearances(
        self,
        *,
        tenant_id: uuid.UUID,
        embedding: list[float],
        top_k: int = 50,
        threshold: float | None = None,
        since: dt.datetime | None = None,
    ) -> list[dict[str, Any]]:
        """Forensic search over the appearance log. `since` is enforced via
        Qdrant's range filter on `occurred_at_ts`."""
        if self._appearance is None:
            return []
        thr = threshold if threshold is not None else self._threshold
        extra_must = []
        if since is not None:
            from qdrant_client.http.models import FieldCondition, Range
            extra_must.append(
                FieldCondition(key="occurred_at_ts", range=Range(gte=int(since.timestamp())))
            )
        return await self._appearance.search(
            tenant_id=tenant_id,
            vector=embedding,
            top_k=top_k,
            score_threshold=thr,
            extra_must=extra_must,
        )
