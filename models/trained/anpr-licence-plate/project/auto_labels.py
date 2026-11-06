"""
auto_labels.py — ask the AI to label its own strongest reads.

    POST /anpr/labels/auto   (trinetra-ai; see api/routes/anpr.py)
        confirmed · real · unlabelled · last 7 days · conf ≥ 0.9 · frames ≥ 6
        · agreement ≥ 0.95 · both readers agreed · not likely_misread
        · strict-format plate · no human 'wrong' label on that plate anywhere
        → anpr_labels rows  verdict=correct  source=auto  weight=0.5
          (≤ 30 per camera per day, one per plate per camera-day)

Officers give ~15 labels a week and the trainer needs 40 to start; these
half-weight labels get the loop going and can never out-vote an officer
(an officer's click on the same read replaces the auto row).

How it reaches the AI — the trainer talks to the backend with the officer
login it already has (auto_retrain.py); the backend then forwards to the AI
with a short HS256 JWT it mints per call (trinetra-backend/src/utils/aiTenant.js:
tid = uuid5(NAMESPACE, "trinetra-org:<org root user id>")). There is no
backend proxy route for /labels/auto, so this script tries the backend path
first (works the day a proxy is added) and otherwise mints the very same
token itself and calls the AI directly. The signing secret is the AI's
VMS_JWT_SECRET: env ANPR_AI_JWT_SECRET / VMS_JWT_SECRET, else the compose
dev default — set the env in production.

    python auto_labels.py                  # label, print a one-line summary
    python auto_labels.py --dry-run --json # count only, full JSON
Called by auto_retrain.py at the start of every cycle (env ANPR_AUTO_LABELS=1).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid

import requests

BACKEND = os.getenv("ANPR_BACKEND_URL", "http://trinetra-backend:5000").rstrip("/")
AI_URL = os.getenv("ANPR_AI_URL", "http://trinetra-ai:8001").rstrip("/")
EMAIL = os.getenv("ANPR_EMAIL", "<redacted>")
PASSWORD = os.getenv("ANPR_PASSWORD", "<redacted>")
# must equal trinetra-ai's VMS_JWT_SECRET (docker-compose.yml: both default to this dev value)
AI_JWT_SECRET = (
    os.getenv("ANPR_AI_JWT_SECRET")
    or os.getenv("VMS_JWT_SECRET")
    or "dev-only-secret-not-for-production-use-xxxx"
)
AI_JWT_ISSUER = os.getenv("ANPR_AI_JWT_ISSUER", "trinetra-vms")
AI_JWT_AUDIENCE = os.getenv("ANPR_AI_JWT_AUDIENCE", "trinetra-vms")
# fixed in trinetra-backend/src/utils/aiTenant.js — never change
AI_TENANT_NAMESPACE = uuid.UUID("6f9a1c2e-1b3d-5e7f-8a9b-0c1d2e3f4a5b")
DAYS = int(os.getenv("ANPR_AUTO_LABEL_DAYS", "7"))
PER_CAM_DAY = int(os.getenv("ANPR_AUTO_LABELS_PER_CAM_DAY", "30"))
# the endpoint's own default is 6; the trainer may pass a lower floor (≥ 2) via env
MIN_FRAMES = int(os.getenv("ANPR_AUTO_LABEL_MIN_FRAMES", "0")) or None


def login(
    backend: str = BACKEND, email: str = EMAIL, password: str = PASSWORD, tries: int = 4
) -> tuple[str, dict]:
    """Officer login → (backend JWT, user). Two logins inside a second can
    draw a 409 / 429 from the backend, so back off and retry a few times."""
    last: Exception | None = None
    for i in range(tries):
        r = requests.post(
            f"{backend}/api/auth/login", json={"email": email, "password": password}, timeout=20
        )
        if r.status_code in (409, 429) and i < tries - 1:
            time.sleep(2.0 * (i + 1))
            last = RuntimeError(f"login {r.status_code}: {r.text[:120]}")
            continue
        r.raise_for_status()
        j = r.json()
        return j["token"], (j.get("user") or {})
    raise last or RuntimeError("login failed")


def tenant_for(user: dict) -> uuid.UUID:
    """The org tenant the backend scopes this user's AI calls to."""
    root = user.get("parentUserId") or user.get("id")
    if not root:
        raise RuntimeError("login response carries no user id — cannot derive the AI tenant")
    return uuid.uuid5(AI_TENANT_NAMESPACE, f"trinetra-org:{root}")


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def mint_ai_token(user: dict, ttl_sec: int = 600, secret: str = AI_JWT_SECRET) -> str:
    """The token trinetra-backend/src/utils/aiTenant.js mints — same claims,
    same secret — done with hmac so the trainer image needs no PyJWT."""
    now = int(time.time())
    claims = {
        "iss": AI_JWT_ISSUER,
        "aud": AI_JWT_AUDIENCE,
        "sub": str(user.get("id") or "anpr-trainer"),
        "tid": str(tenant_for(user)),
        "role": "admin" if str(user.get("role") or "").lower() == "admin" else "operator",
        "scopes": ["persons:write", "persons:read", "events:read"],
        "iat": now,
        "exp": now + max(60, ttl_sec),
    }
    head = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64url(json.dumps(claims, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64url(sig)}"


def run(
    days: int = DAYS,
    per_camera_day: int = PER_CAM_DAY,
    dry_run: bool = False,
    backend: str = BACKEND,
    ai_url: str = AI_URL,
    min_frames: int | None = MIN_FRAMES,
    token: str | None = None,
    user: dict | None = None,
) -> dict:
    """POST /anpr/labels/auto. Pass `token` + `user` from an existing login
    (auto_retrain.py does) to avoid a second login in the same second."""
    if not token or not user:
        token, user = login(backend)
    tok = token
    params = {"days": days, "per_camera_day": per_camera_day, "dry_run": 1 if dry_run else 0}
    if min_frames:
        params["min_frames"] = int(min_frames)
    # 1. through the backend (the day a /api/ai/anpr/labels/auto proxy exists)
    r = requests.post(
        f"{backend}/api/ai/anpr/labels/auto",
        params=params,
        headers={"Authorization": f"Bearer {tok}"},
        timeout=180,
    )
    if r.status_code == 200:
        out = r.json()
        out["via"] = "backend"
        return out
    if r.status_code not in (404, 405, 501):
        r.raise_for_status()
    # 2. the AI directly, with the token the backend would have minted
    r = requests.post(
        f"{ai_url}/anpr/labels/auto",
        params=params,
        headers={
            "Authorization": f"Bearer {mint_ai_token(user)}",
            "X-Operator-Id": f"anpr-trainer:{user.get('id', '')}",
        },
        timeout=180,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"AI {r.status_code} from POST /anpr/labels/auto: {r.text[:300]}")
    out = r.json()
    out["via"] = "ai"
    return out


def summary(res: dict) -> str:
    t = res.get("totals") or {}
    cams = res.get("per_camera") or {}
    key = "chosen" if res.get("dry_run") else "inserted"
    top = sorted(((k, v.get(key, 0)) for k, v in cams.items()), key=lambda kv: -kv[1])[:6]
    cams_s = ", ".join(f"{k} {n}" for k, n in top) or "none"
    verb = "would insert" if res.get("dry_run") else "inserted"
    sk = t.get("skipped") or {}
    sk_s = " ".join(f"{k}={v}" for k, v in sk.items() if v)
    return (
        f"[auto-labels] {verb} {t.get('inserted' if not res.get('dry_run') else 'chosen', 0)} "
        f"(qualified {t.get('qualified', 0)} of {t.get('scanned', 0)} scanned, {res.get('days')} d, "
        f"≤{res.get('per_camera_day')}/cam/day, via {res.get('via')}) — {cams_s}"
        + (f" — skipped: {sk_s}" if sk_s else "")
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--backend", default=BACKEND)
    ap.add_argument("--ai", default=AI_URL, help="AI base URL for the direct path")
    ap.add_argument("--days", type=int, default=DAYS)
    ap.add_argument("--per-camera-day", type=int, default=PER_CAM_DAY)
    ap.add_argument(
        "--min-frames", type=int, default=MIN_FRAMES, help="meta.frames floor (endpoint default 6; ≥ 2)"
    )
    ap.add_argument("--dry-run", action="store_true", help="count only; insert nothing")
    ap.add_argument("--json", action="store_true", help="print the full response")
    a = ap.parse_args()
    try:
        res = run(a.days, a.per_camera_day, a.dry_run, a.backend.rstrip("/"), a.ai.rstrip("/"), a.min_frames)
    except Exception as e:  # noqa: BLE001
        print(f"[auto-labels] FAILED: {e}", flush=True)
        return 1
    print(summary(res), flush=True)
    if a.json:
        print(json.dumps(res, indent=1), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
