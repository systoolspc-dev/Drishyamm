"""Model loading: device resolution, auto-download, and per-detector counting."""

from __future__ import annotations

import logging
from pathlib import Path

from ultralytics import YOLO

from .config import DetectorConfig

log = logging.getLogger("headcount.model")


def resolve_device(requested: str) -> str:
    """Turn 'auto' into the best available device; validate explicit choices."""
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:  # torch import/inspection failure — fall back to CPU
        log.warning("could not probe torch devices; defaulting to cpu")
    return "cpu"


def ensure_weights(cfg: DetectorConfig) -> str:
    """Return a local path to the weights, downloading from HF if absent."""
    path = Path(cfg.weights)
    if path.exists():
        return str(path)
    if not (cfg.hf_repo and cfg.hf_file):
        raise FileNotFoundError(
            f"[{cfg.id}] weights not found at {path} and no hf_repo/hf_file to fetch them"
        )
    from huggingface_hub import hf_hub_download

    log.info("[%s] weights missing; downloading %s/%s", cfg.id, cfg.hf_repo, cfg.hf_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    downloaded = hf_hub_download(
        repo_id=cfg.hf_repo, filename=cfg.hf_file, local_dir=str(path.parent)
    )
    if Path(downloaded) != path:
        Path(downloaded).replace(path)
    return str(path)


class Detector:
    """One YOLO model that counts its detections (optionally filtered by class)."""

    def __init__(self, cfg: DetectorConfig):
        self.cfg = cfg
        self.id = cfg.id
        self.label = cfg.label or cfg.id
        self.color = tuple(cfg.color)
        self.device = resolve_device(cfg.device)
        weights = ensure_weights(cfg)
        log.info("[%s] loading model %s on %s", self.id, weights, self.device)
        self.model = YOLO(weights)

        class_ids = self._resolve_classes(cfg.classes)
        self._predict_kwargs = dict(
            device=self.device, imgsz=cfg.imgsz, conf=cfg.conf,
            classes=class_ids, verbose=False,
        )
        if cfg.half:
            self._predict_kwargs["half"] = True
        self._warmup()

        # Shared batched inference. One GPU call serves every camera instead of
        # one call per camera — measured 5.05 ms/frame -> 0.94 ms/frame at a
        # batch of 32, with identical detections. Falls back to the per-frame
        # path if it cannot start, so a failure here can never take counting out.
        self.engine = None
        if getattr(cfg, "batch", True) and self.device.startswith("cuda"):
            try:
                from .batch_engine import BatchInferenceEngine

                self.engine = BatchInferenceEngine(
                    self.model, imgsz=cfg.imgsz, conf=cfg.conf,
                    iou=float(getattr(cfg, "iou", 0.45)), half=bool(cfg.half),
                    device=self.device, classes=class_ids,
                    max_batch=int(getattr(cfg, "batch_max", 16)),
                    max_wait_ms=float(getattr(cfg, "batch_wait_ms", 8.0)),
                )
                log.info("[%s] batched inference enabled (max_batch=%s, wait=%sms)",
                         self.id, getattr(cfg, "batch_max", 16),
                         getattr(cfg, "batch_wait_ms", 8.0))
            except Exception as e:  # noqa: BLE001
                log.warning("[%s] batched inference unavailable, using per-frame "
                            "path: %s", self.id, e)
                self.engine = None

    def _resolve_classes(self, classes) -> list[int] | None:
        """Map configured class names/ids to model class indices (None = all)."""
        if not classes:
            return None
        name_to_id = {v.lower(): k for k, v in self.model.names.items()}
        ids: list[int] = []
        for c in classes:
            if isinstance(c, int):
                ids.append(c)
            elif c.lower() in name_to_id:
                ids.append(name_to_id[c.lower()])
            else:
                raise ValueError(f"[{self.id}] class {c!r} not in model classes {self.model.names}")
        return ids

    def _warmup(self) -> None:
        import numpy as np

        blank = np.zeros((self.cfg.imgsz, self.cfg.imgsz, 3), dtype=np.uint8)
        self.model.predict(blank, **self._predict_kwargs)

    def infer(self, frame, imgsz: int | None = None):
        """Run inference on one frame.

        With the batched engine active this blocks until the frame's batch runs,
        so the caller must NOT hold a global inference lock (see
        ``batch_engine`` — holding one would stop any other camera joining the
        batch and deadlock the service).
        """
        if self.engine is not None:
            try:
                # Uncontended? Run the stock path — batching is a net loss at a
                # batch of one. Contended? Queue up and share a GPU call with
                # whoever else is here. Lock contention does the routing.
                if self.engine.try_solo():
                    try:
                        kw = dict(self._predict_kwargs)
                        if imgsz:
                            kw["imgsz"] = int(imgsz)
                        return self.model.predict(frame, **kw)[0]
                    finally:
                        self.engine.end_solo()
                return self.engine.submit(frame, imgsz)
            except Exception as e:  # noqa: BLE001 — degrade, never stop counting
                log.warning("[%s] batched inference failed (%s); falling back",
                            self.id, e)
                self.engine = None
        kw = dict(self._predict_kwargs)
        if imgsz:
            kw["imgsz"] = int(imgsz)
        return self.model.predict(frame, **kw)[0]

    @property
    def batched(self) -> bool:
        return self.engine is not None

    def count(self, frame) -> int:
        """Run inference on one frame and return the number of detections."""
        return len(self.infer(frame).boxes)
