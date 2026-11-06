# Pilot Evaluation Harness

Run this **before** trusting the VMS pipeline on real CCTV. Two modes:

1. **Image-based** (`harness.py`) — fast, deterministic, isolates *model* accuracy from infra noise.
2. **Video-based** (`video_pilot.py`) — feeds full clips through detector + tracker + matcher, exercising the production pipeline end-to-end.

Both run in-memory (no Postgres / Qdrant / Redis required) so you can do this on a laptop.

---

## Layout

```
eval_data/
├── gallery/                          # enrolled persons
│   ├── alice__1.jpg                  # filename: {person_id}__{free}.jpg
│   ├── alice__2.jpg
│   ├── bob__1.jpg
│   └── carol__profile.jpg
├── probe/                            # for image-based eval
│   ├── alice__scenario=indoor__camera=cam01.jpg
│   ├── bob__scenario=outdoor_day__camera=cam02.jpg
│   ├── unknown__scenario=outdoor_night__camera=cam05.jpg
│   └── ...
├── manifest.csv                      # OPTIONAL — overrides filename convention
├── clips/                            # for video-based eval
│   ├── cam01_morning.mp4
│   └── cam05_night.mp4
└── manifest_videos.csv               # video manifest
```

### `manifest.csv` (image probes)

```csv
path,true_person_id,scenario,camera
probe/alice_indoor.jpg,alice,indoor,cam-01
probe/bob_outdoor.jpg,bob,outdoor_day,cam-02
probe/visitor.jpg,,outdoor_day,cam-03
```

Empty `true_person_id` = "this person is NOT enrolled" (a negative sample, used to measure FPR).

### `manifest_videos.csv`

```csv
video_path,expected_person_ids,scenario,camera
clips/cam01_morning.mp4,alice;bob,indoor_day,cam-01
clips/cam05_night.mp4,,outdoor_night,cam-05
clips/cam03_distance.mp4,carol,outdoor_distance,cam-03
```

`expected_person_ids` is `;`-delimited. Empty means "nobody enrolled should appear here" (closed-set FPR test).

---

## Run

### Image pilot

```powershell
python -m vms_face.eval.harness `
  --gallery .\eval_data\gallery `
  --probe   .\eval_data\probe `
  --manifest .\eval_data\manifest.csv `
  --threshold 0.45 `
  --out .\eval_data\image_report
```

Outputs into `image_report/`:
- `summary.json` — machine-readable
- `report.txt` — human-readable
- `report.html` — open in a browser, color-coded KPIs
- `outcomes.csv` — every probe with prediction, similarity, latency, tags

### Video pilot

```powershell
python -m vms_face.eval.video_pilot `
  --gallery .\eval_data\gallery `
  --videos-manifest .\eval_data\manifest_videos.csv `
  --threshold 0.45 `
  --target-fps 8 `
  --out .\eval_data\video_report
```

Outputs into `video_report/`:
- `summary.json`
- `report.txt`
- `clip_results.csv` — per-clip results

---

## What the metrics mean

Following NIST FRVT 1:N identification protocol:

| Metric | Definition | Target (campus VMS) |
|--------|------------|---------------------|
| **TPR / Recall** | known-id probes correctly matched | indoor ≥ 0.95, outdoor day ≥ 0.85, night ≥ 0.50 |
| **FPR** | unknown-id probes wrongly matched | ≤ 0.02 globally |
| **Precision** | TP / (TP + FP) | ≥ 0.95 |
| **F1** | harmonic mean of precision and recall | ≥ 0.85 |
| **Detection rate** | probes where detector found ≥ 1 face | ≥ 0.95 — below this means the *detector* is failing, not the recognizer |

If TPR is low but detection rate is high → recognizer is the problem (try AdaFace, lower threshold, more enrollments per person).
If detection rate is low → detector is the problem (try larger input size, tiled inference, swap to YOLOv11-face).
If FPR is high → threshold too low, or gallery has near-duplicate identities.

---

## Building a good probe set

A pilot is worthless if the probe set isn't representative. For a campus deployment:

- **At least 50 enrolled identities** — small galleries inflate accuracy.
- **At least 5 probes per identity, across conditions** — angle, distance, lighting, occlusion.
- **Negative samples** — at minimum 1× the number of positives, ideally 5×. These measure FPR honestly.
- **Per-camera tagging** — so you can spot a bad camera vs a bad model.
- **Scenario tagging** — at least: indoor, outdoor_day, outdoor_night, distance.
- **Real CCTV crops, not selfies** — selfies hide every problem you'll have in production.

A workable starter: 100 identities × 8 probes = 800 positive probes, plus 1500 negative probes. Run in <10 min on a single Blackwell.
