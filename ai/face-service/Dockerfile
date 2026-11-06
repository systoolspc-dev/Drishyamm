FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

# One image, many roles: face API (shard 0..N), inference server, match worker,
# journey stitch worker, footfall/demo publishers. The role is picked by the
# compose `command:`. In-container paths are kept exactly as the code expects
# (/srv/app/face_detection/vms_face) so no module path changes.
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/srv/app/face_detection \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,video

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-dev \
      python3-pip \
      python3-venv \
      ffmpeg \
      fonts-dejavu-core \
      libgl1 \
      libglib2.0-0 \
      libsm6 \
      libxext6 \
      libxrender1 \
      cmake \
      g++ \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
# TensorRT runtime libs land in site-packages/tensorrt_libs (pip). ORT's
# TensorRT provider resolves libnvinfer.so.10 through the dynamic linker, so
# put that directory on the library path; infra/ort_session.py also preloads
# it, which is what makes `docker exec ... python` work without this line.
ENV LD_LIBRARY_PATH=/opt/venv/lib/python3.12/site-packages/tensorrt_libs:${LD_LIBRARY_PATH} \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1

COPY requirements.txt /srv/requirements.txt
RUN pip install --upgrade pip setuptools wheel \
    && pip install -r /srv/requirements.txt \
    # insightface pulls in the CPU-only `onnxruntime`, which shadows
    # `onnxruntime-gpu` and disables the CUDA provider (models fall back to CPU
    # → ~0.3 fps, GPU idle). Remove both and reinstall ONLY the GPU build so
    # CUDAExecutionProvider is available. Do not let `onnxruntime` come back.
    && pip uninstall -y onnxruntime onnxruntime-gpu \
    # Pin to a CUDA-12 wheel. 1.27+ on PyPI is a CUDA-13 build (needs
    # libcudart.so.13) and won't load on this cuda:12.8 base. 1.26.0 is the
    # last CUDA-12 build and what the running stack was verified on
    # (2026-09-20); its TensorRT provider links libnvinfer.so.10, which
    # requirements.txt supplies via tensorrt-cu12-libs.
    && pip install --no-deps "onnxruntime-gpu==1.26.0"

COPY vms_face /srv/app/face_detection/vms_face
RUN mkdir -p /srv/data/models /srv/data/known_faces

# Face models (InsightFace buffalo_l / buffalo_sc) are NOT baked in: compose
# mounts ../../models/insightface at /root/.insightface. Enrolment photos are
# optional and mounted at /srv/data/known_faces.
ENV KNOWN_FACES_DIR=/srv/data/known_faces \
    INSIGHTFACE_MODEL=buffalo_l \
    INSIGHTFACE_CTX_ID=0 \
    INSIGHTFACE_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider

WORKDIR /srv/app/face_detection/vms_face

EXPOSE 8001

CMD ["sh", "-c", "alembic upgrade head && uvicorn vms_face.api.main:app --host 0.0.0.0 --port ${PORT:-8001}"]
