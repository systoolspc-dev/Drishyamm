#!/usr/bin/env bash
# Validate that CPU YOLO extraction is stable (no heap-corruption abort) and
# measure its speed on a small mixed subset, before committing to the full run.
set -uo pipefail
export PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1
export OPENCV_FFMPEG_CAPTURE_OPTIONS="threads;1" OPENCV_FFMPEG_LOGLEVEL=-8
export CUDA_VISIBLE_DEVICES=""   # hide GPU -> backend resolves to CPU
cd /mnt/c/projects/fall_detection_omnifall
PYBIN="$HOME/fall_venv/bin/python"

rm -rf data_raw_test data_prepared_test
mkdir -p data_raw_test/fall data_raw_test/adl
n=0; for f in data_raw/fall/mcfd*.avi; do ln -s "$(realpath "$f")" "data_raw_test/fall/$(basename "$f")"; n=$((n+1)); [ "$n" -ge 5 ] && break; done
n=0; for f in data_raw/fall/le2i*.avi; do ln -s "$(realpath "$f")" "data_raw_test/fall/$(basename "$f")"; n=$((n+1)); [ "$n" -ge 3 ] && break; done
n=0; for f in data_raw/adl/*.avi;      do ln -s "$(realpath "$f")" "data_raw_test/adl/$(basename "$f")";  n=$((n+1)); [ "$n" -ge 2 ] && break; done
echo "subset: fall=$(ls data_raw_test/fall | wc -l) adl=$(ls data_raw_test/adl | wc -l)"

echo "=== CPU extraction on subset (timed) ==="
START=$(date +%s)
"$PYBIN" -m src.data.prepare_dataset --raw data_raw_test --out data_prepared_test --annotations annotations.csv
RC=$?
END=$(date +%s)
echo "EXIT=$RC  ELAPSED=$((END-START))s"
