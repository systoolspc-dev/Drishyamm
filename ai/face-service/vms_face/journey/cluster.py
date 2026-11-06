"""Collapse candidates into sightings.

Two raw detections of the same person on the same camera within
CLUSTER_WINDOW_SEC of each other are the same visit. Each cluster inherits the
highest-similarity candidate's snapshot as the cover and spans
min(occurred_at)..max(occurred_at). Ported from person-tracker."""
from __future__ import annotations

import datetime as dt
import uuid

from vms_face.config import settings
from vms_face.journey.contracts import Candidate, Sighting

# person-tracker used a dedicated CLUSTER_WINDOW_SEC; reuse the reid same-camera
# dedup window as a sensible default when the journey-specific setting is absent.
_DEFAULT_CLUSTER_WINDOW_SEC = getattr(settings, "journey_cluster_window_sec", 30)


def collapse(candidates: list[Candidate], *, window_sec: int | None = None) -> list[Sighting]:
    if not candidates:
        return []
    window = dt.timedelta(seconds=window_sec or _DEFAULT_CLUSTER_WINDOW_SEC)

    by_camera: dict[uuid.UUID, list[Candidate]] = {}
    for c in candidates:
        by_camera.setdefault(c.camera_id, []).append(c)

    out: list[Sighting] = []
    for _camera_id, items in by_camera.items():
        items.sort(key=lambda c: c.occurred_at)
        cluster: list[Candidate] = []
        for c in items:
            # Track-aware linking: detections sharing a track_id are the SAME
            # continuous visit, so merge them even if the gap exceeds the window
            # (a person lingering still emits one track). Otherwise fall back to
            # the time-window rule. We do NOT split on track-id *change* — trackers
            # churn IDs through occlusions, and splitting on every churn fragments
            # one real visit into dozens of stops.
            prev = cluster[-1] if cluster else None
            same_track = (
                prev is not None
                and c.track_id is not None
                and prev.track_id is not None
                and c.track_id == prev.track_id
            )
            within_window = prev is not None and (c.occurred_at - prev.occurred_at) <= window
            if cluster and (same_track or within_window):
                cluster.append(c)
            else:
                if cluster:
                    out.append(_finalise(cluster))
                cluster = [c]
        if cluster:
            out.append(_finalise(cluster))

    # Chronological across cameras so the stitched video plays in time order.
    out.sort(key=lambda s: s.started_at)
    return out


def _finalise(cluster: list[Candidate]) -> Sighting:
    best = max(cluster, key=lambda c: c.similarity)
    return Sighting(
        sighting_id=uuid.uuid4(),
        camera_id=best.camera_id,
        camera_code=best.camera_code,
        camera_name=best.camera_name,
        started_at=min(c.occurred_at for c in cluster),
        ended_at=max(c.occurred_at for c in cluster),
        best_snapshot_uri=best.snapshot_uri,
        best_similarity=best.similarity,
        candidate_count=len(cluster),
        location=None,  # filled by geo.attach_locations() when rendering the map (P1d)
    )
