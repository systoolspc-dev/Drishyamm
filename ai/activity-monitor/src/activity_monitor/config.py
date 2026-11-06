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


class ActivityConfig(BaseModel):
    """Per-person working / on_phone / distracted analysis (front-facing camera)."""
    enabled: bool = False
    pose_weights: str = "models/yolov8s-pose.pt"
    phone_detector_id: str = "phones"     # which detector supplies phone boxes
    device: str = "auto"
    conf: float = Field(0.40, ge=0.0, le=1.0)   # pose person confidence
    imgsz: int = Field(640, ge=64)
    kpt_conf: float = Field(0.30, ge=0.0, le=1.0)
    # --- posture: working = upright (upper-body; tune via probe_activity.py) ---
    posture_head_down: float = Field(-0.50)         # head_lift below this = slumped/head-down
    posture_tilt_max: float = Field(28.0, ge=0.0)   # reclined torso tilt (only if hips visible)
    posture_buried_head: bool = True                # clear shoulders + hidden face => not_working
    posture_face_min: float = Field(0.45, ge=0.0, le=1.0)  # head-kpt conf below this = face hidden
    phone_overlap: float = Field(0.30, ge=0.0, le=1.0)  # phone-in-person overlap frac
    # Precision gate: a phone that overlaps the person box must ALSO sit near a
    # hand (wrist) or head keypoint to count as on_phone — otherwise a phone
    # lying on the desk in front of a seated person reads as usage. Falls back to
    # overlap-only when no wrist/head keypoint is visible (don't lose recall).
    phone_require_hand: bool = True
    phone_hand_radius: float = Field(1.3, gt=0.0)  # max phone→hand/head dist, × shoulder width
    hold_seconds: float = Field(1.5, ge=0.0)      # temporal persistence before switching
    # --- talking (two people facing each other + near, sustained) ---
    talking_enabled: bool = True
    talking_proximity: float = Field(2.5, gt=0.0)     # max center dist / avg box width
    talking_convergence: float = Field(0.20, ge=0.0)  # min |yaw| turned toward each other
    # --- per-person over-time ledger (time-in-state + phone-usage sessions) ---
    ledger_enabled: bool = True
    store_path: str = "activity.db"                   # SQLite: durable daily totals + session log
    ledger_flush_sec: float = Field(30.0, gt=0.0)     # persist running daily totals this often
    session_gap_sec: float = Field(3.0, gt=0.0)       # close an open phone session after this gap unseen
    # --- tracker (reduces one-person-into-many-IDs fragmentation) ---
    track_iou: float = Field(0.3, ge=0.0, le=1.0)
    track_max_misses: int = Field(45, ge=1)           # keep a track alive this many frames across gaps
    track_center_dist_ratio: float = Field(0.6, gt=0.0)  # center-distance re-match tolerance × box width
    min_present_sec: float = Field(3.0, ge=0.0)       # aggregate views ignore ghost tracks seen < this

    @field_validator("device")
    @classmethod
    def _valid_device(cls, v: str) -> str:
        allowed = {"auto", "cpu", "cuda", "mps"}
        if v.split(":", 1)[0] not in allowed:
            raise ValueError(f"device must be one of {allowed} (optionally :N), got {v!r}")
        return v


class ApiConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = Field(8000, ge=1, le=65535)
    preview: bool = True                          # keep annotated frames for the dashboard
    preview_fps: float = Field(15.0, gt=0.0)      # MJPEG stream frame rate
    jpeg_quality: int = Field(70, ge=10, le=100)  # preview JPEG quality


class IdentityConfig(BaseModel):
    """Optional face-name fusion from vms_face's cam-state channel."""
    enabled: bool = False
    redis_url: str = "redis://localhost:6379/0"
    channel_prefix: str = "vms.cam.state"
    ttl_sec: float = Field(3.0, gt=0.0)               # ignore face boxes older than this
    head_region: float = Field(0.6, gt=0.0, le=1.0)   # face must sit in the top fraction of the body box


class StreamConfig(BaseModel):
    id: str
    name: str = ""
    source: Union[int, str]
    vms_camera: str | None = None   # vms_face camera_code (monitorId) → identity fusion

    @field_validator("id")
    @classmethod
    def _non_empty_id(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("stream id must not be empty")
        return v


class AppConfig(BaseModel):
    detectors: List[DetectorConfig] = Field(default_factory=list)
    pipeline: PipelineConfig = PipelineConfig()
    activity: ActivityConfig = ActivityConfig()
    identity: IdentityConfig = IdentityConfig()
    api: ApiConfig = ApiConfig()
    log_level: str = "INFO"
    streams: List[StreamConfig] = Field(default_factory=list)

    @field_validator("streams")
    @classmethod
    def _unique_stream_ids(cls, v: List[StreamConfig]) -> List[StreamConfig]:
        # Empty is allowed: the service can run purely on recognition_sync
        # (DB-driven attendance + alerts) with no camera pull of its own.
        ids = [s.id for s in v]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"duplicate stream ids: {sorted(dupes)}")
        return v

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


def _apply_env_overrides(data: dict, prefix: str = "MONITOR_") -> dict:
    """Override nested keys from env vars, e.g. MONITOR_API__PORT=9000."""
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
