---
name: drishyam-pipeline-hook
description: Build or measure the I-1 track summariser for the Drishyam investigation index — hooking the live AI pipeline (orchestrator / IOUTracker "track ended"), person and vehicle track sources, best crop, image embedding (OpenCLIP/SigLIP), voted clothing attributes, track_points and activity counts, the GPU/latency measurement spike, and NVR-safe backfill. Use for any change in ai/face-service/vms_face/pipeline or services/face_tracker.py in the Drishyamm repo.
---

# I-1 pipeline hook: per-track summaries without hurting live latency

Root: `ai/face-service/vms_face/`. Rules: hub skill `drishyam-investigation`. Storage: `drishyam-ai-schema`.

## Where tracks live today
- Tracker: `services/face_tracker.py:167 IOUTracker` (SORT-like), created at `pipeline/orchestrator.py:161`; `step()` at `:210`.
- **Track ended**: `face_tracker.py:276-291` pops tracks with `miss_count > max_age` into `self.dropped_last_step`
  (overwritten every step). Only consumer: `orchestrator.py:566-569` (identity latch, gated on `_latch_enabled`).
  → Hook here: right after `self._tracker.step(observations)` (`orchestrator.py:558`), outside the latch `if`, hand each
  dropped `Track` to the summariser. Also emit a heartbeat every 30 s for long-lived tracks.
- These are **face tracks only** (SCRFD/InsightFace detections). Track ids are per-process (`face_tracker.py:263`).
- Person boxes: `infra/person_detector.py:98 YOLOPersonDetector` (COCO class 0 only), enabled by
  `pipeline_person_detection_enabled` (`config/settings.py:492`, compose default false), run every N frames at
  `orchestrator.py:575-591` and used **only** for footfall (`:607-642`, own centroid tracker in `services/footfall.py:268`).
  Not tracked, not embedded, not linked to faces. Weights: compose expects `/srv/data/models/yolov8n.onnx` but repo has only
  `models/person/yolov8n.pt` — export ONNX first.
- `ai/zone-guard/zone_sim.py:263` already runs ultralytics `model.track(persist=True)` on person boxes — a reference for a
  person tracker, but a separate service.
- **No vehicle detection anywhere** (I-10 / vehicle tracks need a new detector class set + licence check).

So faceless people need: YOLO person detection on (flag) + a person tracker (IOU/SORT over YOLO boxes, reuse IOUTracker
logic or ByteTrack) + association of face tracks to person tracks (face box inside person box) so both share one `tracks` row.

## Reuse
- Clothing colour: `journey/body.py:107 extract_clothing(img, person_bbox=…)` → `BodyAttributes` (`:48`, `to_payload`).
- Body ReID: `journey/body.py:183 BodyEmbedder.shared().embed(img, person_bbox=…)` (OSNet 512-d, `body_model_path` `settings.py:112`).
- Voting: copy `services/track_attributes.py:36 TrackAttributes` (quality-weighted `add_vote`, `needs_sample` early stop,
  min votes + agreement before asserting a label). Use it per attribute (top/bottom colour, bag, …).
- Best vector/crop: `services/track_embedding_pool.py:8 TrackEmbeddingPool` keeps top-K by quality and returns a pooled average;
  the best observation is `Track.best_obs`/`best_quality`. Keep top-3 crops by area × sharpness × det score × frontalness.
- Existing per-detection body logging behind `journey_body_logging` (`orchestrator.py:1192-1206`) — note compose turns it ON.

## Design constraints
- Summariser off the hot path: dropped tracks go onto a bounded queue; a worker thread batches crops every ~500 ms →
  one GPU call for the embedding, one for attribute heads; drop (and count) when the queue is full rather than block.
- Flag `investigate_index_enabled` default False; per-camera switch later (`ai.searchIndex` next to `ai.journeyMapping`).
- Skip junk: tracks < ~1 s or tiny boxes (settings).
- Night: decide IR from frame saturation; `ir=true` → no colour attributes.
- No gender/age unless tenant opted in.
- Writes: Postgres rows + `vms_tracks` vector + MinIO crop, all with tenant_id; link `tracker_id`, `event_id`, appearance point id.

## Measurement spike (before default-on)
1. Tracks/camera/day: count dropped tracks per camera (log or Prometheus counter beside `TRACKS_OPENED`, `orchestrator.py:560`)
   on lab cameras for 24 h, face and person separately.
2. GPU/latency: compare `PIPELINE_STAGE_LATENCY` and `nvidia-smi dmon` with flag off vs on; target < 10 % extra GPU, no change
   to live p95. Run `media-pipeline/bench` wall scenario to confirm live video is unaffected.
3. Quality: dump ~500 lab person crops; run `extract_clothing` + an OpenCLIP/SigLIP model (check commercial licence; weights via
   Git LFS) and hand-check text→image retrieval ("red top", "backpack"). Keep spike scripts under `vms_face/eval/` or scratch,
   not in the pipeline.
4. Write the numbers into the PR (tracks/cam/day, GPU %, storage/cam/day).

## NVR safety (never break)
No automatic NVR backfill. Backfill decodes recording segments (`/recordings`, cloud segments) at 2–5 fps with `source='backfill'`.
NVR replay only on explicit capped user action, one session, respect per-NVR cap, stop on first error, never loop on credentials.

## Tests
Pure-logic `unittest` with a fake clock like `vms_face/tests/test_footfall_line.py` / `test_identity_latch.py`: drop events reach
the summariser, junk filtered, votes settle, IR suppresses colour, full queue drops instead of blocking.
Run: `docker compose run --rm --no-deps smart-cam-ai sh -c 'cd /srv/app/face_detection && python -m unittest discover -s vms_face/tests -t .'`
