from __future__ import annotations

import uuid

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session, operator_id
from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.domain.models import FaceLearningSample

log = get_logger(__name__)


def _sample_or_404(s: FaceLearningSample | None, tenant_id: uuid.UUID) -> FaceLearningSample:
    if s is None or s.tenant_id != tenant_id:
        raise HTTPException(404, "face learning sample not found")
    return s
from vms_face.domain.schemas import FaceEnrollmentOut, FaceLearningSampleOut
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.qdrant import get_qdrant_enrolled
from vms_face.services.face_learning import approve_sample, reject_sample

router = APIRouter(prefix="/face-learning", tags=["face-learning"])


@router.get("/samples", response_model=list[FaceLearningSampleOut])
async def list_samples(
    person_id: uuid.UUID | None = Query(None),
    status: str | None = Query("pending"),
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> list[FaceLearningSampleOut]:
    stmt = select(FaceLearningSample).where(FaceLearningSample.tenant_id == tenant_id)
    if person_id:
        stmt = stmt.where(FaceLearningSample.person_id == person_id)
    if status:
        stmt = stmt.where(FaceLearningSample.status == status)
    stmt = stmt.order_by(FaceLearningSample.quality_score.desc(), FaceLearningSample.created_at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(stmt)).scalars().all()
    return [_sample_out(row) for row in rows]


@router.post("/samples/{sample_id}/approve", response_model=FaceEnrollmentOut)
async def approve_learning_sample(
    sample_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> FaceEnrollmentOut:
    sample = _sample_or_404(await session.get(FaceLearningSample, sample_id), tenant_id)
    try:
        enrollment = await approve_sample(
            session,
            sample=sample,
            qdrant=get_qdrant_enrolled(),
            operator_id=actor,
        )
        await session.commit()
        await session.refresh(enrollment)
    except ValueError as e:
        await session.rollback()
        raise HTTPException(409, str(e)) from e
    return FaceEnrollmentOut.model_validate(enrollment)


@router.get("/samples/{sample_id}/snapshot")
async def sample_snapshot(
    sample_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
):
    sample = _sample_or_404(await session.get(FaceLearningSample, sample_id), tenant_id)
    bucket, key = _parse_s3_uri(sample.snapshot_uri)
    if not bucket or not key:
        raise HTTPException(404, "sample snapshot not found")

    store = get_object_store()
    client = store._client  # noqa: SLF001

    # Auto-enhance path is dormant — the supporting helpers below remain so
    # flipping `face_learning_auto_enhance` back to True re-enables it
    # without code changes. Default behaviour: stream the original MinIO
    # bytes as the route did before the enhance work.
    if not settings.face_learning_auto_enhance:
        try:
            obj = client.get_object(bucket, key)
        except Exception as e:
            raise HTTPException(404, "sample snapshot not found") from e
        return StreamingResponse(obj.stream(32 * 1024), media_type="image/jpeg")

    # ── on-demand enhance with sidecar cache (gated above) ──
    enhanced_key = key + ".enh.png"
    try:
        cached = client.get_object(bucket, enhanced_key).read()
        return Response(content=cached, media_type="image/png")
    except Exception:
        pass
    try:
        original = client.get_object(bucket, key).read()
    except Exception as e:
        raise HTTPException(404, "sample snapshot not found") from e
    if len(original) >= 4 and original[:4] == b"\x89PNG":
        try:
            store.put_bytes(bucket, enhanced_key, original, content_type="image/png")
        except Exception as e:
            log.debug("face-learning cache write skipped", err=str(e))
        return Response(content=original, media_type="image/png")
    enhanced = await _enhance_for_learning(original)
    if enhanced is not None:
        try:
            store.put_bytes(bucket, enhanced_key, enhanced, content_type="image/png")
        except Exception as e:
            log.debug("face-learning cache write skipped", err=str(e))
        return Response(content=enhanced, media_type="image/png")
    return Response(content=original, media_type="image/jpeg")


# Lazy httpx client (singleton). Face-learning review is operator-driven
# and not on the live pipeline's hot path, so we can afford generous
# timeouts here.
_learning_enhance_client = None


def _get_learning_client():
    global _learning_enhance_client
    if _learning_enhance_client is None:
        import httpx
        _learning_enhance_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=1.0, read=10.0, write=2.0, pool=1.0),
        )
    return _learning_enhance_client


async def _enhance_for_learning(jpeg_bytes: bytes) -> bytes | None:
    """POST a JPEG to face-reconstruct, return enhanced PNG bytes.

    Returns None on any failure so the caller falls back to the original."""
    try:
        client = _get_learning_client()
        url = settings.face_reconstruct_url.rstrip("/") + "/api/reconstruct"
        files = {"file": ("face.jpg", jpeg_bytes, "image/jpeg")}
        data = {"fidelity_weight": str(settings.face_learning_auto_enhance_fidelity)}
        r = await client.post(url, files=files, data=data)
        if r.status_code != 200:
            log.warning("face-learning enhance: non-200", status=r.status_code)
            return None
        body = r.json()
        # See snapshot_pump for the key-name story — `reconstruction_image`
        # is the real GAN output; `final_enhanced_image` is just CV pre-pass.
        after_b64 = (body or {}).get("reconstruction_image") or (body or {}).get("final_enhanced_image")
        if not after_b64:
            return None
        import base64
        return base64.b64decode(after_b64)
    except Exception as e:
        log.warning("face-learning enhance failed", err=str(e))
        return None


@router.post("/samples/{sample_id}/reject", response_model=FaceLearningSampleOut)
async def reject_learning_sample(
    sample_id: uuid.UUID,
    payload: dict = Body(default_factory=dict),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> FaceLearningSampleOut:
    sample = _sample_or_404(await session.get(FaceLearningSample, sample_id), tenant_id)
    reason = str(payload.get("reason") or "operator rejected sample").strip()
    try:
        await reject_sample(session, sample=sample, operator_id=actor, reason=reason)
        await session.commit()
        await session.refresh(sample)
    except ValueError as e:
        await session.rollback()
        raise HTTPException(409, str(e)) from e
    return FaceLearningSampleOut.model_validate(sample)


def _sample_out(sample: FaceLearningSample) -> FaceLearningSampleOut:
    return FaceLearningSampleOut.model_validate(sample)


def _parse_s3_uri(uri: str | None) -> tuple[str | None, str | None]:
    if not uri or not uri.startswith("s3://"):
        return None, None
    _, _, rest = uri.partition("s3://")
    bucket, _, key = rest.partition("/")
    return (bucket or None), (key or None)
