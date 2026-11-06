"""/edge — the server side of the edge tiers (docs/FACE_EDGE_REALTIME_PLAN.md).

    GET  /edge/info                  which embedding space this server speaks
    POST /edge/embed                 one ALIGNED 112x112 crop  → embedding
    POST /edge/embed/batch           many aligned crops (base64) → embeddings
    POST /edge/escalate              a face crop the edge is unsure about → verdict
    GET  /edge/gallery/version       tenant's monotonic gallery version
    GET  /edge/gallery/snapshot      the tenant's whole gallery as one .npz

Two edge shapes use this:

  * detect-track-crop-only (RECOGNIZER_BACKEND=remote on the edge): the edge
    aligns crops and calls /edge/embed — the server never sees a frame, the
    edge never holds a recognizer, one embedding space for everyone.
  * cascade: an edge with its own small recognizer decides the easy 85-95%
    locally and calls /edge/escalate with the best crop for the ambiguous
    band. It gets the big model's verdict, at ~15 KB per escalation.

Everything here is tenant-scoped through the JWT like the rest of the API.
"""
from __future__ import annotations

import asyncio

import base64
import io
import threading
import uuid

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from vms_face.api.deps import bus, current_tenant_id, matcher, qdrant_enrolled, recognizer, runtime
from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.core.logging import get_logger
from vms_face.domain.models import Person
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.postgres import session_scope
from vms_face.infra.qdrant import QdrantStore
from vms_face.infra.recognizers import Recognizer
from vms_face.infra.redis_bus import RedisBus
from vms_face.services import audit as audit_log
from vms_face.services.enrollment import _decode_image
from vms_face.services.face_matcher import FaceMatcher

router = APIRouter(prefix="/edge", tags=["edge"])
log = get_logger(__name__)

_ALIGNED = 112


# ── aligned-crop embedder ─────────────────────────────────────────────────
#
# The configured recognizer may be the legacy "insightface" backend, which has
# no standalone embedder (it only reuses what detection produced). /edge/embed
# needs one, so we lazily build a BatchedArcFaceRecognizer — same weights, same
# vectors — and keep it for the life of the process.

_fallback_lock = threading.Lock()
_fallback_embedder = None


def _aligned_embedder(rec: Recognizer):
    if hasattr(rec, "embed_aligned_batch"):
        return rec
    global _fallback_embedder
    if _fallback_embedder is None:
        with _fallback_lock:
            if _fallback_embedder is None:
                from vms_face.infra.recognizers.batched_arcface import BatchedArcFaceRecognizer

                _fallback_embedder = BatchedArcFaceRecognizer(providers=settings.providers_list)
                log.info("edge: built standalone embedder for /edge/embed",
                         configured_backend=rec.name)
    return _fallback_embedder


def _decode_aligned(data: bytes) -> np.ndarray:
    try:
        img = _decode_image(data)
    except InferenceError as e:
        raise HTTPException(400, str(e)) from e
    if img.shape[0] != _ALIGNED or img.shape[1] != _ALIGNED:
        raise HTTPException(
            422, f"crop must be {_ALIGNED}x{_ALIGNED} aligned (got {img.shape[1]}x{img.shape[0]})",
        )
    return img


# ── routes ────────────────────────────────────────────────────────────────


@router.get("/info")
async def edge_info(
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
    rbus: RedisBus = Depends(bus),
) -> dict:
    emb = _aligned_embedder(rec)
    return {
        "recognizer": emb.name,
        "embedding_dim": int(getattr(emb, "embedding_dim", 512)),
        "detector_det_size": rt.det_size,
        "match_threshold": settings.effective_recognizer_threshold(emb.name),
        "match_top1_margin": float(settings.match_top1_margin),
        "gallery_version": await rbus.gallery_version(tenant_id),
        "tenant_id": str(tenant_id),
    }


