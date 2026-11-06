"""Pydantic REST/wire shapes for the journey module.

Ported from the former person-tracker `schemas.py` (the contract the SPA already
speaks) plus journey-platform's `Journey`/`JourneyStop` response. Kept in one file
so the API surface is obvious at a glance. These are REST DTOs — distinct from the
SQLAlchemy ORM `DetectionEvent`/`Journey` in vms_face.domain.models (different layer,
same concepts)."""
from __future__ import annotations

import datetime as dt
import uuid
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


# ─── search ──────────────────────────────────────────────────────────────
class SearchRequest(BaseModel):
    window_start: dt.datetime | None = None
    window_end: dt.datetime | None = None
    min_similarity: float | None = Field(default=None, ge=0.0, le=1.0)
    camera_ids: list[uuid.UUID] = Field(default_factory=list)


class Candidate(BaseModel):
    """One raw match returned by Qdrant before clustering."""
    appearance_id: uuid.UUID
    camera_id: uuid.UUID
    camera_code: str | None = None
    camera_name: str | None = None          # human label ("office 13 - Camera 03")
    event_id: uuid.UUID | None = None       # → detection_events row (snapshot source)
    track_id: str | None = None
    occurred_at: dt.datetime
    similarity: float = Field(ge=0.0, le=1.0)
    snapshot_uri: str | None = None
    # Fusion breakdown (P1b). face is always present; body when available.
    face_similarity: float | None = None
    body_similarity: float | None = None


class SearchResponse(BaseModel):
    query_face_quality: float | None       # SCRFD/ArcFace det_score on the uploaded photo
    candidates: list[Candidate]
    window_start: dt.datetime
    window_end: dt.datetime
    total_matched: int
    body_used: bool = False                # whether body fusion contributed (P1b)


# ─── sightings ───────────────────────────────────────────────────────────
class Sighting(BaseModel):
    """A cluster of consecutive candidates on the same camera."""
    sighting_id: uuid.UUID
    camera_id: uuid.UUID
    camera_code: str | None = None
    camera_name: str | None = None
    started_at: dt.datetime
    ended_at: dt.datetime
    best_snapshot_uri: str | None = None
    best_similarity: float
    candidate_count: int
    location: dict[str, float] | None = None   # {"lat": ..., "lng": ...} when configured


class ClusterRequest(BaseModel):
    candidates: list[Candidate]
    window_sec: int | None = None


class ClusterResponse(BaseModel):
    sightings: list[Sighting]


# ─── stitch jobs (P1d) ───────────────────────────────────────────────────
class JobStatus(str, Enum):
    queued    = "queued"
    rendering = "rendering"
    done      = "done"
    failed    = "failed"


class StitchRequest(BaseModel):
    sightings: list[Sighting]
    include_overlays: bool = True
    include_intro_card: bool = True
    person_id: uuid.UUID | None = None      # link the rendered journey to a global person


class JobCreateResponse(BaseModel):
    job_id: uuid.UUID
    status: JobStatus
    poll_url: str


class JobStatusResponse(BaseModel):
    # Built via JobStatusResponse(**job) where `job` also holds the raw `request`
    # JSON (tenant_id/created_by). extra="ignore" guarantees those sensitive keys
    # are dropped from the API response — keep this explicit, do not return `job` raw.
    model_config = ConfigDict(extra="ignore")

    job_id: uuid.UUID
    status: JobStatus
    progress: float = Field(ge=0.0, le=1.0)
    message: str | None = None
    video_url: str | None = None
    report_url: str | None = None
    map_url: str | None = None
    failed_reason: str | None = None
    created_at: dt.datetime
    updated_at: dt.datetime


# ─── journey (persisted reconstruction, P1c) ─────────────────────────────
class JourneyStop(BaseModel):
    seq: int
    camera_id: uuid.UUID
    camera_code: str | None = None
    location_name: str | None = None
    lat: float | None = None
    lng: float | None = None
    started_at: dt.datetime
    ended_at: dt.datetime
    confidence: float
    snapshot_uri: str | None = None
    detection_count: int = 0


class Journey(BaseModel):
    journey_id: uuid.UUID
    person_id: uuid.UUID | None = None
    is_unknown: bool = True
    display_name: str | None = None
    mode: str = "forensic"
    first_seen_at: dt.datetime | None = None
    last_seen_at: dt.datetime | None = None
    cameras_count: int = 0
    confidence: float | None = None
    stops: list[JourneyStop] = Field(default_factory=list)
    path: list[list[float]] = Field(default_factory=list)   # [[lat,lng],...]
    video_url: str | None = None
    report_url: str | None = None
    status: str = "building"


# ─── shared error envelope ───────────────────────────────────────────────
class ApiError(BaseModel):
    error: str
    detail: Any | None = None
