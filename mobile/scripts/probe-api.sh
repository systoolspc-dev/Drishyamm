#!/usr/bin/env bash
#
# API surface discovery — the Sprint 3 gate in docs/phase-1-plan.md.
#
#   bash scripts/probe-api.sh [base-url]
#   bash scripts/probe-api.sh http://192.168.1.50:5000/api
#
# READ-ONLY. Sends GET only, never writes, never needs credentials.
#
# The trick: an unauthenticated GET still tells you whether a route EXISTS.
#   401/403  route exists, needs auth
#   405      route exists but is POST/PUT — i.e. a write endpoint
#   400/422  route exists, rejected our empty request
#   404      route genuinely absent
#
# The last section probes four routes we KNOW exist. If those come back 404 or
# 5xx, the whole run is inconclusive — the server is down or the base URL is
# wrong — and nothing above it should be believed. (Cloudflare error 1033 =
# the origin tunnel is down; every route 530s and none of it means anything.)

BASE="${1:-https://drishyamapi.indyatools.com/api}"
echo "Probing $BASE"
echo ""

probe() {
  code=$(curl -s -m 12 -o /dev/null -w "%{http_code}" "$BASE$1" 2>/dev/null)
  case "$code" in
    401|403)     verdict="EXISTS (auth required)" ;;
    405)         verdict="EXISTS (write route)" ;;
    400|422)     verdict="EXISTS (needs params)" ;;
    200|201|204) verdict="EXISTS (public)" ;;
    404)         verdict="--  absent" ;;
    000)         verdict="??  no connection" ;;
    5*)          verdict="??  origin error — see control section" ;;
    *)           verdict="??  HTTP $code" ;;
  esac
  printf "  %-3s  %-40s %s\n" "$code" "$1" "$verdict"
}

section() { echo ""; echo "=== $1 ==="; }

section "AUTH  (T11 Sign Up, Profile, Change Password)"
for p in /auth/login /auth/logout /auth/me /auth/register /auth/refresh-token \
         /auth/forgot-password /auth/reset-password /auth/change-password /auth/profile; do probe "$p"; done

section "DEVICES / SITES  (T10 Add Camera)"
for p in /groups /sites /cameras /devices; do probe "$p"; done

section "CAMERA HEALTH  (T13)"
for p in /camera-health /cameras/health /health/cameras /monitors /stats/cameras; do probe "$p"; done

section "MAP / GEO  (T12 — needs lat/lng per site)"
for p in /map /sites/map /locations /geo; do probe "$p"; done

section "REPORTS  (T14)"
for p in /reports /analytics /ai/analytics /ai/summary; do probe "$p"; done

section "USERS & ROLES"
for p in /users /roles /permissions; do probe "$p"; done

section "PTZ  (deferred beyond Phase 1)"
for p in /ptz /stream/ptz /cameras/ptz; do probe "$p"; done

section "CONTROLS — these are known to exist; if they fail, ignore everything above"
for p in /health /ai/events /stream/start/1 /notifications/register; do probe "$p"; done
echo ""
