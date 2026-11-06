#!/usr/bin/env bash
#
# Retention / MediaMTX-sync smoke-test pipeline.
#
# Verifies, against the LIVE stack, that recording retention actually works
# end-to-end: backend + auth, group/single/bulk retention, inheritance,
# MediaMTX recordDeleteAfter propagation, drift self-heal (periodic +
# event-triggered), and the validation/auth guards. Restores original state.
#
# Usage:
#   ./scripts/smoke.sh                       # runs inside the backend container
#   SMOKE_CONTAINER=my-backend ./scripts/smoke.sh
#   IN_CONTAINER=1 ./scripts/smoke.sh        # already inside the container
#
# Exit: 0 = all checks passed, 1 = a check failed, 2 = setup/infra error.
set -uo pipefail

CONTAINER="${SMOKE_CONTAINER:-drishyam-backend}"

echo "▶ Retention smoke-test pipeline"

if [ "${IN_CONTAINER:-0}" = "1" ]; then
  node scripts/smoke-retention.js
  exit $?
fi

# Host mode: drive it inside the backend container (has API + MediaMTX + DB reach)
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
  echo "✗ container '${CONTAINER}' is not running (set SMOKE_CONTAINER)"; exit 2
fi
echo "  container: ${CONTAINER}"

docker exec "${CONTAINER}" node scripts/smoke-retention.js
code=$?

if [ "${code}" -eq 0 ]; then echo "✅ smoke pipeline PASSED"; else echo "❌ smoke pipeline FAILED (exit ${code})"; fi
exit "${code}"
