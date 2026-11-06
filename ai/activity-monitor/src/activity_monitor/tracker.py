"""Minimal IoU tracker — assigns stable IDs to boxes across frames.

Deliberately simple (greedy IoU matching, no Kalman/appearance) because we only
need short-term identity to smooth per-person state on mostly-stationary people.
One instance per stream (tracker state must not be shared across cameras).
"""

from __future__ import annotations


def _iou(a, b) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


def _center(b):
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


class Track:
    __slots__ = ("id", "box", "misses")

    def __init__(self, tid: int, box):
        self.id = tid
        self.box = box
        self.misses = 0


class IoUTracker:
    """Greedy IoU tracker with a center-distance fallback.

    Office/CCTV people are mostly stationary but their detection box jitters and
    occasionally drops for a few frames — plain IoU then loses the track and a
    new ID is minted (one person → dozens of "people"). Two guards fix that:
      * a CENTER-DISTANCE fallback re-associates a jittered box to a track whose
        centre it's still near (scaled by box width), even when IoU dips below
        threshold;
      * `max_misses` keeps a track alive across brief detection gaps so the same
        person keeps their ID when they flicker out and back.
    """

    def __init__(self, iou_threshold: float = 0.3, max_misses: int = 45,
                 center_dist_ratio: float = 0.6):
        self.iou_threshold = iou_threshold
        self.max_misses = max_misses
        self.center_dist_ratio = center_dist_ratio
        self._tracks: list[Track] = []
        self._next_id = 1

    def update(self, boxes: list) -> list[int]:
        """Match `boxes` (list of [x1,y1,x2,y2]) to tracks; return an ID per box."""
        assigned = [None] * len(boxes)
        used_tracks: set[int] = set()
        used_boxes: set[int] = set()

        # Pass 1 — greedy IoU, best pairs first.
        pairs = []
        for bi, box in enumerate(boxes):
            for ti, tr in enumerate(self._tracks):
                iou = _iou(box, tr.box)
                if iou >= self.iou_threshold:
                    pairs.append((iou, bi, ti))
        pairs.sort(reverse=True)
        for _iou_val, bi, ti in pairs:
            if bi in used_boxes or ti in used_tracks:
                continue
            used_boxes.add(bi)
            used_tracks.add(ti)
            tr = self._tracks[ti]
            tr.box = boxes[bi]
            tr.misses = 0
            assigned[bi] = tr.id

        # Pass 2 — center-distance fallback for boxes IoU missed (jitter/shrink).
        for bi, box in enumerate(boxes):
            if assigned[bi] is not None:
                continue
            bc = _center(box)
            bw = box[2] - box[0]
            best_ti, best_d = None, 1e18
            for ti, tr in enumerate(self._tracks):
                if ti in used_tracks:
                    continue
                tc = _center(tr.box)
                d = ((bc[0] - tc[0]) ** 2 + (bc[1] - tc[1]) ** 2) ** 0.5
                tol = self.center_dist_ratio * max(bw, tr.box[2] - tr.box[0], 1.0)
                if d <= tol and d < best_d:
                    best_d, best_ti = d, ti
            if best_ti is not None:
                used_tracks.add(best_ti)
                tr = self._tracks[best_ti]
                tr.box = box
                tr.misses = 0
                assigned[bi] = tr.id

        # New tracks for anything still unmatched.
        for bi, box in enumerate(boxes):
            if assigned[bi] is None:
                tr = Track(self._next_id, box)
                self._next_id += 1
                self._tracks.append(tr)
                assigned[bi] = tr.id

        # Age out unmatched tracks (kept alive up to max_misses frames).
        for ti, tr in enumerate(self._tracks):
            if ti not in used_tracks:
                tr.misses += 1
        self._tracks = [t for t in self._tracks if t.misses <= self.max_misses]

        return assigned
