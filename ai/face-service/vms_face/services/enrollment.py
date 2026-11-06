from __future__ import annotations

import asyncio

import datetime as dt
import uuid

import cv2
import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.config import settings
from vms_face.core.exceptions import InferenceError, NotFoundError
from vms_face.core.logging import get_logger
from vms_face.domain.models import FaceEnrollment, Person
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import ObjectStore
from vms_face.infra.qdrant import QdrantStore
from vms_face.infra.recognizers import Recognizer
from vms_face.infra.redis_bus import get_bus
from vms_face.services import audit as audit_log
from vms_face.services.face_quality import FaceQualityGate

log = get_logger(__name__)


async def notify_gallery_changed(tenant_id: uuid.UUID, *, reason: str) -> None:
    """Nudge every local gallery cache (match workers) to reload after the
    enrolled collection changed. Best-effort and never raises — the caches
    also reload on a timer, so a lost nudge costs seconds, not correctness."""
    try:
        await get_bus().publish_gallery_changed(tenant_id, reason=reason)
    except Exception as e:  # noqa: BLE001
        log.debug("gallery-changed notify failed", err=str(e), reason=reason)


class EnrollmentService:
    """Handles registering a face for a Person:
       1. decode the uploaded image
       2. detect the largest face
       3. quality-gate it
       4. compute embedding via the configured Recognizer (so gallery vectors
          live in the same embedding space as the live pipeline's queries —
          critical when switching between InsightFace ArcFace and AdaFace)
       5. upload the crop to MinIO
       6. write FaceEnrollment row + Qdrant point in lockstep."""

    def __init__(
        self,
        runtime: FaceRuntime,
        recognizer: Recognizer,
        qdrant: QdrantStore,
        objects: ObjectStore,
        quality: FaceQualityGate,
    ) -> None:
        self._runtime = runtime
        self._recognizer = recognizer
        self._qdrant = qdrant
        self._objects = objects
        self._quality = quality

    async def enroll_image(
        self,
        session: AsyncSession,
        *,
        person_id: uuid.UUID,
        image_bytes: bytes,
        source: str = "upload",
        operator_id: str = "system:bootstrap",
    ) -> FaceEnrollment:
        person = await session.get(Person, person_id)
        if person is None:
            raise NotFoundError(f"person {person_id} not found")

        frame = await asyncio.to_thread(_decode_image, image_bytes)
        observations = await asyncio.to_thread(self._runtime.detect, frame, max_faces=1)
        if not observations:
            raise InferenceError("no face detected in enrollment image")

        obs = max(observations, key=lambda o: o.area)

        verdict = self._quality.evaluate(frame, obs)
        if not verdict.passed:
            raise InferenceError(f"face quality rejected: {verdict.rejected_for}")

        # Always embed via the configured recognizer. For insightface_arc this
        # reuses the embedding FaceAnalysis already computed; for AdaFace it
        # re-embeds using the aligned 5-point landmark crop.
        embedding = self._recognizer.reuse_existing(obs.embedding)
        if embedding is None:
            if obs.landmark_5 is None:
                raise InferenceError("face has no landmarks; recognizer cannot align")
            embedding = await asyncio.to_thread(self._recognizer.embed, frame, obs.landmark_5)
        if embedding is None:
            raise InferenceError(f"recognizer {self._recognizer.name} returned no embedding")

        # Crop & upload snapshot
        x1, y1, x2, y2 = (max(0, int(v)) for v in obs.bbox)
        crop = frame[y1:y2, x1:x2]
        snapshot_uri = await _store_crop(
            self._objects,
            tenant_id=person.tenant_id,
            person_id=person_id,
            crop=crop,
        )

        # Upsert into Qdrant first, then write the DB row referencing it.
        # On DB failure we'll have an orphan vector — Phase 4 adds a janitor.
        point_id = uuid.uuid4()
        await self._qdrant.upsert(
            point_id=point_id,
            vector=embedding.tolist(),
            tenant_id=person.tenant_id,
            person_id=person_id,
            payload={
                "full_name": person.full_name,
                "role": person.role.value,
                "source": source,
                "recognizer": self._recognizer.name,
            },
        )
        await notify_gallery_changed(person.tenant_id, reason="enroll")

        enrollment = FaceEnrollment(
            person_id=person_id,
            qdrant_point_id=point_id,
            snapshot_uri=snapshot_uri,
            det_score=obs.det_score,
            quality_score=verdict.score,
            source=source,
        )
        session.add(enrollment)
        await session.flush()

        await audit_log.record_enroll(
            tenant_id=person.tenant_id,
            person_id=person_id,
            operator_id=operator_id,
            source=source,
            qdrant_point_id=str(point_id),
            session=session,
        )

        log.info(
            "enrolled face",
            person_id=str(person_id),
            point_id=str(point_id),
            det_score=obs.det_score,
            quality=verdict.score,
        )
        return enrollment

    async def repair_enrollment_vector(
        self,
        session: AsyncSession,
        *,
        enrollment: FaceEnrollment,
        image_bytes: bytes,
    ) -> None:
        """Rebuild a missing Qdrant point for an existing DB enrollment.

        This is used by known_faces bootstrap after collection migrations,
        where Postgres rows may exist but the new gallery collection is empty.
        It preserves `face_enrollments.qdrant_point_id` instead of creating
        duplicate enrollment rows.
        """
        person = await session.get(Person, enrollment.person_id)
        if person is None:
            raise NotFoundError(f"person {enrollment.person_id} not found")

        frame = await asyncio.to_thread(_decode_image, image_bytes)
        observations = await asyncio.to_thread(self._runtime.detect, frame, max_faces=1)
        if not observations:
            raise InferenceError("no face detected in enrollment image")

        obs = max(observations, key=lambda o: o.area)
        verdict = self._quality.evaluate(frame, obs)
        if not verdict.passed:
            raise InferenceError(f"face quality rejected: {verdict.rejected_for}")

        embedding = self._recognizer.reuse_existing(obs.embedding)
        if embedding is None:
            if obs.landmark_5 is None:
                raise InferenceError("face has no landmarks; recognizer cannot align")
            embedding = await asyncio.to_thread(self._recognizer.embed, frame, obs.landmark_5)
        if embedding is None:
            raise InferenceError(f"recognizer {self._recognizer.name} returned no embedding")

        await self._qdrant.upsert(
            point_id=enrollment.qdrant_point_id,
            vector=embedding.tolist(),
            tenant_id=person.tenant_id,
            person_id=person.id,
            payload={
                "full_name": person.full_name,
                "role": person.role.value,
                "source": enrollment.source,
                "recognizer": self._recognizer.name,
                "repaired_from": "known_faces_bootstrap",
            },
        )
        await notify_gallery_changed(person.tenant_id, reason="repair")

        enrollment.det_score = obs.det_score
        enrollment.quality_score = verdict.score
        await session.flush()

        log.info(
            "repaired enrollment vector",
            person_id=str(person.id),
            point_id=str(enrollment.qdrant_point_id),
            source=enrollment.source,
        )

    async def delete_person_vectors(self, tenant_id: uuid.UUID, person_id: uuid.UUID) -> None:
        await self._qdrant.delete_person(tenant_id=tenant_id, person_id=person_id)
        # DPDP: a deleted identity must not survive in any cache. The reload
        # this triggers is the server-side half of the "purge within 60 s"
        # rule; edge nodes get the same event via gallery sync (Phase 2).
        await notify_gallery_changed(tenant_id, reason="delete")

    async def list_enrollments(self, session: AsyncSession, person_id: uuid.UUID) -> list[FaceEnrollment]:
        rows = await session.execute(select(FaceEnrollment).where(FaceEnrollment.person_id == person_id))
        return list(rows.scalars())


