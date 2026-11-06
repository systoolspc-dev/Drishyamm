from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from vms_face.config import settings
from vms_face.core.executors import get_gpu_pool, get_io_pool
from vms_face.core.logging import get_logger
from vms_face.domain.schemas import FaceCandidate
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import ObjectStore
from vms_face.infra.recognizers import Recognizer
from vms_face.infra.redis_bus import RedisBus
from vms_face.services.face_quality import FaceQualityGate

log = get_logger(__name__)


@dataclass(slots=True)
class DeepStreamObject:
    """Object metadata extracted from DeepStream NvDsObjectMeta."""

    track_id: str
    bbox: list[float]
    confidence: float
    class_id: int | None = None
    label: str | None = None


@dataclass(slots=True)
class DeepStreamFrame:
    """Frame payload handed from a DeepStream appsink/probe into vms_face."""

    tenant_id: uuid.UUID
    camera_id: uuid.UUID
    camera_code: str
    bgr: np.ndarray
    ts: float
    seq: int
    objects: list[DeepStreamObject]
    zone: str | None = None


class DeepStreamCandidateBridge:
    """Turns DeepStream detections into the normal Redis FaceCandidate stream.

    DeepStream should own RTSP ingest, GPU decode, TensorRT detector, and
    tracker. This bridge keeps the existing vms_face brain: quality gate,
    recognizer embedding, snapshots, Redis FaceCandidate, match worker, Qdrant,
    events, alerts, and the supervised learning queue.

    The bridge expects a BGR frame plus DeepStream object boxes. The current
    repo's opt-in deepstream_api exposes metadata only; production integration
    should add an appsink or GPU-buffer copy stage and call handle_frame().
    """

    def __init__(
        self,
        *,
        runtime: FaceRuntime,
        recognizer: Recognizer,
        bus: RedisBus,
        objects: ObjectStore,
        quality: FaceQualityGate,
    ) -> None:
        self._runtime = runtime
        self._recognizer = recognizer
        self._bus = bus
        self._objects = objects
        self._quality = quality

    async def handle_frame(self, frame: DeepStreamFrame) -> int:
        if frame.bgr.size == 0:
            return 0
        published = 0
        loop = asyncio.get_running_loop()
        for obj in frame.objects:
            face_crop = _crop(frame.bgr, obj.bbox)
            if face_crop is None:
                continue

            observations = await loop.run_in_executor(get_gpu_pool(), self._runtime.detect, face_crop, 1)
            if not observations:
                continue
            obs = max(observations, key=lambda item: item.area)

            verdict = await loop.run_in_executor(get_io_pool(), self._quality.evaluate, face_crop, obs)
            if not verdict.passed:
                continue

            embedding = self._recognizer.reuse_existing(obs.embedding)
            if embedding is None and obs.landmark_5 is not None:
                embedding = await loop.run_in_executor(get_gpu_pool(), self._recognizer.embed, face_crop, obs.landmark_5)
            if embedding is None:
                continue

            snapshot_key = _snapshot_key(frame.tenant_id, frame.camera_id, obj.track_id)
            snapshot_uri = f"s3://{settings.minio_bucket_snapshots}/{snapshot_key}"
            asyncio.create_task(self._upload_snapshot(loop, face_crop, snapshot_key))

            h, w = frame.bgr.shape[:2]
            candidate = FaceCandidate(
                tenant_id=frame.tenant_id,
                camera_id=frame.camera_id,
                track_id=str(obj.track_id),
                occurred_at=dt.datetime.fromtimestamp(frame.ts, tz=dt.timezone.utc),
                bbox=[float(v) for v in obj.bbox],
                det_score=float(obj.confidence),
                quality_score=verdict.score,
                embedding=embedding.tolist(),
                snapshot_uri=snapshot_uri,
                extra={
                    "camera_code": frame.camera_code,
                    "frame_seq": frame.seq,
                    "frame_w": w,
                    "frame_h": h,
                    "face_px": min(obs.width, obs.height),
                    "blur_var": verdict.blur_var,
                    "brightness": verdict.brightness,
                    "class_id": obj.class_id,
                    "label": obj.label,
                    "recognizer": self._recognizer.name,
                    "source_backend": "deepstream",
                    "zone": frame.zone,
                },
            )
            await self._bus.publish_detection(candidate.model_dump(mode="json"))
            published += 1
        return published

    async def _upload_snapshot(
        self,
        loop: asyncio.AbstractEventLoop,
        crop_bgr: np.ndarray,
        key: str,
    ) -> None:
        try:
            await loop.run_in_executor(get_io_pool(), _store_crop, self._objects, crop_bgr, key)
        except Exception as e:
            log.warning("deepstream bridge snapshot upload failed", err=str(e), key=key)


def _crop(frame_bgr: np.ndarray, bbox: list[float]) -> np.ndarray | None:
    h, w = frame_bgr.shape[:2]
    bw = max(1, int(bbox[2] - bbox[0]))
    bh = max(1, int(bbox[3] - bbox[1]))
    pad_x = int(bw * 0.35)
    pad_y = int(bh * 0.45)
    x1, y1 = max(0, int(bbox[0]) - pad_x), max(0, int(bbox[1]) - pad_y)
    x2, y2 = min(w, int(bbox[2]) + pad_x), min(h, int(bbox[3]) + pad_y)
    if x2 <= x1 or y2 <= y1:
        return None
    crop = frame_bgr[y1:y2, x1:x2]
    return crop if crop.size else None


def _snapshot_key(tenant_id: uuid.UUID, camera_id: uuid.UUID, track_id: str) -> str:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{tenant_id}/{camera_id}/deepstream-{track_id}/{ts}_{uuid.uuid4().hex[:8]}.jpg"


def _store_crop(objects: ObjectStore, crop_bgr: np.ndarray, key: str) -> str | None:
    ok, buf = cv2.imencode(".jpg", crop_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    if not ok:
        return None
    return objects.put_bytes(settings.minio_bucket_snapshots, key, buf.tobytes())
