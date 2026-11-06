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
import numpy as np

from collections import deque

from .config import PipelineConfig, StreamConfig
from .counter import RollingCounter
from .head_tracker import HeadTracker
from .model import Detector
from .static_suppress import StaticBoxSuppressor

log = logging.getLogger("headcount.stream")


@dataclass
class StreamStats:
    id: str
    name: str
    counts: dict = field(default_factory=dict)      # {label: smoothed count}
    raw_counts: dict = field(default_factory=dict)  # {label: raw count}
    fps: float = 0.0                  # inference throughput (EMA)
    read_fps: float = 0.0             # camera delivery rate (EMA) — decode health
    infer_ms: float = 0.0             # per-inference latency (EMA) — model health
    infer_p50: float = 0.0            # tail latency (last ~100 inferences)
    infer_p95: float = 0.0
    tracked: int = 0                  # confirmed persistent tracks (the count basis)
    zone_counts: dict = field(default_factory=dict)  # {zone name: people inside}
    tentative: int = 0                # tracks not yet confirmed (not counted)
    count_reliable: bool = True       # False = degraded; treat count as last-known
    gate_saturated: bool = False      # camera noise hit the motion ceiling (degraded)
    verify_deadline_s: float = 30.0   # count older than this is NEVER "reliable"
    status: str = "starting"          # starting | online | reconnecting | stopped | error
    connected: bool = False
    frames_processed: int = 0
    frames_skipped_static: int = 0    # motion gate: scene unchanged → inference skipped
    static_suppressed: int = 0        # furniture boxes currently excluded from counts
    last_frame_ts: Optional[float] = None
    last_infer_ts: Optional[float] = None  # when the count was last VERIFIED by the model
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
                "fps": round(self.fps, 1),
                "read_fps": round(self.read_fps, 1),
                "infer_ms": round(self.infer_ms, 1),
                "infer_p50": round(self.infer_p50, 1),
                "infer_p95": round(self.infer_p95, 1),
                "tracked": self.tracked,
                "tentative": self.tentative,
                # Per-area breakdown when counting zones are configured, so the
                # wall can show "reception: 3, waiting: 7" instead of one total.
                "zone_counts": dict(self.zone_counts),
                "count_reliable": (
                    self.count_reliable
                    and (self.last_infer_ts is None
                         or (time.time() - self.last_infer_ts) <= self.verify_deadline_s)
                ),
                "gate_saturated": self.gate_saturated,
                "status": self.status,
                "connected": self.connected,
                "frames_processed": self.frames_processed,
                "frames_skipped_static": self.frames_skipped_static,
                "static_suppressed": self.static_suppressed,
                "seconds_since_last_frame": age,
                # How stale is the published count? (time since the model last
                # VERIFIED it — bounded by idle_infer_interval on static scenes)
                "count_age_s": (None if self.last_infer_ts is None
                                else round(time.time() - self.last_infer_ts, 2)),
                "last_error": self.last_error,
            }

    def update(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)


def _open_source(source):
    """cv2 wants an int for a camera index and a str for files/URLs."""
    return int(source) if isinstance(source, str) and source.isdigit() else source


# Motion gate working size — tiny on purpose: resize+diff at this size costs
# ~0.2 ms, i.e. ~100-500x cheaper than one YOLO inference on CPU.
_MOTION_W, _MOTION_H = 160, 90
# Per-pixel gray delta below this is treated as sensor noise, not motion.
_MOTION_PIXEL_DELTA = 12


def _downscale_gray(frame) -> "cv2.Mat":
    """Cheap grayscale thumbnail used for the static-scene check."""
    small = cv2.resize(frame, (_MOTION_W, _MOTION_H), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)


def _motion_frac(prev_gray, cur_gray) -> float:
    """Fraction of pixels whose gray value moved more than the noise floor."""
    diff = cv2.absdiff(prev_gray, cur_gray)
    return float((diff > _MOTION_PIXEL_DELTA).mean())


