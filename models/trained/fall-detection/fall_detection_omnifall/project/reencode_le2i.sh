#!/usr/bin/env bash
# Re-encode all le2i rawvideo AVIs -> H.264 mp4 (OpenCV-safe). Keeps the AVIs
# until we've verified the mp4s, then a separate step deletes them to reclaim disk.
set -uo pipefail
cd /mnt/c/projects/fall_detection_omnifall
PYBIN="$HOME/fall_venv/bin/python"
FFMPEG=$("$PYBIN" -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
echo "ffmpeg: $FFMPEG"

ok=0; fail=0
for src in dataset/le2i/*/*.avi; do
    dst="${src%.avi}.mp4"
    if "$FFMPEG" -y -loglevel error -nostdin -i "$src" \
         -c:v libx264 -preset veryfast -crf 20 -an "$dst" 2>/dev/null && [ -s "$dst" ]; then
        ok=$((ok+1))
    else
        echo "FAILED: $src"; fail=$((fail+1))
    fi
done
echo "re-encoded OK=$ok FAIL=$fail"
echo "mp4 count: $(find dataset/le2i -name '*.mp4' | wc -l)  (expect 133)"
echo "avi count: $(find dataset/le2i -name '*.avi' | wc -l)"
du -sh dataset/le2i

echo "=== decode-test 3 random mp4s in isolated subprocesses ==="
for mp4 in $(find dataset/le2i -name '*.mp4' | shuf | head -3); do
    "$PYBIN" -u -c "
import cv2,sys; cv2.setNumThreads(0)
c=cv2.VideoCapture('$mp4'); n=0
while True:
    ok,fr=c.read()
    if not ok: break
    n+=1
print('OK', n, 'frames:', '$mp4'.split('/')[-2:])
" || echo "DECODE-CRASH: $mp4"
done
