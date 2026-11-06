# head-count — dedicated YOLOv8 head-detection counter.
#
# CPU image on purpose (like activity-monitor): head-counting a few cameras at a
# low frame rate doesn't need a GPU, a CPU torch build is ~10x smaller/faster,
# and it keeps the GPU free for the live face-recognition pipeline. To move to
# GPU later: swap the torch wheel for a CUDA build, base off nvidia/cuda, and add
# `gpus: all` in compose.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/head-count

# CPU torch first so ultralytics doesn't drag in the ~2.5GB CUDA build.
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision

# Package baked in; config is bind-mounted (camera/tuning edits survive rebuilds),
# and the head model auto-downloads at runtime into ./models (a named volume, so
# it downloads once).
COPY pyproject.toml ./
COPY src ./src
COPY config ./config
RUN pip install .

EXPOSE 8000
CMD ["headcount", "--config", "config/config.docker.yaml"]
