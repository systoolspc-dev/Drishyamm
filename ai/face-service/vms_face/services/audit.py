"""DPDP-compliant audit logging.

Centralizes writes to the `audit_log` table so every biometric operation has
a uniform shape: actor, action, target, reason, metadata, timestamp. The
match worker calls `record_match()` for each 1:N hit; the API persons /
search routes call `record_search()` and `record_delete()` for human-driven
operations. Failure to write the audit log is logged but does NOT abort the
underlying business transaction — we'd rather have a missing audit row than
a half-completed deletion. (Operationally, an audit-log gap is detectable
via metrics; a half-deleted person is not.)
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.core.logging import get_logger
from vms_face.core.metrics import AUDIT_EVENTS
from vms_face.domain.models import AuditLog
from vms_face.infra.postgres import session_scope

log = get_logger(__name__)


async def _persist(
    session: AsyncSession | None,
    *,
    tenant_id: uuid.UUID | None,
    actor: str,
    actor_kind: str,
    action: str,
    target_type: str | None,
    target_id: str | None,
    reason: str | None,
    metadata: dict[str, Any] | None,
) -> None:
    row = AuditLog(
        tenant_id=tenant_id,
        actor=actor[:128],
        actor_kind=actor_kind[:32],
        action=action[:64],
        target_type=target_type[:64] if target_type else None,
        target_id=target_id[:128] if target_id else None,
        reason=reason[:256] if reason else None,
        metadata_json=metadata or {},
    )
    AUDIT_EVENTS.labels(action=action, actor_kind=actor_kind).inc()
    if session is not None:
        session.add(row)
        await session.flush()
        return
    async with session_scope() as own:
        own.add(row)


async def record(
    *,
    actor: str,
    actor_kind: str,
    action: str,
    tenant_id: uuid.UUID | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    reason: str | None = None,
    metadata: dict[str, Any] | None = None,
    session: AsyncSession | None = None,
) -> None:
    try:
        await _persist(
            session,
            tenant_id=tenant_id,
            actor=actor,
            actor_kind=actor_kind,
            action=action,
            target_type=target_type,
            target_id=target_id,
            reason=reason,
            metadata=metadata,
        )
    except Exception as e:
        # Never let audit failures break the user-facing operation. The
        # incident is still observable via the missing AUDIT_EVENTS bump
        # and the warning log.
        log.warning(
            "audit log write failed",
            err=str(e),
            actor=actor,
            action=action,
            target_id=target_id,
        )


async def record_match(
    *,
    tenant_id: uuid.UUID,
    person_id: uuid.UUID,
    similarity: float,
    camera_id: uuid.UUID | None,
    track_id: str | None,
    session: AsyncSession | None = None,
) -> None:
    """Automated 1:N hit. Logged because DPDP requires every binding of
    biometric data to an identity to be auditable. Misses are not logged
    here (volume) — they're already covered by detection_events."""
    await record(
        actor="system:match_worker",
        actor_kind="system",
        action="search_1n",
        tenant_id=tenant_id,
        target_type="person",
        target_id=str(person_id),
        reason="automated match against enrolled gallery",
        metadata={
            "similarity": float(similarity),
            "camera_id": str(camera_id) if camera_id else None,
            "track_id": track_id,
        },
        session=session,
    )


async def record_search(
    *,
    tenant_id: uuid.UUID,
    operator_id: str,
    top_hits: list[dict[str, Any]],
    reason: str | None = None,
    session: AsyncSession | None = None,
) -> None:
    """Human-driven 1:N search. Always logged at 100% sampling."""
    await record(
        actor=f"user:{operator_id}",
        actor_kind="user",
        action="search_1n",
        tenant_id=tenant_id,
        target_type="search",
        target_id=None,
        reason=reason,
        metadata={"top_hits": top_hits[:10]},
        session=session,
    )


async def record_enroll(
    *,
    tenant_id: uuid.UUID,
    person_id: uuid.UUID,
    operator_id: str,
    source: str,
    qdrant_point_id: str | None,
    session: AsyncSession | None = None,
) -> None:
    await record(
        actor=f"user:{operator_id}",
        actor_kind="user",
        action="enroll",
        tenant_id=tenant_id,
        target_type="person",
        target_id=str(person_id),
        reason=f"enroll from {source}",
        metadata={"qdrant_point_id": qdrant_point_id},
        session=session,
    )


async def record_delete(
    *,
    tenant_id: uuid.UUID,
    person_id: uuid.UUID,
    operator_id: str,
    reason: str,
    metadata: dict[str, Any] | None = None,
    session: AsyncSession | None = None,
) -> None:
    await record(
        actor=f"user:{operator_id}",
        actor_kind="user",
        action="delete_person",
        tenant_id=tenant_id,
        target_type="person",
        target_id=str(person_id),
        reason=reason,
        metadata=metadata or {},
        session=session,
    )
