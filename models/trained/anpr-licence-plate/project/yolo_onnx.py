"""
yolo_onnx.py — minimal YOLOv8 detector on onnxruntime (no torch, no ultralytics).

Why: the AI image already ships onnxruntime-gpu + OpenCV; pulling a CUDA torch
stack just to run two small detectors is 3-4 GB of image and a second runtime
to keep patched. Export once (`yolo export format=onnx`), run everywhere the
rest of Trinetra already runs. TensorRT later is one provider string away.

Handles the standard ultralytics export layout (1, 4+nc, N) and its transpose.
"""

from __future__ import annotations

import os
import threading

import cv2
import numpy as np


def _providers(pref: str | None) -> list[str]:
    import onnxruntime as ort

    avail = ort.get_available_providers()
    want = []
    if (pref or "cuda").lower() != "cpu":
        for p in ("TensorrtExecutionProvider", "CUDAExecutionProvider"):
            if p in avail and (pref or "").lower() in ("", "cuda", "gpu", "0", "tensorrt", "trt"):
                if p.startswith("Tensorrt") and (pref or "").lower() not in ("tensorrt", "trt"):
                    continue
                want.append(p)
    want.append("CPUExecutionProvider")
    return want


class YoloOnnx:
    def __init__(
        self,
        path: str,
        *,
        conf: float = 0.25,
        iou: float = 0.45,
        classes: list[int] | None = None,
        device: str | None = None,
        imgsz: int = 640,
    ):
        import onnxruntime as ort

        if not os.path.exists(path):
            raise FileNotFoundError(path)
        so = ort.SessionOptions()
        so.log_severity_level = 3
        self.sess = ort.InferenceSession(path, so, providers=_providers(device or os.getenv("ANPR_DEVICE")))
        inp = self.sess.get_inputs()[0]
        self.input_name = inp.name
        shape = inp.shape
        self.imgsz = int(shape[2]) if isinstance(shape[2], int) else imgsz
        self.conf = conf
        self.iou = iou
        self.classes = set(classes) if classes else None
        self.provider = self.sess.get_providers()[0]
        self._lock = threading.Lock()
        self.path = path
        # class names: ultralytics writes `names` (repr of {id: name}) into the
        # ONNX metadata on export — the worker maps ids through vehicle_types
        # with them. None when the model carries no names.
        self.names: dict[int, str] | None = None
        try:
            raw = (self.sess.get_modelmeta().custom_metadata_map or {}).get("names")
            if raw:
                import ast

                nm = ast.literal_eval(raw)
                if isinstance(nm, dict):
                    self.names = {int(k): str(v) for k, v in nm.items()}
                elif isinstance(nm, (list, tuple)):
                    self.names = {i: str(v) for i, v in enumerate(nm)}
        except Exception:  # noqa: BLE001 — names are optional
            self.names = None

    # ── pre / post ───────────────────────────────────────────────────────
    def _letterbox(self, bgr: np.ndarray):
        h, w = bgr.shape[:2]
        s = min(self.imgsz / h, self.imgsz / w)
        nh, nw = int(round(h * s)), int(round(w * s))
        resized = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((self.imgsz, self.imgsz, 3), 114, np.uint8)
        top, left = (self.imgsz - nh) // 2, (self.imgsz - nw) // 2
        canvas[top : top + nh, left : left + nw] = resized
        x = canvas[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
        return x[None], s, left, top

    def __call__(self, bgr: np.ndarray) -> np.ndarray:
        """→ (N, 6) float32: x1, y1, x2, y2, score, class — in source pixels."""
        x, s, left, top = self._letterbox(bgr)
        with self._lock:
            out = self.sess.run(None, {self.input_name: x})[0]
        pred = out[0]
        if pred.ndim != 2:
            return np.zeros((0, 6), np.float32)
        # (4+nc, N) → (N, 4+nc)
        if pred.shape[0] < pred.shape[1]:
            pred = pred.T
        boxes = pred[:, :4]
        scores_all = pred[:, 4:]
        if scores_all.shape[1] == 0:
            return np.zeros((0, 6), np.float32)
        cls = scores_all.argmax(1)
        score = scores_all[np.arange(len(cls)), cls]
        keep = score >= self.conf
        if self.classes is not None:
            keep &= np.isin(cls, list(self.classes))
        if not keep.any():
            return np.zeros((0, 6), np.float32)
        boxes, score, cls = boxes[keep], score[keep], cls[keep]
        cx, cy, w, h = boxes.T
        x1, y1 = cx - w / 2, cy - h / 2
        xywh = np.stack([x1, y1, w, h], 1).astype(np.float32)
        idx = cv2.dnn.NMSBoxes(
            xywh.tolist(), score.astype(np.float32).tolist(), float(self.conf), float(self.iou)
        )
        if idx is None or len(idx) == 0:
            return np.zeros((0, 6), np.float32)
        idx = np.asarray(idx).ravel()
        x1, y1, w, h = xywh[idx].T
        x2, y2 = x1 + w, y1 + h
        # undo letterbox
        H, W = bgr.shape[:2]
        x1 = np.clip((x1 - left) / s, 0, W - 1)
        x2 = np.clip((x2 - left) / s, 0, W - 1)
        y1 = np.clip((y1 - top) / s, 0, H - 1)
        y2 = np.clip((y2 - top) / s, 0, H - 1)
        return np.stack([x1, y1, x2, y2, score[idx], cls[idx].astype(np.float32)], 1).astype(np.float32)


if __name__ == "__main__":
    import sys
    import time

    m = YoloOnnx(sys.argv[1], conf=0.25)
    img = cv2.imread(sys.argv[2]) if len(sys.argv) > 2 else np.zeros((480, 640, 3), np.uint8)
    t0 = time.perf_counter()
    for _ in range(5):
        det = m(img)
    print(m.provider, "%.1f ms" % ((time.perf_counter() - t0) / 5 * 1000), det[:10])
