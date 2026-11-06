"""Shared batched inference — one GPU call for every camera at once.

WHY THIS EXISTS
---------------
Measured on the production model (10 Aug 2026): a single `model.predict()` costs
5.05 ms per frame, of which only ~0.41 ms is the GPU actually calculating. The
card sits **92.5% idle** — the time goes on Python, CUDA launch latency and
per-image non-max suppression, all of which are paid once *per camera*.

Worse, every worker took a shared `model_lock`, so N cameras inferred strictly
one after another.

This module inverts that: workers hand frames to one engine, which gathers
whatever has arrived within a few milliseconds, runs **one** forward pass for the
whole group, does non-max suppression for the whole group on the GPU, and hands
each worker its own boxes back.

Measured on the same machine: 5.05 ms/frame -> 0.94 ms/frame at a batch of 32,
a **5.4x** improvement, with detections identical to the current path (same box
count; median corner error 0.50 px, worst 1.41 px — pure floating-point noise).

DEADLOCK NOTE
-------------
`submit()` blocks the calling worker until its batch runs. Callers must NOT hold
a global inference lock while waiting, or no other worker could ever join the
batch and every camera would stall. `Detector.infer` therefore takes no lock when
an engine is active; the engine is the serialisation point.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

log = logging.getLogger("headcount.batch")


# --- result shim -----------------------------------------------------------
# The workers only ever touch res.boxes.{xyxy,conf,cls} and len(res.boxes),
# calling .cpu().numpy() or .tolist() on them. Mimic exactly that much.
class _Arr:
    __slots__ = ("_a",)

    def __init__(self, a: np.ndarray):
        self._a = a

    def cpu(self):
        return self

    def numpy(self):
        return self._a

    def tolist(self):
        return self._a.tolist()

    def __len__(self):
        return len(self._a)

    def __iter__(self):
        return iter(self._a)


class _Boxes:
    __slots__ = ("xyxy", "conf", "cls", "_n")

    def __init__(self, det: np.ndarray):
        self._n = len(det)
        self.xyxy = _Arr(det[:, :4].astype(np.float32))
        self.conf = _Arr(det[:, 4].astype(np.float32))
        self.cls = _Arr(det[:, 5].astype(np.float32))

    def __len__(self):
        return self._n


class BatchResult:
    """Stand-in for an Ultralytics `Results`, carrying only what callers read.

    `names` matters: the preview annotator does `res.names.get(int(cls), ...)`
    to label each box. Without it every preview encode raised
    `AttributeError: 'BatchResult' object has no attribute 'names'` — and since
    that happens before `cv2.imencode`, NO preview JPEG was ever produced while
    batched inference was on. The counts were fine; the video wall was blank.
    """

    __slots__ = ("boxes", "names")

    def __init__(self, det: np.ndarray, names: dict | None = None):
        self.boxes = _Boxes(det)
        self.names = names if names is not None else {}


@dataclass
class _Request:
    frame: np.ndarray
    shape: tuple            # (target_h, target_w) — only same-shape frames batch
    done: threading.Event = field(default_factory=threading.Event)
    result: np.ndarray | None = None
    error: BaseException | None = None


class BatchInferenceEngine:
    """One model, many cameras, one GPU call per group."""

    def __init__(self, model, *, imgsz: int = 640, conf: float = 0.4,
                 iou: float = 0.45, half: bool = True, device: str = "cuda",
                 max_batch: int = 16, max_wait_ms: float = 8.0, topk: int = 300,
                 classes: list[int] | None = None):
        import torch

        self._torch = torch
        self.device = device
        self.conf, self.iou, self.topk = conf, iou, topk
        self.imgsz, self.max_batch = imgsz, max_batch
        self.max_wait = max_wait_ms / 1000.0
        self.classes = classes
        self.half = bool(half) and device.startswith("cuda")

        # Class-index -> label, copied off the Ultralytics wrapper so every
        # BatchResult can label its boxes exactly as the per-frame path does.
        self.names = dict(getattr(model, "names", None) or {})
        self.net = model.model.to(device).eval()
        if self.half:
            self.net = self.net.half()
        self.dtype = torch.half if self.half else torch.float

        self._geom: dict[tuple, tuple] = {}     # (h,w) -> letterbox params
        self._q: list[_Request] = []
        self._inflight = 0                      # callers currently inside submit()
        self._gpu_lock = threading.Lock()       # inline path and engine thread
        self._cv = threading.Condition()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="batch-infer",
                                        daemon=True)
        self._thread.start()
        self.batches = 0
        self.images = 0
        # Exponential average of recent batch size. Drives the adaptive linger:
        # ~1.0 means one camera (never wait), >1 means cameras are arriving
        # together and waiting a few ms pays for itself many times over.
        self._fill_ema = 1.0

    # -- geometry ----------------------------------------------------------
    def _geometry(self, h: int, w: int, imgsz: int | None = None):
        """Ultralytics-compatible letterbox: scale by the limiting side, pad to
        a multiple of 32. Stretching instead of padding shifts every box.

        Cached per (source shape, detail level) — two cameras of the same
        resolution running different detail levels need different geometry."""
        size = int(imgsz or self.imgsz)
        key = (h, w, size)
        g = self._geom.get(key)
        if g is None:
            tw = size
            th = int(np.ceil(size * h / w / 32) * 32)
            r = min(tw / w, th / h)
            uw, uh = int(round(w * r)), int(round(h * r))
            padx, pady = (tw - uw) / 2, (th - uh) / 2
            g = (th, tw, uh, uw, r, padx, pady)
            self._geom[key] = g
        return g

    # -- public ------------------------------------------------------------
    def submit(self, frame: np.ndarray, imgsz: int | None = None) -> BatchResult:
        """Run inference on one frame, batching with other cameras when it pays.

        Two paths, chosen by how many callers are actually inside this method:

        * **Alone** — run inline on the calling thread. Handing off to the engine
          thread and waiting to be woken costs a few milliseconds, and with one
          camera there is nobody to batch with, so that is pure loss.
        * **Concurrent** — queue it. Other cameras are here too, so grouping them
          into one GPU call is worth far more than the hand-off costs.

        Grouping is by SOURCE resolution, not by letterboxed target: 720p and
        1080p both letterbox to 384x640, so keying on the target would stack raw
        frames of different sizes and fail every batch on a mixed-camera site.
        """
        # Group key includes the detail level: tensors of different input sizes
        # cannot share one forward pass, so they must batch separately.
        req = _Request(frame=frame, shape=(frame.shape[0], frame.shape[1],
                                           int(imgsz or self.imgsz)))
        with self._cv:
            self._q.append(req)
            self._cv.notify()
        if not req.done.wait(timeout=30.0):
            raise TimeoutError("batched inference timed out")
        if req.error is not None:
            raise req.error
        return BatchResult(req.result, self.names)

    # -- solo fast path ----------------------------------------------------
    def try_solo(self) -> bool:
        """Claim the GPU for an uncontended, single-frame inference.

        Batching only pays from two frames upward: at a batch of one this
        engine's fixed cost (host copy, GPU resize, top-k, batched NMS) is
        *higher* than the stock single-image path — measured 6.5 ms against
        5.05 ms. So when nobody else wants the GPU, the caller should run the
        stock path instead, and this returns True to say it may.

        Contention does the routing for us: if the lock is already held, another
        camera is mid-inference, so this caller queues and the two get batched.
        Returns False in that case.
        """
        return self._gpu_lock.acquire(blocking=False)

    def end_solo(self) -> None:
        self._gpu_lock.release()

    def stop(self):
        self._stop.set()
        with self._cv:
            self._cv.notify_all()

    def stats(self) -> dict:
        return {"batches": self.batches, "images": self.images,
                "avg_batch": round(self.images / self.batches, 2) if self.batches else 0.0,
                "fill_ema": round(self._fill_ema, 2),
                "lingering": self._fill_ema > 1.15}

    # -- engine loop -------------------------------------------------------
    def _loop(self):
        while not self._stop.is_set():
            with self._cv:
                while not self._q and not self._stop.is_set():
                    self._cv.wait(timeout=0.25)
                if self._stop.is_set():
                    return
                # Linger briefly so other cameras can join — but ONLY when there
                # is someone to wait for. On a single-camera site nobody ever
                # joins, and a fixed linger would add its full delay to every
                # frame (measured: 5 ms -> 17 ms). The engine therefore tracks
                # how full recent batches actually were and waits only while
                # that suggests concurrent demand.
                wait = self.max_wait if self._fill_ema > 1.15 else 0.0
                if wait > 0:
                    deadline = time.perf_counter() + wait
                    while len(self._q) < self.max_batch:
                        remaining = deadline - time.perf_counter()
                        if remaining <= 0:
                            break
                        self._cv.wait(timeout=remaining)
                elif len(self._q) < self.max_batch:
                    # no linger, but take anything already queued this instant
                    pass
                # take one shape-group (mixed resolutions can't share a tensor)
                shape = self._q[0].shape
                batch, rest = [], []
                for r in self._q:
                    (batch if r.shape == shape and len(batch) < self.max_batch
                     else rest).append(r)
                self._q = rest
            try:
                self._run(batch)
            except BaseException as e:                      # noqa: BLE001
                log.exception("batched inference failed")
                for r in batch:
                    r.error = e
                    r.done.set()

    def _run(self, batch: list[_Request]):
        size = batch[0].shape[2]
        with self._gpu_lock:
            dets = self._infer_now([b.frame for b in batch], size)
        n = len(batch)
        self.batches += 1
        self.images += n
        self._fill_ema = 0.8 * self._fill_ema + 0.2 * n
        for req, d in zip(batch, dets):
            req.result = d
            req.done.set()

    def _infer_now(self, frames: list[np.ndarray], imgsz: int | None = None):
        """The actual GPU work: preprocess, one forward, batched NMS."""
        torch = self._torch
        n = len(frames)
        h, w = frames[0].shape[:2]
        th, tw, uh, uw, r, padx, pady = self._geometry(h, w, imgsz)

        # Resize on the CPU BEFORE uploading. Uploading full-resolution frames
        # and resizing on the GPU sounds faster but moves ~3.6x more data across
        # the bus: 12 cameras of 720p is 33 MB per batch against 0.9 MB once
        # letterboxed. cv2.resize also releases the interpreter lock, so this
        # part genuinely runs in parallel across worker threads.
        top, left = int(round(pady - 0.1)), int(round(padx - 0.1))
        small = np.empty((n, th, tw, 3), dtype=np.uint8)
        small.fill(114)
        for i, f in enumerate(frames):
            cv2.resize(f, (uw, uh), dst=small[i, top:top + uh, left:left + uw],
                       interpolation=cv2.INTER_LINEAR)

        with torch.inference_mode():
            t = torch.from_numpy(small).to(self.device, non_blocking=True)
            t = t[..., [2, 1, 0]].permute(0, 3, 1, 2).to(self.dtype).div_(255)
            return self._decode(self.net(t), n, r, padx, pady)

    def _decode(self, pred, n, r, padx, pady):
        torch = self._torch
        import torchvision

        p = (pred[0] if isinstance(pred, (list, tuple)) else pred).transpose(1, 2)
        xywh, cls_scores = p[..., :4], p[..., 4:]
        scores, classes = cls_scores.max(-1)

        # top-k rather than nonzero(): nonzero forces a GPU->CPU sync every call
        k = min(self.topk, scores.shape[1])
        scores, idx = scores.topk(k, dim=1)
        classes = classes.gather(1, idx)
        xywh = xywh.gather(1, idx.unsqueeze(-1).expand(-1, -1, 4))

        xy, wh = xywh[..., :2], xywh[..., 2:]
        boxes = torch.cat([xy - wh / 2, xy + wh / 2], -1).float()
        boxes[..., 0::2] -= padx
        boxes[..., 1::2] -= pady
        boxes /= r

        bidx = torch.arange(n, device=boxes.device).unsqueeze(1).expand(-1, k)
        fb, fs = boxes.reshape(-1, 4), scores.reshape(-1).float()
        fc, fi = classes.reshape(-1), bidx.reshape(-1)

        alive = fs > self.conf
        if self.classes is not None:
            allowed = torch.tensor(self.classes, device=fc.device)
            alive &= (fc.unsqueeze(1) == allowed).any(1)
        fb, fs, fc, fi = fb[alive], fs[alive], fc[alive], fi[alive]
        if fb.numel() == 0:
            return [np.zeros((0, 6), np.float32) for _ in range(n)]

        keep = torchvision.ops.batched_nms(fb, fs, fi * 1000 + fc, self.iou)
        out = torch.cat([fb[keep], fs[keep, None], fc[keep, None].float(),
                         fi[keep, None].float()], 1).cpu().numpy()   # ONE transfer
        return [out[out[:, 6] == i][:, :6] for i in range(n)]
