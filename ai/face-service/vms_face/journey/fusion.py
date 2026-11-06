"""Journey fusion scoring.

Appearance is the *driver* (face + body); time and space are multiplicative
*gates* — a physically impossible transition (wrong building, too fast) vetoes a
high appearance score. See docs/JOURNEY_CENTRALIZATION.md §fusion.

    appearance = (w_f·face + w_b·body) / (w_f + w_b)      # body term optional
    link_score = appearance · time_gate · space_gate

Body term combines the OSNet cosine (when available) and clothing-colour
agreement, so "same shirt + same trousers" boosts a borderline face match.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from vms_face.config import settings


@dataclass(frozen=True)
class FusionWeights:
    w_face: float = 0.65
    w_body: float = 0.35
    # Within the OSNet/colour body term, how much each contributes.
    w_osnet: float = 0.6
    w_colour: float = 0.4

    @classmethod
    def from_settings(cls) -> "FusionWeights":
        return cls(
            w_face=float(getattr(settings, "journey_w_face", 0.65)),
            w_body=float(getattr(settings, "journey_w_body", 0.35)),
            w_osnet=float(getattr(settings, "journey_w_osnet", 0.6)),
            w_colour=float(getattr(settings, "journey_w_colour", 0.4)),
        )


def body_term(osnet_sim: float | None, colour_sim: float | None, w: FusionWeights) -> float | None:
    """Combine the OSNet cosine and clothing-colour agreement into one body
    signal in [0,1], or None when neither is available."""
    parts: list[tuple[float, float]] = []
    if osnet_sim is not None:
        parts.append((w.w_osnet, max(0.0, min(1.0, osnet_sim))))
    if colour_sim is not None:
        parts.append((w.w_colour, max(0.0, min(1.0, colour_sim))))
    if not parts:
        return None
    wsum = sum(wt for wt, _ in parts)
    return sum(wt * val for wt, val in parts) / wsum if wsum else None


def appearance_score(face_sim: float, body_sim: float | None, w: FusionWeights) -> float:
    """Weighted face+body appearance. Face-only when no body signal."""
    face_sim = max(0.0, min(1.0, face_sim))
    if body_sim is None:
        return face_sim
    body_sim = max(0.0, min(1.0, body_sim))
    denom = w.w_face + w.w_body
    return (w.w_face * face_sim + w.w_body * body_sim) / denom if denom else face_sim


def time_gate(delta_sec: float, t_min_sec: float, t_max_sec: float, *, decay_sec: float = 120.0) -> float:
    """1.0 when the inter-camera gap is physically plausible; smooth exponential
    decay outside the [t_min, t_max] window. Negative gap (B before A) → 0."""
    if delta_sec < 0:
        return 0.0
    if t_min_sec <= delta_sec <= t_max_sec:
        return 1.0
    over = (t_min_sec - delta_sec) if delta_sec < t_min_sec else (delta_sec - t_max_sec)
    return math.exp(-over / max(1.0, decay_sec))


def space_gate(adjacency_prob: float | None) -> float:
    """Adjacency prior in [floor,1]. Unknown edge → a soft non-zero floor so an
    unmapped camera pair isn't hard-vetoed, just penalised."""
    floor = float(getattr(settings, "journey_space_gate_floor", 0.15))
    if adjacency_prob is None:
        return floor
    return max(floor, min(1.0, adjacency_prob))


def link_score(appearance: float, tg: float, sg: float) -> float:
    """Final cross-camera link score: appearance gated by time and space."""
    return appearance * tg * sg
