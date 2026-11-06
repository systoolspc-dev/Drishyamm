"""Per-stream capture + multi-detector inference worker.

Each stream runs two threads:
  * a reader that keeps only the *latest* decoded frame (so inference never lags
    behind on buffered RTSP frames), with automatic reconnect and backoff;
  * a processor that pulls the latest frame, runs every configured detector under a
    shared model lock, and updates the smoothed per-detector counts + throughput.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Optional

import cv2

from .config import PipelineConfig, StreamConfig
from .counter import RollingCounter
from .model import Detector

log = logging.getLogger("activity_monitor.stream")


@dataclass
class StreamStats:
    id: str
    name: str
    counts: dict = field(default_factory=dict)      # {label: smoothed count}
    raw_counts: dict = field(default_factory=dict)  # {label: raw count}
    people: list = field(default_factory=list)      # per-person activity states
    activity: dict = field(default_factory=dict)    # {working, on_phone, talking, distracted}
    conversations: list = field(default_factory=list)  # [[id_a, id_b], ...]
    fps: float = 0.0
    status: str = "starting"          # starting | online | reconnecting | stopped | error
    connected: bool = False
    frames_processed: int = 0
    last_frame_ts: Optional[float] = None
    last_error: Optional[str] = None
    _lock: Lock = field(default_factory=Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            age = None if self.last_frame_ts is None else round(time.time() - self.last_frame_ts, 2)
            return {
                "id": self.id,
                "name": self.name,
                "counts": dict(self.counts),
                "raw_counts": dict(self.raw_counts),
                "total": sum(self.counts.values()),
                "people": list(self.people),
                "activity": dict(self.activity),
                "conversations": list(self.conversations),
                "fps": round(self.fps, 1),
                "status": self.status,
                "connected": self.connected,
                "frames_processed": self.frames_processed,
                "seconds_since_last_frame": age,
                "last_error": self.last_error,
            }

    def update(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)


def _open_source(source):
    """cv2 wants an int for a camera index and a str for files/URLs."""
    return int(source) if isinstance(source, str) and source.isdigit() else source


class StreamWorker:
    def __init__(
        self,
        stream: StreamConfig,
        detectors: list[Detector],
        model_lock: Lock,
        pipeline: PipelineConfig,
        preview: bool = False,
        jpeg_quality: int = 70,
        activity=None,
        phone_detector_id: str = "phones",
        ledger=None,
        identity=None,
        vms_camera: str | None = None,
        crosser=None,
        crossing_sink=None,
    ):
        self.cfg = stream
        self.detectors = detectors
        self.model_lock = model_lock
        self.pipe = pipeline
        self.preview = preview
        self.jpeg_quality = jpeg_quality
        self.activity = activity                      # per-stream ActivityAnalyzer or None
        self.phone_detector_id = phone_detector_id
        self.ledger = ledger                          # shared over-time aggregator or None
        self.identity = identity                      # shared face-name provider or None
        self.vms_camera = vms_camera                  # vms_face camera_code for identity lookup
        self.crosser = crosser                        # per-stream LineCrosser or None
        self.crossing_sink = crossing_sink            # callback(stream_id, event) or None
        self.stats = StreamStats(
            id=stream.id, name=stream.name or stream.id,
            counts={d.label: 0 for d in detectors},
            raw_counts={d.label: 0 for d in detectors},
        )
        self.counters = {d.id: RollingCounter(pipeline.smooth_window) for d in detectors}

        self._stop = threading.Event()
        self._frame_lock = Lock()
        self._latest_frame = None
        self._latest_seq = 0
        self._jpeg_lock = Lock()
        self._latest_jpeg: bytes | None = None
        self._reader = threading.Thread(target=self._read_loop, name=f"read-{stream.id}", daemon=True)
        self._processor = threading.Thread(target=self._process_loop, name=f"infer-{stream.id}", daemon=True)

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        self._reader.start()
        self._processor.start()

    def stop(self) -> None:
        self._stop.set()

    def join(self, timeout: float | None = None) -> None:
        self._reader.join(timeout)
        self._processor.join(timeout)
        self.stats.update(status="stopped", connected=False)

    def snapshot(self) -> dict:
        return self.stats.snapshot()

    def get_jpeg(self) -> bytes | None:
        """Latest annotated frame as JPEG bytes (None until one is ready)."""
        with self._jpeg_lock:
            return self._latest_jpeg

    # -- reader thread -----------------------------------------------------
    def _read_loop(self) -> None:
        delay = self.pipe.reconnect_delay
        cap = None
        while not self._stop.is_set():
            if cap is None or not cap.isOpened():
                cap = self._connect()
                if cap is None:
                    self.stats.update(status="reconnecting", connected=False)
                    if self._stop.wait(delay):
                        break
                    delay = min(delay * 2, self.pipe.max_reconnect_delay)
                    continue
                delay = self.pipe.reconnect_delay  # reset backoff on success
                self.stats.update(status="online", connected=True, last_error=None)

            ok, frame = cap.read()
            if not ok or frame is None:
                log.warning("[%s] read failed; will reconnect", self.cfg.id)
                self.stats.update(status="reconnecting", connected=False,
                                  last_error="frame read failed")
                cap.release()
                cap = None
                continue

            with self._frame_lock:
                self._latest_frame = frame
                self._latest_seq += 1
            self.stats.update(last_frame_ts=time.time())

        if cap is not None:
            cap.release()

    def _connect(self):
        source = _open_source(self.cfg.source)
        log.info("[%s] connecting to %r", self.cfg.id, self.cfg.source)
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            log.error("[%s] could not open source %r", self.cfg.id, self.cfg.source)
            self.stats.update(last_error=f"cannot open source {self.cfg.source!r}")
            cap.release()
            return None
        # Keep the driver buffer shallow so we stay near real-time.
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        return cap

    # -- processor thread --------------------------------------------------
    def _process_loop(self) -> None:
        last_seq = 0
        frame_gap = 0
        ema_fps = 0.0
        prev_t = None
        min_interval = 1.0 / self.pipe.target_fps if self.pipe.target_fps > 0 else 0.0

        while not self._stop.is_set():
            # Watchdog: flag a silently-dead stream.
            if self.stats.last_frame_ts and (time.time() - self.stats.last_frame_ts) > self.pipe.read_timeout:
                self.stats.update(status="reconnecting", connected=False,
                                  last_error="read timeout")

            with self._frame_lock:
                frame = self._latest_frame
                seq = self._latest_seq

            if frame is None or seq == last_seq:
                if self._stop.wait(0.005):
                    break
                continue
            last_seq = seq

            # Frame-skip to save compute on edge hardware.
            frame_gap += 1
            if frame_gap < self.pipe.infer_every:
                continue
            frame_gap = 0

            # Run every detector on this frame (all under the shared model lock).
            results = {}
            counts = {}
            raw_counts = {}
            try:
                with self.model_lock:
                    for det in self.detectors:
                        results[det.id] = det.infer(frame)
            except Exception as e:  # never let one bad frame kill the worker
                log.exception("[%s] inference error", self.cfg.id)
                self.stats.update(last_error=f"inference: {e}")
                continue

            for det in self.detectors:
                raw = len(results[det.id].boxes)
                raw_counts[det.label] = raw
                counts[det.label] = self.counters[det.id].update(raw)

            now = time.time()

            # Per-person activity (working / on_phone / talking / distracted), if enabled.
            people, activity, conversations = [], {}, []
            if self.activity is not None:
                phone_res = results.get(self.phone_detector_id)
                phone_boxes = phone_res.boxes.xyxy.tolist() if phone_res is not None else []
                try:
                    with self.model_lock:
                        people = self.activity.analyze(frame, phone_boxes, now)
                    activity = self.activity.counts(people)
                    conversations = self.activity.conversations(people)
                    # Name each body track from the face pipeline, if available.
                    if self.identity is not None and self.vms_camera:
                        fh_, fw_ = frame.shape[:2]
                        for p in people:
                            nm = self.identity.resolve(self.vms_camera, p["box"], fw_, fh_)
                            # Only a REAL recognised name overrides the anonymous
                            # track key. "Unknown" is not a person — leaving it unset
                            # keeps each unrecognised body distinct (keyed by track id)
                            # instead of collapsing everyone into one "Unknown".
                            if nm and nm != "Unknown":
                                p["name"] = nm
                    # Feed the over-time ledger (time-in-state + phone sessions).
                    if self.ledger is not None:
                        for p in people:
                            self.ledger.observe(self.cfg.id, p["id"], p["state"], now,
                                                name=p.get("name"))
                    # Line-crossing in/out attendance.
                    if self.crosser is not None:
                        fh_, fw_ = frame.shape[:2]
                        for ev in self.crosser.update(people, fw_, fh_, now):
                            if self.crossing_sink:
                                self.crossing_sink(self.cfg.id, ev)
                except Exception as e:
                    log.exception("[%s] activity error", self.cfg.id)
                    self.stats.update(last_error=f"activity: {e}")

            if prev_t is not None:
                inst = 1.0 / max(now - prev_t, 1e-6)
                ema_fps = inst if ema_fps == 0 else 0.9 * ema_fps + 0.1 * inst
            prev_t = now

            self.stats.update(counts=counts, raw_counts=raw_counts, people=people,
                              activity=activity, conversations=conversations, fps=ema_fps,
                              frames_processed=self.stats.frames_processed + 1)

            if self.preview:  # annotate + encode outside the model lock
                self._encode_preview(frame, results, counts, ema_fps, people)

            if min_interval:
                time.sleep(min_interval)

    # -- preview -----------------------------------------------------------
    # per-person state box colors (BGR)
    _STATE_COLORS = {"working": (0, 200, 0), "on_phone": (0, 165, 255),
                     "talking": (255, 170, 0), "not_working": (0, 0, 255),
                     "unknown": (170, 170, 170)}

    def _encode_preview(self, frame, results, counts, fps: float, people=None) -> None:
        """Draw detector boxes and/or per-person activity states + banner as JPEG."""
        try:
            img = frame.copy()
            h, w = img.shape[:2]
            scale = max(0.6, w / 1100)
            thick = max(1, int(scale * 2))

            # When activity is on, person-state boxes carry the meaning; only keep
            # phone detector boxes for extra context and skip the rest to de-clutter.
            for det in self.detectors:
                if people and det.id != self.phone_detector_id:
                    continue
                res = results[det.id]
                boxes = res.boxes
                names = res.names
                for xyxy, conf, cls in zip(
                    boxes.xyxy.tolist(), boxes.conf.tolist(), boxes.cls.tolist()
                ):
                    x1, y1, x2, y2 = (int(v) for v in xyxy)
                    cv2.rectangle(img, (x1, y1), (x2, y2), det.color, thick)
                    tag = f"{names.get(int(cls), det.label)} {conf:.2f}"
                    (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, scale * 0.7, 1)
                    cv2.rectangle(img, (x1, y1 - th - 6), (x1 + tw + 4, y1), det.color, -1)
                    cv2.putText(img, tag, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX,
                                scale * 0.7, (0, 0, 0), 1, cv2.LINE_AA)

            # Conversation lines first, so person boxes/labels draw on top.
            talk_color = self._STATE_COLORS["talking"]
            centers = {p["id"]: ((p["box"][0] + p["box"][2]) // 2,
                                 (p["box"][1] + p["box"][3]) // 2) for p in (people or [])}
            drawn = set()
            for p in (people or []):
                for other in p.get("talking_with", []):
                    key = tuple(sorted((p["id"], other)))
                    if key in drawn or other not in centers:
                        continue
                    drawn.add(key)
                    a, b = centers[p["id"]], centers[other]
                    cv2.line(img, a, b, talk_color, thick + 1, cv2.LINE_AA)
                    mid = ((a[0] + b[0]) // 2, (a[1] + b[1]) // 2)
                    cv2.circle(img, mid, max(4, thick * 3), talk_color, -1)
                    cv2.putText(img, "talking", (mid[0] + 6, mid[1] - 6),
                                cv2.FONT_HERSHEY_SIMPLEX, scale * 0.6, talk_color, 2, cv2.LINE_AA)

            for p in (people or []):
                x1, y1, x2, y2 = p["box"]
                color = self._STATE_COLORS.get(p["state"], (170, 170, 170))
                cv2.rectangle(img, (x1, y1), (x2, y2), color, thick + 1)
                who = p.get("name") or f"#{p['id']}"
                tag = f"{who} {p['state']}"
                (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, scale * 0.7, 2)
                cv2.rectangle(img, (x1, y1 - th - 8), (x1 + tw + 6, y1), color, -1)
                cv2.putText(img, tag, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX,
                            scale * 0.7, (0, 0, 0), 2, cv2.LINE_AA)

            summary = counts if not people else self.stats.activity
            banner = f"{self.stats.name}  |  " + "  ".join(
                f"{lbl}: {n}" for lbl, n in summary.items()
            ) + f"  |  {fps:.0f} FPS"
            (tw, th), base = cv2.getTextSize(banner, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
            cv2.rectangle(img, (0, 0), (tw + 20, th + base + 16), (0, 0, 0), -1)
            cv2.putText(img, banner, (10, th + 8), cv2.FONT_HERSHEY_SIMPLEX,
                        scale, (0, 255, 0), thick, cv2.LINE_AA)

            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
            if ok:
                with self._jpeg_lock:
                    self._latest_jpeg = buf.tobytes()
        except Exception:
            log.exception("[%s] preview encode failed", self.cfg.id)
