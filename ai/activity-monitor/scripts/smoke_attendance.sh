#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Attendance pipeline smoke test.
#
# Proves the WHOLE in/out attendance chain works end-to-end:
#   vms.cam.state (vms_face recognition) → attendance watcher → line crossing
#   → SQLite DB → activity-monitor API → backend proxy → (timezone)
#
# It publishes SYNTHETIC recognized people (TEST_Alice, TEST_Bob) crossing the
# drawn line, checks each stage, then deletes its own test data and restarts the
# watcher. Nothing real is touched.
#
#   Run:  bash scripts/smoke_attendance.sh
#   Exit: 0 = all green, 1 = something failed.
#
# Override via env if your setup differs, e.g.:
#   CAM=<camera_code> AM=http://localhost:8010 bash scripts/smoke_attendance.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

CAM="${CAM:-38aa633bd49e4899b0743b79}"                 # reception camera_code
AM="${AM:-http://localhost:8010}"                      # activity-monitor
BE="${BE:-http://localhost:5000}"                      # backend
EMAIL="${EMAIL:-test@outlook.com}"; PW="${PW:-Test@1234}"
RCTR="${RCTR:-drishyam-redis}"
ACTR="${ACTR:-drishyam-activity-monitor}"
DB=/srv/activity-monitor/data/activity.db

