#!/usr/bin/env bash
# Delete le2i raw AVIs, rebuild data_raw so le2i uses the mp4s, refresh annotations.
set -uo pipefail
cd /mnt/c/projects/fall_detection_omnifall
PYBIN="$HOME/fall_venv/bin/python"

echo "=== delete le2i raw AVIs (reclaim disk) ==="
find dataset/le2i -name '*.avi' -delete
echo "le2i avis=$(find dataset/le2i -name '*.avi' | wc -l)  mp4s=$(find dataset/le2i -name '*.mp4' | wc -l)"
du -sh dataset/le2i
df -h /mnt/c | tail -1

echo "=== reset annotations + data_raw, rerun adapter (finds mp4 now) ==="
[ -f annotations.csv ] && cp annotations.csv annotations.csv.orig
rm -f annotations.csv
rm -rf data_raw
"$PYBIN" -m src.data.omnifall --videos dataset --configs mcfd,le2i --out data_raw --annotations annotations.csv

echo "=== verify link types + decode one le2i mp4 link ==="
echo "fall links=$(ls data_raw/fall | wc -l)  adl links=$(ls data_raw/adl | wc -l)"
echo "le2i mp4 links=$(find data_raw -name 'le2i*.mp4' | wc -l)  le2i avi links=$(find data_raw -name 'le2i*.avi' | wc -l)"
L=$(find data_raw -name 'le2i*.mp4' | head -1)
"$PYBIN" -u -c "
import cv2; cv2.setNumThreads(0)
c=cv2.VideoCapture('$L'); n=0
while True:
    ok,fr=c.read()
    if not ok: break
    n+=1
print('le2i link decodes OK:', n, 'frames ->', '$L'.split('/')[-1])
" || echo "DECODE-CRASH on le2i link"
