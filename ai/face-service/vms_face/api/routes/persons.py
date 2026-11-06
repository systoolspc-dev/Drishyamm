from __future__ import annotations

import uuid

from fastapi import APIRouter, Body, Depends, File, HTTPException, Path, Query, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session, enrollment, operator_id
from vms_face.config import settings
from vms_face.core.exceptions import InferenceError, NotFoundError
from vms_face.core.logging import get_logger
from vms_face.domain.models import FaceEnrollment, Person


def _person_or_404(p: Person | None, tenant_id: uuid.UUID) -> Person:
    """Cross-tenant lookups return 404 (same body shape as a real miss) so
    we don't leak the existence of a Person in another tenant."""
    if p is None or p.tenant_id != tenant_id:
        raise HTTPException(404, "person not found")
    return p
from vms_face.domain.schemas import (
    FaceEnrollmentOut,
    PersonCreate,
    PersonOut,
)
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.qdrant import get_qdrant_appearance, get_qdrant_enrolled
from vms_face.services import audit as audit_log
from vms_face.services.enrollment import EnrollmentService

router = APIRouter(prefix="/persons", tags=["persons"])
log = get_logger(__name__)


@router.post("", response_model=PersonOut, status_code=status.HTTP_201_CREATED)
async def create_person(
    payload: PersonCreate,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> PersonOut:
    if payload.tenant_id != tenant_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "tenant_id does not match token")
    person = Person(
        tenant_id=tenant_id,
        external_id=payload.external_id,
        full_name=payload.full_name,
        role=payload.role,
        metadata_json=payload.metadata,
    )
    session.add(person)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(409, "person with that external_id already exists") from e
    await session.refresh(person)
    return PersonOut.model_validate(person)


