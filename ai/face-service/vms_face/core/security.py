"""JWT auth primitives.

A `Principal` is the authenticated identity behind a request. The HTTP layer
extracts it from `Authorization: Bearer <jwt>`, the audit logger records it,
and routes derive their tenant scope from `principal.tenant_id` — never from
a query string.

Token format (HS256):

    {
        "iss": settings.vms_jwt_issuer,
        "aud": settings.vms_jwt_audience,
        "sub": "<operator id>",          // user id, service account, etc.
        "tid": "<tenant uuid>",          // REQUIRED — tenant scope of this token
        "role": "admin" | "operator" | ... ,
        "scopes": ["events:read", "persons:write", ...],
        "iat": <unix>,
        "exp": <unix>,
    }

Issuance is out-of-scope here — an upstream identity service signs tokens with
the same shared secret. We provide an `issue_token()` helper for tests and
local tooling; in production an external system mints tokens.
"""
from __future__ import annotations

import datetime as dt
import time
import uuid
from dataclasses import dataclass, field

import jwt
from jwt import InvalidTokenError

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)


class AuthError(Exception):
    """Raised by decode_token / require_principal on any auth failure."""


@dataclass(slots=True, frozen=True)
class Principal:
    subject: str
    tenant_id: uuid.UUID
    role: str = "operator"
    scopes: tuple[str, ...] = field(default_factory=tuple)
    raw: dict = field(default_factory=dict)

    @property
    def is_admin(self) -> bool:
        return self.role.lower() == "admin"

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes


def _resolve_secret() -> str | None:
    """Return the configured signing secret, or None if it's effectively
    unset. We treat short secrets as 'unset' to prevent foot-gun deploys with
    a 4-character placeholder."""
    secret = (settings.vms_jwt_secret or "").strip()
    if len(secret) < 32:
        return None
    return secret


def jwt_configured() -> bool:
    """True iff a usable JWT secret is configured."""
    return _resolve_secret() is not None


def issue_token(
    *,
    subject: str,
    tenant_id: uuid.UUID,
    role: str = "operator",
    scopes: tuple[str, ...] = (),
    ttl_sec: int = 3600,
    extra_claims: dict | None = None,
) -> str:
    """Mint a token. Used by tests, local tooling, and the bootstrap CLI.
    Production token issuance lives in the identity service, not here."""
    secret = _resolve_secret()
    if secret is None:
        raise AuthError("VMS_JWT_SECRET is unset or too short (need >= 32 chars)")
    now = int(time.time())
    claims: dict = {
        "iss": settings.vms_jwt_issuer,
        "aud": settings.vms_jwt_audience,
        "sub": subject,
        "tid": str(tenant_id),
        "role": role,
        "scopes": list(scopes),
        "iat": now,
        "exp": now + max(60, int(ttl_sec)),
    }
    if extra_claims:
        # Don't let extra_claims silently overwrite the standard ones.
        for k, v in extra_claims.items():
            claims.setdefault(k, v)
    return jwt.encode(claims, secret, algorithm=settings.vms_jwt_algorithm)


def decode_token(token: str) -> Principal:
    """Validate signature, issuer, audience, and exp. Returns a Principal or
    raises AuthError. Never returns a partial principal."""
    secret = _resolve_secret()
    if secret is None:
        raise AuthError("JWT verification not configured")
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=[settings.vms_jwt_algorithm],
            audience=settings.vms_jwt_audience,
            issuer=settings.vms_jwt_issuer,
            leeway=dt.timedelta(seconds=int(settings.vms_jwt_leeway_sec)),
            options={"require": ["exp", "iat", "iss", "aud", "sub", "tid"]},
        )
    except InvalidTokenError as e:
        raise AuthError(f"invalid token: {e}") from e

    tid_raw = claims.get("tid")
    try:
        tenant_id = uuid.UUID(str(tid_raw))
    except (TypeError, ValueError) as e:
        raise AuthError(f"token 'tid' is not a UUID: {tid_raw!r}") from e

    return Principal(
        subject=str(claims.get("sub") or "anonymous")[:128],
        tenant_id=tenant_id,
        role=str(claims.get("role") or "operator"),
        scopes=tuple(str(s) for s in (claims.get("scopes") or ())),
        raw=claims,
    )


def dev_bypass_allowed() -> bool:
    """Dev-only escape hatch. Off in any env != 'dev', regardless of the flag."""
    return settings.vms_env == "dev" and bool(settings.vms_jwt_dev_bypass)
