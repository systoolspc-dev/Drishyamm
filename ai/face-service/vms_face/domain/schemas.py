from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from vms_face.domain.enums import CameraStatus, EventKind, PersonRole

# Schemes accepted for camera ingest URLs. PyAV / FFmpeg will happily open
# `file://` and `http://`, which means an unauthenticated POST /cameras can
# instruct the orchestrator to publish snapshots of arbitrary local files
# into MinIO. Restrict to RTSP variants on enrollment; expand explicitly via
# config if a deployment really needs HTTP/HLS playback.
_ALLOWED_CAMERA_URL_SCHEMES = ("rtsp", "rtsps")


def _validate_camera_url(value: str) -> str:
    if not value or not isinstance(value, str):
        raise ValueError("rtsp_url must be a non-empty string")
    v = value.strip()
    scheme, sep, _ = v.partition("://")
    if not sep:
        raise ValueError("rtsp_url must include a scheme, e.g. rtsp://host/path")
    if scheme.lower() not in _ALLOWED_CAMERA_URL_SCHEMES:
        raise ValueError(
            f"rtsp_url scheme {scheme!r} is not allowed; "
            f"use one of {_ALLOWED_CAMERA_URL_SCHEMES}"
        )
    return v


# -------- Base --------

class _ORMBase(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


# -------- Person --------

class PersonCreate(BaseModel):
    tenant_id: uuid.UUID
    external_id: str | None = None
    full_name: str
    role: PersonRole = PersonRole.UNKNOWN
    metadata: dict[str, Any] | None = None


class PersonOut(_ORMBase):
    id: uuid.UUID
    tenant_id: uuid.UUID
    external_id: str | None
    full_name: str
    role: PersonRole
    is_active: bool
    metadata: dict[str, Any] | None = Field(default=None, alias="metadata_json")
    created_at: dt.datetime
    updated_at: dt.datetime


class FaceEnrollmentOut(_ORMBase):
    id: uuid.UUID
    person_id: uuid.UUID
    qdrant_point_id: uuid.UUID
    snapshot_uri: str | None
    det_score: float | None
    quality_score: float | None
    source: str | None
    created_at: dt.datetime


class FaceLearningSampleOut(_ORMBase):
    id: uuid.UUID
    tenant_id: uuid.UUID
    person_id: uuid.UUID
    camera_id: uuid.UUID | None
    event_id: uuid.UUID | None
    track_id: str | None
    qdrant_point_id: uuid.UUID | None
    snapshot_uri: str | None
    snapshot_url: str | None = None
    bbox: list[float] | None
    similarity: float | None
    det_score: float | None
    quality_score: float | None
    gender: str | None
    status: str
    reason: str | None
    reviewed_by: str | None
    reviewed_at: dt.datetime | None
    metadata: dict[str, Any] | None = Field(default=None, alias="metadata_json")
    occurred_at: dt.datetime
    created_at: dt.datetime


# -------- Camera --------

class CameraCreate(BaseModel):
    tenant_id: uuid.UUID
    code: str
    name: str
    rtsp_url: str
    location: str | None = None
    zone: str | None = None
    target_fps: float = 8.0
    detection_input_size: int = 960
    enabled: bool = True
    config: dict[str, Any] | None = None

    @field_validator("rtsp_url")
    @classmethod
    def _scheme_allowed(cls, v: str) -> str:
        return _validate_camera_url(v)


class CameraUpdate(BaseModel):
    name: str | None = None
    rtsp_url: str | None = None
    location: str | None = None
    zone: str | None = None
    target_fps: float | None = None
    detection_input_size: int | None = None
    enabled: bool | None = None
    config: dict[str, Any] | None = None

    @field_validator("rtsp_url")
    @classmethod
    def _scheme_allowed(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return _validate_camera_url(v)


class CameraOut(_ORMBase):
    id: uuid.UUID
    tenant_id: uuid.UUID
    code: str
    name: str
    rtsp_url: str
    location: str | None
    zone: str | None
    status: CameraStatus
    target_fps: float
    detection_input_size: int
    enabled: bool
    last_seen_at: dt.datetime | None
    config: dict[str, Any] | None = Field(default=None, alias="config_json")
    created_at: dt.datetime
    updated_at: dt.datetime


# -------- Events --------

class DetectionEventOut(_ORMBase):
    id: uuid.UUID
    tenant_id: uuid.UUID
    camera_id: uuid.UUID
    track_id: str
    kind: EventKind
    person_id: uuid.UUID | None
    similarity: float | None
    det_score: float | None
    quality_score: float | None
    bbox: list[float] | None
    snapshot_uri: str | None
    extra: dict[str, Any] | None
    occurred_at: dt.datetime
    created_at: dt.datetime


# -------- Pipeline DTOs (cross-process, JSON-friendly) --------

class FaceCandidate(BaseModel):
    """Emitted by the per-camera pipeline onto Redis Streams.
    The match worker consumes it, runs Qdrant ANN, persists a DetectionEvent."""

    tenant_id: uuid.UUID
    camera_id: uuid.UUID
    track_id: str
    occurred_at: dt.datetime
    bbox: list[float]                   # [x1, y1, x2, y2]
    det_score: float
    quality_score: float
    embedding: list[float]              # 512-D normed
    snapshot_uri: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class MatchResult(BaseModel):
    person_id: uuid.UUID | None
    similarity: float
    qdrant_point_id: uuid.UUID | None = None
    # True when a candidate cleared the threshold but was too close to a rival
    # identity to assert (crowd ambiguity guard) — caller should treat as unknown.
    ambiguous: bool = False
    # Which gallery tier answered: "hot" | "local" | "qdrant". Diagnostic only.
    tier: str | None = None


# -------- Watchlist / search --------


class FaceSearchRequest(BaseModel):
    tenant_id: uuid.UUID
    embedding: list[float]
    top_k: int = 5
    threshold: float | None = None      # falls back to settings.insightface_rec_threshold


class FaceSearchHit(BaseModel):
    person_id: uuid.UUID | None
    qdrant_point_id: uuid.UUID
    similarity: float
    full_name: str | None = None
    role: PersonRole | None = None


class FaceSearchResponse(BaseModel):
    hits: list[FaceSearchHit]
