"""DBSCAN clustering over the moving-pixel field.

A crush precursor often looks like moving mass compacting into a dense, growing
cluster (people funneling toward a bottleneck). We sample the pixels that are
actually moving and measure how concentrated they are.
"""
from __future__ import annotations

import numpy as np


def cluster_metrics(flow: np.ndarray, min_mag: float = 0.5,
                    eps: float = 20.0, min_samples: int = 8,
                    max_points: int = 2000) -> dict[str, float]:
    """Return concentration metrics of moving pixels.

    - moving_fraction : share of pixels that are moving
    - largest_cluster : share of moving pixels in the biggest DBSCAN cluster
    - n_clusters      : number of clusters found
    """
    dx, dy = flow[..., 0], flow[..., 1]
    mag = np.sqrt(dx * dx + dy * dy)
    ys, xs = np.where(mag > min_mag)
    total_px = flow.shape[0] * flow.shape[1]
    if len(xs) < min_samples:
        return {"moving_fraction": len(xs) / total_px, "largest_cluster": 0.0, "n_clusters": 0.0}

    pts = np.column_stack([xs, ys]).astype(float)
    if len(pts) > max_points:  # subsample for speed
        idx = np.linspace(0, len(pts) - 1, max_points).astype(int)
        pts = pts[idx]

    from sklearn.cluster import DBSCAN

    labels = DBSCAN(eps=eps, min_samples=min_samples).fit_predict(pts)
    valid = labels[labels >= 0]
    if valid.size == 0:
        return {"moving_fraction": len(xs) / total_px, "largest_cluster": 0.0, "n_clusters": 0.0}

    counts = np.bincount(valid)
    return {
        "moving_fraction": float(len(xs) / total_px),
        "largest_cluster": float(counts.max() / len(pts)),
        "n_clusters": float(len(counts)),
    }
