#!/bin/bash
# ============================================================================
#  Drishyam SITE RELAY for macOS  -  POC client site
#
#  Runs on a Mac on the SAME network as the NVR. Pulls each camera from the NVR
#  and pushes it OUT to the Drishyam cloud over TLS (rtsps://103.109.7.36:8555).
#  Outbound only: no port forwarding, no static IP, works behind any Wi-Fi router.
#
#  FIRST TIME (in Terminal, in this folder):
#      bash drishyam-mac-relay.sh install
#    -> asks for the NVR password once (stored in the macOS Keychain, never in
#       a file), checks the NVR, finds the working channels, starts streaming,
#       and sets the relay to start again by itself after a restart or login.
#
#  OTHER COMMANDS:
#      bash drishyam-mac-relay.sh test        check NVR + channels, change nothing
#      bash drishyam-mac-relay.sh status      which streams are running
#      bash drishyam-mac-relay.sh logs        last lines of every stream log (password hidden)
#      bash drishyam-mac-relay.sh restart     restart all streams
#      bash drishyam-mac-relay.sh start       open the relay window if it is not running
#
#  The cameras run inside a Terminal window titled "Drishyam relay": macOS only lets
#  Terminal (not background programs) reach devices on the local network. Keep it open
#  (minimised is fine); if it is closed it re-opens by itself within 3 minutes.
#      bash drishyam-mac-relay.sh uninstall   stop everything and remove it
#
#  Needs: macOS 11+, internet upload ~0.5 Mbps per camera (sub stream) or
#  ~2-4 Mbps per camera (main stream), ffmpeg (installed via Homebrew if missing).
# ============================================================================

# ============================ SITE CONFIG ===================================
NVR_IP="192.168.101.2"        # NVR on the local network
NVR_USER="admin"              # NVR login
NVR_PASS="Admin@123"          # NVR password. Leave empty ("") to be asked once and keep it in the Keychain instead.
RTSP_PORT=554                 # NVR RTSP port
MAX_CHANNELS=8                # channels 1..N
SUB_STREAM=0                  # 0 = main stream (this NVR's sub streams never send a usable picture). 1 = sub stream
TRANSCODE=1                   # 1 = re-encode on this Mac (hardware encoder) to clean 720p H.264, key frame every 2 s.
                              #   Needed here: the raw 1440p stream does not survive the upload. 0 = send as-is.
TC_HEIGHT=720                 # picture height after re-encoding
TC_FPS=12                     # frames per second after re-encoding
TC_BITRATE=1200k              # upload per camera after re-encoding (~1.2 Mbps)
CLOUD="103.109.7.36:8555"     # Drishyam cloud relay endpoint (leave as is)
SITE="poc"                    # FIXED for this client: Drishyam is already set up for these names
TOKEN="mt9lc2"                # FIXED for this client: do not change
# ===========================================================================

LABEL="io.drishyam.relay"
ROOT="$HOME/Library/Application Support/DrishyamRelay"
LOGS="$ROOT/logs"
STATE="$ROOT/channels"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
KC_SERVICE="io.drishyam.relay.nvr"

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# run a command with a time limit (macOS has no `timeout`)
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }

# percent-encode for the RTSP URL (passwords with @ : / # % break it otherwise)
urlencode() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

stream_name() { printf 'edge_%s_%s_ch%s' "$SITE" "$TOKEN" "$1"; }
src_url() {
  local ch="$1" pass enc kind
  pass="$(get_pass)"; enc="$(urlencode "$pass")"
  if [ "$SUB_STREAM" = "1" ]; then kind="02"; else kind="01"; fi
  printf 'rtsp://%s:%s@%s:%s/Streaming/Channels/%s%s' "$(urlencode "$NVR_USER")" "$enc" "$NVR_IP" "$RTSP_PORT" "$ch" "$kind"
}
mask() { sed -E 's#(rtsps?://)[^@/ ]+@#\1***@#g'; }

# ---------- password in the macOS Keychain ----------
get_pass() {
  if [ -n "$NVR_PASS" ]; then printf '%s' "$NVR_PASS"; return; fi
  security find-generic-password -s "$KC_SERVICE" -a "$NVR_USER" -w 2>/dev/null
}
ask_pass() {
  if [ -n "$(get_pass)" ]; then return; fi
  local p
  printf "NVR password for user '%s' (typing is hidden): " "$NVR_USER"
  read -r -s p; echo
  [ -n "$p" ] || die "No password entered."
  security add-generic-password -U -s "$KC_SERVICE" -a "$NVR_USER" -w "$p" >/dev/null || die "Could not save the password in the Keychain."
}

