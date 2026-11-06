"""Optional face-identity fusion: name each activity track from vms_face.

activity-monitor tracks BODIES (pose) with anonymous per-stream track IDs.
vms_face recognises FACES and publishes them per camera to the Redis channel
`vms.cam.state:{camera_id}`, whose payload carries `camera_code` (== the VMS
monitorId) and a `boxes` list where recognised faces carry a `name`:

    {"event":"frame","camera_code":"<monitorId>","frame_w":1920,"frame_h":1080,
     "boxes":[{"x1":..,"y1":..,"x2":..,"y2":..,"name":"Pranaya", ...}]}

This subscribes to that channel and, given a body box, returns the name whose
face centre falls inside the box's upper (head) region. Coordinates are
normalised to [0,1] so the two capture pipelines can run at different
resolutions.

Wholly optional: if redis / vms_face isn't reachable the provider stays empty
and resolve() returns None, so the ledger keeps anonymous per-track keys.
"""
from __future__ import annotations

import json
import logging
import threading
import time

log = logging.getLogger("activity_monitor.identity")


class IdentityProvider:
    def __init__(self, redis_url: str, channel_prefix: str = "vms.cam.state",
                 ttl_sec: float = 3.0, head_region: float = 0.6):
        self.redis_url = redis_url
        self.pattern = f"{channel_prefix}:*"
        self.ttl = ttl_sec
        self.head_region = head_region
        self._lock = threading.Lock()
        self._by_camera: dict[str, dict] = {}  # camera_code -> {ts, faces:[{name,cx,cy}]}
        self._stop = threading.Event()
        self._pubsub = None
        self._thread = threading.Thread(target=self._run, name="identity-sub", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._pubsub is not None:
                self._pubsub.close()
        except Exception:
            pass

    # -- subscriber thread ------------------------------------------------
    def _run(self) -> None:
        try:
            import redis  # optional dependency, imported lazily
        except Exception:
            log.warning("identity fusion OFF: `redis` package not installed "
                        "(pip install 'activity-monitor[identity]')")
            return
        while not self._stop.is_set():
            try:
                client = redis.Redis.from_url(self.redis_url, decode_responses=True)
                self._pubsub = client.pubsub()
                self._pubsub.psubscribe(self.pattern)
                log.info("identity: subscribed to %s", self.pattern)
                for msg in self._pubsub.listen():
                    if self._stop.is_set():
                        break
                    if msg.get("type") != "pmessage":
                        continue
                    self._ingest(msg.get("data"))
            except Exception as e:  # noqa: BLE001 — reconnect on any bus error
                if self._stop.is_set():
                    break
                log.warning("identity: subscribe error (%s); retrying in 3s", e)
                if self._stop.wait(3.0):
                    break

    def _ingest(self, raw) -> None:
        try:
            p = json.loads(raw)
        except Exception:
            return
        if p.get("event") != "frame":
            return
        cam = p.get("camera_code")
        if not cam:
            return
        fw = float(p.get("frame_w") or 0) or 1.0
        fh = float(p.get("frame_h") or 0) or 1.0
        faces = []
        for b in p.get("boxes") or []:
            name = b.get("name")
            if not name:
                continue  # unrecognised face — no identity to lend
            x1, y1, x2, y2 = b.get("x1"), b.get("y1"), b.get("x2"), b.get("y2")
            if None in (x1, y1, x2, y2):
                continue
            faces.append({
                "name": name,
                "cx": ((x1 + x2) / 2.0) / fw,
                "cy": ((y1 + y2) / 2.0) / fh,
            })
        with self._lock:
            self._by_camera[cam] = {"ts": time.time(), "faces": faces}

    # -- lookup -----------------------------------------------------------
    def resolve(self, camera_code, person_box, frame_w, frame_h) -> str | None:
        """Name whose face centre lies in the person box's upper region, else None."""
        if not camera_code:
            return None
        with self._lock:
            entry = self._by_camera.get(camera_code)
            if not entry or time.time() - entry["ts"] > self.ttl:
                return None
            faces = list(entry["faces"])
        if not faces:
            return None
        fw = float(frame_w) or 1.0
        fh = float(frame_h) or 1.0
        x1, y1 = person_box[0] / fw, person_box[1] / fh
        x2, y2 = person_box[2] / fw, person_box[3] / fh
        if x2 <= x1 or y2 <= y1:
            return None
        head_cut = y1 + self.head_region * (y2 - y1)
        cx0 = (x1 + x2) / 2.0
        best, best_d = None, 1e9
        for f in faces:
            if x1 <= f["cx"] <= x2 and y1 <= f["cy"] <= head_cut:
                d = abs(f["cx"] - cx0)  # nearest the body's horizontal centre wins
                if d < best_d:
                    best_d, best = d, f["name"]
        return best
