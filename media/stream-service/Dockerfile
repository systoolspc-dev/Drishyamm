# Drishyam Stream Service — RTSP / WebRTC / HLS media gateway for the VMS.
# A thin brand layer over the upstream media engine. Runtime config is
# bind-mounted from ./mediamtx.yml to /mediamtx.yml (the engine's expected
# config path), so tuning stays a plain file edit + restart.
#
# Pinned to the version the running stack was verified on (v1.18.1,
# 2026-11-06). `latest` silently changes config keys between releases.
FROM bluenviron/mediamtx:1.18.1
LABEL org.drishyam.component="Drishyam Stream Service" \
      org.drishyam.description="RTSP/WebRTC/HLS media gateway"
