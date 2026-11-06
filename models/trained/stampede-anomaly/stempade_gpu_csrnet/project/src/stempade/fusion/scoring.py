"""Map raw physical signals to component sub-scores in [0, 1].

Each scorer converts an interpretable measurement into a danger sub-score that the
RiskFuser then combines. Where a per-camera Baseline is available, motion signals are
z-scored against that camera's own normal, which is what makes the score transferable
across scenes (the fix for the cross-scene AUC-collapse problem).
"""
from __future__ import annotations

import math

from ..calibration.baseline import Baseline
from ..motion.clustering import cluster_metrics


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _logistic(value: float, midpoint: float, scale: float) -> float:
    """0..1 logistic ramp: ~0.5 at `midpoint`, steepness set by `scale`."""
    return _sigmoid((value - midpoint) / max(scale, 1e-6))


class Scorer:
    """Produce {motion, density, clustering, rules} sub-scores per frame.

    Parameters
    ----------
    baseline : Baseline | None
        Per-camera normal statistics. If None, raw thresholds are used.
    density_danger : float
        people/m² at which the density sub-score ~= 0.5 (crush danger ~4-6 ppl/m²).
    """

    def __init__(self, baseline: Baseline | None = None,
                 density_danger: float = 5.0, density_scale: float = 1.5) -> None:
        self.baseline = baseline
        self.density_danger = density_danger
        self.density_scale = density_scale

    # --- component scorers -------------------------------------------------
    def motion_score(self, feats: dict[str, float]) -> float:
        """Danger from motion: fast + converging + chaotic + loss of order."""
        if self.baseline is not None:
            z = self.baseline.zscore(feats)
            speed_term = _logistic(z.get("speed", 0.0), 3.0, 1.5)
            ke_term = _logistic(z.get("kinetic_energy", 0.0), 3.0, 1.5)
            conv_term = _logistic(z.get("convergence", 0.0), 2.0, 1.5)
            entropy_term = _logistic(z.get("angular_entropy", 0.0), 2.0, 1.5)
            # order DROP is dangerous -> negative z of order_parameter
            order_term = _logistic(-z.get("order_parameter", 0.0), 2.0, 1.5)
        else:
            speed_term = _logistic(feats.get("speed", 0.0), 3.0, 1.0)
            ke_term = _logistic(feats.get("kinetic_energy", 0.0), 12.0, 4.0)
            conv_term = _logistic(feats.get("convergence", 0.0), 0.15, 0.05)
            entropy_term = _logistic(feats.get("angular_entropy", 0.0), 0.85, 0.1)
            order_term = _logistic(-feats.get("order_parameter", 1.0), -0.4, 0.15)

        # weighted blend; speed & convergence dominate
        return float(
            0.30 * speed_term + 0.20 * ke_term + 0.25 * conv_term
            + 0.15 * entropy_term + 0.10 * order_term
        )

    def density_score(self, people_per_m2: float | None) -> float | None:
        if people_per_m2 is None:
            return None
        return float(_logistic(people_per_m2, self.density_danger, self.density_scale))

    def clustering_score(self, flow) -> float | None:
        if flow is None:
            return None
        m = cluster_metrics(flow)
        # dangerous = a large share of movers compacted into one growing cluster
        return float(min(1.0, m["largest_cluster"] * (0.5 + m["moving_fraction"])))

    def rules_score(self, feats: dict[str, float],
                    people_per_m2: float | None = None) -> float:
        """Hard heuristic tripwires (defense-in-depth against model failure)."""
        hits = 0.0
        if self.baseline is not None:
            z = self.baseline.zscore(feats)
            if z.get("speed", 0.0) > 5.0:
                hits = max(hits, 0.8)
            if z.get("convergence", 0.0) > 4.0:
                hits = max(hits, 0.9)
        if people_per_m2 is not None and people_per_m2 > 7.0:
            hits = max(hits, 1.0)  # >7 ppl/m² is crush territory
        return hits

    # --- aggregate ---------------------------------------------------------
    def sub_scores(self, feats: dict[str, float], flow=None,
                   people_per_m2: float | None = None) -> dict[str, float]:
        out = {
            "motion": self.motion_score(feats),
            "rules": self.rules_score(feats, people_per_m2),
        }
        d = self.density_score(people_per_m2)
        if d is not None:
            out["density"] = d
        c = self.clustering_score(flow)
        if c is not None:
            out["clustering"] = c
        return out
