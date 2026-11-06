from __future__ import annotations

import asyncio

import datetime as dt
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from vms_face.api.deps import current_tenant_id, matcher, operator_id, recognizer, runtime
from vms_face.core.exceptions import InferenceError
from vms_face.domain.schemas import FaceSearchResponse
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.recognizers import Recognizer
from vms_face.services import audit as audit_log
from vms_face.services.enrollment import _decode_image
from vms_face.services.face_matcher import FaceMatcher

router = APIRouter(prefix="/search", tags=["search"])


def _embed_query_image(rt: FaceRuntime, rec: Recognizer, image_bytes: bytes):
    if not image_bytes:
        raise HTTPException(400, "empty file")
    try:
        frame = _decode_image(image_bytes)
    except InferenceError as e:
        raise HTTPException(400, str(e)) from e

    observations = rt.detect(frame, max_faces=1)
    if not observations:
        return None
    obs = observations[0]

    embedding = rec.reuse_existing(obs.embedding)
    if embedding is None:
        if obs.landmark_5 is None:
            return None
        embedding = rec.embed(frame, obs.landmark_5)
    return embedding


@router.post("/by-image", response_model=FaceSearchResponse)
async def search_by_image(
    top_k: int = Form(5),
    threshold: float | None = Form(None),
    reason: str | None = Form(None),
    file: UploadFile = File(...),
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    fm: FaceMatcher = Depends(matcher),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> FaceSearchResponse:
    image_bytes = await file.read()
    embedding = await asyncio.to_thread(_embed_query_image, rt, rec, image_bytes)
    if embedding is None:
        # Always audit the attempt — DPDP requires the binding *attempt* to
        # be auditable, not just successful matches.
        await audit_log.record_search(
            tenant_id=tenant_id,
            operator_id=actor,
            top_hits=[],
            reason=reason or "1:N search by image (no face detected)",
        )
        return FaceSearchResponse(hits=[])

    response = await fm.search(
        tenant_id=tenant_id,
        embedding=embedding.tolist(),
        top_k=top_k,
        threshold=threshold,
    )
    await audit_log.record_search(
        tenant_id=tenant_id,
        operator_id=actor,
        top_hits=[
            {
                "person_id": str(h.person_id) if h.person_id else None,
                "qdrant_point_id": str(h.qdrant_point_id),
                "similarity": h.similarity,
            }
            for h in response.hits
        ],
        reason=reason or "1:N search by image",
    )
    return response


@router.post("/appearances")
async def search_appearances(
    top_k: int = Form(50),
    threshold: float | None = Form(None),
    since_iso: str | None = Form(None, description="ISO 8601; only match appearances after this time"),
    reason: str | None = Form(None),
    file: UploadFile = File(...),
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    fm: FaceMatcher = Depends(matcher),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    """Forensic search across the appearance log: 'show me this face's
    movements over time and across cameras'. Filters by tenant + optional
    time range. The appearance index is populated by the match worker."""
    image_bytes = await file.read()
    embedding = await asyncio.to_thread(_embed_query_image, rt, rec, image_bytes)
    if embedding is None:
        await audit_log.record_search(
            tenant_id=tenant_id,
            operator_id=actor,
            top_hits=[],
            reason=reason or "appearance forensic search (no face)",
        )
        return {"hits": []}

    since: dt.datetime | None = None
    if since_iso:
        try:
            since = dt.datetime.fromisoformat(since_iso)
        except ValueError:
            raise HTTPException(400, "since_iso must be ISO 8601") from None

    hits = await fm.search_appearances(
        tenant_id=tenant_id,
        embedding=embedding.tolist(),
        top_k=top_k,
        threshold=threshold,
        since=since,
    )
    await audit_log.record_search(
        tenant_id=tenant_id,
        operator_id=actor,
        top_hits=[
            {
                "point_id": str(h["point_id"]),
                "similarity": h["score"],
                "camera_id": h["payload"].get("camera_id"),
                "occurred_at": h["payload"].get("occurred_at"),
            }
            for h in hits
        ],
        reason=reason or "appearance forensic search",
    )
    return {
        "hits": [
            {
                "point_id": str(h["point_id"]),
                "similarity": h["score"],
                "camera_id": h["payload"].get("camera_id"),
                "person_id": h["payload"].get("person_id"),
                "track_id": h["payload"].get("track_id"),
                "event_id": h["payload"].get("event_id"),
                "occurred_at": h["payload"].get("occurred_at"),
            }
            for h in hits
        ]
    }
