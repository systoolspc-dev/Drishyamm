"""Per-camera baseline statistics for normalizing motion features.

The cross-scene AUC-collapse finding (0.704 -> 0.499) means thresholds must be set
per camera. We estimate the mean/std of each motion feature from a clip of NORMAL
activity, then downstream scoring measures how many std-devs the live signal sits
above that camera's own normal. This makes the risk score comparable across cameras.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

from ..ingestion import FrameSource
from ..motion import MotionAnalyzer


@dataclass
class Baseline:
    """Per-feature mean/std learned from normal footage."""

    mean: dict[str, float] = field(default_factory=dict)
    std: dict[str, float] = field(default_factory=dict)
    n_frames: int = 0

    def zscore(self, feats: dict[str, float]) -> dict[str, float]:
        out = {}
        for k, v in feats.items():
            mu = self.mean.get(k, 0.0)
            sd = self.std.get(k, 0.0)
            out[k] = (v - mu) / sd if sd > 1e-9 else 0.0
        return out

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls, path: str | Path) -> "Baseline":
        return cls(**json.loads(Path(path).read_text()))


def estimate_baseline(source: str, target_fps: float = 15,
                      resize: tuple[int, int] | None = (640, 480),
                      max_frames: int | None = None) -> Baseline:
    """Compute per-feature mean/std of motion features over a NORMAL clip."""
    analyzer = MotionAnalyzer()
    frames = FrameSource(source, target_fps=target_fps, resize=resize)

    acc: dict[str, list[float]] = {}
    n = 0
    for frame in frames:
        feats = analyzer.process(frame)
        if feats is None:
            continue
        for k, v in feats.items():
            if np.isfinite(v):
                acc.setdefault(k, []).append(float(v))
        n += 1
        if max_frames and n >= max_frames:
            break

    mean = {k: float(np.mean(vs)) for k, vs in acc.items()}
    std = {k: float(np.std(vs)) for k, vs in acc.items()}
    return Baseline(mean=mean, std=std, n_frames=n)
