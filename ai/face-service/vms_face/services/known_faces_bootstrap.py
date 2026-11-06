"""
known_faces_bootstrap.py

On startup, scan the on-disk `known_faces/` folder and enroll every image into
the default tenant's gallery. The folder lives at $KNOWN_FACES_DIR (set in the
Dockerfile to /srv/app/face_detection/insightface-master/known_faces).

Filename convention
-------------------
   <Person Name>_<N>.<ext>      e.g.  "Aakash Baghel_3.JPG"
   <Person Name>.<ext>          e.g.  "Anshika.jpg"

The trailing _<digits> (if any) is stripped to derive the person's full name.
Multiple files for the same person all enroll under the same Person row,
giving the matcher 5+ embeddings per face → much higher recall than a single
shot.

Idempotency
-----------
EnrollmentService stamps each FaceEnrollment.source with a unique marker:

   bootstrap:<filename>:<sha256[:8]>

On re-runs we query face_enrollments for that source string and skip any
file we've already imported with the same content hash. Edit a file → its
hash changes → it gets re-enrolled (resulting in *another* embedding for the
same person, which is fine — embeddings are additive).

This is run from the FastAPI lifespan as a background task so service boot
isn't blocked. Logs progress to stdout every 10 enrollments.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import unicodedata
from pathlib import Path
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.core.logging import get_logger
from vms_face.domain.enums import PersonRole
from vms_face.domain.models import FaceEnrollment, Person, Tenant
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.postgres import session_scope
from vms_face.infra.qdrant import get_qdrant
from vms_face.infra.recognizers import get_recognizer
from vms_face.services.enrollment import EnrollmentService
from vms_face.services.face_quality import FaceQualityGate

log = get_logger(__name__)

# Folder defaults to the Dockerfile path; falls back gracefully if missing.
KNOWN_FACES_DIR = os.environ.get(
    "KNOWN_FACES_DIR",
    "/srv/app/face_detection/insightface-master/known_faces",
)

# Anything that's clearly not an image we should bother loading.
_VALID_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

# Match `_1` / `_12` etc. at the end of the stem (case-insensitive)
_TRAILING_INDEX_RE = re.compile(r"_\d+$", re.IGNORECASE)


def _person_name_from_filename(filename: str) -> str:
    """Extract a clean person name from a filename like
       'Aakash Baghel_3.JPG' → 'Aakash Baghel'
       'Anshika.jpg'         → 'Anshika'
    """
    stem = Path(filename).stem
    cleaned = _TRAILING_INDEX_RE.sub("", stem).strip()
    # Title-case fragments that are clearly all-lower (e.g. "ishita Sahu" → "Ishita Sahu")
    parts = [p[:1].upper() + p[1:] if p else p for p in cleaned.split(" ")]
    return " ".join(parts)


def _file_hash_short(path: Path) -> str:
    """First 8 hex chars of sha256 — short enough for the source field, unique
    enough across this dataset (collision risk ≈ 1 in 4 billion)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


def _source_marker(filename: str, content_hash: str) -> str:
    return f"bootstrap:{filename}:{content_hash}"


def _is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in _VALID_EXT and not path.name.startswith(".")


def _iter_images(root: Path) -> Iterable[Path]:
    # Recurse into subfolders too (e.g. known_faces/anilteam/). The person name
    # still comes from the FILENAME, so `anilteam/Pranaya_1.jpg` → "Pranaya".
    yield from (p for p in sorted(root.rglob("*")) if _is_image(p))


# ──────────────────────────────────────────────────────────────────────────────


async def _ensure_default_tenant(session) -> Tenant:
    rows = await session.execute(
        select(Tenant).where(Tenant.name == settings.default_tenant_name)
    )
    tenant = rows.scalar_one_or_none()
    if tenant is None:
        tenant = Tenant(name=settings.default_tenant_name)
        session.add(tenant)
        await session.commit()
        await session.refresh(tenant)
        log.info("created default tenant", name=tenant.name)
    return tenant


async def _ensure_person(session, *, tenant_id, full_name: str) -> Person:
    full_name = full_name.strip()
    rows = await session.execute(
        select(Person).where(Person.tenant_id == tenant_id, Person.full_name == full_name)
    )
    person = rows.scalar_one_or_none()
    if person is None:
        person = Person(
            tenant_id=tenant_id,
            full_name=full_name,
            role=PersonRole.UNKNOWN,
            external_id=None,
        )
        session.add(person)
        try:
            await session.commit()
            await session.refresh(person)
        except IntegrityError:
            # Another process raced us — re-fetch.
            await session.rollback()
            rows = await session.execute(
                select(Person).where(Person.tenant_id == tenant_id, Person.full_name == full_name)
            )
            person = rows.scalar_one()
    return person


async def _existing_enrollment(session, *, person_id, source_marker: str) -> FaceEnrollment | None:
    rows = await session.execute(
        select(FaceEnrollment).where(
            FaceEnrollment.person_id == person_id,
            FaceEnrollment.source == source_marker,
        )
        .order_by(FaceEnrollment.created_at.desc())
        .limit(1)
    )
    return rows.scalar_one_or_none()