@router.post("/embed")
async def edge_embed(
    file: UploadFile = File(...),
    rec: Recognizer = Depends(recognizer),
    _tenant: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    aligned = _decode_aligned(data)
    emb = _aligned_embedder(rec)
    vec = emb.embed_aligned(aligned)
    if vec is None:
        raise HTTPException(500, f"recognizer {emb.name} returned no embedding")
    return {"embedding": vec.tolist(), "recognizer": emb.name}


class _BatchIn(BaseModel):
    format: str = "png"
    crops: list[str] = Field(default_factory=list, max_length=64)   # base64 images


@router.post("/embed/batch")
async def edge_embed_batch(
    body: _BatchIn,
    rec: Recognizer = Depends(recognizer),
    _tenant: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    if not body.crops:
        return {"embeddings": [], "recognizer": _aligned_embedder(rec).name}
    crops: list[np.ndarray | None] = []
    for b64 in body.crops:
        try:
            crops.append(_decode_aligned(base64.b64decode(b64)))
        except HTTPException:
            crops.append(None)
    emb = _aligned_embedder(rec)
    valid = [c for c in crops if c is not None]
    vecs = emb.embed_aligned_batch(valid) if valid else []
    it = iter(vecs)
    out: list[list[float] | None] = []
    for c in crops:
        if c is None:
            out.append(None)
            continue
        v = next(it, None)
        out.append(v.tolist() if v is not None else None)
    return {"embeddings": out, "recognizer": emb.name}


@router.post("/escalate")
async def edge_escalate(
    file: UploadFile = File(...),
    camera_id: uuid.UUID | None = Form(None),
    track_id: str | None = Form(None),
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    fm: FaceMatcher = Depends(matcher),
    rbus: RedisBus = Depends(bus),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    """The cascade's second opinion. The edge sends the best crop of a track
    it could not decide (with some margin around the face, NOT aligned); we
    detect, embed with the big model, run the same 1:N + ambiguity guard the
    match worker uses, and answer with a verdict the edge feeds straight into
    its identity latch. Audited like any automated 1:N hit."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    try:
        frame = _decode_image(data)
    except InferenceError as e:
        raise HTTPException(400, str(e)) from e

    obs_list = await asyncio.to_thread(rt.detect, frame, max_faces=1, det_thresh=float(settings.edge_escalate_det_threshold))
    if not obs_list:
        return {"found": False, "person_id": None, "person_name": None,
                "similarity": 0.0, "ambiguous": False, "tier": None}
    obs = obs_list[0]
    embedding = rec.reuse_existing(obs.embedding)
    if embedding is None:
        if obs.landmark_5 is None:
            raise HTTPException(422, "face has no landmarks; cannot align")
        embedding = await asyncio.to_thread(rec.embed, frame, obs.landmark_5)
    if embedding is None:
        raise HTTPException(500, f"recognizer {rec.name} returned no embedding")

    result = await fm.match_one(tenant_id=tenant_id, embedding=embedding.tolist(), camera_id=camera_id)

    person_name: str | None = None
    if result.person_id is not None:
        async with session_scope() as session:
            person = await session.get(Person, result.person_id)
            person_name = person.full_name if person is not None else None
            await audit_log.record_match(
                tenant_id=tenant_id,
                person_id=result.person_id,
                similarity=result.similarity,
                camera_id=camera_id,
                track_id=track_id or "edge",
                session=session,
            )

    verdict = {
        "found": True,
        "camera_id": str(camera_id) if camera_id else None,
        "track_id": track_id,
        "skipped": False,
        "person_id": str(result.person_id) if result.person_id else None,
        "person_name": person_name,
        "similarity": float(result.similarity),
        "ambiguous": bool(result.ambiguous),
        "tier": result.tier,
        "det_score": float(obs.det_score),
        "face_px": float(min(obs.width, obs.height)),
        "latch_reason": "escalation",
    }
    # If the caller shares our Redis (a server-hosted orchestrator, or an
    # edge on the same bus) its latch can also hear this on the verdict
    # channel. Harmless otherwise.
    if camera_id is not None and track_id:
        try:
            await rbus.publish_verdict(str(camera_id), verdict)
        except Exception:  # noqa: BLE001
            pass
    return verdict


@router.get("/gallery/version")
async def gallery_version(
    tenant_id: uuid.UUID = Depends(current_tenant_id),
    rbus: RedisBus = Depends(bus),
) -> dict:
    return {"tenant_id": str(tenant_id), "version": await rbus.gallery_version(tenant_id)}


@router.get("/gallery/snapshot")
async def gallery_snapshot(
    quant: str = "float16",
    tenant_id: uuid.UUID = Depends(current_tenant_id),
    store: QdrantStore = Depends(qdrant_enrolled),
    rec: Recognizer = Depends(recognizer),
    rbus: RedisBus = Depends(bus),
) -> Response:
    """The tenant's enrolled gallery as one compressed .npz — what an edge
    node loads into its local L3 cache. `quant`: float16 (default, half the
    bytes, cosine drift ~1e-4) | float32 | int8 (per-row scale, 4x smaller).
    50k identities is ~50 MB float16; pull it when /gallery/version moves."""
    from vms_face.services.gallery_cache import LocalGallery, _quantize_rows

    rows = await LocalGallery(store)._scroll_all(tenant_id)  # noqa: SLF001 — shared loader
    n = len(rows)
    dim = int(settings.qdrant_vector_size)
    version = await rbus.gallery_version(tenant_id)
    emb = _aligned_embedder(rec)

    ids = np.array([pid for pid, _, _ in rows], dtype="U36")
    person_ids = np.array([str(p.get("person_id") or "") for _, p, _ in rows], dtype="U36")
    names = np.array([str(p.get("full_name") or "") for _, p, _ in rows], dtype="U128")
    roles = np.array([str(p.get("role") or "") for _, p, _ in rows], dtype="U32")
    mat = np.stack([v for _, _, v in rows]).astype(np.float32) if n else np.zeros((0, dim), np.float32)
    if n:
        mat = mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-9)

    payload: dict = {
        "ids": ids, "person_ids": person_ids, "names": names, "roles": roles,
        "version": np.int64(version), "recognizer": np.str_(emb.name),
        "tenant_id": np.str_(str(tenant_id)), "dim": np.int64(dim),
    }
    q = (quant or "float16").lower()
    if q == "int8":
        q8, scale = _quantize_rows(mat) if n else (np.zeros((0, dim), np.int8), np.zeros((0,), np.float32))
        payload["vectors_int8"] = q8
        payload["scales"] = scale
    elif q == "float32":
        payload["vectors"] = mat
    else:
        payload["vectors"] = mat.astype(np.float16)

    buf = io.BytesIO()
    np.savez_compressed(buf, **payload)
    body = buf.getvalue()
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            "X-Gallery-Version": str(version),
            "X-Gallery-Count": str(n),
            "X-Recognizer": emb.name,
            "Content-Disposition": f'attachment; filename="gallery-{tenant_id}-v{version}.npz"',
        },
    )
