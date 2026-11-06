"""End-to-end stampede-detection pipeline.

Wires ingestion -> motion (+ optional density) -> scoring -> fusion into a stream of
per-frame RiskState. Runs identically over an offline video (eval) or a live RTSP
feed (serving). Density is optional so the whole thing runs without torch.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator

import numpy as np

from .calibration.baseline import Baseline
from .calibration.homography import Homography
from .fusion import RiskFuser, RiskLevel, Scorer
from .ingestion import FrameSource
from .motion import MotionAnalyzer


@dataclass
class RiskState:
    frame_idx: int
    time_s: float
    score: float
    level: RiskLevel
    sub_scores: dict[str, float] = field(default_factory=dict)
    features: dict[str, float] = field(default_factory=dict)
    people_per_m2: float | None = None


class StampedePipeline:
    def __init__(self, config: dict,
                 baseline: Baseline | None = None,
                 homography: Homography | None = None) -> None:
        self.config = config
        self.fps = float(config.get("ingestion", {}).get("target_fps", 15))

        self.analyzer = MotionAnalyzer(
            farneback_params=config.get("motion", {}).get("farneback", {}))

        self.scorer = Scorer(baseline=baseline)

        fcfg = config.get("fusion", {})
        persistence = int(round(fcfg.get("temporal_persistence_sec", 3.0) * self.fps))
        combiner = None
        if fcfg.get("learned_model"):
            from .fusion.learned import LearnedFuser
            combiner = LearnedFuser.load(fcfg["learned_model"])
        self.fuser = RiskFuser(
            weights=fcfg.get("weights", {"motion": 1.0}),
            thresholds=fcfg.get("thresholds",
                               {"moderate": 0.45, "high": 0.60, "critical": 0.80}),
            persistence_frames=max(1, persistence),
            persistence_ratio=fcfg.get("temporal_persistence_ratio", 0.66),
            combiner=combiner,
        )

        # optional density branch (Phase 2, needs torch + weights)
        self.density = None
        self.homography = homography
        self._ground_area = None
        dcfg = config.get("density", {})
        if dcfg.get("enabled"):
            from .density import DensityEstimator
            self.density = DensityEstimator(weights=dcfg.get("weights"))
            if homography is not None:
                self._ground_area = self._frame_ground_area(config)

    def _frame_ground_area(self, config: dict) -> float | None:
        """Ground-plane area (m²) of the frame via the homography corners."""
        if self.homography is None or self.homography.matrix is None:
            return None
        w, h = config.get("ingestion", {}).get("resize", [640, 480])
        corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=float)
        m = self.homography.pixels_to_meters(corners)
        # shoelace area
        x, y = m[:, 0], m[:, 1]
        return float(0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))

    def _people_per_m2(self, frame: np.ndarray) -> float | None:
        if self.density is None or not self._ground_area:
            return None
        count = self.density.count(frame)
        return count / self._ground_area

    def run(self, source: str | None = None) -> Iterator[RiskState]:
        icfg = self.config.get("ingestion", {})
        src = source or icfg.get("source")
        frames = FrameSource(src, target_fps=self.fps,
                             resize=tuple(icfg.get("resize")) if icfg.get("resize") else None)

        for i, frame in enumerate(frames):
            feats = self.analyzer.process(frame)
            if feats is None:  # first frame, no flow yet
                yield RiskState(i, i / self.fps, 0.0, RiskLevel.NORMAL)
                continue

            ppl = self._people_per_m2(frame)
            subs = self.scorer.sub_scores(feats, flow=self.analyzer.last_flow,
                                          people_per_m2=ppl)
            score, level = self.fuser.update(subs)
            yield RiskState(i, i / self.fps, score, level,
                            sub_scores=subs, features=feats, people_per_m2=ppl)
