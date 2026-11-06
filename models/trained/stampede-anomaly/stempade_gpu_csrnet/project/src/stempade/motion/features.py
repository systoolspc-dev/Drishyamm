"""Physics-based motion features derived from a dense optical-flow field.

These are the interpretable, low-training-data signals at the heart of the
risk-indicator approach:

- speed            : mean flow magnitude (overall crowd motion)
- acceleration     : frame-to-frame change in speed (sudden bursts)
- divergence       : mean signed divergence; strongly NEGATIVE = flow converging
                     (funneling toward a blockage — a crush precursor)
- convergence      : max(0, -divergence), a positive "funneling" signal
- kinetic_energy   : mean squared flow magnitude (energy of the crowd)
- order_parameter  : Vicsek-style coherence in [0,1] (optical-flow analog of the
                     mutual-information order parameter); FALLING values signal the
                     breakdown of coherent motion that can precede a crush
- angular_entropy  : disorder of flow directions in [0,1] (rises with chaos)
"""
from __future__ import annotations

import numpy as np

# magnitudes below this (px/frame) are treated as noise and ignored for direction stats
_MIN_MAG = 0.25


def motion_features(flow: np.ndarray, prev_speed: float | None = None) -> dict[str, float]:
    """Compute scene-level motion features from an ``(H, W, 2)`` flow field.

    ``prev_speed`` (the previous frame's mean speed) enables acceleration; pass
    ``None`` for the first frame.
    """
    dx, dy = flow[..., 0], flow[..., 1]
    mag = np.sqrt(dx * dx + dy * dy)

    speed = float(mag.mean())
    kinetic_energy = float((mag ** 2).mean())

    # signed divergence = d(dx)/dx + d(dy)/dy  (negative => converging)
    ddx_dx = np.gradient(dx, axis=1)
    ddy_dy = np.gradient(dy, axis=0)
    div_field = ddx_dx + ddy_dy
    divergence = float(div_field.mean())
    convergence = float(max(0.0, -divergence))

    acceleration = float(abs(speed - prev_speed)) if prev_speed is not None else 0.0

    order_parameter, angular_entropy = _directional_order(dx, dy, mag)

    return {
        "speed": speed,
        "acceleration": acceleration,
        "divergence": divergence,
        "convergence": convergence,
        "kinetic_energy": kinetic_energy,
        "order_parameter": order_parameter,
        "angular_entropy": angular_entropy,
        # kept for config/back-compat: MI order parameter == directional coherence
        "mutual_information": order_parameter,
    }


def _directional_order(dx: np.ndarray, dy: np.ndarray, mag: np.ndarray,
                       bins: int = 16) -> tuple[float, float]:
    """Return (order_parameter, angular_entropy) from the flow direction field.

    order_parameter = |magnitude-weighted mean unit velocity|  in [0, 1]
        1.0 = perfectly coherent flow, 0.0 = fully disordered.
    angular_entropy = normalized Shannon entropy of the weighted angle histogram.
    """
    m = mag > _MIN_MAG
    if not m.any():
        return 0.0, 0.0

    w = mag[m]
    ang = np.arctan2(dy[m], dx[m])

    # Vicsek order parameter (magnitude-weighted resultant of unit vectors)
    cx = float(np.sum(w * np.cos(ang)))
    cy = float(np.sum(w * np.sin(ang)))
    order = float(np.hypot(cx, cy) / (w.sum() + 1e-9))

    # weighted angular entropy, normalized to [0, 1]
    hist, _ = np.histogram(ang, bins=bins, range=(-np.pi, np.pi), weights=w)
    p = hist / (hist.sum() + 1e-9)
    p = p[p > 0]
    entropy = float(-(p * np.log(p)).sum() / np.log(bins))

    return order, entropy
