# smart-cam-transcoder — per-camera NVENC normalisation
#
# Reads RTSP from MediaMTX (camera-as-published), normalises through
# NVDEC → no-filter → NVENC, publishes back to MediaMTX at a sibling
# path (cam_<id>_clean). The SPA + AI service consume the clean path
# transparently — operators don't see the difference, just the smoother
# stream.
#
# Base: nvidia/cuda + Ubuntu 22.04. We don't use a pytorch base because
# this service has zero ML deps — just FFmpeg + a tiny FastAPI control
# plane. Keeping the image small (and CUDA-only) makes pulls fast.
FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

# ── FFmpeg with NVENC + NVDEC ────────────────────────────────────────────
# We need an FFmpeg build with h264_nvenc + h264_cuvid configured. The
# stock apt ffmpeg in jammy has NVENC enabled but the libnvcuvid stubs
# are missing; we copy them from the CUDA runtime image (it ships
# libnvidia-encode.so and libnvcuvid.so via the nvidia-container-runtime
# bind mount at /usr/local/nvidia/lib64/).
#
# Build deps + ffmpeg from the Ubuntu repos. If/when we need a newer
# FFmpeg (LL-HLS encoder, AV1, etc) we'll switch to BtbN's static builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        ca-certificates \
        python3 \
        python3-pip \
        && rm -rf /var/lib/apt/lists/*

# Bundle FFmpeg version so docker inspect can confirm what shipped.
RUN ffmpeg -hide_banner -encoders 2>/dev/null | grep nvenc | head -3 > /etc/ffmpeg-nvenc-encoders.txt || true

WORKDIR /app

COPY requirements.txt /app/requirements.txt
# Ubuntu 22.04 ships pip without PEP 668's externally-managed marker, so
# --break-system-packages is unrecognised. Plain pip is fine.
RUN pip3 install --no-cache-dir -r requirements.txt

COPY app /app/app

# Port 8004 — sibling of person-tracker (:8003), face-reconstruct (:8002),
# smart-cam-ai (:8001), smart-cam-backend (:5000).
ENV PORT=8004
EXPOSE 8004

ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8004}"]
