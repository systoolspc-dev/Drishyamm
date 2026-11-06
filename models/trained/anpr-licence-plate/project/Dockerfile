# syntax=docker/dockerfile:1.6
#
# ANPR live worker (GPU) — ByteTrack + enhancement + multi-hypothesis OCR.
#
# Built ON TOP of the local face-reconstruct image on purpose:
#   - it already carries torch 2.7.1+cu128 that is VERIFIED to see this
#     host's GPU (RTX A3000; `torch.cuda.is_available() == True` in the
#     running container). Pulling pytorch/pytorch again is a 3-4 GB download
#     that has failed repeatedly on this network (see that Dockerfile).
#   - the main trinetra/ai image can't host it: its onnxruntime is the CPU
#     wheel (1.29 overwrote onnxruntime-gpu) and it has no torch at all.
#   - ultralytics + fast-plate-ocr on top are ~100 MB of pure-python wheels.
#
# The worker source, models and data are NOT copied in — compose bind-mounts
# ./trinetra-ai/app/anpr_worker to /srv/anpr so edits + new weights need a
# container restart, never a rebuild. Only dependencies live in the image.
#
# Fallback if this base is ever unavailable: FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime
# plus `apt-get install libgl1 libglib2.0-0` gives an identical result.
FROM drisyam-face-reconstruct:latest

ENV PIP_DEFAULT_TIMEOUT=300 PIP_RETRIES=5 PYTHONUNBUFFERED=1 \
    YOLO_CONFIG_DIR=/tmp/ultralytics

# ultralytics : YOLOv8 inference on CUDA (vehicle + plate detectors, .pt)
# fast-plate-ocr[onnx] : CCT plate OCR (ONNX, CPU is plenty at ~2 ms/crop)
# Video decode: the pip opencv-python wheel's bundled FFmpeg cannot fetch the
# corp8 LL-HLS segments ("Error when loading first segment"). video_source.py
# tries PyAV → static ffmpeg (imageio-ffmpeg wheel, no compile) → cv2.
#   imageio-ffmpeg : always installs (pure wheel with a static ffmpeg binary)
#   av (PyAV)      : best-effort — this base's pip finds no matching wheel and
#                    the sdist needs FFmpeg headers, so it is allowed to fail.
# The base already has opencv-python, numpy 1.26, scipy, requests.
RUN pip install --no-cache-dir "ultralytics>=8.3,<9" "fast-plate-ocr[onnx]>=1.1" "imageio-ffmpeg>=0.5" \
 && (pip install --no-cache-dir --only-binary=:all: "av" || echo "PyAV wheel unavailable — using static ffmpeg") \
 && python -c "import ultralytics, fast_plate_ocr, imageio_ffmpeg, torch; print('anpr-worker deps OK, cuda build', torch.version.cuda, 'ffmpeg', imageio_ffmpeg.get_ffmpeg_exe())"

# The base image's entrypoint downloads CodeFormer weights on start — not
# wanted here. Compose sets working_dir + command; this is the default.
ENTRYPOINT []
WORKDIR /srv/anpr
CMD ["python", "worker.py"]
