"""Minimal IoU box tracker for person (and later vehicle) detections.

The face pipeline's ``IOUTracker`` is built around ``FaceObservation``s
(embeddings, quality, identity latch). YOLO person boxes are plain
``(x1, y1, x2, y2, score)`` tuples that arrive only every Nth frame, so this
tracker is deliberately small: greedy IoU matching, time-based expiry, and a
``closed`` list of finished tracks for the caller to consume.

Pure Python + no GPU: safe to unit-test with a fake clock.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

Box = Sequence[float]  # (x1, y1, x2, y2[, score])


def iou(a: Box, b: Box) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


@dataclass(slots=True)
class BoxTrack:
    track_id: str
    bbox: tuple[float, float, float, float]
    first_seen: float
    last_seen: float
    hits: int = 1
    max_area: float = 0.0
    extra: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return max(0.0, self.last_seen - self.first_seen)


class BoxTracker:
    """Greedy IoU tracker with time-based expiry.

    ``step(boxes)`` matches boxes to live tracks by IoU (highest first),
    births tracks for the rest, and moves tracks unseen for more than
    ``max_gap_s`` into ``closed`` (overwritten on every step, like
    ``IOUTracker.dropped_last_step``).
    """

    def __init__(
        self,
        *,
        iou_threshold: float = 0.3,
        max_gap_s: float = 1.0,
        id_prefix: str = "p",
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.iou_threshold = iou_threshold
        self.max_gap_s = max_gap_s
        self._prefix = id_prefix
        self._clock = clock
        self._tracks: dict[str, BoxTrack] = {}
        self._next_id = 1
        self.closed: list[BoxTrack] = []

    @property
    def active_count(self) -> int:
        return len(self._tracks)

    def step(self, boxes: Iterable[Box]) -> list[BoxTrack]:
        now = self._clock()
        boxes = [tuple(float(v) for v in b[:4]) for b in boxes]

        pairs: list[tuple[float, str, int]] = []
        for tid, tr in self._tracks.items():
            for j, b in enumerate(boxes):
                s = iou(tr.bbox, b)
                if s >= self.iou_threshold:
                    pairs.append((s, tid, j))
        pairs.sort(reverse=True)

        used_t: set[str] = set()
        used_b: set[int] = set()
        live: list[BoxTrack] = []
        for _, tid, j in pairs:
            if tid in used_t or j in used_b:
                continue
            used_t.add(tid)
            used_b.add(j)
            tr = self._tracks[tid]
            tr.bbox = boxes[j]  # type: ignore[assignment]
            tr.last_seen = now
            tr.hits += 1
            tr.max_area = max(tr.max_area, _area(boxes[j]))
            live.append(tr)

        for j, b in enumerate(boxes):
            if j in used_b:
                continue
            tid = f"{self._prefix}{self._next_id:08d}"
            self._next_id += 1
            tr = BoxTrack(track_id=tid, bbox=b, first_seen=now, last_seen=now, max_area=_area(b))  # type: ignore[arg-type]
            self._tracks[tid] = tr
            live.append(tr)

        self.closed = self._expire(now)
        return live

    def flush(self) -> list[BoxTrack]:
        """Close every live track (camera stopping)."""
        out = list(self._tracks.values())
        self._tracks.clear()
        self.closed = out
        return out

    def _expire(self, now: float) -> list[BoxTrack]:
        dead = [tid for tid, tr in self._tracks.items() if now - tr.last_seen > self.max_gap_s]
        return [self._tracks.pop(tid) for tid in dead]


def _area(b: Box) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
