"""How packed can people get before we start missing heads?

This is the question behind BOTH camera tilt and choke-point placement. A
shallow, near-horizontal view stacks people onto each other in image space; a
steeper look-down spreads them out. Rather than assume, measure recall against
two crowding metrics that are meaningful regardless of view angle:

  • nearest-neighbour distance, in head-diameters (1.0 = heads touching)
  • local density: how many other heads sit within 3 head-diameters

Head size is held >=12 px at model input so this isolates crowding from range.
"""
import json
import sys

import cv2
import numpy as np
from ultralytics import YOLO

VIDEO = "/demo/crowd.mp4"
MODEL = "/srv/head-count/models/abel/best.pt"
FRAMES = 120
REF_IMGSZ, REF_CONF = 1536, 0.60
OP_IMGSZ, OP_CONF = 1280, 0.40
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
    step = max(total // FRAMES, 1)
    scale = OP_IMGSZ / W

    rows = []          # (nn_dist_in_head_diameters, density_within_3d, hit)

    for i in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            continue
        ref_b, ref_c = boxes_of(model.predict(frame, imgsz=REF_IMGSZ, conf=0.20,
                                              verbose=False))
        ref_b = ref_b[ref_c >= REF_CONF]
        if len(ref_b) < 2:
            continue
        ref_px = (ref_b[:, 3] - ref_b[:, 1]) * scale

        cx = (ref_b[:, 0] + ref_b[:, 2]) / 2
        cy = (ref_b[:, 1] + ref_b[:, 3]) / 2
        diam = (ref_b[:, 3] - ref_b[:, 1])                    # native px
        D = np.hypot(cx[:, None] - cx[None, :], cy[:, None] - cy[None, :])
        np.fill_diagonal(D, np.inf)
        nn = D.min(axis=1) / np.maximum(diam, 1e-6)           # in head-diameters
        density = (D < (3.0 * diam[:, None])).sum(axis=1)

        det_b, det_c = boxes_of(model.predict(frame, imgsz=OP_IMGSZ,
                                              conf=OP_CONF, verbose=False))
        M = iou_matrix(ref_b, det_b)
        for r in range(len(ref_b)):
            if ref_px[r] < 12:
                continue
            j = int(M[r].argmax()) if M.shape[1] else -1
            rows.append((float(nn[r]), int(density[r]),
                         bool(j >= 0 and M[r, j] >= IOU_MATCH)))
    cap.release()

    def bucket(key, edges, label):
        out = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            sel = [x for x in rows if lo <= key(x) < hi]
            if len(sel) < 15:
                continue
            out.append({label: f"{lo}-{hi}" if hi < 1e8 else f"{lo}+",
                        "n": len(sel),
                        "recall": round(100 * sum(1 for x in sel if x[2]) / len(sel), 1)})
        return out

    result = {
        "samples": len(rows),
        "by_nearest_neighbour_head_diameters":
            bucket(lambda x: x[0], [0, 1.0, 1.5, 2.0, 3.0, 5.0, 1e9], "spacing"),
        "by_local_density_within_3_diameters":
            bucket(lambda x: x[1], [0, 1, 2, 3, 5, 8, 1e9], "neighbours"),
    }
    with open("/out/crowd_sweep.json", "w") as fh:
        json.dump(result, fh, indent=1)
    print("WROTE /out/crowd_sweep.json", file=sys.stderr)


if __name__ == "__main__":
    main()
