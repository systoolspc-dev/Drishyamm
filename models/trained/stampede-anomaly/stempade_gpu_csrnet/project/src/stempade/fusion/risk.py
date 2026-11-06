"""Weighted risk-score fusion with temporal persistence.

v1 is deliberately a transparent weighted sum + a sustained-signal gate (the
false-alarm control that governs operator trust). A learned fusion model can
replace ``combine`` in Phase 5 without changing the interface.
"""
from __future__ import annotations

from collections import deque
from enum import IntEnum


class RiskLevel(IntEnum):
    NORMAL = 0
    MODERATE = 1
    HIGH = 2
    CRITICAL = 3


class RiskFuser:
    """Combine component sub-scores (each in [0, 1]) into a risk level.

    Parameters
    ----------
    weights : dict[str, float]
        Per-component weights (e.g. motion, density, clustering, rules). Normalized.
    thresholds : dict[str, float]
        Score cutoffs for ``moderate`` / ``high`` / ``critical``.
    persistence_frames : int
        Number of consecutive frames a level must hold before it is emitted.
    """

    def __init__(self, weights: dict[str, float], thresholds: dict[str, float],
                 persistence_frames: int = 45, persistence_ratio: float = 0.66,
                 combiner=None) -> None:
        total = sum(weights.values()) or 1.0
        self.weights = {k: v / total for k, v in weights.items()}
        self.thresholds = thresholds
        self._history: deque[RiskLevel] = deque(maxlen=persistence_frames)
        self.persistence_frames = persistence_frames
        self.persistence_ratio = persistence_ratio
        # optional learned fuser (Phase 5) — must expose .combine(sub_scores)->[0,1]
        self.combiner = combiner

    def combine(self, sub_scores: dict[str, float]) -> float:
        """Risk score in [0, 1]. Uses a learned combiner if provided, else a
        weighted sum of available sub-scores."""
        if self.combiner is not None:
            return float(self.combiner.combine(sub_scores))
        num = sum(self.weights.get(k, 0.0) * v for k, v in sub_scores.items())
        denom = sum(self.weights.get(k, 0.0) for k in sub_scores) or 1.0
        return num / denom

    def _to_level(self, score: float) -> RiskLevel:
        t = self.thresholds
        if score >= t["critical"]:
            return RiskLevel.CRITICAL
        if score >= t["high"]:
            return RiskLevel.HIGH
        if score >= t["moderate"]:
            return RiskLevel.MODERATE
        return RiskLevel.NORMAL

    def update(self, sub_scores: dict[str, float]) -> tuple[float, RiskLevel]:
        """Feed one frame's sub-scores; return (risk_score, persisted_level).

        A level is emitted only once the instantaneous level has been at-or-above
        it for at least ``persistence_ratio`` of the persistence window. Using a
        fraction (not every frame) tolerates brief dips while still suppressing
        single-frame spikes — the false-alarm control.
        """
        score = self.combine(sub_scores)
        self._history.append(self._to_level(score))

        n = len(self._history)
        if n < self.persistence_frames:  # warm-up: not enough history yet
            return score, RiskLevel.NORMAL

        emitted = RiskLevel.NORMAL
        for lvl in (RiskLevel.CRITICAL, RiskLevel.HIGH, RiskLevel.MODERATE):
            frac = sum(1 for x in self._history if x >= lvl) / n
            if frac >= self.persistence_ratio:
                emitted = lvl
                break
        return score, emitted
