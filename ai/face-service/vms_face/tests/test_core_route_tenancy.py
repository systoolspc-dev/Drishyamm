"""Codebase-wide tenant guard: every HTTP route is tenant-scoped by the JWT.

test_investigate_search.py checks this for /investigate only. This file
extends the same idea to every router under vms_face/api/routes/, so a new
route (or a new router file) that forgets `Depends(current_tenant_id)` fails
CI instead of shipping a cross-tenant read.

Policy, per route:
  * default: the route's dependency tree must contain `current_tenant_id`
    (which itself only reads the verified JWT `tid`);
  * no route may accept a caller-supplied `tenant_id` / `tid` parameter
    (query, path, header, cookie or form) -- the tenant comes only from the
    token;
  * documented exceptions, each with a reason, live in the allow-lists
    below. A stale allow-list entry (route renamed / removed) also fails,
    so the list cannot silently rot.

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_route_tenancy -v
"""
from __future__ import annotations

import importlib
import inspect
import pathlib
import pkgutil
import re
import unittest

from fastapi import APIRouter
from pydantic import BaseModel
from fastapi.routing import APIRoute, APIWebSocketRoute

from vms_face.api import deps
from vms_face.api import routes as routes_pkg

# ── allow-lists (keep each entry justified) ──────────────────────────────

# Routes that touch no tenant data at all, so a tenant scope is meaningless.
NO_TENANT_DATA: dict[tuple[str, str], str] = {
    ("POST", "/journey/cluster"):
        "pure function of the request body (collapse candidates into sightings); reads nothing stored",
    ("POST", "/api/embed/face"):
        "stateless: embeds the uploaded image and returns it; reads no gallery or event data "
        "(note: also carries no auth at all -- see the test report)",
}

# Create routes whose JSON body carries a tenant_id for backwards compat. It
# is tolerated only when it equals the JWT tenant (403 otherwise); that is
# checked behaviourally in BodyTenantMustMatchTest below.
BODY_TENANT_MUST_MATCH: dict[tuple[str, str], dict] = {
    ("POST", "/cameras"): {"code": "c1", "name": "Gate", "rtsp_url": "rtsp://10.0.0.1/stream"},
    ("POST", "/persons"): {"full_name": "Someone"},
}

# Whole routers guarded by something other than a tenant JWT.
ADMIN_ROUTERS = {"tenants"}          # cross-tenant by design: platform admin only
LEGACY_ROUTERS = {"legacy"}          # shared X-API-Key, default-tenant compat layer
WEBSOCKET_ROUTERS = {"ws"}           # authenticated inside the handler (_ws_authenticate)

# App-level routes defined directly in api/main.py, not in a router.
APP_LEVEL_ALLOWED = {"/healthz", "/metrics", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}

# Prefixes whose routes must ALWAYS be tenant-scoped, no allow-list possible.
ALWAYS_TENANT_PREFIXES = ("/investigate", "/journey/search", "/journey/stitch", "/journey/map",
                          "/journey/snapshot", "/reid", "/persons", "/cameras", "/events", "/search",
                          "/footfall", "/face-learning", "/personnel", "/streams", "/edge")

FORBIDDEN_PARAM_NAMES = {"tid", "x_tid"}   # plus anything containing "tenant"


def _calls(dependant):
    for sub in dependant.dependencies:
        yield sub.call
        yield from _calls(sub)


def _all_params(dependant):
    for group in ("query_params", "path_params", "header_params", "cookie_params", "body_params"):
        for f in getattr(dependant, group, []) or []:
            yield group, f
    for sub in dependant.dependencies:
        yield from _all_params(sub)


def _route_modules() -> dict[str, object]:
    out = {}
    for info in pkgutil.iter_modules(routes_pkg.__path__):
        out[info.name] = importlib.import_module(f"{routes_pkg.__name__}.{info.name}")
    return out


def _routers() -> list[tuple[str, APIRouter]]:
    found = []
    for name, mod in _route_modules().items():
        for attr in vars(mod).values():
            if isinstance(attr, APIRouter):
                found.append((name, attr))
    return found


def _http_routes():
    for mod_name, router in _routers():
        for r in router.routes:
            if isinstance(r, APIRoute):
                for m in sorted(r.methods or ()):
                    yield mod_name, m, r


def _param_names(f) -> set[str]:
    """The parameter's own name/alias, plus the field names of a Pydantic
    body model (a `tenant_id` inside a JSON body is just as caller-controlled)."""
    from pydantic import BaseModel

    names = {str(n).lower().replace("-", "_") for n in (f.name, getattr(f, "alias", None)) if n}
    ann = getattr(getattr(f, "field_info", None), "annotation", None)
    if isinstance(ann, type) and issubclass(ann, BaseModel):
        for fname, finfo in ann.model_fields.items():
            names.add(fname.lower())
            if finfo.alias:
                names.add(finfo.alias.lower().replace("-", "_"))
    return names


