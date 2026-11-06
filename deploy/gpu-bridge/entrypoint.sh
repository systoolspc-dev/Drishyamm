#!/bin/sh
# Drishyam gpu-bridge entrypoint.
#
# Brings up one WireGuard interface (wg0) with exactly one peer, locks wg0 down
# with iptables (fail closed), then runs plain TCP forwards with socat:
#
#   EXPOSE="port=host:port ..."  listen on the TUNNEL IP, forward to a service on
#                                this side. This is what the peer may reach.
#   REACH="port=host:port ..."   listen on this container's docker-network
#                                addresses (never wg0), forward across the tunnel.
#                                This is what local services use.
#
# Exits non-zero if any forwarder dies, so the restart policy restarts the bridge.
set -eu

log() { echo "[gpu-bridge] $*"; }
die() { echo "[gpu-bridge] FATAL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- config
: "${WG_ADDRESS:?WG_ADDRESS is required (e.g. 10.8.0.1/24)}"
: "${WG_PRIVATE_KEY:?WG_PRIVATE_KEY is required}"
: "${WG_PEER_PUBLIC_KEY:?WG_PEER_PUBLIC_KEY is required}"
: "${WG_PEER_ALLOWED_IPS:?WG_PEER_ALLOWED_IPS is required (e.g. 10.8.0.2/32)}"
WG_LISTEN_PORT=${WG_LISTEN_PORT:-}
WG_PEER_ENDPOINT=${WG_PEER_ENDPOINT:-}
WG_KEEPALIVE=${WG_KEEPALIVE:-25}
WG_MTU=${WG_MTU:-1380}
EXPOSE=${EXPOSE:-}
REACH=${REACH:-}
IF=wg0
WG_IP=${WG_ADDRESS%/*}

# Validate a "port=host:port ..." list; prints nothing, dies on a bad entry.
check_map() {
  for m in $2; do
    case "$m" in
      *=*:*) ;;
      *) die "$1 entry '$m' is not port=host:port" ;;
    esac
    p=${m%%=*}; tp=${m##*:}
    case "$p$tp" in *[!0-9]*|'') die "$1 entry '$m' has a non-numeric port" ;; esac
  done
}
check_map EXPOSE "$EXPOSE"
check_map REACH "$REACH"

# ---------------------------------------------------------------- wireguard
ip link del "$IF" 2>/dev/null || true
ip link add "$IF" type wireguard || die "cannot create a wireguard interface (kernel module? cap_add NET_ADMIN?)"

# Private key: 0600 temp file, removed straight after `wg set`.
umask 077
keyfile=$(mktemp)
printf '%s\n' "$WG_PRIVATE_KEY" > "$keyfile"
set -- wg set "$IF" private-key "$keyfile"
[ -n "$WG_LISTEN_PORT" ] && set -- "$@" listen-port "$WG_LISTEN_PORT"
set -- "$@" peer "$WG_PEER_PUBLIC_KEY" allowed-ips "$WG_PEER_ALLOWED_IPS"
[ -n "$WG_PEER_ENDPOINT" ] && [ "$WG_KEEPALIVE" != "0" ] && set -- "$@" persistent-keepalive "$WG_KEEPALIVE"
if ! "$@"; then rm -f "$keyfile"; die "wg set failed (bad key?)"; fi
rm -f "$keyfile"
unset WG_PRIVATE_KEY
umask 022

ip address add "$WG_ADDRESS" dev "$IF"
ip link set "$IF" mtu "$WG_MTU" up
# Route any allowed range that is not already covered by the interface subnet.
for cidr in $(echo "$WG_PEER_ALLOWED_IPS" | tr ',' ' '); do
  ip route replace "$cidr" dev "$IF" 2>/dev/null || true
done

# The endpoint (the dialling side) may be a hostname that is not resolvable yet:
# retry for up to 60 s, then give up and let the restart policy try again.
set_endpoint() {
  wg set "$IF" peer "$WG_PEER_PUBLIC_KEY" endpoint "$WG_PEER_ENDPOINT" 2>/dev/null
}
if [ -n "$WG_PEER_ENDPOINT" ]; then
  n=0
  until set_endpoint; do
    n=$((n + 1)); [ "$n" -ge 30 ] && die "cannot resolve endpoint $WG_PEER_ENDPOINT"
    sleep 2
  done
  log "peer endpoint $WG_PEER_ENDPOINT, keepalive ${WG_KEEPALIVE}s"
else
  log "listening for the peer on udp/${WG_LISTEN_PORT:-random}"
fi

# ---------------------------------------------------------------- firewall (fail closed)
# Anything arriving on wg0 is dropped unless it is a reply, ICMP, or an EXPOSE port.
iptables -N GPUB_IN 2>/dev/null || iptables -F GPUB_IN
iptables -D INPUT -i "$IF" -j GPUB_IN 2>/dev/null || true
iptables -I INPUT 1 -i "$IF" -j GPUB_IN
iptables -A GPUB_IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A GPUB_IN -p icmp -j ACCEPT
for m in $EXPOSE; do
  iptables -A GPUB_IN -p tcp --dport "${m%%=*}" -j ACCEPT
done
iptables -A GPUB_IN -j DROP
# Never route between the tunnel and the docker network.
iptables -I FORWARD 1 -i "$IF" -j DROP
iptables -I FORWARD 1 -o "$IF" -j DROP
ip6tables -I INPUT 1 -i "$IF" -j DROP 2>/dev/null || true
log "firewall on $IF: allow established, icmp, tcp [$(for m in $EXPOSE; do printf '%s ' "${m%%=*}"; done)] ; drop the rest"

# ---------------------------------------------------------------- forwarders
PIDS=""
SOCAT_OPTS="fork,reuseaddr,keepalive,nodelay"

forward() { # $1 = listen port, $2 = bind address, $3 = target host:port
  # socat opens the target in the forked child, so the hostname resolves per connection.
  socat -d "TCP4-LISTEN:$1,bind=$2,$SOCAT_OPTS" "TCP:$3,keepalive,nodelay" &
  PIDS="$PIDS $!"
  log "forward $2:$1 -> $3 (pid $!)"
}

for m in $EXPOSE; do
  forward "${m%%=*}" "$WG_IP" "${m#*=}"
done

if [ -n "$REACH" ]; then
  # Every IPv4 address of this container except wg0 (docker networks + loopback).
  addrs=$(ip -4 -o address show | awk -v w="$IF" '$2 != w {sub(/\/.*/, "", $4); print $4}')
  [ -n "$addrs" ] || die "no non-tunnel IPv4 address to bind REACH listeners on"
  for m in $REACH; do
    for a in $addrs; do
      forward "${m%%=*}" "$a" "${m#*=}"
    done
  done
