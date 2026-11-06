"""Counting zones — count the people in an AREA, not everything the lens sees.

WHY
---
A camera aimed at a room also sees the corridor through the doorway, the car park
through the window, and the reflection in the glass. Every one of those bodies
lands in the count, so the number answers "what can this camera see" when the
operator asked "how many are in this room". It also makes the figure jump every
time somebody walks past outside — the flicker that makes people distrust it.

A zone fixes both: draw the area that IS the room, and only heads standing inside
it are counted.

TWO THINGS THAT MATTER FOR STABILITY
------------------------------------
1. **Anchor point.** A head box is tested by its BOTTOM-CENTRE, not its middle.
   That is the point nearest where the person is actually standing, so someone at
   the far edge of a room is judged by their position on the floor rather than by
   where their head happens to project.

2. **Hysteresis on the boundary.** Testing "inside?" every frame makes anybody
   standing on the line flicker in and out, which is precisely the jitter zones
   are meant to remove. So entering requires being inside the polygon, while
   LEAVING requires being outside it by a margin (a fraction of the head's own
   size) for a short, sustained period. Asymmetric on purpose — the same
   enter-fast / leave-slow shape used everywhere else in the detection doctrine.

Coordinates are NORMALISED (0..1) so a zone drawn on a preview keeps its meaning
at any resolution, and survives a camera being re-profiled.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def _point_in_polygon(x: float, y: float, poly: np.ndarray) -> bool:
    """Ray-casting test. `poly` is (N,2) in the same units as x, y."""
    n = len(poly)
    if n < 3:
        return True                      # a degenerate zone counts everything
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def _distance_to_edge(x: float, y: float, poly: np.ndarray) -> float:
    """Shortest distance from the point to the polygon boundary."""
    n = len(poly)
    if n < 2:
        return 0.0
    best = float("inf")
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * vx + (y - ay) * vy) / L2))
        dx, dy = x - (ax + t * vx), y - (ay + t * vy)
        best = min(best, float(np.hypot(dx, dy)))
    return best


@dataclass
class Zone:
    """One named counting area, as a normalised polygon."""
    id: str
    name: str
    points: np.ndarray               # (N,2) normalised 0..1
    enabled: bool = True

    @classmethod
    def from_config(cls, cfg: dict) -> "Zone | None":
        pts = cfg.get("points") or cfg.get("polygon") or []
        arr = np.asarray([[float(p[0]), float(p[1])] if isinstance(p, (list, tuple))
                          else [float(p["x"]), float(p["y"])] for p in pts],
                         dtype=np.float32) if pts else np.zeros((0, 2), np.float32)
        if len(arr) < 3:
            return None                  # not a usable area
        return cls(id=str(cfg.get("id") or cfg.get("name") or "zone"),
                   name=str(cfg.get("name") or cfg.get("id") or "zone"),
                   points=np.clip(arr, 0.0, 1.0),
                   enabled=cfg.get("enabled", True) is not False)

    def contains(self, nx: float, ny: float) -> bool:
        return _point_in_polygon(nx, ny, self.points)

    def outside_by(self, nx: float, ny: float) -> float:
        """How far outside the zone the point is (0 when inside)."""
        if self.contains(nx, ny):
            return 0.0
        return _distance_to_edge(nx, ny, self.points)


@dataclass
class ZoneCounter:
    """Decides which tracks count, with hysteresis so the edge doesn't flicker.

    `exit_margin_frac` is a fraction of the head's own height, so the deadband
    scales with distance — a far-away head needs a smaller absolute movement to
    be considered genuinely out than a near one.
    """
    zones: list[Zone] = field(default_factory=list)
    exit_margin_frac: float = 0.35      # of head height, before "left" is believed
    exit_hold_sec: float = 1.0          # sustained outside before dropping
    _state: dict = field(default_factory=dict)   # track id -> {zone, since}

    @property
    def active(self) -> bool:
        return any(z.enabled for z in self.zones)

    @classmethod
    def from_config(cls, cfg) -> "ZoneCounter":
        raw = (cfg or {}).get("zones") if isinstance(cfg, dict) else (cfg or [])
        zones = [z for z in (Zone.from_config(c) for c in (raw or [])) if z]
        return cls(zones=zones)

    @staticmethod
    def anchor(box, w: int, h: int) -> tuple[float, float]:
        """Bottom-centre of the head box, normalised — closest to where the
        person is standing."""
        x1, y1, x2, y2 = box[:4]
        return float((x1 + x2) / 2 / max(w, 1)), float(y2 / max(h, 1))

    def evaluate(self, track_id, box, w: int, h: int, now: float) -> str | None:
        """Return the zone this track counts toward, or None if it counts nowhere.

        With no zones configured every track counts (zone filtering is opt-in),
        so enabling the feature can never silently zero a working camera.
        """
        if not self.active:
            return "__all__"

        nx, ny = self.anchor(box, w, h)
        head_h_norm = float(abs(box[3] - box[1])) / max(h, 1)
        margin = max(head_h_norm * self.exit_margin_frac, 0.005)

        st = self._state.get(track_id)
        for z in self.zones:
            if not z.enabled:
                continue
            if z.contains(nx, ny):
                self._state[track_id] = {"zone": z.id, "out_since": None}
                return z.id

        # Outside every zone. If it was counted, hold it until it is CLEARLY out
        # for long enough — otherwise someone on the line toggles every frame.
        if st and st.get("zone"):
            z = next((q for q in self.zones if q.id == st["zone"]), None)
            if z is not None:
                if z.outside_by(nx, ny) < margin:
                    return st["zone"]                    # inside the deadband
                if st.get("out_since") is None:
                    st["out_since"] = now
                    return st["zone"]
                if now - st["out_since"] < self.exit_hold_sec:
                    return st["zone"]                    # not sustained yet
            self._state.pop(track_id, None)
        return None

    def forget(self, track_id) -> None:
        self._state.pop(track_id, None)
