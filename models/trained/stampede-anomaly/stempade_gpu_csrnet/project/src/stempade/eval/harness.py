"""Evaluate the pipeline on a labeled video.

Labels: one 0/1 per sampled frame (1 = stampede/panic), as a .npy or whitespace/
newline-separated .txt. Produces AUC + first-alarm lead time + false-alarm count.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ..fusion import RiskLevel
from ..pipeline import StampedePipeline
from .metrics import auc, false_alarm_rate, lead_time


def load_labels(path: str | Path) -> np.ndarray:
    path = Path(path)
    if path.suffix == ".npy":
        return np.load(path).astype(int)
    return np.array(path.read_text().split(), dtype=int)


def evaluate_video(config: dict, source: str, labels_path: str,
                   baseline=None, homography=None,
                   alarm_level: RiskLevel = RiskLevel.HIGH) -> dict:
    labels = load_labels(labels_path)
    pipe = StampedePipeline(config, baseline=baseline, homography=homography)
    fps = pipe.fps

    scores, alarm_frames, states = [], [], []
    for st in pipe.run(source):
        states.append(st)
        scores.append(st.score)
        if st.level >= alarm_level:
            alarm_frames.append(st.frame_idx)

    scores = np.array(scores[: len(labels)])
    labels = labels[: len(scores)]

    report: dict[str, object] = {"n_frames": len(scores)}

    # AUC (needs both classes present)
    if labels.min() != labels.max():
        report["auc"] = round(auc(scores, labels), 4)
    else:
        report["auc"] = "n/a (single class)"

    # lead time: first alarm vs first positive-label frame
    pos = np.where(labels == 1)[0]
    if pos.size and alarm_frames:
        event_frame = int(pos[0])
        first_alarm = int(min(alarm_frames))
        report["lead_time_s"] = round(lead_time(first_alarm, event_frame, fps), 2)
    else:
        report["lead_time_s"] = "n/a"

    # false alarms: alarm frames that fall in labeled-normal segments
    fa = sum(1 for f in alarm_frames if f < len(labels) and labels[f] == 0)
    duration_h = len(scores) / fps / 3600.0
    report["false_alarms"] = fa
    report["false_alarm_rate_per_h"] = round(false_alarm_rate(fa, duration_h), 2) if duration_h > 0 else "n/a"
    return report
