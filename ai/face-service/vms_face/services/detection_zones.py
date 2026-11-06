from __future__ import annotations

from typing import Any


def _number(value: Any, default: float | None = None) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if n != n:
        return default
    return max(0.0, min(1.0, n))


# Each zone is one of three shapes the operator drew in the UI:
#   • "line"    — a 2-point straight boundary; the ``side`` field selects which
#                 half-plane is watched.
#   • "box"     — a rectangle stored as its 4 corner points.
#   • "polygon" — a freeform 3..24-point outline.
_SHAPE_MIN_POINTS = {"line": 2, "box": 3, "polygon": 3}


def normalize_zones(raw: Any) -> list[dict[str, Any]]:
    """Return enabled detection zones with normalized 0..1 points.

    The frontend stores camera-frame shapes (line / box / polygon). Keeping the
    contract normalized lets the same zone survive stream resolution changes.
    """
    if not isinstance(raw, list):
        return []

    zones: list[dict[str, Any]] = []
    for index, zone in enumerate(raw[:8]):
        if not isinstance(zone, dict) or zone.get("enabled") is False:
            continue
        shape = zone.get("shape")
        if shape not in _SHAPE_MIN_POINTS:
            shape = "polygon"
        raw_points = zone.get("points")
        if not isinstance(raw_points, list):
            continue
        points: list[dict[str, float]] = []
        for point in raw_points[:24]:
            if not isinstance(point, dict):
                continue
            x = _number(point.get("x"))
            y = _number(point.get("y"))
            if x is None or y is None:
                continue
            points.append({"x": x, "y": y})
        if len(points) < _SHAPE_MIN_POINTS[shape]:
            continue
        if shape == "line":
            points = points[:2]

        apply_to = zone.get("applyTo")
        if not isinstance(apply_to, list):
            apply_to = ["face", "person"]
        apply_to = [str(item) for item in apply_to if item in {"face", "person"}]
        if not apply_to:
            apply_to = ["face", "person"]

        zones.append(
            {
                "id": str(zone.get("id") or f"zone-{index + 1}")[:64],
                "name": str(zone.get("name") or f"Detection Zone {index + 1}")[:80],
                "shape": shape,
                "side": "right" if zone.get("side") == "right" else "left",
                "applyTo": sorted(set(apply_to)),
                "points": points,
            }
        )
    return zones


def _point_on_inside_of_line(x: float, y: float, points: list[dict[str, float]], side: str) -> bool:
    """True when (x, y) lies on the watched half-plane of the line a→b.

    Sign convention matches the frontend's ``lineInsideNormal``: the 'left'
    half-plane is where the cross product of (b - a) × (p - a) is >= 0.
    """
    if len(points) < 2:
        return False
    a, b = points[0], points[1]
    cross = (b["x"] - a["x"]) * (y - a["y"]) - (b["y"] - a["y"]) * (x - a["x"])
    if side == "right":
        return cross <= 1e-9
    return cross >= -1e-9


def _point_in_zone(x: float, y: float, zone: dict[str, Any]) -> bool:
    if zone.get("shape") == "line":
        return _point_on_inside_of_line(x, y, zone["points"], zone.get("side", "left"))
    return _point_in_polygon(x, y, zone["points"])


def _point_in_polygon(x: float, y: float, points: list[dict[str, float]]) -> bool:
    inside = False
    j = len(points) - 1
    for i, pi in enumerate(points):
        pj = points[j]
        xi, yi = pi["x"], pi["y"]
        xj, yj = pj["x"], pj["y"]

        # Boundary counts as inside so an operator can draw tight lines.
        cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi)
        if abs(cross) < 1e-9 and min(xi, xj) - 1e-9 <= x <= max(xi, xj) + 1e-9 and min(yi, yj) - 1e-9 <= y <= max(yi, yj) + 1e-9:
            return True

        intersects = (yi > y) != (yj > y)
        if intersects:
            x_at_y = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x <= x_at_y:
                inside = not inside
        j = i
    return inside


def bbox_zone(
    bbox: Any,
    frame_w: int,
    frame_h: int,
    zones: list[dict[str, Any]],
    *,
    target: str = "face",
) -> dict[str, Any] | None:
    if not zones:
        return {"id": "full-frame", "name": "Full frame"}
    if frame_w <= 0 or frame_h <= 0:
        return None
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
    except (TypeError, ValueError):
        return None

    cx = ((x1 + x2) / 2.0) / frame_w
    cy = ((y1 + y2) / 2.0) / frame_h
    if target == "person":
        cy = y2 / frame_h
    cx = max(0.0, min(1.0, cx))
    cy = max(0.0, min(1.0, cy))

    for zone in zones:
        if target not in zone.get("applyTo", ["face", "person"]):
            continue
        if _point_in_zone(cx, cy, zone):
            return zone
    return None


def bbox_allowed(
    bbox: Any,
    frame_w: int,
    frame_h: int,
    zones: list[dict[str, Any]],
    *,
    target: str = "face",
) -> bool:
    return bbox_zone(bbox, frame_w, frame_h, zones, target=target) is not None
