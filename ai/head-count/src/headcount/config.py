"""Typed configuration loaded from YAML with environment-variable overrides."""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Union

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


class DetectorConfig(BaseModel):
    id: str                                   # short key, e.g. "heads", "phones"
    label: str = ""                           # display name; defaults to id
    weights: str
    hf_repo: str | None = None                # optional auto-download source
    hf_file: str | None = None
    device: str = "auto"                      # auto | cpu | cuda | mps
    half: bool = False
    conf: float = Field(0.35, ge=0.0, le=1.0)
    imgsz: int = Field(640, ge=64)
    classes: list[str | int] | None = None    # count only these classes; None = all
    color: tuple[int, int, int] = (0, 255, 0) # preview box color (BGR)

    @field_validator("device")
    @classmethod
    def _valid_device(cls, v: str) -> str:
        allowed = {"auto", "cpu", "cuda", "mps"}
        base = v.split(":", 1)[0]
        if base not in allowed:
            raise ValueError(f"device must be one of {allowed} (optionally :N), got {v!r}")
        return v

    @model_validator(mode="after")
    def _default_label(self) -> "DetectorConfig":
        if not self.label:
            self.label = self.id
        return self


class PipelineConfig(BaseModel):
    smooth_window: int = Field(5, ge=1)
    infer_every: int = Field(1, ge=1)
    target_fps: float = Field(0.0, ge=0.0)
    reconnect_delay: float = Field(3.0, gt=0.0)
    max_reconnect_delay: float = Field(30.0, gt=0.0)
    read_timeout: float = Field(10.0, gt=0.0)
    # ── resource savers ──────────────────────────────────────────────────
    # Motion gate: skip inference while the scene is static — if nothing moved,
    # the head count cannot have changed, so re-detecting burns CPU for the
    # same answer. A cheap downscaled gray-diff (~0.2 ms) decides.
    motion_gate: bool = True
    # Fraction of (downscaled) pixels that must change to count as motion.
    motion_threshold: float = Field(0.008, ge=0.0, le=1.0)
    # Safety net: even with no motion, infer at least this often (seconds) so
    # drift/noise/missed motion can never freeze a wrong count for long.
    idle_infer_interval: float = Field(1.5, gt=0.0)
    # Preview stays LIVE while inference is skipped: re-encode the latest raw
    # frame (with the last-known boxes) at least this often. JPEG encode is
    # ~2 ms — without this, a static scene freezes the video tile until the
    # next heartbeat, which reads as multi-second "lag" on webcams/dashboards.
    preview_refresh_sec: float = Field(0.5, gt=0.0)
    # ── static-object suppression ────────────────────────────────────────
    # Furniture is not people: chair headrests/monitors can score above ANY
    # usable confidence floor (observed 0.57), and a *stable* false positive
    # survives median smoothing forever. A box that sits in the same spot for
    # this long, across this many inferences, is flagged STATIC and excluded
    # from counts/preview — and instantly un-suppressed when motion touches
    # its region (someone sits in the chair → their head counts).
    static_suppress: bool = True
    static_suppress_sec: float = Field(120.0, gt=0.0)
    static_suppress_iou: float = Field(0.6, gt=0.0, le=1.0)
    static_suppress_min_hits: int = Field(8, ge=2)
    # ── v2: tracker + count-from-confirmed-tracks ────────────────────────
    # Published count = number of CONFIRMED persistent tracks (temporal state),
    # not a smoothed per-frame detection count. Weak detections must persist to
    # confirm; strong ones confirm instantly; brief occlusion coasts instead of
    # dropping the count.
    tracking: bool = True
    track_candidate_conf: float = Field(0.5, gt=0.0, le=1.0)
    track_strong_conf: float = Field(0.65, gt=0.0, le=1.0)
    track_confirm_hits: int = Field(2, ge=1)
    # Two hits inside one detector burst must not confirm — require a real
    # time span between first sighting and confirmation.
    track_min_confirm_sep_sec: float = Field(0.3, ge=0.0)
    track_max_miss: int = Field(2, ge=1)      # consecutive missed inferences
    track_miss_timeout_sec: float = Field(6.0, gt=0.0)
    # Displacement (in birth-box diagonals) that marks a track as "has moved" —
    # human evidence forever; also what un-flags a static spot when its
    # occupant genuinely moves.
    track_move_release_ratio: float = Field(0.35, gt=0.0)
    # ── v2: self-calibrating motion gate + hysteresis ────────────────────
    # Each camera learns its own noise floor (IR grain, compression shimmer)
    # instead of sharing one global constant; enter/exit thresholds differ so
    # the gate can't oscillate at the boundary.
    motion_adaptive: bool = True
    motion_floor: float = Field(0.004, ge=0.0, le=1.0)   # minimum enter threshold
    motion_noise_mult: float = Field(3.0, gt=1.0)        # enter = noise_ema * mult
    motion_exit_ratio: float = Field(0.4, gt=0.0, lt=1.0)  # exit = enter * ratio
    # Hard ceiling: a noisy camera must DEGRADE visibly (gate_saturated), not
    # silently become blind to real motion by inflating its own threshold.
    motion_ceiling: float = Field(0.03, gt=0.0, le=1.0)
    # ── v2: rapid verification (adaptive heartbeat) ──────────────────────
    # After motion or a count change, re-verify quickly N times before easing
    # back to the idle heartbeat — CPU stays low, transitions confirm in ~1 s.
    verify_rapid_interval: float = Field(0.5, gt=0.0)
    verify_confirmations: int = Field(2, ge=0)
    # Cap torch intra-op threads (0 = leave torch's default). On a shared box
    # one CPU inference otherwise grabs every core; 2-4 keeps latency close
    # while making the service a polite co-tenant.
    torch_threads: int = Field(0, ge=0)
    # ── Jetson / hardware decode ─────────────────────────────────────────
    # Wrap rtsp:// sources in a GStreamer pipeline that decodes on the SoC's
    # NVDEC block (nvv4l2decoder) instead of the CPU. Requires an OpenCV built
    # with GStreamer (the L4T/JetPack images have it; the PyPI headless wheel
    # does NOT — hence default off). Falls back to plain cv2 open on failure.
    gst_nvdec: bool = False
    # Template used when gst_nvdec is on; {url} is replaced with the source.
    # Default is H.264 (our sub-streams); switch depay/parse for H.265 cams.
    gst_pipeline_template: str = (
        "rtspsrc location={url} protocols=tcp latency=200 ! "
        "rtph264depay ! h264parse ! nvv4l2decoder ! "
        "nvvidconv ! video/x-raw,format=BGRx ! "
        "videoconvert ! video/x-raw,format=BGR ! "
        "appsink drop=1 max-buffers=1"
    )


class ApiConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = Field(8000, ge=1, le=65535)
    preview: bool = True                          # keep annotated frames for the dashboard
    preview_fps: float = Field(15.0, gt=0.0)      # MJPEG stream frame rate
    jpeg_quality: int = Field(70, ge=10, le=100)  # preview JPEG quality
    # Burn the camera name / counts / fps into the top of the preview. Useful for
    # this service's own bare dashboard; redundant inside the VMS, where the page
    # renders the same facts as real text — two copies collide and neither is
    # legible. Boxes are always drawn; only the banner is optional.
    preview_banner: bool = True


class SourceConfig(BaseModel):
    """Dynamic camera source — pull the set of headcount-enabled cameras from the
    VMS backend (``/api/internal/cameras``, filtered by ``settings.headcount.enabled``)
    and add/remove stream workers as users toggle the feature per camera. When
    enabled, the static ``streams`` list may be empty.

    backend_url / service_token fall back to BACKEND_URL / SERVICE_TOKEN env vars.
    """
    enabled: bool = False
    backend_url: str = ""
    service_token: str = ""
    poll_interval_sec: float = Field(15.0, gt=0.0)
    prefer_sub: bool = True          # use the camera's sub-stream RTSP when present
    # ── NVR protection (learned the hard way, twice) ─────────────────────
    # Entry/mid-range NVRs jam past a handful of concurrent RTSP sessions —
    # 18 head-count workers behind ONE NVR took every camera offline. These
    # caps mean toggling head-count on 50 cameras can never flood a recorder:
    # excess cameras simply wait their turn (logged, not silently dropped).
    max_streams: int = Field(8, ge=1)          # total workers this service runs
    max_streams_per_host: int = Field(4, ge=1)  # workers per camera host/NVR


