#!/bin/sh
# deploy.sh — build the backend from this folder and put it live.
#
#   ./deploy.sh            build from the committed code, deploy, wait for health
#   ./deploy.sh --build    build + check only, do not deploy
#   ./deploy.sh --rollback go back to the image that was live before the last deploy
#
# Only committed code is deployed (uncommitted edits stop the script), so every
# image tag maps to a git commit: drishyam/backend:prod-YYYYMMDD-<commit>.
set -eu

cd "$(dirname "$0")"
COMPOSE=/data/build/docker-compose.prod.yml
PROJECT=build
SERVICE=smart-cam-backend
REPO=drishyam/backend
LAST=.last-deployed-image        # previous live image, for --rollback

live_image() { sed -n "s#^ *image: \($REPO:[^ ]*\)\$#\1#p" "$COMPOSE"; }

wait_healthy() {
  i=0
  until curl -sf -o /dev/null http://127.0.0.1:5000/api/health; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && return 1
    sleep 3
  done
}

switch_to() {
  [ "$(grep -c "image: $REPO:" "$COMPOSE")" = 1 ] || { echo "expected exactly one $REPO image line in $COMPOSE"; exit 1; }
  cp "$COMPOSE" "/data/backups/docker-compose.prod.yml.$(date +%Y%m%d-%H%M%S)"
  sed -i "s#image: $REPO:[^ ]*#image: $1#" "$COMPOSE"
  docker compose -f "$COMPOSE" -p "$PROJECT" up -d --no-deps "$SERVICE"
  if wait_healthy; then
    echo "LIVE: $1"
  else
    echo "!! $1 did not become healthy within 3 minutes."
    echo "   Logs:     docker logs --tail 100 drisyam-original-backend"
    echo "   Go back:  ./deploy.sh --rollback"
    exit 1
  fi
}

if [ "${1:-}" = "--rollback" ]; then
  [ -s "$LAST" ] || { echo "no previous image recorded"; exit 1; }
  prev=$(cat "$LAST")
  echo "Rolling back $(live_image) -> $prev"
  switch_to "$prev"
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes - commit them first (git add -A && git commit -m '...'):"
  git status --short
  exit 1
fi

tag="$REPO:prod-$(date +%Y%m%d)-$(git rev-parse --short HEAD)"
echo "Building $tag ..."
docker build -q -t "$tag" .

echo "Checking every .js file parses ..."
docker run --rm --entrypoint sh "$tag" -c \
  'find src migrations seeders scripts -name "*.js" -exec node --check {} \; 2>&1' | grep . && { echo "!! syntax errors above - not deploying"; exit 1; }
echo "Syntax OK"

[ "${1:-}" = "--build" ] && { echo "Built $tag (not deployed)."; exit 0; }

live_image > "$LAST"
echo "Deploying $tag (was $(cat "$LAST")) - backend restarts, ~10 s"
switch_to "$tag"
