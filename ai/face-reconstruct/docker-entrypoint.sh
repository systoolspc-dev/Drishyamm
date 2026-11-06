#!/bin/sh
# Face reconstruction entrypoint.
#
# Idempotently downloads the model weights that pipeline.py expects:
#
#   CodeFormer/weights/CodeFormer/codeformer.pth                  (~380 MB)
#   CodeFormer/weights/facelib/detection_Resnet50_Final.pth       (~110 MB)
#   CodeFormer/weights/facelib/parsing_parsenet.pth               (~85 MB)
#   CodeFormer/weights/realesrgan/RealESRGAN_x2plus.pth           (~64 MB)
#
# All four come from CodeFormer's GitHub release page — no Google Drive,
# no rate limits, no API keys. Total ~640 MB on first run.
#
# We download with wget directly rather than the upstream Python script
# because the upstream script imports basicsr (which imports torchvision
# — a 3 s import time) just to fetch a URL. wget is instant.
# Deliberately NOT using `set -e`. The Real-ESRGAN download is allowed
# to fail without taking the whole service down: pipeline.py degrades
# gracefully when bg_model_path is missing (background super-resolution
# is disabled, but face restoration still works). The core CodeFormer +
# facelib weights are required; we abort if those fail.

W=/srv/CodeFormer/weights
mkdir -p "$W/CodeFormer" "$W/facelib" "$W/realesrgan"

fetch() {
    # $1 = target path
    # $2 = URL
    # $3 = required? "required" | "optional"
    if [ -s "$1" ]; then
        echo "[weights] OK  $(basename "$1")"
        return 0
    fi
    echo "[weights] GET $(basename "$1")"
    if wget --no-verbose --tries=3 --timeout=60 -O "$1" "$2"; then
        return 0
    fi
    # Failed. Remove any partial file so the next start retries cleanly.
    rm -f "$1"
    if [ "$3" = "required" ]; then
        echo "[weights] FATAL: required weight $(basename "$1") could not be fetched from $2"
        exit 1
    else
        echo "[weights] WARN: optional weight $(basename "$1") missing — pipeline will skip the feature that uses it"
    fi
}

fetch "$W/CodeFormer/codeformer.pth" \
      "https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/codeformer.pth" \
      required
fetch "$W/facelib/detection_Resnet50_Final.pth" \
      "https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/detection_Resnet50_Final.pth" \
      required
fetch "$W/facelib/parsing_parsenet.pth" \
      "https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/parsing_parsenet.pth" \
      required
# Correct Real-ESRGAN release URL. The v0.2.5.0 tag does NOT publish
# RealESRGAN_x2plus.pth; v0.2.1 is the canonical release for that file.
# Marked optional — pipeline.py handles its absence by disabling
# background super-resolution and falling back to bicubic upscale.
fetch "$W/realesrgan/RealESRGAN_x2plus.pth" \
      "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth" \
      optional

echo "[weights] all required present, launching service"
exec "$@"
