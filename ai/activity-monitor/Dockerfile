# activity-monitor — CPU-only image.
#
# CPU (not CUDA) on purpose: per-person activity on a handful of cameras at a few
# fps doesn't need a GPU, the build is ~10x smaller/faster than a torch-CUDA
# image, and it keeps the GPU free for the live face-recognition demo. To move to
# GPU later: swap the torch wheel for a CUDA build, base off nvidia/cuda, and add
# `gpus: all` in compose.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/activity-monitor

# Install CPU torch first so ultralytics doesn't drag in the ~2.5GB CUDA build.
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision

# Package + models baked in; config + data are bind-mounted so camera/tuning
# edits and the SQLite ledger survive without a rebuild.
COPY pyproject.toml ./
COPY src ./src
COPY models ./models
COPY config ./config
RUN pip install ".[identity]"
# psycopg2 for the recognition-sync poller (reads vms_face's detection_events
# Postgres to build attendance from real recognised people).
RUN pip install "psycopg2-binary>=2.9"

EXPOSE 8000
CMD ["activity-monitor", "--config", "config/config.docker.yaml"]