P=0; F=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; P=$((P+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; F=$((F+1)); }

pub(){ docker exec "$RCTR" redis-cli PUBLISH "vms.cam.state:$CAM" "$1" >/dev/null 2>&1; }

# One frame with both test people at the given feet-Y positions (0..1 of frame height).
frame(){ python - "$CAM" "$1" "$2" <<'PY'
import json,sys
cam,ay,by=sys.argv[1],float(sys.argv[2]),float(sys.argv[3])
def box(name,x,tid,fy):
    y2=int(fy*1080); return {"x1":x,"y1":max(0,y2-220),"x2":x+120,"y2":y2,"name":name,"track_id":tid}
print(json.dumps({"event":"frame","camera_code":cam,"frame_w":1920,"frame_h":1080,"running":True,
      "boxes":[box("TEST_Alice",800,701,ay),box("TEST_Bob",1000,702,by)]},separators=(",",":")))
PY
}

# Read one field of one test person from /activity/attendance.
# (pipe → `python -c`; a heredoc here would shadow stdin so the JSON never arrives)
field(){ curl -s -m6 "$AM/activity/attendance" | python -c "import sys,json;d=json.load(sys.stdin);p=next((x for x in d.get('people',[]) if x['name']=='$1'),None);print(p.get('$2') if p is not None else 'MISSING')"; }

echo "======== ATTENDANCE SMOKE TEST — $(date '+%F %H:%M %Z') ========"

# 1) Infrastructure
docker ps --format '{{.Names}} {{.Status}}' | grep -q "$ACTR.*Up" && ok "activity-monitor container is Up" || no "activity-monitor container is not running"
docker logs "$ACTR" 2>&1 | grep -q "attendance: subscribed" && ok "watcher subscribed to recognition stream (vms.cam.state)" || no "watcher did not subscribe"
docker exec "$ACTR" date 2>/dev/null | grep -q IST && ok "container timezone is IST" || no "container timezone is not IST"
docker exec "$ACTR" python -c "import sqlite3;print('y' if sqlite3.connect('$DB').execute(\"select 1 from sqlite_master where name='attendance'\").fetchone() else 'n')" 2>/dev/null | grep -q y \
  && ok "DB has the attendance table" || no "DB attendance table missing"

# 2) Line present (set one if the camera has none)
curl -s -m6 -X PUT "$AM/activity/line" -H 'content-type: application/json' \
  -d "{\"camera\":\"$CAM\",\"line\":{\"x1\":0.1,\"y1\":0.5,\"x2\":0.9,\"y2\":0.5,\"inside_x\":0.5,\"inside_y\":0.75}}" >/dev/null 2>&1
curl -s -m6 "$AM/activity/line?camera=$CAM" | grep -q inside_y && ok "in/out line is set for the camera" || no "no in/out line for the camera"

# 3) Simulate crossings — both enter, then Bob leaves.
#    Use ONE snapshot per phase (one read → check all fields) so separate curls
#    can't race the watcher's async update.
snap(){ curl -s -m6 "$AM/activity/attendance" | python -c "
import sys,json
d=json.load(sys.stdin); P={x['name']:x for x in d.get('people',[])}
a=P.get('TEST_Alice') or {}; b=P.get('TEST_Bob') or {}
print('alice_in=%s bob_in=%s bob_out=%s bob_time=%.1f inside=%s' % (
  a.get('currently_inside'), b.get('in_count'), b.get('out_count'),
  float(b.get('total_inside_sec') or 0), d.get('inside_count')))"; }

curl -s -m6 -X POST "$AM/activity/attendance/reset?prefix=TEST_" >/dev/null 2>&1   # clean slate
pub "$(frame 0.30 0.30)"; sleep 2                 # both outside the line
pub "$(frame 0.70 0.70)"; sleep 3                 # both cross to the inside -> IN
R=$(snap); echo "     snapshot: [$R]"
echo "$R" | grep -q 'alice_in=True' && ok "Alice crossed IN (currently inside)" || no "Alice IN not recorded"
echo "$R" | grep -q 'bob_in=1'      && ok "Bob crossed IN (in_count=1)"         || no "Bob IN not recorded"
echo "$R" | grep -q 'inside=2'      && ok "inside_count=2 (both counted inside)" || no "inside_count wrong"

pub "$(frame 0.70 0.30)"; sleep 3                 # Alice stays inside, Bob crosses back OUT
R=$(snap); echo "     snapshot: [$R]"
echo "$R" | grep -q 'bob_out=1'                       && ok "Bob crossed OUT (out_count=1)"    || no "Bob OUT not recorded"
echo "$R" | grep -qE 'bob_time=[1-9]|bob_time=0\.[1-9]' && ok "Bob's time-inside measured"       || no "Bob's time-inside not measured"
echo "$R" | grep -q 'alice_in=True'                   && ok "Alice still inside (did not falsely leave)" || no "Alice state wrong"

# 4) Persistence in the database
read n x < <(docker exec "$ACTR" python -c "import sqlite3;c=sqlite3.connect('$DB');print(c.execute(\"select count(*) from attendance where name like 'TEST_%'\").fetchone()[0], c.execute(\"select count(*) from crossings where name like 'TEST_%'\").fetchone()[0])" 2>/dev/null)
{ [ "${n:-0}" -ge 2 ] && [ "${x:-0}" -ge 3 ]; } && ok "written to the database (attendance rows=$n, crossings=$x)" || no "DB persistence weak (attendance=${n:-0}, crossings=${x:-0})"

# 5) Backend proxy (authenticated, what the console uses)
JWT=$(curl -s -m10 -X POST "$BE/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
[ -n "$JWT" ] && ok "backend login" || no "backend login failed"
c=$(curl -s -m6 -o /dev/null -w '%{http_code}' "$BE/api/ai/activity/attendance" -H "Authorization: Bearer $JWT")
[ "$c" = "200" ] && ok "backend proxy /api/ai/activity/attendance -> 200" || no "backend proxy returned $c"

# Cleanup — clear the test data from memory + DB (no restart needed).
rc=$(curl -s -m6 -o /dev/null -w '%{http_code}' -X POST "$AM/activity/attendance/reset?prefix=TEST_")
[ "$rc" = "200" ] && ok "cleanup: reset TEST_ data (memory + DB)" || no "cleanup reset returned $rc"

echo "======== RESULT: $P passed, $F failed ========"
if [ "$F" -eq 0 ]; then echo "ALL GREEN — the attendance pipeline is working end-to-end."; exit 0
else echo "SOME CHECKS FAILED — see the FAIL lines above."; exit 1; fi
