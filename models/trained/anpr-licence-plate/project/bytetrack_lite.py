"""
bytetrack_lite.py — a self-contained ByteTrack (Zhang et al. 2022).

Same idea as the ultralytics tracker the worker used before, without torch:
  • constant-velocity Kalman filter per track on (cx, cy, w, h)
  • TWO-STAGE association: high-confidence detections first (IoU + Hungarian),
    then the LOW-confidence leftovers are matched to still-unmatched tracks —
    that second pass is what keeps a vehicle's id alive through a few frames
    of partial occlusion or motion blur, which is exactly when the plate is
    hardest to read and the vote needs continuity most.
  • lost tracks are kept for `lost_buffer` frames and can be re-attached.

Track ids restart at 1 when `reset()` is called — the worker does that on a
stream reconnect / loop discontinuity so ids never bridge a scene cut.
"""

from __future__ import annotations

import numpy as np

try:
    from scipy.optimize import linear_sum_assignment as _lsa
except Exception:  # pragma: no cover — greedy fallback
    _lsa = None


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)), np.float32)
    ax1, ay1, ax2, ay2 = a[:, 0:1], a[:, 1:2], a[:, 2:3], a[:, 3:4]
    bx1, by1, bx2, by2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    iw = np.clip(np.minimum(ax2, bx2) - np.maximum(ax1, bx1), 0, None)
    ih = np.clip(np.minimum(ay2, by2) - np.maximum(ay1, by1), 0, None)
    inter = iw * ih
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return (inter / (area_a + area_b - inter + 1e-6)).astype(np.float32)


def _assign(cost: np.ndarray, max_cost: float):
    """→ matches [(row, col)], unmatched rows, unmatched cols."""
    if cost.size == 0:
        return [], list(range(cost.shape[0])), list(range(cost.shape[1]))
    if _lsa is not None:
        r, c = _lsa(cost)
        pairs = [(int(i), int(j)) for i, j in zip(r, c) if cost[i, j] <= max_cost]
    else:
        pairs = []
        used_r, used_c = set(), set()
        for i, j in sorted(
            ((i, j) for i in range(cost.shape[0]) for j in range(cost.shape[1])), key=lambda ij: cost[ij]
        ):
            if cost[i, j] > max_cost:
                break
            if i in used_r or j in used_c:
                continue
            pairs.append((i, j))
            used_r.add(i)
            used_c.add(j)
    mr = {i for i, _ in pairs}
    mc = {j for _, j in pairs}
    return (
        pairs,
        [i for i in range(cost.shape[0]) if i not in mr],
        [j for j in range(cost.shape[1]) if j not in mc],
    )


class _KF:
    """Constant-velocity Kalman on x=[cx, cy, w, h, vx, vy, vw, vh]."""

    def __init__(self, box: np.ndarray):
        cx, cy, w, h = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, box[2] - box[0], box[3] - box[1]
        self.x = np.array([cx, cy, w, h, 0, 0, 0, 0], np.float32)
        self.P = np.diag([10, 10, 10, 10, 100, 100, 100, 100]).astype(np.float32)
        self.F = np.eye(8, dtype=np.float32)
        self.F[0, 4] = self.F[1, 5] = self.F[2, 6] = self.F[3, 7] = 1.0
        self.H = np.zeros((4, 8), np.float32)
        self.H[0, 0] = self.H[1, 1] = self.H[2, 2] = self.H[3, 3] = 1.0
        self.Q = np.diag([1, 1, 1, 1, 4, 4, 1, 1]).astype(np.float32)
        self.R = np.diag([4, 4, 16, 16]).astype(np.float32)

    def predict(self):
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q
        self.x[2] = max(self.x[2], 1.0)
        self.x[3] = max(self.x[3], 1.0)

    def update(self, box: np.ndarray):
        z = np.array(
            [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, box[2] - box[0], box[3] - box[1]], np.float32
        )
        y = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        self.P = (np.eye(8, dtype=np.float32) - K @ self.H) @ self.P

    @property
    def box(self) -> np.ndarray:
        cx, cy, w, h = self.x[:4]
        return np.array([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], np.float32)


