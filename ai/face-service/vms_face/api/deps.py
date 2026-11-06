from __future__ import annotations

import uuid
from typing import AsyncIterator

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.config import settings
from vms_face.core.security import (
    AuthError,
    Principal,
    decode_token,
    dev_bypass_allowed,
    jwt_configured,
)
from vms_face.domain.models import Tenant
from vms_face.infra.detection_state import StatePublisher, get_state_publisher
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import ObjectStore, get_object_store
from vms_face.infra.postgres import fastapi_session, session_scope
from vms_face.infra.qdrant import (
    QdrantStore,
    get_qdrant_appearance,
    get_qdrant_enrolled,
)
from vms_face.infra.recognizers import Recognizer, get_recognizer
from vms_face.infra.redis_bus import RedisBus, get_bus
from vms_face.services.enrollment import EnrollmentService
from vms_face.services.face_matcher import FaceMatcher
from vms_face.services.face_quality import FaceQualityGate


async def db_session() -> AsyncIterator[AsyncSession]:
    async for s in fastapi_session():
        yield s


def qdrant_enrolled() -> QdrantStore:
    return get_qdrant_enrolled()


def qdrant_appearance() -> QdrantStore | None:
    if not settings.qdrant_appearance_enabled:
        return None
    return get_qdrant_appearance()


# Backwards-compat alias used by existing routes
def qdrant() -> QdrantStore:
    return get_qdrant_enrolled()


def bus() -> RedisBus:
    return get_bus()


def objects() -> ObjectStore:
    return get_object_store()


def runtime() -> FaceRuntime:
    return FaceRuntime.shared()


def recognizer() -> Recognizer:
    return get_recognizer()


def quality_gate() -> FaceQualityGate:
    return FaceQualityGate()


def state_publisher() -> StatePublisher:
    return get_state_publisher()


def matcher(
    enrolled: QdrantStore = Depends(qdrant_enrolled),
    appearance: QdrantStore | None = Depends(qdrant_appearance),
    rec: Recognizer = Depends(recognizer),
) -> FaceMatcher:
    return FaceMatcher(enrolled, appearance, recognizer_name=rec.name)


def enrollment(
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    q: QdrantStore = Depends(qdrant_enrolled),
    obj: ObjectStore = Depends(objects),
    qg: FaceQualityGate = Depends(quality_gate),
) -> EnrollmentService:
    return EnrollmentService(rt, rec, q, obj, qg)


_BEARER = "bearer "


async def _resolve_default_tenant() -> uuid.UUID:
    """Look up (or create) the default tenant. Used only by dev-bypass mode
    so the API behaves like the old anonymous setup."""
    async with session_scope() as session:
        row = await session.execute(
            select(Tenant).where(Tenant.name == settings.default_tenant_name)
        )
        tenant = row.scalar_one_or_none()
        if tenant is None:
            tenant = Tenant(name=settings.default_tenant_name)
            session.add(tenant)
            await session.flush()
        return tenant.id


def _principal_from_authorization(authorization: str | None) -> Principal | None:
    if not authorization:
        return None
    head, _, value = authorization.partition(" ")
    if head.lower() != _BEARER.strip() or not value:
        return None
    try:
        return decode_token(value.strip())
    except AuthError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {e}")


async def current_principal(
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> Principal:
    """Authenticated principal for protected routes. Raises 401 unless either
      (a) the request carries a valid Bearer JWT, or
      (b) dev_bypass_allowed() is True (VMS_ENV=dev + opt-in flag), in which
          case we synthesize a Principal bound to the default tenant.
    Never returns an unauthenticated principal in stage/prod."""
    p = _principal_from_authorization(authorization)
    if p is not None:
        return p

    if dev_bypass_allowed():
        # Synthesize a default-tenant principal so legacy callers can keep
        # working while the front-end rolls out. This branch is unreachable
        # in any env != "dev".
        tid = await _resolve_default_tenant()
        return Principal(subject="dev-bypass", tenant_id=tid, role="operator")

    if not jwt_configured():
        # Misconfiguration: prod with no secret. Fail closed.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "auth is not configured (VMS_JWT_SECRET unset)",
        )
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing or invalid Authorization header")


def current_tenant_id(p: Principal = Depends(current_principal)) -> uuid.UUID:
    """Tenant scope of the current request — derived from the JWT claim, not
    a query string. Routes that used `tenant_id: uuid.UUID = Query(...)` should
    switch to `tenant_id: uuid.UUID = Depends(current_tenant_id)`."""
    return p.tenant_id


def require_admin(p: Principal = Depends(current_principal)) -> Principal:
    if not p.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin role required")
    return p


def operator_id(p: Principal = Depends(current_principal)) -> str:
    """Identity for DPDP audit logging. Now sourced from the verified JWT
    `sub` claim, not an operator-supplied header. Older callers that depended
    on this dep keep working with no signature change."""
    return p.subject


def legacy_api_key_ok(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> bool:
    """Gate for the AiFeed compat router.

    Three states:
      1. `LEGACY_API_KEY` is set + caller sends matching `X-API-Key` → allow.
      2. `dev_bypass_allowed()` (VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true) → allow
         without a key. This is the local-dev path where the AiFeed.jsx
         frontend talks straight to the API without minting tokens.
      3. Anything else → 404 if the key is unset, 401 if the caller's key is
         wrong. Production deploys MUST set LEGACY_API_KEY; otherwise the
         legacy router stays disabled."""
    if dev_bypass_allowed():
        # Dev escape hatch — explicit opt-in via VMS_JWT_DEV_BYPASS=true.
        # The startup banner in api/main.py warns loudly when this is on.
        return True
    expected = (settings.legacy_api_key or "").strip()
    if not expected:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "legacy router is disabled — set LEGACY_API_KEY in prod, or "
            "VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true for local dev",
        )
    if not x_api_key or x_api_key.strip() != expected:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid X-API-Key")
    return True
