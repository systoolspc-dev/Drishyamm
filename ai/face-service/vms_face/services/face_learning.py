from __future__ import annotations

import datetime as dt
import math
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.domain.models import FaceEnrollment, FaceLearningSample, Person
from vms_face.domain.schemas import FaceCandidate, MatchResult
from vms_face.infra.qdrant import QdrantStore
from vms_face.services import audit as audit_log

log = get_logger(__name__)

ACTIVE_STATUSES = ("pending", "approved")


async def maybe_queue_sample(
    session: AsyncSession,
    *,
    candidate: FaceCandidate,
    result: MatchResult,
    event_id: uuid.UUID,
    person: Person | None,
) -> FaceLearningSample | None:
    """Store a high-quality matched CCTV crop as a pending learning sample.

    This does not mutate the enrolled gallery. It only records evidence that an
    operator can approve later. Keeping this in the match worker gives us the
    cleaned, track-pooled embedding and the crop URI without slowing detection.
    """
    if not settings.face_learning_enabled:
        return None
    if result.person_id is None or person is None:
        return None
    if not candidate.snapshot_uri:
        return None
    if result.similarity < settings.face_learning_min_similarity:
        return None
    if candidate.quality_score < settings.face_learning_min_quality:
        return None
    if float((candidate.extra or {}).get("face_px") or 0.0) < settings.face_learning_min_face_px:
        return None
    blur_var = (candidate.extra or {}).get("blur_var")
    if blur_var is None or float(blur_var) < settings.face_learning_min_blur_var:
        return None
    if not candidate.embedding:
        return None

    track_count = await _count_samples(
        session,
        person_id=result.person_id,
        camera_id=candidate.camera_id,
        track_id=candidate.track_id,
    )
    if track_count >= settings.face_learning_max_samples_per_track:
        return None

    pending_count = await _count_pending_for_person(session, person_id=result.person_id)
    if pending_count >= settings.face_learning_max_pending_per_person:
        return None

    duplicate = await _is_near_duplicate(session, person_id=result.person_id, embedding=candidate.embedding)
    if duplicate:
        return None

    sample = FaceLearningSample(
        tenant_id=candidate.tenant_id,
        person_id=result.person_id,
        camera_id=candidate.camera_id,
        event_id=event_id,
        track_id=candidate.track_id,
        snapshot_uri=candidate.snapshot_uri,
        bbox=candidate.bbox,
        embedding=[float(v) for v in candidate.embedding],
        similarity=result.similarity,
        det_score=candidate.det_score,
        quality_score=candidate.quality_score,
        gender=(candidate.extra or {}).get("gender"),
        status="pending",
        metadata_json={
            "source": "match_worker",
            "recognizer": (candidate.extra or {}).get("recognizer"),
            "camera_code": (candidate.extra or {}).get("camera_code"),
            "frame_w": (candidate.extra or {}).get("frame_w"),
            "frame_h": (candidate.extra or {}).get("frame_h"),
            "face_px": (candidate.extra or {}).get("face_px"),
            "blur_var": (candidate.extra or {}).get("blur_var"),
            "brightness": (candidate.extra or {}).get("brightness"),
            "person_name": person.full_name,
        },
        occurred_at=candidate.occurred_at,
    )
    session.add(sample)
    await session.flush()
    log.info(
        "queued face learning sample",
        sample_id=str(sample.id),
        person_id=str(result.person_id),
        similarity=result.similarity,
        quality=candidate.quality_score,
    )
    return sample


