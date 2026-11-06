#!/usr/bin/env bash
# Prove that re-encoding a le2i AVI to H.264 mp4 yields a file OpenCV can decode
# without the heap-corruption crash. imageio-ffmpeg bundles a static ffmpeg (no sudo).
set -uo pipefail
cd /mnt/c/projects/fall_detection_omnifall
PYBIN="$HOME/fall_venv/bin/python"

echo "=== install imageio-ffmpeg ==="
"$PYBIN" -m pip install -q imageio-ffmpeg
FFMPEG=$("$PYBIN" -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
echo "ffmpeg: $FFMPEG"

SRC="dataset/le2i/Coffee_room_01/video_1.avi"
DST="/tmp/le2i_test.mp4"
echo "=== source stream info ==="
"$FFMPEG" -i "$SRC" 2>&1 | grep -E "Video:|Duration" | head

echo "=== re-encode to H.264 mp4 (preserve fps/duration) ==="
"$FFMPEG" -y -loglevel error -i "$SRC" -c:v libx264 -preset veryfast -crf 20 -an "$DST"
ls -la "$DST"

echo "=== decode-test the mp4 in OpenCV (isolated subprocess) ==="
"$PYBIN" -u -c "
import cv2; cv2.setNumThreads(0)
c=cv2.VideoCapture('/tmp/le2i_test.mp4'); n=0
while True:
    ok,fr=c.read()
    if not ok: break
    n+=1
print('MP4 decoded frames:', n, 'fps', c.get(cv2.CAP_PROP_FPS))
"
echo "decode rc=$?"