def _caller_tenant_params(route) -> list[str]:
    bad = []
    for group, f in _all_params(route.dependant):
        names = _param_names(f)
        if names & FORBIDDEN_PARAM_NAMES or any("tenant" in n for n in names):
            bad.append(f"{group} {f.name}")
    return bad


class _LeakyBody(BaseModel):
    q: str
    tenant_id: str | None = None


class CheckerSelfTest(unittest.TestCase):
    """The guard must actually catch the mistakes it exists for."""

    def setUp(self):
        import uuid

        from fastapi import Depends, Header, Query

        r = APIRouter(prefix="/investigate")

        @r.get("/leaky")
        def leaky(tenant_id: uuid.UUID = Query(...)):
            return {}

        @r.get("/header-leaky")
        def header_leaky(x: str = Header(None, alias="X-Tenant-Id"), t=Depends(deps.current_tenant_id)):
            return {}

        @r.post("/body-leaky")
        def body_leaky(body: _LeakyBody, t=Depends(deps.current_tenant_id)):
            return {}

        @r.get("/ok")
        def ok(t: uuid.UUID = Depends(deps.current_tenant_id)):
            return {}

        self.routes = {x.path: x for x in r.routes}

    def test_a_route_without_the_tenant_dependency_is_detected(self):
        self.assertNotIn(deps.current_tenant_id, set(_calls(self.routes["/investigate/leaky"].dependant)))
        self.assertIn(deps.current_tenant_id, set(_calls(self.routes["/investigate/ok"].dependant)))

    def test_a_caller_supplied_tenant_parameter_is_detected(self):
        self.assertTrue(_caller_tenant_params(self.routes["/investigate/leaky"]))
        self.assertTrue(_caller_tenant_params(self.routes["/investigate/header-leaky"]))
        self.assertTrue(_caller_tenant_params(self.routes["/investigate/body-leaky"]))
        self.assertEqual(_caller_tenant_params(self.routes["/investigate/ok"]), [])


class TenantGuardTest(unittest.TestCase):
    def test_router_discovery_found_the_known_routers(self):
        names = {n for n, _ in _routers()}
        for expected in ("investigate", "journey", "reid", "persons", "cameras", "legacy", "tenants", "ws"):
            self.assertIn(expected, names)
        self.assertGreater(sum(1 for _ in _http_routes()), 50)

    def test_every_tenant_data_route_depends_on_current_tenant_id(self):
        missing = []
        for mod_name, method, r in _http_routes():
            if mod_name in ADMIN_ROUTERS | LEGACY_ROUTERS:
                continue
            if (method, r.path) in NO_TENANT_DATA:
                continue
            if deps.current_tenant_id not in set(_calls(r.dependant)):
                missing.append(f"{method} {r.path} ({mod_name}.py)")
        self.assertEqual(missing, [], "routes without Depends(current_tenant_id)")

    def test_core_prefixes_can_never_be_allow_listed(self):
        for method, path in NO_TENANT_DATA:
            for prefix in ALWAYS_TENANT_PREFIXES:
                self.assertFalse(path.startswith(prefix), f"{method} {path} is under {prefix}")
        for mod_name, method, r in _http_routes():
            if r.path.startswith(ALWAYS_TENANT_PREFIXES):
                with self.subTest(route=f"{method} {r.path}"):
                    self.assertIn(deps.current_tenant_id, set(_calls(r.dependant)))

    def test_investigate_journey_and_reid_routes_are_all_scoped(self):
        seen = {"/investigate": 0, "/journey": 0, "/reid": 0}
        for _, method, r in _http_routes():
            for p in seen:
                if r.path.startswith(p) and (method, r.path) not in NO_TENANT_DATA:
                    seen[p] += 1
                    self.assertIn(deps.current_tenant_id, set(_calls(r.dependant)), f"{method} {r.path}")
        for p, n in seen.items():
            self.assertGreater(n, 0, f"no routes found under {p}")

    def test_no_route_takes_a_tenant_from_the_caller(self):
        bad = []
        for mod_name, method, r in _http_routes():
            if (method, r.path) in BODY_TENANT_MUST_MATCH:
                continue
            bad += [f"{method} {r.path}: {b}" for b in _caller_tenant_params(r)]
        self.assertEqual(bad, [], "routes accepting a caller-supplied tenant")

    def test_allow_list_entries_still_exist(self):
        live = {(m, r.path) for _, m, r in _http_routes()}
        for key in NO_TENANT_DATA:
            self.assertIn(key, live, f"stale allow-list entry {key}")

    def test_allow_listed_routes_do_not_read_tenant_storage(self):
        # An allow-listed route must not open a DB session or a vector store:
        # if it starts doing so it needs a tenant scope and must leave the list.
        storage = {deps.db_session, deps.qdrant_enrolled, deps.qdrant_appearance, deps.qdrant, deps.objects}
        for _, m, r in _http_routes():
            if (m, r.path) in NO_TENANT_DATA:
                self.assertFalse(storage & set(_calls(r.dependant)), f"{m} {r.path} uses storage")

    def test_tenant_admin_router_requires_admin(self):
        for mod_name, method, r in _http_routes():
            if mod_name in ADMIN_ROUTERS:
                self.assertIn(deps.require_admin, set(_calls(r.dependant)), f"{method} {r.path}")

    def test_every_legacy_route_requires_the_legacy_key(self):
        n = 0
        for mod_name, router in _routers():
            if mod_name not in LEGACY_ROUTERS:
                continue
            for r in router.routes:
                if isinstance(r, (APIRoute, APIWebSocketRoute)):
                    n += 1
                    self.assertIn(deps.legacy_api_key_ok, set(_calls(r.dependant)), r.path)
        self.assertGreater(n, 0)

    def test_websocket_handlers_authenticate_before_serving(self):
        from vms_face.api.routes import ws

        n = 0
        for mod_name, router in _routers():
            if mod_name not in WEBSOCKET_ROUTERS:
                continue
            for r in router.routes:
                if isinstance(r, APIWebSocketRoute):
                    n += 1
                    src = inspect.getsource(r.endpoint)
                    self.assertIn("_ws_authenticate(websocket)", src, r.path)
                    self.assertIn("dev_bypass_allowed()", src, r.path)
        self.assertGreater(n, 0)
        self.assertTrue(callable(ws._ws_authenticate))

    def test_no_websocket_outside_the_allowed_routers_is_unguarded(self):
        for mod_name, router in _routers():
            if mod_name in WEBSOCKET_ROUTERS | LEGACY_ROUTERS:
                continue
            for r in router.routes:
                if isinstance(r, APIWebSocketRoute):
                    self.assertIn(deps.current_tenant_id, set(_calls(r.dependant)), r.path)