async def approve_sample(
    session: AsyncSession,
    *,
    sample: FaceLearningSample,
    qdrant: QdrantStore,
    operator_id: str,
) -> FaceEnrollment:
    if sample.status == "approved":
        existing = await _enrollment_for_point(session, sample.qdrant_point_id)
        if existing is not None:
            return existing
    if sample.status not in ("pending", "approved"):
        raise ValueError(f"sample is {sample.status}, not pending")

    person = await session.get(Person, sample.person_id)
    if person is None:
        raise ValueError("sample person no longer exists")

    point_id = sample.qdrant_point_id or uuid.uuid4()
    await qdrant.upsert(
        point_id=point_id,
        vector=[float(v) for v in sample.embedding],
        tenant_id=sample.tenant_id,
        person_id=sample.person_id,
        payload={
            "full_name": person.full_name,
            "role": person.role.value,
            "source": "auto-learning",
            "learning_sample_id": str(sample.id),
            "recognizer": (sample.metadata_json or {}).get("recognizer"),
        },
    )
    # New gallery vector → local gallery caches must reload.
    from vms_face.services.enrollment import notify_gallery_changed
    await notify_gallery_changed(sample.tenant_id, reason="learning_approve")

    enrollment = FaceEnrollment(
        person_id=sample.person_id,
        qdrant_point_id=point_id,
        snapshot_uri=sample.snapshot_uri,
        det_score=sample.det_score,
        quality_score=sample.quality_score,
        source="auto-learning",
    )
    session.add(enrollment)
    sample.qdrant_point_id = point_id
    sample.status = "approved"
    sample.reviewed_by = operator_id[:128]
    sample.reviewed_at = _now()
    sample.reason = "approved into enrolled gallery"
    await session.flush()

    await audit_log.record_enroll(
        tenant_id=sample.tenant_id,
        person_id=sample.person_id,
        operator_id=operator_id,
        source="auto-learning",
        qdrant_point_id=str(point_id),
        session=session,
    )
    return enrollment


async def reject_sample(
    session: AsyncSession,
    *,
    sample: FaceLearningSample,
    operator_id: str,
    reason: str,
) -> FaceLearningSample:
    if sample.status == "approved":
        raise ValueError("approved samples cannot be rejected")
    sample.status = "rejected"
    sample.reviewed_by = operator_id[:128]
    sample.reviewed_at = _now()
    sample.reason = reason[:256]
    await audit_log.record(
        actor=f"user:{operator_id}",
        actor_kind="user",
        action="reject_face_learning_sample",
        tenant_id=sample.tenant_id,
        target_type="face_learning_sample",
        target_id=str(sample.id),
        reason=sample.reason,
        metadata={"person_id": str(sample.person_id)},
        session=session,
    )
    await session.flush()
    return sample


async def _count_samples(
    session: AsyncSession,
    *,
    person_id: uuid.UUID,
    camera_id: uuid.UUID,
    track_id: str,
) -> int:
    stmt = (
        select(func.count())
        .select_from(FaceLearningSample)
        .where(
            FaceLearningSample.person_id == person_id,
            FaceLearningSample.camera_id == camera_id,
            FaceLearningSample.track_id == track_id,
            FaceLearningSample.status.in_(ACTIVE_STATUSES),
        )
    )
    return int((await session.execute(stmt)).scalar_one() or 0)


async def _count_pending_for_person(session: AsyncSession, *, person_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(FaceLearningSample)
        .where(FaceLearningSample.person_id == person_id, FaceLearningSample.status == "pending")
    )
    return int((await session.execute(stmt)).scalar_one() or 0)


async def _is_near_duplicate(
    session: AsyncSession,
    *,
    person_id: uuid.UUID,
    embedding: list[float],
) -> bool:
    stmt = (
        select(FaceLearningSample.embedding)
        .where(
            FaceLearningSample.person_id == person_id,
            FaceLearningSample.status.in_(ACTIVE_STATUSES),
        )
        .order_by(FaceLearningSample.created_at.desc())
        .limit(50)
    )
    rows = (await session.execute(stmt)).scalars().all()
    threshold = settings.face_learning_duplicate_similarity
    return any(_cosine(embedding, row) >= threshold for row in rows if row)


async def _enrollment_for_point(
    session: AsyncSession,
    point_id: uuid.UUID | None,
) -> FaceEnrollment | None:
    if point_id is None:
        return None
    row = await session.execute(select(FaceEnrollment).where(FaceEnrollment.qdrant_point_id == point_id))
    return row.scalar_one_or_none()


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(float(x) * float(y) for x, y in zip(a, b))
    na = math.sqrt(sum(float(x) * float(x) for x in a))
    nb = math.sqrt(sum(float(y) * float(y) for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)