# ---------- ffmpeg ----------
find_ffmpeg() {
  local c
  for c in "$(command -v ffmpeg 2>/dev/null)" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
ensure_ffmpeg() {
  FF="$(find_ffmpeg)" && return
  local brew
  brew="$(command -v brew 2>/dev/null || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1)"
  if [ -z "$brew" ]; then
    warn "Homebrew is not installed. Install it first (one time), then run this again:"
    say  '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    exit 1
  fi
  warn "Installing ffmpeg with Homebrew (one time, a few minutes)..."
  "$brew" install ffmpeg || die "ffmpeg install failed."
  FF="$(find_ffmpeg)" || die "ffmpeg not found after install."
}

# ---------- NVR checks ----------
check_nvr() {
  say ""; say "[1/3] Checking the NVR at $NVR_IP ..."
  ping -c 2 -t 3 "$NVR_IP" >/dev/null 2>&1 || nc -z -G 3 "$NVR_IP" 80 >/dev/null 2>&1 \
    || die "NVR $NVR_IP does not answer. Is this Mac on the same Wi-Fi/network as the NVR?"
  nc -z -G 5 "$NVR_IP" "$RTSP_PORT" >/dev/null 2>&1 \
    || die "NVR answers but RTSP port $RTSP_PORT is closed. Turn on RTSP in the NVR network settings."
  ok "      NVR reachable, RTSP port $RTSP_PORT open."
}

probe_channel() {   # prints ok:<codec> | auth | no:<reason>
  local ch="$1" out
  out="$(with_timeout 15 "$FF" -nostdin -hide_banner -rtsp_transport tcp -timeout 8000000 \
          -analyzeduration 2000000 -probesize 1000000 -i "$(src_url "$ch")" -frames:v 1 -f null - 2>&1 | mask)"
  # The URL holds the encoded password (Admin%40123 contains "401"), so it is masked first and
  # only the NVR's real "401 Unauthorized" answer counts as a wrong password.
  if printf '%s' "$out" | grep -q -E 'Server returned 401|401 Unauthorized'; then echo auth; return; fi
  local codec; codec="$(printf '%s' "$out" | grep -o -E 'Video: [a-z0-9]+' | head -1 | awk '{print $2}')"
  if [ -n "$codec" ]; then echo "ok:$codec"; return; fi
  local why; why="$(printf '%s' "$out" | grep -v -E '^[[:space:]]*$' | tail -1 | cut -c1-160)"
  echo "no:${why:-no answer within 15 s}"
}

detect_channels() {
  say ""; say "[2/3] Finding working channels (1..$MAX_CHANNELS) ..."
  local ch r found=""
  for (( ch = 1; ch <= MAX_CHANNELS; ch++ )); do
    r="$(probe_channel "$ch")"
    case "$r" in
      auth) [ -z "$NVR_PASS" ] && security delete-generic-password -s "$KC_SERVICE" -a "$NVR_USER" >/dev/null 2>&1
            die "The NVR rejected user '$NVR_USER' and its password. Check NVR_PASS at the top of this script (do not retry many times: the NVR may lock the account)." ;;
      ok:*) ok "      ch $ch  OK (${r#ok:})"; found="$found $ch" ;;
      *)    warn "      ch $ch  no video  -> ${r#no:}" ;;
    esac
  done
  [ -n "$found" ] || die "No channel returned video."
  mkdir -p "$ROOT"; printf '%s\n' $found > "$STATE"
}

# ---------- Hikvision key-frame request (H.265 cameras send codec setup only on key frames) ----------
kick() {
  local ch="$1" kind; if [ "$SUB_STREAM" = "1" ]; then kind="02"; else kind="01"; fi
  curl -s -o /dev/null --max-time 5 --digest -u "$NVR_USER:$(get_pass)" -X PUT \
    "http://$NVR_IP/ISAPI/Streaming/channels/${ch}${kind}/requestKeyFrame" 2>/dev/null || true
}

