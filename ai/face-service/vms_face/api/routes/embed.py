"""POST /api/embed/face — detect + embed one face, return the raw embedding.

This is a thin slice of /search/by-image (same routes/search.py) that
returns ONLY the embedding + det_score, without doing the gallery search.
Created because person-tracker needed an embedding endpoint to delegate
the appearance-search step to its own Qdrant query, instead of letting
smart-cam-ai do it. Keeping the responsibility split:

  - smart-cam-ai owns the face model (SCRFD + ArcFace runtime)
  - person-tracker owns the query semantics (time window, threshold,
    camera filter, clustering, video stitching)

Mounted alongside /search routes so the URL is `/api/embed/face` (not
`/embed/face`) — person-tracker hardcodes `/api/embed/face` and we
preserve that contract.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from vms_face.api.deps import recognizer, runtime
from vms_face.core.exceptions import InferenceError
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.recognizers import Recognizer
from vms_face.services.enrollment import _decode_image

router = APIRouter(prefix="/api/embed", tags=["embed"])


@router.post("/face")
async def embed_face(
    file: UploadFile = File(...),
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
) -> dict:
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(400, "empty file")
    try:
        frame = _decode_image(image_bytes)
    except InferenceError as e:
        raise HTTPException(400, str(e)) from e

    observations = await asyncio.to_thread(rt.detect, frame, max_faces=1)
    if not observations:
        # Match the existing /search/by-image semantics: 404 = no face
        # detected. person-tracker's smart_cam_ai.py treats 404 → None.
        raise HTTPException(404, "no face detected")
    obs = observations[0]

    # Reuse the embedding the detection runtime already computed when
    # the recognizer matches its shape. ArcFace/InsightFace agreement
    # means we never recompute; SCRFD's embedding is the ArcFace one.
    embedding = rec.reuse_existing(obs.embedding)
    if embedding is None:
        if obs.landmark_5 is None:
            raise HTTPException(422, "face has no landmarks; cannot align for embedding")
        embedding = await asyncio.to_thread(rec.embed, frame, obs.landmark_5)
    if embedding is None:
        raise HTTPException(500, f"recognizer {rec.name} returned no embedding")

    # obs.bbox is a numpy ndarray; `ndarray or []` raises ValueError on
    # ambiguous truth-check. Use explicit None check.
    bbox_list = None
    if obs.bbox is not None:
        bbox_list = [float(v) for v in obs.bbox]
    return {
        "embedding": embedding.tolist(),
        "det_score": float(obs.det_score) if obs.det_score is not None else None,
        "quality_score": None,  # caller (person-tracker) doesn't currently consume this
        "bbox": bbox_list,
    }
