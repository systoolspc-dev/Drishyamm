"""Evaluation metrics for stampede detection.

Beyond AUC (which the research showed does NOT imply deployable reliability),
the metrics that matter operationally are early-warning lead time and
false-alarm rate per hour.
"""
from __future__ import annotations

import numpy as np


def auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """Frame-level ROC AUC. Validate cross-scene, not just same-scene."""
    from sklearn.metrics import roc_auc_score

    return float(roc_auc_score(labels, scores))


def lead_time(alarm_frame: int, event_frame: int, fps: float) -> float:
    """Seconds the alarm preceded the ground-truth crush onset.

    Positive = early warning; negative = late/missed.
    """
    return (event_frame - alarm_frame) / fps


def false_alarm_rate(false_alarms: int, duration_hours: float) -> float:
    """False alarms per hour — the KPI that governs operator trust."""
    if duration_hours <= 0:
        raise ValueError("duration_hours must be > 0")
    return false_alarms / duration_hours