class BodyTenantMustMatchTest(unittest.TestCase):
    """The two create routes that still accept `tenant_id` in the body must
    refuse a body tenant that differs from the token, before touching the DB."""

    def _client(self, tenant):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from vms_face.api.routes import cameras, persons

        app = FastAPI()
        app.include_router(cameras.router)
        app.include_router(persons.router)

        async def no_db():
            yield None

        app.dependency_overrides[deps.current_tenant_id] = lambda: tenant
        app.dependency_overrides[deps.db_session] = no_db
        return TestClient(app)

    def test_body_tenant_differing_from_token_is_403(self):
        import uuid

        mine, theirs = uuid.uuid4(), uuid.uuid4()
        c = self._client(mine)
        for (method, path), body in BODY_TENANT_MUST_MATCH.items():
            with self.subTest(route=f"{method} {path}"):
                r = c.request(method, path, json={**body, "tenant_id": str(theirs)})
                self.assertEqual(r.status_code, 403, r.text)

    def test_allow_list_routes_exist_and_are_scoped(self):
        live = {(m, r.path): r for _, m, r in _http_routes()}
        for key in BODY_TENANT_MUST_MATCH:
            self.assertIn(key, live)
            self.assertIn(deps.current_tenant_id, set(_calls(live[key].dependant)))


class MountTest(unittest.TestCase):
    """The router-level checks above only mean something if main.py mounts
    routers without adding prefixes or bypassing them."""

    MAIN = pathlib.Path(inspect.getfile(routes_pkg)).parent.parent / "main.py"

    def test_routers_are_mounted_verbatim(self):
        src = self.MAIN.read_text()
        calls = re.findall(r"app\.include_router\(([^)]*)\)", src)
        self.assertTrue(calls)
        for c in calls:
            self.assertRegex(c.strip(), r"^\w+\.router$", f"include_router({c}) adds options")

    def test_every_router_module_is_mounted(self):
        src = self.MAIN.read_text()
        mounted = set(re.findall(r"app\.include_router\((\w+)\.router\)", src))
        modules = {n for n, _ in _routers()}
        self.assertEqual(modules - mounted, set(), "router modules not mounted in main.py")

    def test_app_level_routes_are_only_health_and_metrics(self):
        try:
            from vms_face.api.main import app
        except ImportError as e:  # pragma: no cover - optional heavy dependency missing
            self.skipTest(f"api.main not importable here: {e}")
        router_keys = {r.path for _, router in _routers() for r in router.routes if hasattr(r, "path")}
        extra = set()
        for r in app.routes:
            original = getattr(r, "original_router", None)
            if original is not None:
                self.assertIn(original, [rt for _, rt in _routers()], "app mounts an unknown router")
                continue
            path = getattr(r, "path", None)
            if path is not None and path not in router_keys:
                extra.add(path)
        self.assertEqual(extra - APP_LEVEL_ALLOWED, set(), "unguarded app-level routes")


if __name__ == "__main__":
    unittest.main()
