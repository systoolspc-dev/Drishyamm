#!/bin/sh
# Healthy = the peer's latest handshake is younger than HEALTH_MAX_AGE (default 180 s).
max=${HEALTH_MAX_AGE:-180}
ts=$(wg show wg0 latest-handshakes 2>/dev/null | awk 'NR==1 {print $2}')
[ -n "$ts" ] && [ "$ts" -gt 0 ] || { echo "no handshake yet"; exit 1; }
age=$(( $(date +%s) - ts ))
if [ "$age" -lt "$max" ]; then
  echo "handshake ${age}s ago"
  exit 0
fi
echo "handshake stale: ${age}s ago"
exit 1
