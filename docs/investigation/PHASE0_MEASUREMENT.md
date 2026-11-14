# I-1 Phase 0: measuring tracks per camera per day

Before we build the search index, we need real numbers from real cameras:

1. **How many people pass each camera per day?** Split into *face tracks* (what Drishyam tracks today) and *person tracks* (YOLO body boxes, which also catch people seen from behind).
2. **How much extra GPU does person detection cost?**
3. From those: **how much storage the index will need** per camera per day.

This runs on the **testing server**. The code reaches it the normal way: PR → `main` → auto-deploy.

## What the meter does

`ai/face-service/vms_face/investigate/measure.py`, switched on with `INVESTIGATE_MEASURE_ENABLED=true`.

- Counts every finished track per camera, as **kept** (at least 1 s long and at least 3 matched frames: what we would index) or **junk** (flicker).
- Counting only. It saves no crops or embeddings and writes nothing to any database. Each frame costs one dictionary update per visible track.
- Off by default. When off, the pipeline behaves exactly as before.

Outputs:

| Where | What |
|---|---|
| Logs | One `investigate.measure` line per camera every 15 min: `face_kept`, `person_kept`, totals |
| Prometheus `/metrics` | `vms_investigate_tracks_closed_total{camera_id,kind,kept}`, `vms_investigate_track_duration_seconds{kind}` |
| `GET /streams/debug` (JWT) | `investigate_measure` block per camera, including a per-day projection |

## Runbook (testing server)

All commands run in the repo checkout on the testing server. Changing `.env` is configuration, not code, so it doesn't break the "no code edits on servers" rule.

### 1. Baseline GPU, with measurement and person detection off (30 min)

```bash
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv -l 10 > /tmp/gpu_baseline.csv
# leave it running ~30 min with the usual cameras live, then Ctrl+C
```

### 2. Turn on face-track counting only (24 h)

```bash
echo "INVESTIGATE_MEASURE_ENABLED=true" >> .env       # if the key is already in .env, edit it instead
docker compose up -d smart-cam-ai
docker compose logs -f smart-cam-ai | grep investigate.measure      # a line per camera every 15 min
```

### 3. Add person detection (YOLO), another 24 h

Person tracks need the YOLO model as ONNX at `data/ai-models/yolov8n.onnx`. The repo has only `models/person/yolov8n.pt`. Export it once on any machine with Python:

```bash
pip install ultralytics
yolo export model=models/person/yolov8n.pt format=onnx imgsz=640 simplify=True
cp models/person/yolov8n.onnx data/ai-models/yolov8n.onnx
```

Then:

```bash
echo "PIPELINE_PERSON_DETECTION_ENABLED=true" >> .env
docker compose up -d smart-cam-ai
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used --format=csv -l 10 > /tmp/gpu_person.csv
```

Compare `/tmp/gpu_person.csv` with `/tmp/gpu_baseline.csv`. **Target: under 10 % extra GPU.** Also watch live view for lag. If live view lags, set `PIPELINE_PERSON_DETECT_EVERY_N_FRAMES=4` and measure again.

> ⚠️ YOLOv8 from Ultralytics is **AGPL-3.0**. It's fine for this internal measurement, but before the index ships to customers, we need either an Ultralytics commercial licence or a permissively licensed detector. Tracked under the licence check for I-1.

### 4. Read the numbers

```bash
docker compose logs --since 24h smart-cam-ai | grep investigate.measure | tail -50
docker compose exec smart-cam-ai python -c "import urllib.request;print('\n'.join(l for l in urllib.request.urlopen('http://localhost:8001/metrics').read().decode().splitlines() if 'vms_investigate' in l))"
```

### 5. Switch it off again

```bash
sed -i '/^INVESTIGATE_MEASURE_ENABLED=/d;/^PIPELINE_PERSON_DETECTION_ENABLED=/d' .env
docker compose up -d smart-cam-ai
```

## Results (fill in)

| Camera | Type of place | Face tracks kept / day | Person tracks kept / day | Avg track length (s) |
|---|---|---|---|---|
| | | | | |

| Measure | Value |
|---|---|
| GPU util, baseline → with person detection | ___ % → ___ % |
| GPU memory, baseline → with person detection | ___ MB → ___ MB |
| Live view lag noticed? | |

**Storage estimate per camera per day** = person tracks/day × (≈ 15 KB crop + ≈ 1 KB vector + ≈ 2 KB row + track length × ≈ 16 B for 1 point/s positions).

These numbers go in the I-1 PR description and decide the GPU and storage budget for the index.
