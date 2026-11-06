"""Measure the two deployment parameters that are NOT pure optics.

1) Illumination — recall vs light level. Simulated physically: drop the scene to
   a fraction of its reference exposure in LINEAR light, apply shot (Poisson) +
   read noise at that photon count, then auto-gain back up. That is what a real
   sensor does in a dim room, and it is the noise — not the darkness — that
   kills small-object recall.

2) Crowding — recall vs how much a head overlaps its neighbours. This is the
   mechanism camera TILT actually controls: a steeper look-down separates heads
   that a shallow view stacks on top of each other. Size is held constant
   (>=12 px at model input) so this measures occlusion, not distance.

Both run at the settings head-count uses in production: imgsz 640, conf 0.40.
"""
import json
import sys

import cv2
import numpy as np
from ultralytics import YOLO

VIDEO = "/demo/crowd.mp4"
MODEL = "/srv/head-count/models/abel/best.pt"
FRAMES = 40
REF_IMGSZ, REF_CONF = 1536, 0.60
OP_IMGSZ, OP_CONF = 1280, 0.40
IOU_MATCH = 0.40
STOPS = list(range(0, 11))            # stops below reference (-10 ~= 1 lux)
FULL_WELL = 6000.0                    # electrons at reference exposure
READ_NOISE = 2.5                      # electrons RMS
BLURS = [0, 2, 3, 5, 7, 9, 13]        # motion-blur kernel, px of travel


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


def dim(frame, stops, rng):
    """Reference frame → same scene at 2**-stops the light, sensor noise and all."""
    if stops == 0:
        return frame
    lin = (frame.astype(np.float32) / 255.0) ** 2.2         # to linear light
    g = 2.0 ** -stops
    photons = np.clip(lin * g * FULL_WELL, 0, None)          # electrons collected
    noisy = rng.poisson(photons).astype(np.float32)
    noisy += rng.normal(0, READ_NOISE, noisy.shape)          # read noise
    lin2 = np.clip(noisy / (FULL_WELL * g), 0, 1.0)          # auto-gain back up
    return np.clip((lin2 ** (1 / 2.2)) * 255.0, 0, 255).astype(np.uint8)


def main():
    model = YOLO(MODEL)
    rng = np.random.default_rng(7)
    cap = cv2.VideoCapture(VIDEO)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 300
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    step = max(total // FRAMES, 1)
    scale = OP_IMGSZ / W                                     # native px → model px

    light = {s: [0, 0, []] for s in STOPS}                   # stops → [n, hit, confs]
    blur = {b: [0, 0] for b in BLURS}                        # kernel px → [n, hit]
    crowd = []                                               # (neighbour_iou, hit)

    for i in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            continue

        ref_b, ref_c = boxes_of(model.predict(frame, imgsz=REF_IMGSZ, conf=0.20,
                                              verbose=False))
        ref_b = ref_b[ref_c >= REF_CONF]
        if len(ref_b) == 0:
            continue
        ref_px = (ref_b[:, 3] - ref_b[:, 1]) * scale         # size at model input

        # neighbour crowding: strongest overlap with any OTHER reference head
        RR = iou_matrix(ref_b, ref_b)
        np.fill_diagonal(RR, 0.0)
        neigh = RR.max(axis=1) if len(ref_b) > 1 else np.zeros(len(ref_b))

        for st in STOPS:
            det_b, det_c = boxes_of(model.predict(dim(frame, st, rng), imgsz=OP_IMGSZ,
                                                  conf=OP_CONF, verbose=False))
            M = iou_matrix(ref_b, det_b)
            for r in range(len(ref_b)):
                if ref_px[r] < 12:            # hold size constant: only heads the
                    continue                  # detector can resolve in good light
                j = int(M[r].argmax()) if M.shape[1] else -1
                hit = j >= 0 and M[r, j] >= IOU_MATCH
                light[st][0] += 1
                light[st][1] += int(hit)
                if hit:
                    light[st][2].append(float(det_c[j]))
                if st == 0:
                    crowd.append((float(neigh[r]), bool(hit)))

        # Motion blur: low light forces a longer exposure, and a walking head
        # smears across the sensor. Kernel length = px travelled while the
        # shutter is open.
        for k in BLURS:
            src = frame if k == 0 else cv2.filter2D(
                frame, -1, np.ones((1, k), np.float32) / k)
            det_b, det_c = boxes_of(model.predict(src, imgsz=OP_IMGSZ,
                                                  conf=OP_CONF, verbose=False))
            M = iou_matrix(ref_b, det_b)
            for r in range(len(ref_b)):
                if ref_px[r] < 12:
                    continue
                j = int(M[r].argmax()) if M.shape[1] else -1
                blur[k][0] += 1
                blur[k][1] += int(j >= 0 and M[r, j] >= IOU_MATCH)
    cap.release()

    light_rows = [{
        "stops_below_reference": s,
        "relative_light": round(2.0 ** -s, 4),
        "n": light[s][0],
        "recall": round(100 * light[s][1] / max(light[s][0], 1), 1),
        "mean_conf": round(float(np.mean(light[s][2])), 3) if light[s][2] else 0.0,
    } for s in STOPS]

    edges = [0.0, 0.05, 0.15, 0.30, 0.45, 1.01]
    crowd_rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = [c for c in crowd if lo <= c[0] < hi]
        if len(sel) < 10:
            continue
        crowd_rows.append({
            "neighbour_iou": f"{lo:.2f}-{hi:.2f}", "n": len(sel),
            "recall": round(100 * sum(1 for c in sel if c[1]) / len(sel), 1),
        })

    blur_rows = [{
        "kernel_px": b, "n": blur[b][0],
        "recall": round(100 * blur[b][1] / max(blur[b][0], 1), 1),
    } for b in BLURS]

    with open("/out/env_sweep.json", "w") as fh:
        json.dump({"illumination": light_rows, "motion_blur": blur_rows,
                   "crowding": crowd_rows}, fh, indent=1)
    print("WROTE /out/env_sweep.json", file=sys.stderr)


if __name__ == "__main__":
    main()