class Track:
    __slots__ = ("id", "kf", "score", "cls", "hits", "age", "misses", "confirmed", "box")

    def __init__(self, tid: int, det: np.ndarray):
        self.id = tid
        self.kf = _KF(det[:4])
        self.box = det[:4].copy()
        self.score = float(det[4])
        self.cls = int(det[5])
        self.hits = 1
        self.age = 1
        self.misses = 0
        self.confirmed = False


class ByteTrackLite:
    def __init__(
        self,
        *,
        track_thresh: float = 0.5,
        match_iou: float = 0.2,
        low_match_iou: float = 0.5,
        lost_buffer: int = 30,
        min_hits: int = 2,
    ):
        self.track_thresh = track_thresh
        self.match_iou = match_iou
        self.low_match_iou = low_match_iou
        self.lost_buffer = lost_buffer
        self.min_hits = min_hits
        self.tracks: list[Track] = []
        self._next = 1
        self.frame = 0

    def reset(self):
        self.tracks = []
        self._next = 1
        self.frame = 0

    def update(self, dets: np.ndarray) -> list[tuple[float, float, float, float, int, int, float]]:
        """dets: (N,6) x1,y1,x2,y2,score,cls → confirmed tracks seen THIS frame
        as (x1,y1,x2,y2,id,cls,score)."""
        self.frame += 1
        dets = np.asarray(dets, np.float32).reshape(-1, 6)
        for t in self.tracks:
            t.kf.predict()
            t.age += 1
        active = [t for t in self.tracks if t.misses == 0]
        lost = [t for t in self.tracks if t.misses > 0]

        high = dets[dets[:, 4] >= self.track_thresh]
        low = dets[dets[:, 4] < self.track_thresh]

        # stage 1: all tracks vs high-confidence detections
        pool = active + lost
        pboxes = np.array([t.kf.box for t in pool], np.float32).reshape(-1, 4)
        pairs, un_t, un_d = _assign(1.0 - iou_matrix(pboxes, high[:, :4]), 1.0 - self.match_iou)
        matched_ids = set()
        for ti, di in pairs:
            self._hit(pool[ti], high[di])
            matched_ids.add(id(pool[ti]))
        # stage 2: still-unmatched ACTIVE tracks vs low-confidence detections
        rem_active = [pool[i] for i in un_t if pool[i].misses == 0]
        if rem_active and len(low):
            rboxes = np.array([t.kf.box for t in rem_active], np.float32)
            pairs2, un_t2, _ = _assign(1.0 - iou_matrix(rboxes, low[:, :4]), 1.0 - self.low_match_iou)
            for ti, di in pairs2:
                self._hit(rem_active[ti], low[di])
                matched_ids.add(id(rem_active[ti]))
        # misses
        for t in self.tracks:
            if id(t) not in matched_ids:
                t.misses += 1
        # births from unmatched high-confidence detections
        for di in un_d:
            self.tracks.append(Track(self._next, high[di]))
            self._next += 1
        # deaths
        self.tracks = [
            t for t in self.tracks if t.misses <= self.lost_buffer and not (t.misses > 0 and not t.confirmed)
        ]
        out = []
        for t in self.tracks:
            if t.misses == 0 and t.confirmed:
                x1, y1, x2, y2 = t.box
                out.append((float(x1), float(y1), float(x2), float(y2), t.id, t.cls, t.score))
        return out

    def _hit(self, t: Track, det: np.ndarray):
        t.kf.update(det[:4])
        t.box = det[:4].copy()
        t.score = float(det[4])
        t.cls = int(det[5])
        t.hits += 1
        t.misses = 0
        if t.hits >= self.min_hits:
            t.confirmed = True


if __name__ == "__main__":
    # a box moving right 8 px/frame with one dropped frame keeps its id
    bt = ByteTrackLite(min_hits=1)
    ids = []
    for f in range(12):
        if f == 6:
            out = bt.update(np.zeros((0, 6), np.float32))
        else:
            x = 100 + 8 * f
            out = bt.update(np.array([[x, 100, x + 60, 140, 0.9, 2]], np.float32))
        ids.append([o[4] for o in out])
    print(ids)
    assert all(i == [1] for i in ids if i), ids
    print("bytetrack_lite OK")
