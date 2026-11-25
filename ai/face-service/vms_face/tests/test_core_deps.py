"""Request identity (api/deps.py): where the tenant and the operator come from.

Rules protected here:
  * the tenant of a request is the JWT `tid`, never a query string / header /
    body field the caller controls;
  * the audit identity (`operator_id`) is the JWT `sub`, never a header;
  * no token -> 401 (or 503 when auth is not configured at all), and only
    VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true synthesises a default-tenant
    principal; a *bad* token is a 401 even in dev bypass;
  * require_admin / legacy_api_key_ok gate correctly.

No DB: the dev-bypass default-tenant lookup is patched out.

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_deps -v
"""
from __future__ import annotations

import asyncio
import contextlib
import time
import unittest
import uuid
from unittest import mock

import jwt
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from vms_face.api import deps
from vms_face.config import settings
from vms_face.core.security import Principal, issue_token

SECRET = "k" * 40
TENANT_A = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
TENANT_B = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
DEFAULT_TENANT = uuid.UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")


@contextlib.contextmanager
def override(**kw):
    old = {k: getattr(settings, k) for k in kw}
    for k, v in kw.items():
        setattr(settings, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(settings, k, v)


def auth(env="prod", bypass=False, secret=SECRET, legacy_key=""):
    return override(
        vms_env=env, vms_jwt_dev_bypass=bypass, vms_jwt_secret=secret,
        vms_jwt_algorithm="HS256", vms_jwt_issuer="iss-t", vms_jwt_audience="aud-t",
        vms_jwt_leeway_sec=30, legacy_api_key=legacy_key,
    )


def token(tenant=TENANT_A, sub="alice", role="operator") -> str:
    return issue_token(subject=sub, tenant_id=tenant, role=role)


async def _fake_default_tenant() -> uuid.UUID:
    return DEFAULT_TENANT


def principal(authorization):
    return asyncio.run(deps.current_principal(authorization=authorization))


class CurrentPrincipalTest(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(deps, "_resolve_default_tenant", _fake_default_tenant)
        p.start()
        self.addCleanup(p.stop)

    def test_valid_bearer_gives_the_token_tenant(self):
        with auth():
            p = principal(f"Bearer {token()}")
        self.assertEqual((p.tenant_id, p.subject), (TENANT_A, "alice"))

    def test_scheme_is_case_insensitive(self):
        with auth():
            self.assertEqual(principal(f"bearer {token()}").tenant_id, TENANT_A)
            self.assertEqual(principal(f"BEARER {token()}").tenant_id, TENANT_A)

    def test_missing_header_is_401_in_prod(self):
        with auth():
            with self.assertRaises(HTTPException) as cm:
                principal(None)
        self.assertEqual(cm.exception.status_code, 401)

    def test_non_bearer_scheme_is_treated_as_no_token(self):
        with auth():
            for h in ("Basic dXNlcjpwYXNz", "Token abc", "Bearer", "Bearer "):
                with self.subTest(h=h), self.assertRaises(HTTPException) as cm:
                    principal(h)
                self.assertEqual(cm.exception.status_code, 401)

    def test_invalid_token_is_401(self):
        with auth():
            with self.assertRaises(HTTPException) as cm:
                principal("Bearer not.a.jwt")
        self.assertEqual(cm.exception.status_code, 401)

    def test_no_secret_and_no_bypass_fails_closed_with_503(self):
        with auth(secret=""):
            with self.assertRaises(HTTPException) as cm:
                principal(None)
        self.assertEqual(cm.exception.status_code, 503)

    def test_dev_bypass_synthesises_the_default_tenant(self):
        with auth(env="dev", bypass=True):
            p = principal(None)
        self.assertEqual((p.tenant_id, p.subject, p.role), (DEFAULT_TENANT, "dev-bypass", "operator"))
        self.assertFalse(p.is_admin)

    def test_dev_bypass_still_honours_a_real_token(self):
        with auth(env="dev", bypass=True):
            self.assertEqual(principal(f"Bearer {token(TENANT_B)}").tenant_id, TENANT_B)

    def test_bad_token_is_401_even_in_dev_bypass(self):
        with auth(env="dev", bypass=True):
            with self.assertRaises(HTTPException) as cm:
                principal("Bearer forged.token.value")
        self.assertEqual(cm.exception.status_code, 401)

    def test_bypass_flag_is_ignored_outside_dev(self):
        for env in ("stage", "prod"):
            with self.subTest(env=env), auth(env=env, bypass=True):
                with self.assertRaises(HTTPException) as cm:
                    principal(None)
                self.assertEqual(cm.exception.status_code, 401)

    def test_dev_env_without_flag_requires_a_token(self):
        with auth(env="dev", bypass=False):
            with self.assertRaises(HTTPException) as cm:
                principal(None)
        self.assertEqual(cm.exception.status_code, 401)


class DerivedIdentityTest(unittest.TestCase):
    def test_tenant_and_operator_come_from_the_principal(self):
        p = Principal(subject="op-9", tenant_id=TENANT_B)
        self.assertEqual(deps.current_tenant_id(p), TENANT_B)
        self.assertEqual(deps.operator_id(p), "op-9")

    def test_require_admin_rejects_operators_with_403(self):
        with self.assertRaises(HTTPException) as cm:
            deps.require_admin(Principal(subject="s", tenant_id=TENANT_A, role="operator"))
        self.assertEqual(cm.exception.status_code, 403)

    def test_require_admin_accepts_admins(self):
        p = Principal(subject="s", tenant_id=TENANT_A, role="admin")
        self.assertIs(deps.require_admin(p), p)


def _probe_app() -> FastAPI:
    app = FastAPI()

    @app.get("/probe")
    def probe(tenant_id: uuid.UUID = Depends(deps.current_tenant_id), op: str = Depends(deps.operator_id)):
        return {"tenant": str(tenant_id), "operator": op}

    return app


class OverHttpTest(unittest.TestCase):
    """The same rules, through a real FastAPI request (no lifespan)."""

    def setUp(self):
        self.c = TestClient(_probe_app())

    def test_query_string_and_headers_cannot_change_the_tenant(self):
        with auth():
            r = self.c.get(
                "/probe",
                params={"tenant_id": str(TENANT_B), "tid": str(TENANT_B)},
                headers={"Authorization": f"Bearer {token(TENANT_A)}",
                         "X-Tenant-Id": str(TENANT_B), "X-Operator-Id": "mallory"},
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"tenant": str(TENANT_A), "operator": "alice"})

    def test_no_token_is_401_over_http(self):
        with auth():
            self.assertEqual(self.c.get("/probe", params={"tenant_id": str(TENANT_A)}).status_code, 401)

    def test_expired_token_is_401_over_http(self):
        now = int(time.time())
        with auth():
            tok = jwt.encode({"iss": "iss-t", "aud": "aud-t", "sub": "a", "tid": str(TENANT_A),
                              "iat": now - 3600, "exp": now - 600}, SECRET, algorithm="HS256")
            r = self.c.get("/probe", headers={"Authorization": f"Bearer {tok}"})
        self.assertEqual(r.status_code, 401)

    def test_unconfigured_auth_is_503_over_http(self):
        with auth(secret=""):
            self.assertEqual(self.c.get("/probe").status_code, 503)


class LegacyApiKeyTest(unittest.TestCase):
    def test_unset_key_disables_the_router_with_404(self):
        with auth(legacy_key=""):
            with self.assertRaises(HTTPException) as cm:
                deps.legacy_api_key_ok(x_api_key="anything")
        self.assertEqual(cm.exception.status_code, 404)

    def test_wrong_or_missing_key_is_401(self):
        with auth(legacy_key="right-key"):
            for k in (None, "", "wrong", "right-key-but-longer"):
                with self.subTest(k=k), self.assertRaises(HTTPException) as cm:
                    deps.legacy_api_key_ok(x_api_key=k)
                self.assertEqual(cm.exception.status_code, 401)

    def test_matching_key_is_allowed(self):
        with auth(legacy_key="right-key"):
            self.assertTrue(deps.legacy_api_key_ok(x_api_key="right-key"))

    def test_dev_bypass_opens_the_legacy_router_only_in_dev(self):
        with auth(env="dev", bypass=True, legacy_key=""):
            self.assertTrue(deps.legacy_api_key_ok(x_api_key=None))
        with auth(env="prod", bypass=True, legacy_key=""):
            with self.assertRaises(HTTPException):
                deps.legacy_api_key_ok(x_api_key=None)


if __name__ == "__main__":
    unittest.main()
