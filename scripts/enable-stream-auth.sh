#!/usr/bin/env bash
#
# enable-stream-auth.sh — turn ON live-stream media-plane protection (audit H9).
#
# Idempotent + reversible. It only EDITS config (adds STREAM_URL_SECRET, flips the
# nginx auth_request lines, backing up nginx.conf); it does NOT restart services,
# so you stay in control of when + can verify playback. Run from the repo root.
#
# Reverse: remove STREAM_URL_SECRET from smart-cam-backend/.env and restore
# nginx.conf from the .bak this creates.
set -euo pipefail

BACKEND_ENV="${BACKEND_ENV:-smart-cam-backend/.env}"
NGINX_CONF="${NGINX_CONF:-nginx.conf}"

# ── 1. Ensure STREAM_URL_SECRET is set ────────────────────────────────────────
if grep -qE '^STREAM_URL_SECRET=.+' "$BACKEND_ENV" 2>/dev/null; then
  echo "[stream-auth] STREAM_URL_SECRET already set in $BACKEND_ENV"
else
  SECRET="$(openssl rand -base64 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  printf '\n# Live-stream media-plane auth (H9). base64 secret — BACK IT UP.\nSTREAM_URL_SECRET=%s\nSTREAM_URL_TTL_SEC=3600\n' "$SECRET" >> "$BACKEND_ENV"
  echo "[stream-auth] added STREAM_URL_SECRET to $BACKEND_ENV"
fi

# ── 2. Uncomment the nginx auth_request directives (/hls/ + /live/) ────────────
if grep -qE '^[[:space:]]*# auth_request /_stream_auth;' "$NGINX_CONF"; then
  sed -i.bak 's|# auth_request /_stream_auth;|auth_request /_stream_auth;|' "$NGINX_CONF"
  echo "[stream-auth] enabled auth_request in $NGINX_CONF (backup: $NGINX_CONF.bak)"
else
  echo "[stream-auth] auth_request already enabled (or directive lines not found) in $NGINX_CONF"
fi

# ── 3. Operator steps (kept manual so YOU verify) ─────────────────────────────
cat <<'EOF'

[stream-auth] Config updated. Now, with the stack running:
  1. restart the backend so it reads the secret:
       docker compose restart smart-cam-backend
  2. reload nginx:
       nginx -t && nginx -s reload      (or restart your edge/nginx container)
  3. VERIFY:
     - logged-in playback still works (SPA /live and /live-hls),
     - a stream URL opened with NO cookie now returns 401:
         curl -s -o /dev/null -w "%{http_code}\n" "https://<host>/hls/cam_<id>/index.m3u8"
       expect 401 (was 200 = anyone could watch).
  REVERT if playback breaks:
     - remove STREAM_URL_SECRET from smart-cam-backend/.env
     - mv nginx.conf.bak nginx.conf ; nginx -s reload
EOF
