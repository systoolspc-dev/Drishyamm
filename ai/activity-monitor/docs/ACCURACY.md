# Improving activity-monitor accuracy

Three independent accuracy levers, cheapest first.

## 1. Tune thresholds on YOUR footage (no retraining)
Every posture/phone threshold is config (`config/config.yaml` → `activity:`), so
tune against real frames rather than guessing:

```bash
python scripts/probe_activity.py frame.jpg           # prints per-person state + posture features
python scripts/probe_activity.py frame.jpg --tilt 24 # try a different reclined-torso threshold
python scripts/render_video.py in.mp4 out.mp4        # eyeball an annotated clip
```

Knobs that matter most:
- `phone_overlap` / `phone_require_hand` / `phone_hand_radius` — phone-usage precision.
  A phone must overlap the person **and** sit near a wrist/head keypoint; loosen
  `phone_hand_radius` if real usage is missed, tighten if desk-phones trigger.
- `posture_head_down` / `posture_tilt_max` / `posture_face_min` — working vs slumped.
- `hold_seconds` — how long a state must persist before it switches (anti-flicker).

## 2. Tracker stability (already improved)
Low fps makes a stationary person's box jitter, and plain IoU then loses the
track → one person becomes many IDs. `tracker.py` now adds a **center-distance
fallback** + a longer `track_max_misses`, and the aggregate views drop ghost
tracks under `min_present_sec`. If you still see fragmentation, raise
`track_max_misses` (keeps IDs across longer gaps) or `track_center_dist_ratio`.
The real fix for churn, though, is **identity fusion** (`identity.enabled`) —
naming a track from vms_face collapses all its fragments into one person.

## 3. Retrain the phone model (the big recall win)
`models/phone.pt` is a small, **close-range** detector — it misses small/distant
phones on wide CCTV. This is the ceiling on recall and only retraining moves it.

Path:
1. **Collect** phone-in-hand crops from YOUR cameras (varied distance/angle/light).
   A few thousand boxes beats a generic dataset.
2. **Label** them (one class, `using phone`) — CVAT / Roboflow / Label Studio.
3. **Train** at `s` scale (better small-object recall than the current `n`):
   ```bash
   yolo detect train model=yolov8s.pt data=phones.yaml imgsz=1280 epochs=100
   ```
4. **Export** for the target device and drop it in `models/`:
   ```bash
   python scripts/export_model.py runs/detect/train/weights/best.pt   # ONNX / TensorRT
   ```
   Then point `detectors[0].weights` at it.

## Note on compute
Small-object recall wants a **high `imgsz`** (1280+), which is the opposite of
what CPU + multi-camera can afford (this deployment runs CPU at 640 to keep a few
cameras real-time). Moving activity-monitor to **GPU** (swap the torch wheel to a
CUDA build, base off `nvidia/cuda`, add `gpus: all` in compose) is what lets you
raise `imgsz` and add cameras without dropping fps.
