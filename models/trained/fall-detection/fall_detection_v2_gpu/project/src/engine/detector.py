"""The runtime fall-detection engine.

Ties everything together for live/recorded video:
    frame -> YOLO-pose+tracking -> per-person feature window -> classifier
          -> per-person state machine -> events

Each tracked person has independent state, so multiple people in one CCTV frame
are handled correctly. Timing is derived from frame index / fps (deterministic,
works identically on recorded files and live streams).

Confirmation logic — why it's fraction-based:
A single window classifier fires briefly both on real falls AND on lying-down
transitions. The discriminator is DURATION: a real fall keeps the probability
high for seconds (person stays on the floor), while lying down on a bed/sofa
only spikes for ~0.5s and then decays. So we confirm a FALL only when a high
FRACTION of frames over a ~2s window are fall-ish. This is also robust to brief
pose-keypoint dropouts (which previously reset a per-frame check and caused
missed falls).
"""
from __future__ import annotations
from collections import deque
from dataclasses import dataclass, field
from enum import Enum

import numpy as np
import torch

import config
from src.features.normalize import extract_features, is_grounded
from src.model.model import build_model
from src.pose.base import TrackedPose


class State(Enum):
    NORMAL = "normal"
    FALL = "fall"          # confirmed emergency (person stayed down)


@dataclass
class TrackState:
    window: deque = field(default_factory=lambda: deque(maxlen=config.WINDOW_SIZE))
    # (t, prob) history over roughly the last CONFIRM_SECONDS
    prob_hist: deque = field(default_factory=deque)
    state: State = State.NORMAL
    last_seen_t: float = 0.0
    last_bbox: np.ndarray | None = None
    prob: float = 0.0      # latest classifier probability


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU of two normalized (x1,y1,x2,y2) boxes."""
    x1 = max(a[0], b[0]); y1 = max(a[1], b[1])
    x2 = min(a[2], b[2]); y2 = min(a[3], b[3])
    inter = max(x2 - x1, 0) * max(y2 - y1, 0)
    area_a = max(a[2] - a[0], 0) * max(a[3] - a[1], 0)
    area_b = max(b[2] - b[0], 0) * max(b[3] - b[1], 0)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


@dataclass
class FallEvent:
    track_id: int
    time_sec: float
    bbox: np.ndarray


class FallEngine:
    def __init__(self, model_path=config.FALL_CLASSIFIER_PATH, device: str | None = None):
        self.device = torch.device(
            device or ("cuda" if torch.cuda.is_available()
                       else "mps" if torch.backends.mps.is_available() else "cpu")
        )
        ckpt = torch.load(model_path, map_location=self.device)
        self.model = build_model(ckpt["n_features"]).to(self.device)
        self.model.load_state_dict(ckpt["state_dict"])
        self.model.eval()
        self.tracks: dict[int, TrackState] = {}

    def _classify(self, ts: TrackState) -> float:
        if len(ts.window) < config.WINDOW_SIZE:
            return 0.0
        x = torch.tensor(np.stack(ts.window)[None], dtype=torch.float32,
                         device=self.device)
        with torch.no_grad():
            return float(torch.sigmoid(self.model(x)).item())

    @staticmethod
    def _fallish_fraction(ts: TrackState, t_sec: float):
        """Over the last CONFIRM_SECONDS, return (fall-ish fraction, grounded
        fraction, have-full-window). grounded fraction is how much of the window
        showed a body actually on the ground (vs standing / bent over)."""
        # prune history older than the confirm window
        while ts.prob_hist and t_sec - ts.prob_hist[0][0] > config.CONFIRM_SECONDS:
            ts.prob_hist.popleft()
        if not ts.prob_hist:
            return 0.0, 0.0, False
        span = t_sec - ts.prob_hist[0][0]
        have_full = span >= config.CONFIRM_SECONDS * 0.9
        n = len(ts.prob_hist)
        fallish = sum(p >= config.FALL_PROB_THRESHOLD for _, p, _ in ts.prob_hist)
        grounded = sum(g for _, _, g in ts.prob_hist)
        return fallish / n, grounded / n, have_full

    def process(self, poses: list[TrackedPose], t_sec: float):
        """Advance the engine by one frame. Returns (per_track_status, events)."""
        events: list[FallEvent] = []
        status = {}
        seen = set()

        for p in poses:
            tid = p.track_id
            # Track hand-off: if this is a NEW id, but a recently-lost track sat
            # at the same location, inherit its state so a fall in progress isn't
            # lost when the tracker reassigns the id (occlusion / fast fall).
            if tid not in self.tracks:
                best, best_iou = None, 0.4
                for otid, ots in self.tracks.items():
                    if otid in seen or ots.last_bbox is None:
                        continue
                    if t_sec - ots.last_seen_t > 1.5:
                        continue
                    i = _iou(p.bbox, ots.last_bbox)
                    if i > best_iou:
                        best, best_iou = otid, i
                if best is not None:
                    self.tracks[tid] = self.tracks.pop(best)

            seen.add(tid)
            ts = self.tracks.setdefault(tid, TrackState())
            ts.last_seen_t = t_sec
            ts.last_bbox = p.bbox.copy()
            ts.window.append(extract_features(p.keypoints))
            ts.prob = self._classify(ts)
            ts.prob_hist.append((t_sec, ts.prob, is_grounded(p.keypoints)))

            frac, grounded_frac, have_full = self._fallish_fraction(ts, t_sec)

            if ts.state == State.NORMAL:
                # a fall must look fall-ish AND the body must actually be on the
                # ground for part of the window (vetoes bending/shoveling, where
                # the legs stay vertical the whole time -> grounded_frac ~ 0)
                if (have_full and frac >= config.CONFIRM_FRACTION
                        and grounded_frac >= config.GROUNDED_FRACTION):
                    ts.state = State.FALL
                    events.append(FallEvent(p.track_id, t_sec, p.bbox.copy()))
            elif ts.state == State.FALL:
                if frac <= config.RECOVER_FRACTION:   # person got back up / cleared
                    ts.state = State.NORMAL

            status[p.track_id] = (ts.state, ts.prob)

        # forget tracks that vanished a while ago
        for tid in [t for t in self.tracks if t not in seen
                    and t_sec - self.tracks[t].last_seen_t > 5.0]:
            del self.tracks[tid]

        return status, events
