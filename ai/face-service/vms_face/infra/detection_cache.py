from __future__ import annotations

import asyncio
import threading
import time
from collections import defaultdict, deque
from typing import Any

from vms_face.core.logging import get_logger
from vms_face.core.metrics import CAMERA_PEOPLE_COUNT

log = get_logger(__name__)

# How long the rolling-max smoothing window remembers a count. 2 s lets a
# tracked face survive ~16 frames of momentary occlusion (one person walks
# in front of another) without the displayed count flickering down. Longer
# windows mask real exits; shorter ones flicker. 2 s is a fine middle.
_COUNT_SMOOTH_WINDOW_SEC = 2.0

# Name we consider "unrecognized". MATCHES the orchestrator's default fill
# value in StreamOrchestrator._update_overlay. Match-worker patches override
# to a real name when recognition succeeds.
_UNKNOWN_NAME = "Unknown"


class LatestDetectionCache:
    """Process-local cache of the latest detection state per camera. Drives
    the legacy AI engine API (`GET /api/detections/{camera_id}` polling and
    `WebSocket /ws`) consumed by the AiFeed frontend page.

    Two writers update it:
      1. Per-frame writer — the StreamOrchestrator pushes the current frame's
         boxes (with name=Unknown) every time it processes a frame. This
         shows green/red overlays on the UI immediately, even before the
         match worker has caught up.
      2. Name patcher — an alerts-stream subscriber updates per-track names
         when the match worker emits an alert. Subsequent per-frame writes
         carry the now-known name forward.

    The cache is in-memory and per-process. It assumes the FastAPI app and
    the orchestrator tasks live in the same process — they do, in Phase 1.
    For Phase 2+ multi-node deployment, replace this with a Redis Pub/Sub
    or equivalent fanout."""

    def __init__(self) -> None:
        self._frames: dict[str, dict[str, Any]] = {}
        self._stats: dict[str, dict[str, Any]] = {}
        # (camera_id, track_id) -> {"name": str, "conf": float}
        self._track_names: dict[tuple[str, str], dict[str, Any]] = {}
        self._subscribers: dict[str, set[Any]] = defaultdict(set)
        # Per-camera rolling window of (timestamp, total, known, unknown)
        # for smoothing. Bounded deque — older entries trimmed on read.
        self._count_history: dict[str, deque] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def write_frame(
        self,
        camera_id: str,
        *,
        boxes: list[dict[str, Any]],
        frame_w: int,
        frame_h: int,
        running: bool = True,
        active_tracks: int = 0,
        persons_present: int = 0,
    ) -> None:
        """Boxes should already be in pixel coordinates and may have name=Unknown.
        We patch in names from the track-name cache before storing/broadcasting."""
        # Decorate with names known so far
        now = time.monotonic()
        async with self._lock:
            stats = self._stats.setdefault(
                camera_id,
                {"frames": 0, "fps": 0.0, "last_ts": None},
            )
            stats["frames"] = int(stats.get("frames", 0)) + 1
            last_ts = stats.get("last_ts")
            if isinstance(last_ts, (int, float)) and now > last_ts:
                instant_fps = 1.0 / max(now - float(last_ts), 1e-6)
                prev_fps = float(stats.get("fps") or 0.0)
                stats["fps"] = instant_fps if prev_fps <= 0 else (prev_fps * 0.8) + (instant_fps * 0.2)
            stats["last_ts"] = now

            for box in boxes:
                tk = (camera_id, str(box.get("track_id", "")))
                hit = self._track_names.get(tk)
                # The orchestrator's identity latch now writes the name at the
                # source. Only fill in from the alerts-stream patch when the
                # producer did not know — otherwise a stale patched name would
                # override a latch that has since re-identified the track.
                if hit and str(box.get("name") or _UNKNOWN_NAME) == _UNKNOWN_NAME:
                    box["name"] = hit["name"]
                    if hit.get("conf") is not None:
                        box["conf"] = float(hit["conf"])

            # ── People counting ──
            # Total = visible faces this frame, with YOLOv8 person count taking
            # over when enabled (that's the more comprehensive "humans in
            # scene" signal — catches back-of-head + occluded people).
            #
            # We deliberately do NOT use `active_tracks` here. It includes
            # tracks the Kalman filter is *predicting* through misses, which
            # in practice is a flood of phantom tracks on noisy cameras
            # (SCRFD false positives at det_score=0.6 accumulate for the
            # tracker_max_age=30 frame window = 3.75s at 8fps). The result
            # was empty rooms displaying 16+ people. The 2 s rolling-max
            # smoothing below handles brief face misses without phantoms.
            visible_faces = len(boxes)
            total = max(int(persons_present or 0), visible_faces)
            known = sum(
                1 for b in boxes
                if str(b.get("name") or "").strip() not in ("", _UNKNOWN_NAME)
            )
            unknown = max(0, total - known)
            # Gender breakdown from the track-voted labels the orchestrator
            # puts on each box. Labels are already multi-frame stabilized, so
            # no extra smoothing here; people whose vote hasn't resolved (or
            # who are only visible to YOLO, not the face detector) land in
            # gender_unknown.
            male = sum(1 for b in boxes if b.get("gender") == "Male")
            female = sum(1 for b in boxes if b.get("gender") == "Female")
            gender_unknown = max(0, total - male - female)

            # Maintain rolling-window for smoothing — keep current entry and
            # drop anything older than the window deadline.
            history = self._count_history[camera_id]
            history.append((now, total, known, unknown))
            cutoff = now - _COUNT_SMOOTH_WINDOW_SEC
            while history and history[0][0] < cutoff:
                history.popleft()
            # Smoothed = peak count seen in the window. Resilient to a single
            # frame where the detector momentarily missed a face.
            smoothed_total = max((h[1] for h in history), default=total)
            smoothed_known = max((h[2] for h in history), default=known)
            smoothed_unknown = max((h[3] for h in history), default=unknown)

            # Export to Prometheus so Grafana / ops dashboards can chart
            # occupancy per camera over time.
            CAMERA_PEOPLE_COUNT.labels(camera_id=camera_id, kind="total").set(total)
            CAMERA_PEOPLE_COUNT.labels(camera_id=camera_id, kind="known").set(known)
            CAMERA_PEOPLE_COUNT.labels(camera_id=camera_id, kind="unknown").set(unknown)
            CAMERA_PEOPLE_COUNT.labels(camera_id=camera_id, kind="smoothed_2s").set(smoothed_total)

            payload = {
                "boxes": boxes,
                "frame_w": int(frame_w),
                "frame_h": int(frame_h),
                "running": bool(running),
                "fps": float(stats.get("fps") or 0.0),
                # `persons` stays as the raw current-frame count for backwards
                # compatibility with AiFeed's existing readers. The richer
                # breakdown lives in `people`.
                "persons": total,
                "people": {
                    "total": total,
                    "known": known,
                    "unknown": unknown,
                    "male": male,
                    "female": female,
                    "gender_unknown": gender_unknown,
                    "smoothed_total": smoothed_total,
                    "smoothed_known": smoothed_known,
                    "smoothed_unknown": smoothed_unknown,
                    "window_sec": _COUNT_SMOOTH_WINDOW_SEC,
                },
                "frames": int(stats.get("frames") or 0),
                "ts": time.time(),
            }
            self._frames[camera_id] = payload
            subs = list(self._subscribers.get(camera_id, set()))

        if subs:
            await self._broadcast(subs, payload)

    async def patch_name(
        self,
        camera_id: str,
        track_id: str,
        *,
        name: str,
        conf: float | None = None,
    ) -> None:
        """Record that this track has a confirmed identity. Future frames will
        carry this name. We do NOT push immediately — the next per-frame write
        from the orchestrator will reflect it."""
        # Also patch the current snapshot so the legacy WebSocket turns the
        # active box green as soon as the match worker alert arrives.
        payload: dict[str, Any] | None = None
        subs: list[Any] = []
        async with self._lock:
            self._track_names[(camera_id, str(track_id))] = {
                "name": name,
                "conf": conf if conf is not None else 0.0,
            }
            cur = self._frames.get(camera_id)
            if cur:
                changed = False
                for box in cur.get("boxes", []):
                    if str(box.get("track_id", "")) == str(track_id):
                        box["name"] = name
                        if conf is not None:
                            box["conf"] = float(conf)
                        changed = True
                if changed:
                    payload = self._copy_snapshot(cur)
                    subs = list(self._subscribers.get(camera_id, set()))

        if payload is not None and subs:
            await self._broadcast(subs, payload)

    def get(self, camera_id: str) -> dict[str, Any]:
        return self._copy_snapshot(
            self._frames.get(
                camera_id,
                {
                    "boxes": [],
                    "frame_w": 0,
                    "frame_h": 0,
                    "running": False,
                    "fps": 0.0,
                    "persons": 0,
                    # Default `people` block so callers can read
                    # response.people.total without null-checks even
                    # before the first frame lands.
                    "people": {
                        "total": 0,
                        "known": 0,
                        "unknown": 0,
                        "male": 0,
                        "female": 0,
                        "gender_unknown": 0,
                        "smoothed_total": 0,
                        "smoothed_known": 0,
                        "smoothed_unknown": 0,
                        "window_sec": _COUNT_SMOOTH_WINDOW_SEC,
                    },
                    "frames": 0,
                    "ts": None,
                },
            )
        )

    def is_running(self, camera_id: str) -> bool:
        return bool(self._frames.get(camera_id, {}).get("running", False))

    async def mark_offline(self, camera_id: str) -> None:
        payload: dict[str, Any] | None = None
        subs: list[Any] = []
        async with self._lock:
            cur = self._frames.get(camera_id)
            if cur:
                cur["running"] = False
                cur["boxes"] = []
                cur["persons"] = 0
                cur["people"] = {
                    "total": 0,
                    "known": 0,
                    "unknown": 0,
                    "male": 0,
                    "female": 0,
                    "gender_unknown": 0,
                    "smoothed_total": 0,
                    "smoothed_known": 0,
                    "smoothed_unknown": 0,
                    "window_sec": _COUNT_SMOOTH_WINDOW_SEC,
                }
                cur["fps"] = 0.0
                self._count_history.pop(camera_id, None)
                for kind in ("total", "known", "unknown", "smoothed_2s"):
                    CAMERA_PEOPLE_COUNT.labels(camera_id=camera_id, kind=kind).set(0)
                payload = self._copy_snapshot(cur)
                subs = list(self._subscribers.get(camera_id, set()))

        if payload is not None and subs:
            await self._broadcast(subs, payload)

    def people_snapshot(self) -> dict[str, Any]:
        """Aggregate people counts across all cameras the cache knows about.
        Used by `GET /api/people-count` for the dashboard tile. Reading
        outside the lock: a stale snapshot is fine — this is presentational
        data, not authoritative state."""
        per_camera: list[dict[str, Any]] = []
        running_cameras = 0
        total_now = 0
        known_now = 0
        unknown_now = 0
        male_now = 0
        female_now = 0
        total_smoothed = 0
        for cam_id, frame in self._frames.items():
            if not frame.get("running"):
                continue
            running_cameras += 1
            ppl = frame.get("people") or {}
            t = int(ppl.get("total") or 0)
            k = int(ppl.get("known") or 0)
            u = int(ppl.get("unknown") or 0)
            m = int(ppl.get("male") or 0)
            f = int(ppl.get("female") or 0)
            s = int(ppl.get("smoothed_total") or t)
            total_now += t
            known_now += k
            unknown_now += u
            male_now += m
            female_now += f
            total_smoothed += s
            per_camera.append({
                "camera_id": cam_id,
                "total": t,
                "known": k,
                "unknown": u,
                "male": m,
                "female": f,
                "smoothed_total": s,
                "running": True,
            })
        return {
            "running_cameras": running_cameras,
            "total": total_now,
            "known": known_now,
            "unknown": unknown_now,
            "male": male_now,
            "female": female_now,
            "gender_unknown": max(0, total_now - male_now - female_now),
            "smoothed_total": total_smoothed,
            "cameras": per_camera,
            "window_sec": _COUNT_SMOOTH_WINDOW_SEC,
            "ts": time.time(),
        }

    async def subscribe(self, camera_id: str, ws: Any) -> None:
        async with self._lock:
            self._subscribers[camera_id].add(ws)
        # Push the current snapshot immediately so the client doesn't wait
        snapshot = self.get(camera_id)
        if snapshot:
            try:
                await ws.send_json(snapshot)
            except Exception:
                pass

    async def unsubscribe(self, camera_id: str, ws: Any) -> None:
        async with self._lock:
            if ws in self._subscribers.get(camera_id, set()):
                self._subscribers[camera_id].discard(ws)

    async def _broadcast(self, subs: list[Any], payload: dict[str, Any]) -> None:
        # Fan-out without holding the lock; ignore individual send failures.
        for ws in subs:
            try:
                await ws.send_json(payload)
            except Exception:
                pass

    @staticmethod
    def _copy_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
        copied = dict(snapshot)
        copied["boxes"] = [dict(box) for box in snapshot.get("boxes", [])]
        return copied


_lock = threading.Lock()
_cache: LatestDetectionCache | None = None


def get_detection_cache() -> LatestDetectionCache:
    global _cache
    if _cache is None:
        with _lock:
            if _cache is None:
                _cache = LatestDetectionCache()
    return _cache