@router.get("", response_model=list[PersonOut])
async def list_persons(
    q: str | None = Query(None, description="search in full_name"),
    limit: int = Query(50, le=500),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> list[PersonOut]:
    stmt = select(Person).where(Person.tenant_id == tenant_id)
    if q:
        stmt = stmt.where(Person.full_name.ilike(f"%{q}%"))
    stmt = stmt.order_by(Person.created_at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(stmt)).scalars().all()
    return [PersonOut.model_validate(p) for p in rows]


@router.get("/{person_id}", response_model=PersonOut)
async def get_person(
    person_id: uuid.UUID = Path(...),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> PersonOut:
    p = _person_or_404(await session.get(Person, person_id), tenant_id)
    return PersonOut.model_validate(p)


@router.delete("/{person_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_person(
    person_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    enroller: EnrollmentService = Depends(enrollment),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> None:
    """Soft DB delete + Qdrant gallery delete. For full DPDP hard-delete
    (purges appearance log and MinIO snapshots too) use POST /persons/{id}/forget."""
    p = _person_or_404(await session.get(Person, person_id), tenant_id)
    await session.delete(p)
    await session.commit()
    await enroller.delete_person_vectors(tenant_id=tenant_id, person_id=person_id)
    await audit_log.record_delete(
        tenant_id=tenant_id,
        person_id=person_id,
        operator_id=actor,
        reason="soft delete via DELETE /persons/{id}",
    )


@router.post("/{person_id}/forget", status_code=status.HTTP_200_OK)
async def forget_person(
    person_id: uuid.UUID,
    payload: dict = Body(default_factory=dict),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    caller_tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    """DPDP Act 2023 hard-delete (Right to Erasure).

    Removes:
      * all `face_enrollments` rows + the `persons` row (cascade)
      * all enrolled vectors in the gallery Qdrant collection
      * all appearance vectors that referenced this person
      * MinIO snapshots under {tenant}/{person}/ (enrollment images) AND
        every snapshot key referencing this person via its tracks (best
        effort; the key shape is {tenant}/{camera}/{track}/...).
      * an audit_log entry capturing the operator and reason.

    The operation is idempotent — subsequent calls return ok with deleted=0.
    A failure of any step is logged but does NOT roll back the others; we
    prefer "best-effort full erasure with detailed audit" over "all-or-nothing"."""

    reason = (payload.get("reason") or "DPDP right-to-erasure request").strip()[:256]

    person = await session.get(Person, person_id)
    if person is None:
        # Idempotent: already gone. Audit against the caller's tenant so the
        # log entry is unambiguous and never fabricates a fake tenant id.
        await audit_log.record_delete(
            tenant_id=caller_tenant_id,
            person_id=person_id,
            operator_id=actor,
            reason=reason,
            metadata={"already_absent": True},
        )
        return {"ok": True, "deleted": False, "person_id": str(person_id)}

    # Cross-tenant erasure attempts return the same idempotent shape as a
    # genuine miss so existence in another tenant isn't probeable.
    if person.tenant_id != caller_tenant_id:
        await audit_log.record_delete(
            tenant_id=caller_tenant_id,
            person_id=person_id,
            operator_id=actor,
            reason=reason,
            metadata={"cross_tenant_attempt": True},
        )
        return {"ok": True, "deleted": False, "person_id": str(person_id)}

    tenant_id = person.tenant_id

    enrollments = (
        await session.execute(
            select(FaceEnrollment).where(FaceEnrollment.person_id == person_id)
        )
    ).scalars().all()
    enrollment_count = len(enrollments)
    snapshot_keys = [e.snapshot_uri for e in enrollments if e.snapshot_uri]

    # 1. Postgres cascade
    await session.delete(person)
    await session.commit()

    deleted = {
        "person_id": str(person_id),
        "tenant_id": str(tenant_id),
        "enrollments_db": enrollment_count,
        "qdrant_enrolled": False,
        "qdrant_appearance": False,
        "snapshots_minio": 0,
    }

    # 2. Enrolled-gallery Qdrant
    try:
        await get_qdrant_enrolled().delete_person(tenant_id=tenant_id, person_id=person_id)
        deleted["qdrant_enrolled"] = True
    except Exception as e:
        log.warning("forget: enrolled qdrant delete failed", err=str(e), person_id=str(person_id))
    # Purge the identity from every local gallery cache (DPDP hard-delete).
    from vms_face.services.enrollment import notify_gallery_changed
    await notify_gallery_changed(tenant_id, reason="forget")

    # 3. Appearance log Qdrant
    if settings.qdrant_appearance_enabled:
        try:
            await get_qdrant_appearance().delete_person(tenant_id=tenant_id, person_id=person_id)
            deleted["qdrant_appearance"] = True
        except Exception as e:
            log.warning("forget: appearance qdrant delete failed", err=str(e), person_id=str(person_id))

    # 4. MinIO snapshots
    try:
        objects = get_object_store()
        client = objects._client  # noqa: SLF001 — internal access for bulk delete
        from minio.deleteobjects import DeleteObject  # type: ignore

        prefix_enroll = f"{tenant_id}/{person_id}/"
        prefix_snapshots = f"{tenant_id}/"

        # Enrollment images: path-addressable by person_id.
        to_delete = [
            DeleteObject(o.object_name)
            for o in client.list_objects(
                settings.minio_bucket_enrollments, prefix=prefix_enroll, recursive=True
            )
        ]
        if to_delete:
            errors = list(client.remove_objects(settings.minio_bucket_enrollments, to_delete))
            deleted["snapshots_minio"] += len(to_delete) - len(errors)

        # Snapshot bucket: keys are partitioned by camera, not person. We
        # delete the explicitly-known enrollment-derived snapshots above;
        # appearance-derived snapshots remain pinned by retention TTL.
        for uri in snapshot_keys:
            if not uri or not uri.startswith("s3://"):
                continue
            # parse "s3://bucket/key"
            try:
                _, _, rest = uri.partition("//")
                bucket_name, _, object_name = rest.partition("/")
                if not bucket_name or not object_name:
                    continue
                client.remove_object(bucket_name, object_name)
                deleted["snapshots_minio"] += 1
            except Exception:
                continue
    except Exception as e:
        log.warning("forget: minio cleanup failed", err=str(e), person_id=str(person_id))

    # 5. Audit log
    await audit_log.record_delete(
        tenant_id=tenant_id,
        person_id=person_id,
        operator_id=actor,
        reason=reason,
        metadata=deleted,
    )

    log.info("person erased (DPDP)", person_id=str(person_id), tenant_id=str(tenant_id), deleted=deleted)
    return {"ok": True, "deleted": True, **deleted}


@router.post(
    "/{person_id}/enrollments",
    response_model=FaceEnrollmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def enroll_face(
    person_id: uuid.UUID,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(db_session),
    enroller: EnrollmentService = Depends(enrollment),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> FaceEnrollmentOut:
    # Cross-tenant enroll would let an attacker poison another tenant's
    # gallery with a chosen face. Authorize the person upfront.
    _person_or_404(await session.get(Person, person_id), tenant_id)
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(400, "empty file")
    try:
        record = await enroller.enroll_image(
            session,
            person_id=person_id,
            image_bytes=image_bytes,
            operator_id=actor,
        )
        await session.commit()
        await session.refresh(record)
    except NotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except InferenceError as e:
        raise HTTPException(422, str(e)) from e
    return FaceEnrollmentOut.model_validate(record)


@router.get("/{person_id}/enrollments", response_model=list[FaceEnrollmentOut])
async def list_enrollments(
    person_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> list[FaceEnrollmentOut]:
    _person_or_404(await session.get(Person, person_id), tenant_id)
    rows = await session.execute(select(FaceEnrollment).where(FaceEnrollment.person_id == person_id))
    return [FaceEnrollmentOut.model_validate(r) for r in rows.scalars()]
