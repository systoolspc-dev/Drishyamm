"""Measure OUR head detector's recall as a function of head size in pixels.

Why this experiment: mounting height, tilt and camera resolution all reduce to
ONE number the detector actually cares about — how many pixels a head occupies
at the model's input tensor. Everything else in a deployment table is geometry
on top of that. So measure the model, then do the geometry.

Method
  reference : detections at imgsz=1536 with conf >= 0.60  → treated as truth
  sweep     : detections at imgsz in {1280..256}, mapped back to native coords
              and matched to the reference by IoU >= 0.40
  x-axis    : head height in pixels AT MODEL INPUT = h_native * (imgsz / W_native)

Recall is measured only against reference heads, so this is "of the heads that
are really there, how many does a given pixel budget find".
"""
import json
import sys

import cv2
import numpy as np
from ultralytics import YOLO

VIDEO = "/demo/crowd.mp4"
MODEL = "/srv/head-count/models/abel/best.pt"
FRAMES = 40                 # sampled across the clip
REF_IMGSZ = 1536
REF_CONF = 0.60
SWEEP_IMGSZ = [1280, 1024, 896, 768, 640, 512, 416, 320, 256]
OP_CONF = 0.40              # the threshold head-count actually runs in production
IOU_MATCH = 0.40


def boxes_of(res):
    b = res[0].boxes
    if b is None or len(b) == 0:
        return np.zeros((0, 4)), np.zeros((0,))
    return b.xyxy.cpu().numpy(), b.conf.cpu().numpy()


def iou_matrix(a, b):
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    aa = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    bb = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / (aa[:, None] + bb[None, :] - inter + 1e-9)


def main():
    model = YOLO(MODEL)
    cap = cv2.VideoCapture(VIDEO)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 300
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(total // FRAMES, 1)
    print(f"video {W}x{H}, {total} frames, sampling every {step}", file=sys.stderr)

    samples = []      # (model_input_px, found, conf)
    ref_native_px = []
    n_frames = 0

    for i in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            continue
        n_frames += 1

        ref_b, ref_c = boxes_of(model.predict(frame, imgsz=REF_IMGSZ, conf=0.20,
                                              verbose=False))
        keep = ref_c >= REF_CONF
        ref_b = ref_b[keep]
        if len(ref_b) == 0:
            continue
        ref_h = ref_b[:, 3] - ref_b[:, 1]          # head height, native px
        ref_native_px.extend(ref_h.tolist())

        for sz in SWEEP_IMGSZ:
            det_b, det_c = boxes_of(model.predict(frame, imgsz=sz, conf=OP_CONF,
                                                  verbose=False))
            M = iou_matrix(ref_b, det_b)
            scale = sz / max(W, H)                  # letterbox long-side scale
            for r in range(len(ref_b)):
                j = int(M[r].argmax()) if M.shape[1] else -1
                hit = j >= 0 and M[r, j] >= IOU_MATCH
                samples.append((float(ref_h[r] * scale), bool(hit),
                                float(det_c[j]) if hit else 0.0))

    cap.release()
    print(f"frames used {n_frames}, reference heads {len(ref_native_px)}, "
          f"samples {len(samples)}", file=sys.stderr)

    # Recall vs head pixels at model input
    edges = [0, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 96, 1e9]
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = [s for s in samples if lo <= s[0] < hi]
        if len(sel) < 12:
            continue
        found = [s for s in sel if s[1]]
        rows.append({
            "lo": lo, "hi": None if hi > 1e8 else hi, "n": len(sel),
            "recall": round(100 * len(found) / len(sel), 1),
            "mean_conf": round(float(np.mean([s[2] for s in found])), 3) if found else 0.0,
        })

    out = {
        "video": f"{W}x{H}", "frames": n_frames,
        "reference_heads": len(ref_native_px),
        "ref_native_px": {
            "p10": round(float(np.percentile(ref_native_px, 10)), 1),
            "median": round(float(np.median(ref_native_px)), 1),
            "p90": round(float(np.percentile(ref_native_px, 90)), 1),
        },
        "recall_by_model_input_px": rows,
    }
    with open("/out/sweep.json", "w") as fh:
        json.dump(out, fh, indent=1)
    print("WROTE /out/sweep.json", file=sys.stderr)


if __name__ == "__main__":
    main()
