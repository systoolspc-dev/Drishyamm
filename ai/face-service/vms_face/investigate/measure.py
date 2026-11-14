"""Phase 0 meter for the I-1 search index: how many tracks per camera per day?

Before we index every person pass (crop + embedding + attributes + DB rows),
we need real numbers: finished tracks per camera per day, split into face
tracks (today's tracker) and person tracks (YOLO boxes, which also catch
people seen from behind). Those numbers size the GPU, Postgres, Qdrant and
MinIO budget.

The meter only counts. It never touches the GPU, the network or a database,
and every call is O(tracks in frame). The orchestrator creates one per camera
when ``investigate_measure_enabled`` is on.

Output:
  * Prometheus: ``vms_investigate_tracks_closed_total{camera_id,kind,kept}``
    and ``vms_investigate_track_duration_seconds{kind}``.
  * One ``investigate.measure`` log line per camera every
    ``investigate_measure_log_interval_s`` (works without Prometheus).
  * ``snapshot()`` for ``/debug/pipeline``.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.core.metrics import INVESTIGATE_TRACK_DURATION, INVESTIGATE_TRACKS_CLOSED
from vms_face.investigate.box_tracker import BoxTracker

log = get_logger(__name__)

KINDS = ("face", "person")


@dataclass(slots=True)
class _Tally:
    closed: int = 0
    kept: int = 0
    kept_seconds: float = 0.0

    def add(self, kept: bool, duration: float) -> None:
        self.closed += 1
        if kept:
            self.kept += 1
            self.kept_seconds += duration

    def as_dict(self) -> dict:
        return {
            "closed": self.closed,
            "kept": self.kept,
            "junk": self.closed - self.kept,
            "avg_kept_seconds": round(self.kept_seconds / self.kept, 1) if self.kept else None,
        }


class TrackMeter:
    def __init__(
        self,
        camera_label: str,
        *,
        clock: Callable[[], float] = time.time,
        min_seconds: float | None = None,
        min_hits: int | None = None,
        log_interval_s: float | None = None,
        person_max_gap_s: float | None = None,
    ) -> None:
        self.camera_label = camera_label
        self._clock = clock
        self.min_seconds = settings.investigate_min_track_seconds if min_seconds is None else min_seconds
        self.min_hits = settings.investigate_min_track_hits if min_hits is None else min_hits
        self.log_interval_s = (
            settings.investigate_measure_log_interval_s if log_interval_s is None else log_interval_s
        )
        self._persons = BoxTracker(
            max_gap_s=(
                settings.investigate_person_track_max_gap_s if person_max_gap_s is None else person_max_gap_s
            ),
            clock=clock,
        )
        # face track_id -> (first_seen, last_seen); IOUTracker has no timestamps.
        self._face_seen: dict[str, tuple[float, float]] = {}
        self._started = clock()
        self._window_start = self._started
        self._total = {k: _Tally() for k in KINDS}
        self._window = {k: _Tally() for k in KINDS}
        self._person_steps = 0

    # ── feeds ──────────────────────────────────────────────────────────────

    def face_step(self, tracked: Iterable, dropped: Iterable) -> None:
        """``tracked``: TrackedFace list from IOUTracker.step();
        ``dropped``: IOUTracker.dropped_last_step (Track objects)."""
        now = self._clock()
        seen = self._face_seen
        for tf in tracked:
            tid = tf.track.track_id
            first = seen[tid][0] if tid in seen else now
            seen[tid] = (first, now)
        for tr in dropped:
            first, last = seen.pop(tr.track_id, (now, now))
            self._record("face", last - first, int(getattr(tr, "hits", 0)))
        self.maybe_log()

    def person_step(self, boxes: Sequence[Sequence[float]]) -> None:
        """YOLO person boxes for a frame where the person detector ran."""
        self._person_steps += 1
        self._persons.step(boxes)
        for tr in self._persons.closed:
            self._record("person", tr.duration, tr.hits)

    def close(self) -> None:
        """Camera stopping: count what's still open, then log."""
        now = self._clock()
        for first, last in self._face_seen.values():
            self._record("face", last - first, self.min_hits)
        self._face_seen.clear()
        for tr in self._persons.flush():
            self._record("person", tr.duration, tr.hits)
        self._log(now)

    # ── output ─────────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        now = self._clock()
        elapsed = max(1.0, now - self._started)
        per_day = 86400.0 / elapsed
        return {
            "enabled": True,
            "running_seconds": round(elapsed),
            "person_detection_ran": self._person_steps > 0,
            "open": {"face": len(self._face_seen), "person": self._persons.active_count},
            "totals": {k: t.as_dict() for k, t in self._total.items()},
            # Straight-line projection; only meaningful after a full day.
            "kept_per_day_projection": {k: round(t.kept * per_day) for k, t in self._total.items()},
        }

    def maybe_log(self) -> None:
        now = self._clock()
        if now - self._window_start >= self.log_interval_s:
            self._log(now)

    def _log(self, now: float) -> None:
        w = self._window
        log.info(
            "investigate.measure",
            camera=self.camera_label,
            window_s=round(now - self._window_start),
            face_closed=w["face"].closed,
            face_kept=w["face"].kept,
            person_closed=w["person"].closed,
            person_kept=w["person"].kept,
            person_detection_ran=self._person_steps > 0,
            total_face_kept=self._total["face"].kept,
            total_person_kept=self._total["person"].kept,
        )
        self._window = {k: _Tally() for k in KINDS}
        self._window_start = now

    def _record(self, kind: str, duration: float, hits: int) -> None:
        kept = duration >= self.min_seconds and hits >= self.min_hits
        self._total[kind].add(kept, duration)
        self._window[kind].add(kept, duration)
        INVESTIGATE_TRACKS_CLOSED.labels(
            camera_id=self.camera_label, kind=kind, kept="yes" if kept else "no"
        ).inc()
        if kept:
            INVESTIGATE_TRACK_DURATION.labels(kind=kind).observe(duration)