class ForwardConfig(BaseModel):
    """Forward live counts to the VMS backend (occupancy gauge + threshold alerts).

    backend_url / service_token fall back to the BACKEND_URL / SERVICE_TOKEN env
    vars (shared with the AI + backend services) when left blank, so the token
    never has to live in this YAML.
    """
    enabled: bool = False
    backend_url: str = ""
    service_token: str = ""
    interval_sec: float = Field(5.0, gt=0.0)
    # stream id -> monitorId. Empty ⇒ the stream id IS the monitorId.
    monitor_by_stream: dict[str, str] = Field(default_factory=dict)


class StreamConfig(BaseModel):
    id: str
    name: str = ""
    source: Union[int, str]
    # Counting zones drawn by the operator, as normalised polygons. Empty means
    # count everyone the camera sees (opt-in). See zones.py.
    zones: list = []
    # Per-camera detail level (model input size). None = use the service default.
    #
    # This is the single most effective range control we have: detection depends
    # on how many pixels a head occupies at the model's input, and that scales
    # directly with this number. Measured 10 Aug 2026: at 640 a 4 mm lens reaches
    # ~9 m; at 1280 the same lens reaches ~18 m. On GPU the cost is close to zero
    # (5.6 ms -> 5.8 ms, because fixed per-call overhead dominates), so a large
    # room can simply be given more detail. On CPU it is ~2.5x, hence per camera
    # rather than a global switch.
    imgsz: int | None = None

    @field_validator("id")
    @classmethod
    def _non_empty_id(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("stream id must not be empty")
        return v


class AppConfig(BaseModel):
    detectors: List[DetectorConfig] = Field(default_factory=list)
    pipeline: PipelineConfig = PipelineConfig()
    api: ApiConfig = ApiConfig()
    source: SourceConfig = SourceConfig()
    forward: ForwardConfig = ForwardConfig()
    log_level: str = "INFO"
    streams: List[StreamConfig] = Field(default_factory=list)

    @field_validator("streams")
    @classmethod
    def _unique_stream_ids(cls, v: List[StreamConfig]) -> List[StreamConfig]:
        ids = [s.id for s in v]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"duplicate stream ids: {sorted(dupes)}")
        return v

    @model_validator(mode="after")
    def _streams_or_source(self) -> "AppConfig":
        # Either configure static streams, or enable the dynamic source (which
        # populates cameras at runtime from the backend).
        if not self.streams and not self.source.enabled:
            raise ValueError("configure at least one stream, or set source.enabled=true")
        return self

    @field_validator("detectors")
    @classmethod
    def _unique_detector_ids(cls, v: List[DetectorConfig]) -> List[DetectorConfig]:
        if not v:
            raise ValueError("at least one detector must be configured")
        ids = [d.id for d in v]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"duplicate detector ids: {sorted(dupes)}")
        return v


def _apply_env_overrides(data: dict, prefix: str = "HEADCOUNT_") -> dict:
    """Override nested keys from env vars, e.g. HEADCOUNT_API__PORT=9000."""
    for key, raw in os.environ.items():
        if not key.startswith(prefix):
            continue
        path = key[len(prefix):].lower().split("__")
        node = data
        for part in path[:-1]:
            node = node.setdefault(part, {})
            if not isinstance(node, dict):
                break
        else:
            node[path[-1]] = yaml.safe_load(raw)  # parse ints/bools/lists sensibly
    return data


def load_config(path: str | os.PathLike = "config.yaml") -> AppConfig:
    """Load and validate configuration from a YAML file, applying env overrides."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"config file not found: {p}")
    data = yaml.safe_load(p.read_text()) or {}
    data = _apply_env_overrides(data)
    return AppConfig.model_validate(data)
