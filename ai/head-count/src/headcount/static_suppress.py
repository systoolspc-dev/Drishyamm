"""Static-object suppression — furniture is not people.

The YOLO head model occasionally scores head-SHAPED objects (chair headrests,
monitors) above any usable confidence floor (observed: a chair at 0.57). A
confidence threshold cannot fix a *stable* false positive — but physics can:
a real head moves within minutes; furniture never does.

Rule: a detection that stays in the same spot (IoU-matched) across
``min_hits`` inferences spanning ``min_span_sec`` seconds is flagged STATIC and
excluded from counts and preview. The moment motion touches its region
(someone sits in that chair), it is rehabilitated instantly and counts again.

Deterministic, ~zero cost (a handful of IoU checks per inference), fully
config-off-able per site.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU of two xyxy boxes."""
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if inter <= 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return float(inter / max(area_a + area_b - inter, 1e-9))


@dataclass
class _Entry:
    box: np.ndarray          # EMA'd xyxy in frame coordinates
    first_t: float
    last_t: float
    hits: int = 1
    suppressed: bool = False


@dataclass
class StaticBoxSuppressor:
    iou_thr: float = 0.6
    min_span_sec: float = 120.0
    min_hits: int = 8
    stale_sec: float = 45.0
    entries: list[_Entry] = field(default_factory=list)

    def update(self, boxes: np.ndarray, now: float) -> list[bool]:
        """Match this inference's boxes against the registry.

        Returns keep-flags aligned with ``boxes``: True = count/draw it,
        False = suppressed static object. Also ages the registry.
        """
        keep: list[bool] = []
        claimed: set[int] = set()
        for b in boxes:
            best_i, best_v = -1, 0.0
            for i, e in enumerate(self.entries):
                if i in claimed:
                    continue
                v = iou(b, e.box)
                if v > best_v:
                    best_i, best_v = i, v
            if best_i >= 0 and best_v >= self.iou_thr:
                e = self.entries[best_i]
                claimed.add(best_i)
                e.box = 0.8 * e.box + 0.2 * np.asarray(b, dtype=np.float32)
                e.last_t = now
                e.hits += 1
                if (not e.suppressed and e.hits >= self.min_hits
                        and (now - e.first_t) >= self.min_span_sec):
                    e.suppressed = True
                keep.append(not e.suppressed)
            else:
                self.entries.append(
                    _Entry(box=np.asarray(b, dtype=np.float32), first_t=now, last_t=now)
                )
                keep.append(True)
        # Age out entries that stopped being detected (occluded/moved away).
        self.entries = [e for e in self.entries if (now - e.last_t) <= self.stale_sec]
        return keep

    def rehabilitate(self, prev_gray: np.ndarray, cur_gray: np.ndarray,
                     frame_w: int, frame_h: int,
                     pixel_delta: int = 12, motion_frac: float = 0.05) -> int:
        """Un-suppress any entry whose region shows motion (someone arrived).

        prev/cur are the motion-gate thumbnails; boxes are scaled into them.
        Returns how many entries were rehabilitated.
        """
        if prev_gray is None or cur_gray is None or not self.entries:
            return 0
        th, tw = cur_gray.shape[:2]
        sx, sy = tw / max(frame_w, 1), th / max(frame_h, 1)
        n = 0
        for e in self.entries:
            if not e.suppressed:
                continue
            x1 = max(0, int(e.box[0] * sx)); y1 = max(0, int(e.box[1] * sy))
            x2 = min(tw, int(e.box[2] * sx) + 1); y2 = min(th, int(e.box[3] * sy) + 1)
            if x2 <= x1 or y2 <= y1:
                continue
            region_prev = prev_gray[y1:y2, x1:x2].astype(np.int16)
            region_cur = cur_gray[y1:y2, x1:x2].astype(np.int16)
            frac = float((np.abs(region_cur - region_prev) > pixel_delta).mean())
            if frac >= motion_frac:
                e.suppressed = False
                e.first_t = e.last_t   # restart the stillness clock
                e.hits = 1
                n += 1
        return n

    @property
    def suppressed_count(self) -> int:
        return sum(1 for e in self.entries if e.suppressed)
