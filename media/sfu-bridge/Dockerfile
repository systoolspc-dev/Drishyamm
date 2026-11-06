# smart-cam-sfu-bridge — RTSP → LiveKit publisher.
#
# Reads RTSP from MediaMTX (cam_<id> or cam_<id>_clean depending on
# whether the camera has Phase 3 transcoding on) and republishes into a
# LiveKit room as a "bridge" participant via WHIP. LiveKit handles the
# SFU fanout to operator subscribers.
#
# Base: python:3.12-slim. NO CUDA — bridge does zero encode/decode work;
# just FFmpeg-to-WHIP packetisation.
FROM python:3.12-slim

# FFmpeg with the WHIP output muxer (`-f whip`). IMPORTANT: the muxer landed in
# FFmpeg 8.0 — the Debian apt build (even 7.1.5) does NOT include it, so we copy
# a static 8.0 build instead of `apt-get install ffmpeg`. Static = self-contained
# (bundles the TLS/SRTP/DTLS that WHIP needs), no shared-lib deps on the slim base.
COPY --from=mwader/static-ffmpeg:8.0 /ffmpeg /ffprobe /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        && rm -rf /var/lib/apt/lists/*

# Hard gate: fail the build if the whip muxer is missing. The bridge's entire job
# is FFmpeg→WHIP, so a build without it would silently break every publisher. This
# replaces the old "record what shipped to a file" check with a real guarantee.
RUN ffmpeg -hide_banner -muxers 2>/dev/null | grep -q '\bwhip\b' \
    || (echo "FATAL: this FFmpeg build lacks the WHIP muxer (-f whip); need >= 8.0" && exit 1)

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app /app/app

# Port 8005 — sibling of smart-cam-transcoder (:8004), person-tracker
# (:8003), face-reconstruct (:8002), smart-cam-ai (:8001).
ENV PORT=8005
EXPOSE 8005

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8005}"]
