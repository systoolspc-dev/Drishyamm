"""The runtime fall-detection engine.

Ties everything together for live/recorded video:
    frame -> YOLO-pose+tracking -> per-person feature window -> classifier
          -> per-person state machine (debounce + stayed-down) -> events

Each tracked person has independent state, so multiple people in one CCTV frame
are handled correctly. Timing is derived from frame index / fps (deterministic,
works identically on recorded files and live streams).
"""
from __future__ import annotations
from collections import deque
from dataclasses import dataclass, field
from enum import Enum

import numpy as np
import torch

import config
from src.features.normalize import extract_features, is_horizontal
from src.model.model import build_model
from src.pose.base import TrackedPose


class State(Enum):
    NORMAL = "normal"
    CANDIDATE = "candidate"      # looks like a fall, waiting to confirm it stays down
    FALL = "fall"               # confirmed emergency


@dataclass
class TrackState:
    window: deque = field(default_factory=lambda: deque(maxlen=config.WINDOW_SIZE))
    state: State = State.NORMAL
    fallish: int = 0             # consecutive fall-ish window count (debounce)
    candidate_t: float = 0.0     # time the candidate started
    last_seen_t: float = 0.0
    prob: float = 0.0            # latest classifier probability


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

    def process(self, poses: list[TrackedPose], t_sec: float):
        """Advance the engine by one frame. Returns (per_track_status, events)."""
        events: list[FallEvent] = []
        status = {}
        seen = set()

        for p in poses:
            seen.add(p.track_id)
            ts = self.tracks.setdefault(p.track_id, TrackState())
            ts.last_seen_t = t_sec
            ts.window.append(extract_features(p.keypoints))
            ts.prob = self._classify(ts)
            down_now = is_horizontal(p.keypoints)

            # --- debounce: accumulate fall-ish windows ---
            if ts.prob >= config.FALL_PROB_THRESHOLD:
                ts.fallish += 1
            else:
                ts.fallish = max(ts.fallish - 1, 0)

            if ts.state == State.NORMAL:
                if ts.fallish >= config.DEBOUNCE_WINDOWS and down_now:
                    ts.state = State.CANDIDATE
                    ts.candidate_t = t_sec

            elif ts.state == State.CANDIDATE:
                if not down_now:
                    # got back up within the grace window -> false alarm
                    if t_sec - ts.candidate_t <= config.RECOVER_GRACE_SECONDS:
                        ts.state = State.NORMAL
                        ts.fallish = 0
                elif t_sec - ts.candidate_t >= config.CONFIRM_SECONDS:
                    # stayed down long enough -> real emergency
                    ts.state = State.FALL
                    events.append(FallEvent(p.track_id, t_sec, p.bbox.copy()))

            elif ts.state == State.FALL:
                if not down_now:  # recovered -> reset for future detections
                    ts.state = State.NORMAL
                    ts.fallish = 0

            status[p.track_id] = (ts.state, ts.prob)

        # forget tracks that vanished a while ago
        for tid in [t for t in self.tracks if t not in seen
                    and t_sec - self.tracks[t].last_seen_t > 5.0]:
            del self.tracks[tid]

        return status, events