# ---------- encoder choice (sets HWDEC + CODEC_ARGS) ----------
# Apple's hardware encoder (VideoToolbox) is in every Mac and in Homebrew's ffmpeg; libx264 is the
# software fallback. A 1-second test encode decides, so a Mac without it still works.
pick_codec() {
  HWDEC=""; CODEC_ARGS="-c copy"
  [ "$TRANSCODE" = "1" ] || return 0
  local g=$(( TC_FPS * 2 )) vf="scale=-2:${TC_HEIGHT},fps=${TC_FPS},format=yuv420p"
  if "$FF" -nostdin -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=12 -t 1 \
       -pix_fmt yuv420p -c:v h264_videotoolbox -f null - >/dev/null 2>&1; then
    HWDEC="-hwaccel videotoolbox"
    CODEC_ARGS="-vf $vf -c:v h264_videotoolbox -realtime 1 -profile:v main -b:v $TC_BITRATE -maxrate $TC_BITRATE -g $g -bf 0"
  else
    CODEC_ARGS="-vf $vf -c:v libx264 -preset veryfast -tune zerolatency -profile:v main -b:v $TC_BITRATE -maxrate $TC_BITRATE -bufsize $TC_BITRATE -g $g -keyint_min $g -bf 0"
  fi
  echo "$(date)  encoder: ${CODEC_ARGS}" >> "$LOGS/relay.log"
}

# ---------- one channel: push forever, back off on fast failures ----------
relay_loop() {
  local ch="$1" name log fails=0 t0 dur wait
  name="$(stream_name "$ch")"; log="$LOGS/$name.log"
  while :; do
    [ -f "$log" ] && [ "$(stat -f%z "$log" 2>/dev/null || echo 0)" -gt 5000000 ] && : > "$log"
    echo "---- start $(date)" >> "$log"
    t0=$(date +%s)
    ( sleep 2; kick "$ch"; sleep 3; kick "$ch"; sleep 4; kick "$ch" ) &
    "$FF" -nostdin -loglevel warning $HWDEC -rtsp_transport tcp -timeout 10000000 \
      -analyzeduration 20000000 -probesize 30000000 -fflags +genpts+discardcorrupt \
      -i "$(src_url "$ch")" $CODEC_ARGS -an \
      -f rtsp -rtsp_transport tcp -tls_verify 0 "rtsps://$CLOUD/$name" 2>&1 | mask >> "$log"
    dur=$(( $(date +%s) - t0 ))
    if [ "$dur" -lt 90 ]; then fails=$((fails + 1)); else fails=0; fi
    [ "$fails" -gt 4 ] && f=4 || f=$fails
    wait=$(( 5 * (1 << f) )); [ "$wait" -gt 60 ] && wait=60
    echo "---- dropped after ${dur}s, retry in ${wait}s $(date)" >> "$log"
    sleep "$wait"
  done
}

# ---------- what launchd runs ----------
run_all() {
  FF="$(find_ffmpeg)" || { echo "ffmpeg missing" >> "$LOGS/relay.log"; exit 1; }
  [ -f "$STATE" ] || { echo "not installed" >> "$LOGS/relay.log"; exit 1; }
  mkdir -p "$LOGS"
  echo "==== relay start $(date)" >> "$LOGS/relay.log"
  pick_codec
  trap 'kill 0' TERM INT HUP        # window closed / uninstall -> stop every stream with us
  printf '\033]0;Drishyam relay - keep this window open\007'
  say "Drishyam relay running ($(wc -l < "$STATE" | tr -d ' ') cameras). Keep this window open; you can minimise it."
  caffeinate -i -s -w $$ &          # keep the Mac awake while the relay runs (on power)
  local ch
  for ch in $(cat "$STATE"); do relay_loop "$ch" & sleep 1; done
  wait
}

# macOS "Local Network" privacy blocks LAN access (192.168.x.x -> "No route to host") for programs
# that launchd starts in the background, and bare command-line tools cannot be granted it. Terminal
# HAS that permission, so the streams run inside a Terminal window; launchd only checks every 3 min
# (and at login) that the window is running, and re-opens it if not.
relay_running() { pgrep -f "drishyam-mac-relay.sh run" >/dev/null 2>&1; }
ensure_running() {
  relay_running && return 0
  echo "$(date)  relay not running - opening it in Terminal" >> "$LOGS/relay.log"
  open -g -a Terminal "$ROOT/start-relay.command"
}

