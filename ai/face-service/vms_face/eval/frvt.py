"""NIST FRVT-style 1:N identification metrics.

Per the FRVT 1:N protocol, the headline metric is **FNIR @ FPIR = 1e-3**:
the False-Negative Identification Rate (proportion of known-identity probes
that fail to be matched correctly) at the operating point where the
False-Positive Identification Rate (proportion of unknown-identity probes
that produce ANY match above threshold) is at most 1 in 1000.

This is more rigorous than threshold-based TPR/FPR because:
  1. It removes the threshold from the measurement — we sweep all thresholds
     and pick the one that meets the target FPIR.
  2. It directly maps to operational cost: "false alerts per 1000 unknowns".
  3. It lets you compare detectors / recognizers / quality gates fairly,
     without fighting over what threshold to use.

For the same reasons we also report:
  - FNIR @ FPIR=1e-2 (lower bar — fine for forensic search)
  - FNIR @ FPIR=3e-3
  - DET curve (Detection Error Tradeoff) — FNIR vs FPIR log-log

Reference: NIST FRVT 1:N protocol (NIST IR 8009 series).
TinyFace AdaFace ceiling for context: Rank-1 = 72.29% (≈ FNIR ~0.28 at large galleries).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from vms_face.eval.types import ProbeOutcome


@dataclass(slots=True)
class OperatingPoint:
    """A single point on the DET curve."""
    fpir_target: float
    fpir_observed: float
    threshold: float
    fnir: float
    n_known: int
    n_unknown: int

    def to_dict(self) -> dict:
        return {
            "fpir_target": self.fpir_target,
            "fpir_observed": round(self.fpir_observed, 6),
            "threshold": round(self.threshold, 4),
            "fnir": round(self.fnir, 4),
            "tpir": round(1.0 - self.fnir, 4),
            "n_known": self.n_known,
            "n_unknown": self.n_unknown,
        }


@dataclass(slots=True)
class DETCurve:
    """Full Detection Error Tradeoff curve, plus key NIST operating points."""
    points: list[tuple[float, float, float]]   # [(threshold, fpir, fnir), ...]
    operating_points: dict[str, OperatingPoint]   # keyed by "fpir=1e-3" etc.
    n_known: int
    n_unknown: int

    def to_dict(self) -> dict:
        return {
            "n_known": self.n_known,
            "n_unknown": self.n_unknown,
            "operating_points": {k: v.to_dict() for k, v in self.operating_points.items()},
            "curve": [
                {"threshold": round(t, 4), "fpir": round(fpir, 6), "fnir": round(fnir, 6)}
                for t, fpir, fnir in self.points
            ],
        }


def compute_det_curve(
    outcomes: Iterable[ProbeOutcome],
    *,
    fpir_targets: tuple[float, ...] = (1e-2, 3e-3, 1e-3),
) -> DETCurve | None:
    """Build the DET curve and pin requested operating points.

    For 1:N FRVT-style scoring, each probe's *top-1 candidate similarity* is
    treated as a score. We then sweep score thresholds and at each one count:
      - FN  = known-id probe whose top-1 score < threshold OR top-1 id != true id
      - TP  = known-id probe correctly matched at top-1 with score >= threshold
      - FP  = unknown-id probe whose top-1 score >= threshold (any match counts)
      - TN  = unknown-id probe whose top-1 score < threshold

    FNIR = FN / (TP + FN)
    FPIR = FP / (FP + TN)

    Probes with `undetected` or `rejected_quality` are still counted: an
    undetected known-id probe is a false negative regardless of threshold,
    and an undetected unknown is a true negative."""

    known_pairs: list[tuple[float, bool]] = []  # (similarity, was_correct_id)
    unknown_pairs: list[float] = []             # unknown's top-1 similarity

    for o in outcomes:
        if o.true_person_id is not None:
            # known probe
            if o.undetected or o.rejected_quality or o.predicted_person_id is None:
                known_pairs.append((-1.0, False))
            else:
                correct = (o.predicted_person_id == o.true_person_id)
                known_pairs.append((float(o.similarity or 0.0), correct))
        else:
            # unknown probe
            if o.undetected or o.rejected_quality or o.predicted_person_id is None:
                unknown_pairs.append(-1.0)
            else:
                unknown_pairs.append(float(o.similarity or 0.0))

    n_known = len(known_pairs)
    n_unknown = len(unknown_pairs)
    if n_known == 0 or n_unknown == 0:
        return None

    # Build the union of candidate thresholds for a smooth curve
    all_thresholds = sorted({s for s, _ in known_pairs} | set(unknown_pairs))
    # Add a virtual "+inf" so we get the (0, 1) endpoint
    all_thresholds.append(all_thresholds[-1] + 1.0 if all_thresholds else 1.0)

    points: list[tuple[float, float, float]] = []
    for t in all_thresholds:
        tp = sum(1 for sim, ok in known_pairs if sim >= t and ok)
        fn = n_known - tp
        fp = sum(1 for sim in unknown_pairs if sim >= t)
        # tn = n_unknown - fp  # implicit
        fnir = fn / n_known
        fpir = fp / n_unknown
        points.append((t, fpir, fnir))

    points.sort(key=lambda p: p[1])  # ascending FPIR, useful for searching

    # Pin operating points: pick the smallest threshold whose observed FPIR ≤ target.
    # Equivalently the lowest fpir entry whose fpir <= target — pick the one with
    # smallest FNIR among those.
    operating_points: dict[str, OperatingPoint] = {}
    for target in fpir_targets:
        eligible = [(t, fpir, fnir) for t, fpir, fnir in points if fpir <= target]
        if not eligible:
            # target FPIR not achievable — record the closest achievable
            t, fpir, fnir = min(points, key=lambda p: p[1])
        else:
            t, fpir, fnir = min(eligible, key=lambda p: p[2])
        key = _format_target_key(target)
        operating_points[key] = OperatingPoint(
            fpir_target=target,
            fpir_observed=fpir,
            threshold=t,
            fnir=fnir,
            n_known=n_known,
            n_unknown=n_unknown,
        )

    return DETCurve(
        points=points,
        operating_points=operating_points,
        n_known=n_known,
        n_unknown=n_unknown,
    )


def _format_target_key(target: float) -> str:
    if target >= 1e-2:
        return f"fpir={target:.0e}"
    return f"fpir={target:.0e}"