class StreamWorker:
    def __init__(
        self,
        stream: StreamConfig,
        detectors: list[Detector],
        model_lock: Lock,
        pipeline: PipelineConfig,
        preview: bool = False,
        jpeg_quality: int = 70,
        preview_banner: bool = True,
    ):
        self.cfg = stream
        self.detectors = detectors
        self.model_lock = model_lock
        self.pipe = pipeline
        self.preview = preview
        self.jpeg_quality = jpeg_quality
        self.preview_banner = preview_banner
        self.stats = StreamStats(
            id=stream.id, name=stream.name or stream.id,
            counts={d.label: 0 for d in detectors},
            raw_counts={d.label: 0 for d in detectors},
        )
        self.counters = {d.id: RollingCounter(pipeline.smooth_window) for d in detectors}
        # Static-object suppression (furniture ≠ people), one registry per detector.
        self._suppressors = {
            d.id: StaticBoxSuppressor(
                iou_thr=pipeline.static_suppress_iou,
                min_span_sec=pipeline.static_suppress_sec,
                min_hits=pipeline.static_suppress_min_hits,
            )
            for d in detectors
        } if (pipeline.static_suppress and not pipeline.tracking) else {}
        # Counting zones: one shared definition per camera, applied to every
        # detector's tracker. Built once here so a malformed polygon fails at
        # startup rather than silently per frame.
        from .zones import ZoneCounter
        self._zone_counter = ZoneCounter.from_config(
            {"zones": list(getattr(stream, "zones", []) or [])})
        if self._zone_counter.active:
            log.info("[%s] counting zones active: %s", stream.id,
                     ", ".join(z.name for z in self._zone_counter.zones))

        # v2: temporal tracker — owns static/furniture evidence when enabled — published count = confirmed persistent tracks.
        self._trackers = {
            d.id: HeadTracker(
                candidate_conf=pipeline.track_candidate_conf,
                strong_conf=pipeline.track_strong_conf,
                confirm_hits=pipeline.track_confirm_hits,
                min_confirm_sep_sec=pipeline.track_min_confirm_sep_sec,
                max_miss=pipeline.track_max_miss,
                miss_timeout_sec=pipeline.track_miss_timeout_sec,
                static_min_hits=pipeline.static_suppress_min_hits,
                static_min_span_sec=(pipeline.static_suppress_sec
                                     if pipeline.static_suppress else float("inf")),
                move_release_ratio=pipeline.track_move_release_ratio,
                zone_counter=self._zone_counter,
            )
            for d in detectors
        } if pipeline.tracking else {}
        # v2: adaptive-gate + rapid-verification state.
        self._noise_ema = 0.002        # learned per-camera sensor-noise floor
        self._in_motion = False        # gate hysteresis state
        self._rapid_pending = 0        # rapid re-verifications still owed
        self._last_published: dict = {}
        self._infer_hist: deque = deque(maxlen=100)   # for p50/p95
        # Formal freshness guarantee: a count is never claimed reliable beyond
        # 3 heartbeats — even if nothing crashed.
        self.stats.verify_deadline_s = 3.0 * pipeline.idle_infer_interval + 2.0

        self._stop = threading.Event()
        self._read_dt_ema: float | None = None   # frame-interval EMA (read_fps)
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
                    self.stats.update(status="reconnecting", connected=False, count_reliable=False)
                    if self._stop.wait(delay):
                        break
                    delay = min(delay * 2, self.pipe.max_reconnect_delay)
                    continue
                delay = self.pipe.reconnect_delay  # reset backoff on success
                self.stats.update(status="online", connected=True, last_error=None)

            ok, frame = cap.read()
            if not ok or frame is None:
                log.warning("[%s] read failed; will reconnect", self.cfg.id)
                self.stats.update(status="reconnecting", connected=False, count_reliable=False,
                                  last_error="frame read failed")
                cap.release()
                cap = None
                continue

            with self._frame_lock:
                self._latest_frame = frame
                self._latest_seq += 1
            now_read = time.time()
            # Camera delivery rate — separates "decode/camera slow" from "model
            # slow" when diagnosing lag. EMA the INTERVAL and invert: RTSP
            # delivers in bursts, and averaging instantaneous 1/gap explodes
            # (harmonic-mean bias) — a 640x360@12fps stream read as "638 fps".
            if self.stats.last_frame_ts:
                dt = max(now_read - self.stats.last_frame_ts, 1e-4)
                prev = self._read_dt_ema
                self._read_dt_ema = dt if prev is None else 0.9 * prev + 0.1 * dt
                self.stats.update(read_fps=1.0 / self._read_dt_ema,
                                  last_frame_ts=now_read)
            else:
                self.stats.update(last_frame_ts=now_read)

        if cap is not None:
            cap.release()

    def _connect(self):
        source = _open_source(self.cfg.source)
        log.info("[%s] connecting to %r", self.cfg.id, self.cfg.source)

        # Jetson: decode on the SoC's NVDEC block via GStreamer instead of the
        # CPU. Only for rtsp:// sources; falls back to a plain open below if
        # the pipeline can't start (e.g. OpenCV built without GStreamer).
        if (
            self.pipe.gst_nvdec
            and isinstance(source, str)
            and source.startswith("rtsp://")
        ):
            pipeline = self.pipe.gst_pipeline_template.format(url=source)
            cap = cv2.VideoCapture(pipeline, cv2.CAP_GSTREAMER)
            if cap.isOpened():
                log.info("[%s] NVDEC (GStreamer) decode active", self.cfg.id)
                return cap
            cap.release()
            log.warning("[%s] GStreamer/NVDEC open failed — falling back to CPU decode",
                        self.cfg.id)

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
        # Motion gate state: thumbnail of the last frame we actually inferred
        # on, and when. While the scene matches that thumbnail, the count
        # cannot have changed — skip inference and hold the published counts.
        last_infer_gray = None
        last_infer_t = 0.0
        # Live-preview state: last inference's results/counts (for drawing
        # boxes on skipped frames) and when we last refreshed the JPEG.
        last_results = None
        last_counts: dict = {}
        last_preview_t = 0.0

        while not self._stop.is_set():
            # Watchdog: flag a silently-dead stream.
            if self.stats.last_frame_ts and (time.time() - self.stats.last_frame_ts) > self.pipe.read_timeout:
                self.stats.update(status="reconnecting", connected=False, count_reliable=False,
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

            # Motion gate: if the scene is (near-)identical to the last frame
            # we inferred on, the head count cannot have changed — skip the
            # model entirely and keep publishing the held counts. A periodic
            # idle inference (idle_infer_interval) is the safety net so a
            # missed motion can never freeze a stale count for long. The
            # preview intentionally freezes too: the scene is static, so the
            # last annotated frame is still an accurate picture.
            now_gate = time.time()
            cur_gray = _downscale_gray(frame) if self.pipe.motion_gate else None
            if self.pipe.motion_gate and last_infer_gray is not None:
                frac = _motion_frac(last_infer_gray, cur_gray)

                # v2 gate: self-calibrating threshold + hysteresis. Each camera
                # learns its own noise floor (IR grain, compression shimmer)
                # from static periods; enter/exit thresholds differ so the gate
                # cannot oscillate at the boundary.
                if self.pipe.motion_adaptive:
                    raw_thr = self._noise_ema * self.pipe.motion_noise_mult
                    thr_enter = min(max(self.pipe.motion_floor, raw_thr),
                                    self.pipe.motion_ceiling)
                    # A camera so noisy it hits the ceiling is DEGRADED — say
                    # so instead of silently going blind to real motion.
                    self.stats.update(gate_saturated=raw_thr > self.pipe.motion_ceiling)
                else:
                    thr_enter = self.pipe.motion_threshold
                thr_exit = thr_enter * self.pipe.motion_exit_ratio
                self._in_motion = (frac > thr_exit) if self._in_motion else (frac >= thr_enter)
                if not self._in_motion:
                    # Learn sensor noise ONLY while static, so real motion
                    # never inflates the baseline.
                    self._noise_ema = 0.98 * self._noise_ema + 0.02 * frac

                # v2 cadence: motion → infer now; owed rapid confirmations →
                # short interval; otherwise the idle heartbeat.
                interval = (self.pipe.verify_rapid_interval if self._rapid_pending > 0
                            else self.pipe.idle_infer_interval)
                if not self._in_motion and (now_gate - last_infer_t) < interval:
                    self.stats.update(
                        frames_skipped_static=self.stats.frames_skipped_static + 1,
                    )
                    # Keep the preview LIVE even though inference is skipped:
                    # encode the current raw frame with the last-known boxes at
                    # a throttled rate (the "webcam lag" fix).
                    if (
                        self.preview
                        and last_results is not None
                        and (now_gate - last_preview_t) >= self.pipe.preview_refresh_sec
                    ):
                        self._encode_preview(frame, last_results, last_counts, ema_fps,
                                             getattr(self, "_last_kept", None))
                        last_preview_t = now_gate
                    continue

            # Run every detector on this frame.
            #
            # The shared lock serialises cameras onto one GPU — correct for the
            # per-frame path, FATAL for the batched one: a worker holding it while
            # waiting for its batch would stop every other camera joining, and the
            # batch would never fill. When a detector batches, it IS the
            # serialisation point, so we take no lock here.
            results = {}
            counts = {}
            raw_counts = {}
            t_inf = time.perf_counter()
            try:
                cam_imgsz = getattr(self.cfg, "imgsz", None)
                for det in self.detectors:
                    if getattr(det, "batched", False):
                        results[det.id] = det.infer(frame, cam_imgsz)
                    else:
                        with self.model_lock:
                            results[det.id] = det.infer(frame, cam_imgsz)
            except Exception as e:  # never let one bad frame kill the worker
                log.exception("[%s] inference error", self.cfg.id)
                self._infer_failures = getattr(self, "_infer_failures", 0) + 1
                self.stats.update(
                    last_error=f"inference: {e}",
                    # persistent model failure = stale count, say so
                    count_reliable=self._infer_failures < 3 and self.stats.count_reliable,
                )
                continue
            self._infer_failures = 0
            inf_ms = (time.perf_counter() - t_inf) * 1000.0
            im = self.stats.infer_ms
            self.stats.update(infer_ms=inf_ms if im == 0 else 0.9 * im + 0.1 * inf_ms)

            # Region micro-motion → tracker stillness clocks (a seated human
            # scrolling a phone stays "alive"; furniture never trips this).
            if last_infer_gray is not None and cur_gray is not None:
                fh, fw = frame.shape[:2]
                for trk_ in self._trackers.values():
                    trk_.note_region_activity(last_infer_gray, cur_gray, fw, fh,
                                              now=now_gate)
                for sup in self._suppressors.values():
                    sup.rehabilitate(last_infer_gray, cur_gray, fw, fh)

            kept_map: dict = {}
            tracked_total = tentative_total = 0
            # Seed every configured area at 0. An empty room must report "0",
            # not vanish from the breakdown — otherwise the operator cannot tell
            # "nobody is in the area" from "the area isn't being counted".
            zone_totals: dict = {z.name: 0 for z in self._zone_counter.zones
                                 if z.enabled} if self._zone_counter.active else {}
            for det in self.detectors:
                res = results[det.id]
                n = len(res.boxes)
                xyxy = res.boxes.xyxy.cpu().numpy() if n else np.zeros((0, 4), np.float32)
                confs = res.boxes.conf.cpu().numpy() if n else np.zeros((0,), np.float32)
                trk = self._trackers.get(det.id)
                if trk is not None:
                    # v2 semantics: count = CONFIRMED persistent tracks. The
                    # tracker sees ALL detections and owns furniture evidence:
                    # only never-moved-since-birth tracks can be flagged
                    # static, so a stationary HUMAN can never be demoted.
                    # Zones are stored normalised (0..1); the tracker needs the
                    # real frame size to place a box inside the polygon.
                    fh, fw = frame.shape[:2]
                    trk.frame_w, trk.frame_h = fw, fh
                    counts[det.label] = trk.update(xyxy, confs, now_gate, in_motion=self._in_motion)
                    kept = list(trk.last_keep)
                    tracked_total += trk.confirmed_count
                    tentative_total += trk.tentative_count
                    # Per-area breakdown, keyed by the zone's display name so the
                    # wall can label it without a second lookup.
                    for zid, n in (trk.counts_by_zone or {}).items():
                        label = next((z.name for z in self._zone_counter.zones
                                      if z.id == zid), zid)
                        zone_totals[label] = zone_totals.get(label, 0) + n
                else:
                    sup = self._suppressors.get(det.id)
                    kept = sup.update(xyxy, now_gate) if (sup is not None and n) else [True] * n
                    counts[det.label] = self.counters[det.id].update(int(sum(kept)))
                kept_map[det.id] = kept
                raw_counts[det.label] = int(sum(kept))

            # v2 cadence feedback: a count change or motion earns rapid
            # re-verifications; quiet verifies pay one back.
            if counts != self._last_published or self._in_motion:
                self._rapid_pending = self.pipe.verify_confirmations
            elif self._rapid_pending > 0:
                self._rapid_pending -= 1
            self._last_published = dict(counts)

            self._infer_hist.append(inf_ms)
            hist = sorted(self._infer_hist)
            if self._trackers:
                self.stats.update(static_suppressed=sum(
                    t.static_count for t in self._trackers.values()))
            elif self._suppressors:
                self.stats.update(static_suppressed=sum(
                    s.suppressed_count for s in self._suppressors.values()))
            self.stats.update(
                last_infer_ts=time.time(),
                tracked=tracked_total,
                tentative=tentative_total,
                zone_counts=zone_totals,
                infer_p50=hist[len(hist) // 2],
                infer_p95=hist[min(len(hist) - 1, int(len(hist) * 0.95))],
                count_reliable=True,
            )

            now = time.time()
            if prev_t is not None:
                inst = 1.0 / max(now - prev_t, 1e-6)
                ema_fps = inst if ema_fps == 0 else 0.9 * ema_fps + 0.1 * inst
            prev_t = now

            self.stats.update(counts=counts, raw_counts=raw_counts, fps=ema_fps,
                              frames_processed=self.stats.frames_processed + 1)

            # This frame is now the motion-gate reference: future frames are
            # compared against what the model last actually saw.
            if cur_gray is not None:
                last_infer_gray = cur_gray
                last_infer_t = now_gate
            # Cache for live-preview refreshes while the gate is skipping.
            last_results, last_counts = results, counts
            self._last_kept = kept_map

            if self.preview:  # annotate + encode outside the model lock
                self._encode_preview(frame, results, counts, ema_fps, kept_map)
                last_preview_t = now_gate

            if min_interval:
                time.sleep(min_interval)

    # -- preview -----------------------------------------------------------
    def _encode_preview(self, frame, results, counts, fps: float, kept=None) -> None:
        """Draw detector boxes + a count banner as JPEG.

        `kept` (det_id -> list[bool]) filters out suppressed static objects so
        a chair flagged as furniture is neither counted NOR drawn.
        """
        try:
            img = frame.copy()
            h, w = img.shape[:2]
            scale = max(0.6, w / 1100)
            thick = max(1, int(scale * 2))

            for det in self.detectors:
                res = results[det.id]
                boxes = res.boxes
                # Defensive: a result shim without `names` must cost us a box
                # LABEL, not the whole preview frame. This raised for every
                # frame under batched inference and blanked the video wall.
                names = getattr(res, "names", None) or {}
                det_kept = (kept or {}).get(det.id)
                for bi, (xyxy, conf, cls) in enumerate(zip(
                    boxes.xyxy.tolist(), boxes.conf.tolist(), boxes.cls.tolist()
                )):
                    if det_kept is not None and bi < len(det_kept) and not det_kept[bi]:
                        continue  # suppressed static object — not a head
                    x1, y1, x2, y2 = (int(v) for v in xyxy)
                    cv2.rectangle(img, (x1, y1), (x2, y2), det.color, thick)
                    tag = f"{names.get(int(cls), det.label)} {conf:.2f}"
                    (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, scale * 0.7, 1)
                    cv2.rectangle(img, (x1, y1 - th - 6), (x1 + tw + 4, y1), det.color, -1)
                    cv2.putText(img, tag, (x1 + 2, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX,
                                scale * 0.7, (0, 0, 0), 1, cv2.LINE_AA)

            if getattr(self, "preview_banner", True):
              banner = f"{self.stats.name}  |  " + "  ".join(
                f"{lbl}: {n}" for lbl, n in counts.items()
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
