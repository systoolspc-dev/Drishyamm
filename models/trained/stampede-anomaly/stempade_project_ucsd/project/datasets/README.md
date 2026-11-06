# Datasets

This project uses the **UCSD Anomaly Detection Dataset as its only data source**.
Training, validation and evaluation all come from UCSD. See
[../pipeline.md](../pipeline.md) for the paper's spec and
[../TRAINING.md](../TRAINING.md) for how the labels are derived.

Downloaded 2026-08-25. On disk: **1.2 GB** extracted.

---

## Layout

```
datasets/
└── ucsd/
    ├── UCSD_Anomaly_Dataset.tar.gz          706 MB  (original archive, kept)
    └── UCSD_Anomaly_Dataset.v1p2/           1.2 GB  (extracted)
        ├── UCSDped1/{Train,Test}
        ├── UCSDped2/{Train,Test}
        └── README.txt
```

---

## UCSD Anomaly Detection Dataset (v1p2)

- **Source:** http://www.svcl.ucsd.edu/projects/anomaly/UCSD_Anomaly_Dataset.tar.gz
- **Citation:** Mahadevan, Li, Bhalodia & Vasconcelos, *Anomaly detection in crowded scenes*,
  CVPR 2010 (the paper's ref. 23)
- **Verified:** 740,306,953 bytes, matches server `Content-Length` exactly.

| Subset | Train clips | Test clips | Pixel-GT clips | Resolution | Frames |
|---|---|---|---|---|---|
| UCSDped1 | 34 | 36 | 10 | 238 × 158 | 14,000 |
| UCSDped2 | 16 | 12 | 12 | 360 × 240 | 4,560 |
| **Total** | **50** | **48** | 22 | — | **18,560** |

- Format: `.tif` frames, 200 per Ped1 clip, 120–180 per Ped2 clip. Grayscale, static camera.
- Each subset is one fixed camera on one walkway; the two subsets are different walkways.
- `Train` clips contain only normal frames.
- `Test` clips carry frame-level anomaly annotations in `Test/<subset>.m`, as MATLAB
  `gt_frame` index ranges. Parsed by `src/datasets_io.py`.
- The `Test<n>_gt/` directories hold per-pixel masks. They are **not used** here — the
  pipeline classifies whole frames.
- Anomalies are bikes, skateboards, carts and wheelchairs on a pedestrian walkway.

Measured over the whole dataset: **5,693 of 18,560 frames (30.7 %) are flagged anomalous.**

---

## The label problem

The paper trains on a derived set of **10,000 frames labelled `normal` / `moderate` /
`dense` / `risky`, ~2,500 per class**. That annotation was made by the authors and is
**not published**; neither is the trained model (no repository, no weights, no
supplementary material — the data availability statement covers only "reasonable request"
to the corresponding author).

UCSD's native labels are **binary** (normal / anomalous) plus pixel masks. The four-class
density taxonomy is not present in it, so the labelling step had to be rebuilt.

This project derives the four classes from UCSD alone:

| Class | Derived from |
|---|---|
| `risky` | UCSD's own `gt_frame` anomaly annotation, verbatim |
| `normal` / `moderate` / `dense` | tertiles of a foreground-occupancy density proxy over the non-anomalous frames |

The proxy uses a per-subset background plate built from the all-normal `Train` clips, which
is only valid because UCSD's camera is fixed. Full derivation and its three caveats — UCSD
anomalies are not stampedes, occupancy is a perspective-distorted area measure, and density
is near-constant within a clip — are in [../TRAINING.md](../TRAINING.md) under "Labels", and
the implementation is `src/ucsd_labels.py`.