def _decode_image(image_bytes: bytes) -> np.ndarray:
    """Decode an uploaded photo to an UPRIGHT BGR ndarray.

    PIL-first, on purpose. Two reasons cv2.imdecode alone was wrong for uploads:
      1. EXIF orientation — phone cameras (iPhone especially) store portrait
         shots rotated with an EXIF flag. cv2.imdecode ignores it, so the face is
         decoded sideways and SCRFD (trained on upright faces) finds nothing —
         the "clear photo but 'no face detected'" bug. ImageOps.exif_transpose
         rotates it upright first.
      2. HEIC/HEIF — the iPhone default format, which cv2 can't read at all;
         pillow-heif teaches PIL to.
    cv2 is the fallback for exotic formats PIL can't open. Every upload surface
    (enrollment, journey search, face search, embed) funnels through here, so
    both fixes land product-wide.
    """
    if not image_bytes:
        raise InferenceError("empty file")
    try:
        import io

        from PIL import Image, ImageOps

        try:  # register HEIF opener once; harmless/no-op if unavailable
            from pillow_heif import register_heif_opener

            register_heif_opener()
        except ImportError:
            pass
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)  # honor EXIF orientation → upright
        rgb = img.convert("RGB")
        return cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
    except Exception:  # noqa: BLE001 — PIL choked; try cv2 for exotic formats
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise InferenceError(
                "could not decode uploaded image — use JPEG, PNG, WebP or HEIC"
            ) from None
        return frame