fi

shutdown() {
  log "stopping"
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  exit "${1:-0}"
}
trap 'shutdown 0' TERM INT

alive() { # running and not a zombie
  [ -r "/proc/$1/stat" ] || return 1
  st=$(sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f1)
  [ "$st" != "Z" ]
}

handshake_age() {
  ts=$(wg show "$IF" latest-handshakes | awk 'NR==1 {print $2}')
  [ -n "$ts" ] && [ "$ts" -gt 0 ] && echo $(( $(date +%s) - ts )) || echo -1
}

# Heartbeat: one JSON line every HEARTBEAT_SEC into HEARTBEAT_LOG, so there is
# always a record of whether the other machine was reachable. The peer counts
# as up while its last handshake is younger than PEER_DOWN_AFTER (WireGuard
# re-handshakes every ~2 min while traffic or keepalives flow). Up/down
# transitions are also printed to the container log.
HEARTBEAT_LOG=${HEARTBEAT_LOG:-/var/log/gpu-bridge/heartbeat.log}
HEARTBEAT_SEC=${HEARTBEAT_SEC:-30}
PEER_DOWN_AFTER=${PEER_DOWN_AFTER:-180}
NODE_NAME=${NODE_NAME:-$(hostname)}
PEER_NAME=${PEER_NAME:-peer}
HB_MAX_BYTES=5242880
mkdir -p "$(dirname "$HEARTBEAT_LOG")" 2>/dev/null || true
peer_state=unknown

rotate_heartbeat() {
  [ -f "$HEARTBEAT_LOG" ] || return 0
  [ "$(wc -c < "$HEARTBEAT_LOG")" -lt "$HB_MAX_BYTES" ] && return 0
  for i in 4 3 2 1; do
    [ -f "$HEARTBEAT_LOG.$i" ] && mv -f "$HEARTBEAT_LOG.$i" "$HEARTBEAT_LOG.$((i + 1))"
  done
  mv -f "$HEARTBEAT_LOG" "$HEARTBEAT_LOG.1"
}

heartbeat() {
  age=$(handshake_age)
  set -- $(wg show "$IF" transfer | awk 'NR==1 {print $2, $3}')
  rx=${1:-0}; tx=${2:-0}
  if [ "$age" -ge 0 ] && [ "$age" -le "$PEER_DOWN_AFTER" ]; then state=up; else state=down; fi
  if [ "$state" != "$peer_state" ]; then
    if [ "$state" = up ]; then log "PEER UP: $PEER_NAME reachable (handshake ${age}s ago)"
    else log "PEER DOWN: $PEER_NAME unreachable (last handshake: $([ "$age" -ge 0 ] && echo "${age}s ago" || echo never))"; fi
    change=true; peer_state=$state
  else
    change=false
  fi
  rotate_heartbeat
  printf '{"ts":"%s","node":"%s","peer":"%s","state":"%s","changed":%s,"handshake_age_s":%s,"rx_bytes":%s,"tx_bytes":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NODE_NAME" "$PEER_NAME" "$state" "$change" "$age" "$rx" "$tx" \
    >> "$HEARTBEAT_LOG" 2>/dev/null || true
}

log "up: $WG_ADDRESS mtu $WG_MTU, peer $WG_PEER_PUBLIC_KEY ($WG_PEER_ALLOWED_IPS)"
log "heartbeat: every ${HEARTBEAT_SEC}s to $HEARTBEAT_LOG (peer down after ${PEER_DOWN_AFTER}s without a handshake)"
tick=0
hb_every=$(( HEARTBEAT_SEC / 5 )); [ "$hb_every" -lt 1 ] && hb_every=1
while :; do
  for p in $PIDS; do
    if ! alive "$p"; then
      log "forwarder pid $p died; exiting so the bridge restarts"
      shutdown 1
    fi
  done
  tick=$((tick + 1))
  # Every ~30 s: if the handshake is stale and the endpoint is a name, re-resolve it.
  if [ -n "$WG_PEER_ENDPOINT" ] && [ $((tick % 6)) -eq 0 ]; then
    age=$(handshake_age)
    if [ "$age" -lt 0 ] || [ "$age" -gt 135 ]; then
      set_endpoint || log "endpoint re-resolve failed"
    fi
  fi
  [ $((tick % hb_every)) -eq 0 ] && heartbeat
  sleep 5 &
  wait $! || true
done