install_agent() {
  mkdir -p "$ROOT" "$LOGS" "$HOME/Library/LaunchAgents"
  # stop anything from an earlier install (incl. the old background version that had no LAN access)
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
  pkill -f "drishyam-mac-relay.sh run" >/dev/null 2>&1
  pkill -f "rtsps://$CLOUD/edge_${SITE}_${TOKEN}_ch" >/dev/null 2>&1
  sleep 2
  cp "$0" "$ROOT/drishyam-mac-relay.sh"; chmod 755 "$ROOT/drishyam-mac-relay.sh"
  cat > "$ROOT/start-relay.command" <<EOF
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec /bin/bash "$ROOT/drishyam-mac-relay.sh" run
EOF
  chmod 755 "$ROOT/start-relay.command"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$ROOT/drishyam-mac-relay.sh</string><string>ensure</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>180</integer>
  <key>StandardOutPath</key><string>$LOGS/launchd.out</string>
  <key>StandardErrorPath</key><string>$LOGS/launchd.err</string>
</dict></plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "Could not register the auto-start check (launchctl)."
  ensure_running
}

show_cameras() {
  say ""; say "================  CAMERAS IN DRISHYAM  ================"
  say "Already set up in Drishyam (host 103.109.7.36, port 8554, no username/password):"
  local ch; for ch in $(cat "$STATE"); do say "  Camera $ch  ->  /$(stream_name "$ch")"; done
}

status() {
  [ -f "$STATE" ] || die "Not installed yet. Run: bash drishyam-mac-relay.sh install"
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && ok "Auto-start check: on" || warn "Auto-start check: NOT on (run install again)"
  relay_running && ok "Relay window: running" || warn "Relay window: NOT running (it re-opens within 3 min, or run: bash $0 start)"
  local ch name n
  for ch in $(cat "$STATE"); do
    name="$(stream_name "$ch")"
    n=$(pgrep -f "rtsps://$CLOUD/$name\$" | wc -l | tr -d ' ')
    if [ "$n" -gt 0 ]; then ok "  ch $ch  RUNNING"; else warn "  ch $ch  DOWN    $(tail -1 "$LOGS/$name.log" 2>/dev/null | mask)"; fi
  done
}

case "${1:-}" in
  install)
    ensure_ffmpeg; ask_pass; check_nvr; detect_channels
    say ""; say "[3/3] Starting the streams and setting them to start by themselves ..."
    install_agent
    say "      A Terminal window titled 'Drishyam relay' is now running the cameras. Keep it open (minimise is fine)."
    sleep 15; status; show_cameras
    say ""
    warn "Keep this Mac switched on, plugged in, and logged in (the relay runs in your user session)."
    warn "Recommended once:  System Settings > Energy (or Battery > Options): 'Prevent automatic sleeping when the"
    warn "display is off' ON, and 'Start up automatically after a power failure' ON. Turn on automatic login if possible."
    ;;
  test)      ensure_ffmpeg; ask_pass; check_nvr; detect_channels; say ""; ok "Test only: nothing was started." ;;
  run)       run_all ;;
  ensure)    mkdir -p "$LOGS"; [ -f "$STATE" ] && ensure_running ;;
  start)     ensure_running && ok "Relay window opened (or already running)." ;;
  status)    status ;;
  logs)      [ -f "$STATE" ] || die "Not installed."; for ch in $(cat "$STATE"); do say ""; say "== camera $ch"; tail -15 "$LOGS/$(stream_name "$ch").log" 2>/dev/null | mask; done ;;
  restart)   pkill -f "drishyam-mac-relay.sh run"; pkill -f "rtsps://$CLOUD/edge_${SITE}_${TOKEN}_ch"; sleep 2; ensure_running && ok "Restarted." ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
    pkill -f "drishyam-mac-relay.sh run" >/dev/null 2>&1
    pkill -f "rtsps://$CLOUD/edge_${SITE}_${TOKEN}_ch" >/dev/null 2>&1
    rm -f "$PLIST"
    security delete-generic-password -s "$KC_SERVICE" -a "$NVR_USER" >/dev/null 2>&1
    ok "Relay stopped and removed (password deleted from the Keychain). Logs kept in: $ROOT"
    ;;
  *) say "Usage: bash drishyam-mac-relay.sh install | test | status | logs | restart | uninstall"; exit 1 ;;
esac
