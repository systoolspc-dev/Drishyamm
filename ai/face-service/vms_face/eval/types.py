from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(slots=True)
class ProbeRecord:
    """One row from the manifest CSV. Drives a single evaluation step."""

    path: Path
    true_person_id: str | None        # None means 'unknown' (negative sample)
    tags: dict[str, str] = field(default_factory=dict)   # e.g. scenario=outdoor_night, camera=cam-01


@dataclass(slots=True)
class GalleryRecord:
    """Enrolled-side image."""

    path: Path
    person_id: str


@dataclass(slots=True)
class ProbeOutcome:
    """Result of running one probe through the pipeline + matcher."""

    probe_path: Path
    true_person_id: str | None
    predicted_person_id: str | None
    similarity: float | None
    threshold: float
    quality_score: float | None
    det_score: float | None
    undetected: bool = False
    rejected_quality: bool = False
    detect_latency_ms: float | None = None
    match_latency_ms: float | None = None
    tags: dict[str, str] = field(default_factory=dict)
    error: str | None = None