async def _store_crop(
    objects: ObjectStore,
    *,
    tenant_id: uuid.UUID,
    person_id: uuid.UUID,
    crop: np.ndarray,
) -> str | None:
    if crop.size == 0:
        return None
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        return None
    payload = buf.tobytes()
    # Run the crop through face-reconstruct (CodeFormer + Real-ESRGAN) so the
    # stored gallery thumbnail looks studio-quality even when the operator
    # enrolled from a CCTV grab. The embedding above was already computed
    # against the ORIGINAL pixels — recognition was trained on low-res faces
    # and SR-before-embed hurts match accuracy, so we deliberately enhance
    # only the bytes that humans see, not what the matcher consumes.
    # Falls back to the original JPEG on any failure (timeout, service down).
    if settings.enrollment_auto_enhance:
        enhanced = await _maybe_enhance_enrollment(payload)
        if enhanced is not None:
            payload = enhanced
    ts = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    key = f"{tenant_id}/{person_id}/{ts}_{uuid.uuid4().hex[:8]}.jpg"
    return objects.put_bytes(settings.minio_bucket_enrollments, key, payload)


# Lazy httpx client (singleton) — same pattern as snapshot_pump's
# `_get_enhance_client`. Enrollment is operator-driven and rare compared to
# the live pump, so we can afford much looser timeouts here (10 s read).
_enroll_enhance_client = None


def _get_enroll_client():
    global _enroll_enhance_client
    if _enroll_enhance_client is None:
        import httpx
        _enroll_enhance_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=1.0, read=10.0, write=2.0, pool=1.0),
        )
    return _enroll_enhance_client


async def _maybe_enhance_enrollment(jpeg_bytes: bytes) -> bytes | None:
    """POST a JPEG to face-reconstruct, return the enhanced PNG bytes.

    Returns None on any failure (timeout, 5xx, malformed response) so the
    caller falls back to the original JPEG — losing the enhancement is
    always preferable to losing the enrollment."""
    try:
        client = _get_enroll_client()
        url = settings.face_reconstruct_url.rstrip("/") + "/api/reconstruct"
        files = {"file": ("face.jpg", jpeg_bytes, "image/jpeg")}
        data = {"fidelity_weight": str(settings.enrollment_auto_enhance_fidelity)}
        r = await client.post(url, files=files, data=data)
        if r.status_code != 200:
            log.warning("enrollment enhance: non-200", status=r.status_code)
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
        log.warning("enrollment enhance failed", err=str(e))
        return None
