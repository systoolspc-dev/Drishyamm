"""SORT-style tracker with Kalman prediction, Hungarian assignment, and an
optional appearance-feature term in the cost matrix (DeepSORT-style).

State (per track):
    x = [cx, cy, s, r, vx, vy, vs]^T   (7,)
    where (cx, cy) is the bbox center, s is scale (= w*h, area), r is aspect
    (= w/h), and (vx, vy, vs) are constant-velocity terms. Aspect r is
    treated as quasi-constant — short-term aspect drift is mostly noise.

Observation:
    z = [cx, cy, s, r]^T               (4,)

Cost matrix (T tracks × D detections):
    cost[t, d] = w_iou * (1 - IoU(predicted_box_t, det_box_d))
               + w_app * (1 - cosine(track_t.smooth_embedding, det_d.embedding))
    Pairs gated by IoU < tracker_iou_threshold are forbidden (assigned +inf)
    so wildly disjoint pairs are never matched even if appearance lies.

Solved with scipy.optimize.linear_sum_assignment (the Hungarian / Kuhn-
Munkres algorithm), giving optimal assignment in O((T+D)^3) — fast in
practice for the per-camera face counts we see (typically <50).

Track lifecycle:
    - born on unmatched detection
    - matched detection → kalman update + hits++ + miss_count=0
    - unmatched track → kalman predict only + miss_count++
    - dropped when miss_count > max_age

Per-track embedding pool (top-K quality-weighted) is unchanged from Phase 1.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
from scipy.optimize import linear_sum_assignment

from vms_face.config import settings
from vms_face.infra.insightface_runtime import FaceObservation
from vms_face.services.identity_latch import IdentityLatch
from vms_face.services.track_attributes import TrackAttributes
from vms_face.services.track_embedding_pool import TrackEmbeddingPool

_INF = 1e9


# ── Kalman bookkeeping ────────────────────────────────────────────────────


def _bbox_to_z(bbox: np.ndarray) -> np.ndarray:
    """[x1,y1,x2,y2] → [cx, cy, s, r] where s=w*h and r=w/h."""
    x1, y1, x2, y2 = bbox
    w = max(1e-6, float(x2 - x1))
    h = max(1e-6, float(y2 - y1))
    cx = float(x1 + w / 2.0)
    cy = float(y1 + h / 2.0)
    s = w * h
    r = w / h
    return np.array([cx, cy, s, r], dtype=np.float64)


def _x_to_bbox(x: np.ndarray) -> np.ndarray:
    """[cx, cy, s, r, ...] → [x1, y1, x2, y2] using w=sqrt(s*r), h=sqrt(s/r)."""
    cx, cy, s, r = x[0], x[1], x[2], x[3]
    s = max(1e-6, float(s))
    r = max(1e-6, float(r))
    w = float(np.sqrt(s * r))
    h = float(np.sqrt(s / r))
    return np.array([cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0], dtype=np.float32)


class _KalmanBox:
    """Constant-velocity Kalman filter on (cx, cy, s, r). Pure NumPy."""

    __slots__ = ("x", "P", "F", "H", "Q", "R")

    def __init__(self, bbox: np.ndarray) -> None:
        # State 7-D, observation 4-D.
        self.x = np.zeros((7, 1), dtype=np.float64)
        self.x[:4, 0] = _bbox_to_z(bbox)
        # State transition (constant-velocity for cx, cy, s; r and vs decoupled simply).
        self.F = np.eye(7, dtype=np.float64)
        for i in range(3):
            self.F[i, i + 4] = 1.0
        # Observation model: take first 4 dims.
        self.H = np.zeros((4, 7), dtype=np.float64)
        self.H[:4, :4] = np.eye(4)
        # Covariances tuned to the SORT defaults — generous on velocity uncertainty.
        self.P = np.eye(7, dtype=np.float64) * 10.0
        self.P[4:, 4:] *= 1000.0
        # Process noise: small on position, slightly larger on velocity.
        self.Q = np.eye(7, dtype=np.float64) * 0.01
        self.Q[4:, 4:] *= 0.1
        # Measurement noise.
        self.R = np.eye(4, dtype=np.float64)
        self.R[2:, 2:] *= 10.0

    def predict(self) -> np.ndarray:
        # If predicted scale would go negative, clamp velocity.
        if self.x[2, 0] + self.x[6, 0] <= 0:
            self.x[6, 0] = 0.0
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q
        return _x_to_bbox(self.x[:, 0])

    def update(self, bbox: np.ndarray) -> None:
        z = _bbox_to_z(bbox).reshape(4, 1)
        y = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        I7 = np.eye(7, dtype=np.float64)
        self.P = (I7 - K @ self.H) @ self.P

    def bbox(self) -> np.ndarray:
        return _x_to_bbox(self.x[:, 0])


# ── Public Track / TrackedFace types ───────────────────────────────────────


def _default_pool() -> TrackEmbeddingPool:
    return TrackEmbeddingPool(
        top_k=settings.track_pool_top_k,
        min_quality=settings.track_pool_min_quality,
    )


@dataclass(slots=True)
class Track:
    track_id: str
    bbox: np.ndarray              # last predicted/updated [x1,y1,x2,y2]
    last_seen_frame: int
    hits: int = 1
    miss_count: int = 0
    age: int = 0                  # frames since birth (predicts + updates)
    last_obs: FaceObservation | None = None
    best_quality: float = 0.0
    best_obs: FaceObservation | None = None
    embedding_pool: TrackEmbeddingPool = field(default_factory=_default_pool)
    # Quality-weighted gender/age vote — same multi-frame-fusion idea as the
    # embedding pool, applied to the genderage head's noisy per-crop output.
    attributes: TrackAttributes = field(default_factory=TrackAttributes)
    # L0 identity cache: who this track is, how sure we are, and whether the
    # recognizer needs to look again. Same per-track-fusion idea as the
    # embedding pool and the attribute vote, applied to the identity itself.
    identity: IdentityLatch = field(default_factory=IdentityLatch)
    smooth_embedding: np.ndarray | None = None   # EWMA appearance vector
    # Frames seen on this track since the orchestrator last decided to embed.
    # Track-local cadence avoids the "all tracks embed on the same frame"
    # GPU burst pattern that a global frame.seq mod produces.
    frames_since_last_embed: int = 0
    extra: dict = field(default_factory=dict)


@dataclass(slots=True)
class TrackedFace:
    track: Track
    observation: FaceObservation
    is_new: bool


# ── Tracker ────────────────────────────────────────────────────────────────


class IOUTracker:
    """Backward-compatible name. Underneath now: SORT (Kalman + Hungarian)
    with optional DeepSORT-style appearance term.

    Kept the historical class name because every caller imports
    `IOUTracker`; behavior is strictly an upgrade — pure-IoU matching is
    still the dominant cost when appearance is unavailable, and the public
    surface (`step`, `update_quality`, `is_confirmed`, `active_track_count`)
    is unchanged."""

    def __init__(
        self,
        iou_threshold: float | None = None,
        max_age: int | None = None,
        min_hits: int | None = None,
        *,
        appearance_weight: float | None = None,
        appearance_alpha: float | None = None,
    ) -> None:
        self.iou_threshold = iou_threshold or settings.tracker_iou_threshold
        self.max_age = max_age or settings.tracker_max_age
        self.min_hits = min_hits or settings.tracker_min_hits
        self.appearance_weight = (
            appearance_weight
            if appearance_weight is not None
            else settings.tracker_appearance_weight
        )
        self.appearance_alpha = (
            appearance_alpha
            if appearance_alpha is not None
            else settings.tracker_appearance_alpha
        )
        self._tracks: dict[str, Track] = {}
        self._kalman: dict[str, _KalmanBox] = {}
        self._next_id = 1
        self._frame_idx = 0
        # Tracks aged out by the most recent step(). The orchestrator reads
        # this to bank a dead track's identity for re-association; it is
        # overwritten on every step, so consumers must read it right after.
        self.dropped_last_step: list[Track] = []

    # ── public API ─────────────────────────────────────────────────────────

    def step(self, observations: Iterable[FaceObservation]) -> list[TrackedFace]:
        self._frame_idx += 1
        obs_list = list(observations)

        # 1. Predict every active track forward one step.
        track_ids = list(self._tracks.keys())
        predicted_boxes: list[np.ndarray] = []
        for tid in track_ids:
            kf = self._kalman[tid]
            predicted_boxes.append(kf.predict())
            self._tracks[tid].bbox = predicted_boxes[-1]
            self._tracks[tid].age += 1

        if not track_ids and not obs_list:
            return []

        # 2. Build cost matrix.
        cost = self._build_cost_matrix(track_ids, predicted_boxes, obs_list)

        # 3. Hungarian assignment.
        matched_pairs: list[tuple[int, int]] = []
        used_tracks: set[int] = set()
        used_obs: set[int] = set()
        if cost.size > 0:
            row_ind, col_ind = linear_sum_assignment(cost)
            for i, j in zip(row_ind, col_ind):
                if cost[i, j] >= _INF / 2.0:
                    continue
                matched_pairs.append((int(i), int(j)))
                used_tracks.add(int(i))
                used_obs.add(int(j))

        emitted: list[TrackedFace] = []

        # 4. Update matched tracks via Kalman + appearance EWMA.
        for i, j in matched_pairs:
            tid = track_ids[i]
            tr = self._tracks[tid]
            obs = obs_list[j]
            self._kalman[tid].update(np.asarray(obs.bbox, dtype=np.float32))
            tr.bbox = self._kalman[tid].bbox()
            tr.last_obs = obs
            tr.last_seen_frame = self._frame_idx
            tr.hits += 1
            tr.miss_count = 0
            self._update_smooth_embedding(tr, obs)
            emitted.append(TrackedFace(track=tr, observation=obs, is_new=False))

        # 5. Birth new tracks for unmatched observations.
        for j, obs in enumerate(obs_list):
            if j in used_obs:
                continue
            tid = f"t{self._next_id:08d}"
            self._next_id += 1
            kf = _KalmanBox(np.asarray(obs.bbox, dtype=np.float32))
            self._kalman[tid] = kf
            tr = Track(
                track_id=tid,
                bbox=kf.bbox(),
                last_seen_frame=self._frame_idx,
                last_obs=obs,
            )
            self._update_smooth_embedding(tr, obs, is_new=True)
            self._tracks[tid] = tr
            emitted.append(TrackedFace(track=tr, observation=obs, is_new=True))

        # 6. Age out & drop stale tracks (predicted but never matched again).
        to_drop: list[str] = []
        for idx, tid in enumerate(track_ids):
            if idx in used_tracks:
                continue
            tr = self._tracks[tid]
            tr.miss_count = self._frame_idx - tr.last_seen_frame
            if tr.miss_count > self.max_age:
                to_drop.append(tid)
        dropped: list[Track] = []
        for tid in to_drop:
            tr = self._tracks.pop(tid, None)
            self._kalman.pop(tid, None)
            if tr is not None:
                dropped.append(tr)
        self.dropped_last_step = dropped

        return emitted

    def get_track(self, track_id: str) -> Track | None:
        return self._tracks.get(track_id)

    def update_appearance(self, track_id: str, embedding: np.ndarray) -> None:
        """Feed a post-detection embedding back into the track's smoothed
        appearance vector. Called by the orchestrator after the recognizer
        runs (for the AdaFace path the FaceObservation has no embedding,
        so the appearance feature would otherwise stay empty for the
        track's lifetime)."""
        tr = self._tracks.get(track_id)
        if tr is None:
            return
        arr = np.asarray(embedding, dtype=np.float32).reshape(-1)
        n = float(np.linalg.norm(arr))
        if n <= 0:
            return
        arr = arr / n
        if tr.smooth_embedding is None:
            tr.smooth_embedding = arr.astype(np.float32, copy=True)
            return
        alpha = self.appearance_alpha
        smoothed = alpha * tr.smooth_embedding + (1.0 - alpha) * arr
        sn = float(np.linalg.norm(smoothed))
        if sn > 0:
            smoothed = smoothed / sn
        tr.smooth_embedding = smoothed.astype(np.float32)

    def update_quality(self, track_id: str, quality_score: float, obs: FaceObservation) -> bool:
        tr = self._tracks.get(track_id)
        if tr is None:
            return False
        if quality_score > tr.best_quality:
            tr.best_quality = quality_score
            tr.best_obs = obs
            return True
        return False

    def is_confirmed(self, track_id: str) -> bool:
        tr = self._tracks.get(track_id)
        return bool(tr and tr.hits >= self.min_hits)

    def tracks(self) -> list[Track]:
        """Every live track (matched this frame or coasting on prediction)."""
        return list(self._tracks.values())

    @property
    def active_track_count(self) -> int:
        return len(self._tracks)

    def tracks_for_overlay(self, max_miss: int = 0) -> list[Track]:
        """Tracks to draw this frame, including Kalman-predicted ones.

        `step()` already advanced every track's Kalman state, so `track.bbox`
        holds the current predicted position whether or not the face was
        detected this frame. `max_miss` bounds how many consecutive missed
        detections a box may be drawn through:

          - 0  → only tracks matched THIS frame (what the overlay drew before,
                 so the default is an exact no-op).
          - N  → also draw tracks predicted for up to N frames, which is what
                 lets the box keep gliding with a moving person while the
                 detector runs every N frames.

        Kept small on purpose: a person who has actually LEFT keeps a track
        alive until `max_age`, so drawing every alive track would leave ghost
        boxes for ~max_age frames after they go. Bounding by recent-miss draws
        the box through detection gaps but drops it promptly on real departure.
        """
        return [t for t in self._tracks.values() if t.miss_count <= max_miss]

    # ── internals ──────────────────────────────────────────────────────────

    def _build_cost_matrix(
        self,
        track_ids: list[str],
        predicted_boxes: list[np.ndarray],
        obs_list: list[FaceObservation],
    ) -> np.ndarray:
        T = len(track_ids)
        D = len(obs_list)
        if T == 0 or D == 0:
            return np.zeros((T, D), dtype=np.float64)

        track_boxes = np.stack(predicted_boxes).astype(np.float32)
        obs_boxes = np.array([o.bbox for o in obs_list], dtype=np.float32)
        iou = _iou_matrix(track_boxes, obs_boxes)
        cost_iou = 1.0 - iou
        cost = cost_iou.astype(np.float64)

        if self.appearance_weight > 0:
            track_embs = [self._tracks[tid].smooth_embedding for tid in track_ids]
            obs_embs = [_get_obs_embedding(obs) for obs in obs_list]
            track_mask = np.array([e is not None for e in track_embs], dtype=bool)
            obs_mask = np.array([e is not None for e in obs_embs], dtype=bool)
            cost_app = np.zeros((T, D), dtype=np.float64)
            if track_mask.any() and obs_mask.any():
                # Stack only the rows/cols where both sides have an embedding,
                # then write back into the dense matrix via boolean indexing.
                # Single matmul replaces the (T*D) Python loop.
                t_emb = np.stack([e for e in track_embs if e is not None]).astype(np.float64)
                o_emb = np.stack([e for e in obs_embs if e is not None]).astype(np.float64)
                sim = t_emb @ o_emb.T
                sub_cost = np.maximum(0.0, 1.0 - sim)
                # Build the (T,D) sub-block index by outer product of masks.
                pair_mask = np.outer(track_mask, obs_mask)
                cost_app[pair_mask] = sub_cost.reshape(-1)
            cost = (1.0 - self.appearance_weight) * cost + self.appearance_weight * cost_app

        # Gate impossible matches: forbid pairs whose IoU is below the
        # threshold regardless of appearance.
        cost[iou < self.iou_threshold] = _INF
        return cost

    def _update_smooth_embedding(
        self,
        track: Track,
        obs: FaceObservation,
        *,
        is_new: bool = False,
    ) -> None:
        emb = _get_obs_embedding(obs)
        if emb is None:
            return
        if is_new or track.smooth_embedding is None:
            track.smooth_embedding = emb.astype(np.float32, copy=True)
            return
        alpha = self.appearance_alpha
        smoothed = alpha * track.smooth_embedding + (1.0 - alpha) * emb
        n = float(np.linalg.norm(smoothed))
        if n > 0:
            smoothed = smoothed / n
        track.smooth_embedding = smoothed.astype(np.float32)


def _get_obs_embedding(obs: FaceObservation) -> np.ndarray | None:
    emb = obs.embedding
    if emb is None:
        return None
    arr = np.asarray(emb, dtype=np.float32)
    if arr.ndim != 1:
        arr = arr.reshape(-1)
    n = float(np.linalg.norm(arr))
    if n <= 0:
        return None
    return arr / n


def _iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """a: (N,4), b: (M,4); both [x1,y1,x2,y2]. Returns (N,M) IOU matrix."""
    if a.size == 0 or b.size == 0:
        return np.zeros((a.shape[0], b.shape[0]), dtype=np.float64)
    a_x1, a_y1, a_x2, a_y2 = a[:, 0:1], a[:, 1:2], a[:, 2:3], a[:, 3:4]
    b_x1, b_y1, b_x2, b_y2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    inter_x1 = np.maximum(a_x1, b_x1)
    inter_y1 = np.maximum(a_y1, b_y1)
    inter_x2 = np.minimum(a_x2, b_x2)
    inter_y2 = np.minimum(a_y2, b_y2)
    inter_w = np.clip(inter_x2 - inter_x1, 0, None)
    inter_h = np.clip(inter_y2 - inter_y1, 0, None)
    inter = inter_w * inter_h
    area_a = (a_x2 - a_x1) * (a_y2 - a_y1)
    area_b = (b_x2 - b_x1) * (b_y2 - b_y1)
    union = area_a + area_b - inter + 1e-9
    return (inter / union).astype(np.float64)
