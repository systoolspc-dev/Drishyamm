#!/bin/sh
# Build + deploy the operator console.
#
# The Dockerfile declares ARG VITE_* and does ENV VITE_X=$VITE_X, so omitting a
# build-arg sets that variable to an EMPTY STRING — which overrides .env.production
# and makes Vite fall back to the http://localhost:5000 dev default. The app then
# calls localhost from the browser, every request fails CORS, and the UI renders
# with no cameras. Always pass these explicitly.
#
# Bases are relative on purpose: nginx proxies /api, /ai, /hls, /whep on the same
# origin, so one build works for demo.indyatools.com, dash.drishyam.io and
# app.drishyam.io alike.
set -e
cd /data/build/smart-cam-app
docker build -f Dockerfile.prod \
  --build-arg VITE_API_BASE_URL=/ \
  --build-arg VITE_AI_BASE_URL=/ai \
  --build-arg VITE_STREAM_SERVICE_WEBRTC_BASE=/whep \
  -t drishyam/app:prod .
cd /data/build
docker compose -f docker-compose.prod.yml -p build up -d --no-deps --force-recreate smart-cam-app
echo "deployed. verify: curl -s -o /dev/null -w '%{http_code}\n' https://demo.indyatools.com/api/health"
