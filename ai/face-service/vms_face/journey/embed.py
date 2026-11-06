"""In-process query-face embedding.

The former person-tracker delegated this over HTTP to smart-cam-ai's
`/api/embed/face`. Centralized, we call the same runtime + recognizer directly
(no network hop) — identical logic to api/routes/embed.py, so the query vector
lives in the exact same space as the `vms_appearance` log it searches."""
from __future__ import annotations

from dataclasses import dataclass

from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.recognizers import Recognizer
from vms_face.services.enrollment import _decode_image

# Permissive detection floor for uploaded QUERY photos only (the live pipeline
# keeps its strict floor). A forensic upload is a deliberate single-face image,
# so a real face that scores under the strict CCTV threshold should still match.
_QUERY_DET_THRESHOLD = float(getattr(settings, "journey_query_det_threshold", 0.30))


@dataclass
class QueryEmbedding:
    embedding: list[float]
    det_score: float | None
    bbox: list[float] | None


class NoFaceError(Exception):
    """No usable face in the uploaded photo (mirrors the 404 the route returned)."""


def embed_query_face(image_bytes: bytes, *, rt: FaceRuntime, rec: Recognizer) -> QueryEmbedding:
    """Detect the largest face and return its embedding + det_score.
    Raises NoFaceError when no face is detected, InferenceError on bad input."""
    if not image_bytes:
        raise InferenceError("empty file")
    frame = _decode_image(image_bytes)

    # Strict pass first (the live-CCTV floor); if nothing, retry once with the
    # permissive query threshold — recovers real faces (beard / slight angle /
    # phone compression) that scored under the strict floor. An uploaded query
    # photo is a deliberate single-face image, so this won't add false matches.
    observations = rt.detect(frame, max_faces=1)
    if not observations:
        observations = rt.detect(frame, max_faces=1, det_thresh=_QUERY_DET_THRESHOLD)
    if not observations:
        raise NoFaceError("no face detected in uploaded photo")
    obs = observations[0]

    # Reuse the embedding the detector already produced when the recognizer
    # agrees on shape; otherwise align + embed from the 5-point landmarks.
    embedding = rec.reuse_existing(obs.embedding)
    if embedding is None:
        if obs.landmark_5 is None:
            raise InferenceError("face has no landmarks; cannot align for embedding")
        embedding = rec.embed(frame, obs.landmark_5)
    if embedding is None:
        raise InferenceError(f"recognizer {rec.name} returned no embedding")

    bbox = [float(v) for v in obs.bbox] if obs.bbox is not None else None
    det = float(obs.det_score) if obs.det_score is not None else None
    return QueryEmbedding(embedding=embedding.tolist(), det_score=det, bbox=bbox)