async def bootstrap_known_faces() -> dict:
    """Enroll every image in $KNOWN_FACES_DIR. Safe to call repeatedly.

    Returns: { dir, total_files, enrolled, repaired_missing_vector,
               skipped_existing, skipped_no_face, skipped_quality, errors }
    """
    root = Path(KNOWN_FACES_DIR)
    if not root.exists() or not root.is_dir():
        log.warning("known_faces bootstrap: directory missing", path=str(root))
        return {"dir": str(root), "total_files": 0, "enrolled": 0,
                "repaired_missing_vector": 0,
                "skipped_existing": 0, "skipped_no_face": 0,
                "skipped_quality": 0, "errors": 0}

    images = list(_iter_images(root))
    log.info("known_faces bootstrap starting",
             path=str(root), count=len(images))

    # Build the enrollment service ONCE — its components are heavy (FaceRuntime
    # warms up an ONNX session). We hold it for the whole import.
    runtime = FaceRuntime.shared()
    recognizer = get_recognizer()
    qdrant = get_qdrant()
    objects = get_object_store()

    # Permissive quality gate for the curated gallery. The default gate is
    # tuned for LIVE camera frames (rejects pose > 45° / blur / dark crops)
    # so it doesn't pollute the gallery with bad detections. But the
    # known_faces folder contains intentionally-curated photos — many have
    # the subject looking slightly off-axis or in soft indoor light. We only
    # require:
    #   - a face was detected at decent confidence
    #   - it's at least 40px wide (the runtime default)
    # Everything else is waived. The downstream matcher uses cosine similarity
    # on embeddings, which handles pose tolerance better than a hard gate.
    quality = FaceQualityGate(
        max_yaw_deg=180.0,
        max_pitch_deg=180.0,
        max_blur_var=0.0,        # already disabled by default; explicit for clarity
    )
    service = EnrollmentService(runtime, recognizer, qdrant, objects, quality)

    stats = {
        "dir": str(root),
        "total_files":             len(images),
        "enrolled":                0,
        "repaired_missing_vector": 0,
        "skipped_existing":        0,
        "skipped_no_face":         0,
        "skipped_quality":         0,
        "errors":                  0,
    }

    async with session_scope() as session:
        tenant = await _ensure_default_tenant(session)

        for idx, image_path in enumerate(images, 1):
            filename = image_path.name
            person_name = _person_name_from_filename(filename)
            if not person_name:
                stats["errors"] += 1
                continue

            try:
                content_hash = _file_hash_short(image_path)
            except OSError as e:
                log.warning("known_faces: read failed", file=filename, error=str(e))
                stats["errors"] += 1
                continue

            marker = _source_marker(filename, content_hash)
            person = await _ensure_person(session, tenant_id=tenant.id, full_name=person_name)

            try:
                with image_path.open("rb") as fh:
                    image_bytes = fh.read()
            except OSError as e:
                log.warning("known_faces: read failed", file=filename, error=str(e))
                stats["errors"] += 1
                continue

            existing = await _existing_enrollment(session, person_id=person.id, source_marker=marker)
            if existing is not None:
                try:
                    if await qdrant.point_exists(existing.qdrant_point_id):
                        stats["skipped_existing"] += 1
                    else:
                        await service.repair_enrollment_vector(
                            session,
                            enrollment=existing,
                            image_bytes=image_bytes,
                        )
                        await session.commit()
                        stats["repaired_missing_vector"] += 1
                    continue
                except InferenceError as e:
                    msg = str(e)
                    if "no face" in msg.lower():
                        stats["skipped_no_face"] += 1
                    else:
                        stats["skipped_quality"] += 1
                    log.info("known_faces: skipped repair",
                             file=filename, person=person_name, reason=msg)
                    await session.rollback()
                    continue
                except Exception as e:
                    stats["errors"] += 1
                    log.warning("known_faces: repair crashed",
                                file=filename, person=person_name, error=str(e))
                    await session.rollback()
                    continue

            try:
                await service.enroll_image(
                    session,
                    person_id=person.id,
                    image_bytes=image_bytes,
                    source=marker,
                )
                await session.commit()
                stats["enrolled"] += 1
            except InferenceError as e:
                # "no face detected" / "face quality rejected" — log + continue
                msg = str(e)
                if "no face" in msg.lower():
                    stats["skipped_no_face"] += 1
                else:
                    stats["skipped_quality"] += 1
                log.info("known_faces: skipped",
                         file=filename, person=person_name, reason=msg)
                await session.rollback()
            except Exception as e:
                stats["errors"] += 1
                log.warning("known_faces: enrollment crashed",
                            file=filename, person=person_name, error=str(e))
                await session.rollback()

            # Progress log every 10 + at end
            if idx % 10 == 0 or idx == len(images):
                log.info("known_faces progress",
                         processed=idx, total=len(images), **stats)

    log.info("known_faces bootstrap complete", **stats)
    return stats


def schedule_bootstrap() -> asyncio.Task:
    """Schedule bootstrap as a background task so it doesn't block boot.
    The first inference request may race with enrollment — that's fine,
    new vectors become searchable in Qdrant within milliseconds of upsert."""
    return asyncio.create_task(bootstrap_known_faces(), name="known-faces-bootstrap")
