"""Directional line-crossing with identity — turns a drawn line into in/out.

The line is two normalised points (a→b) plus an `inside` reference point (a spot
the user marked as inside). A person's FEET point (bottom-centre of their box) is
"inside" when it's on the same side of the line as that reference point. A
transition outside→inside is an ENTER, inside→outside an EXIT. Track IDs come
from the tracker; names (when known) from identity fusion, so the log reads as
real people with entry/exit times.
"""
from __future__ import annotations


def _side(px, py, ax, ay, bx, by) -> float:
    """Signed area — >0 on one side of a→b, <0 on the other."""
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)


class LineCrosser:
    def __init__(self, min_frames: int = 3):
        self.line: dict | None = None          # {x1,y1,x2,y2,inside_x,inside_y} normalised
        self._inside_sign = 1
        self._prev: dict[str, int] = {}          # person key -> last side (+1 inside / -1 outside)
        self._seen: dict[str, int] = {}          # frames observed per key (flicker/churn filter)
        self._min_frames = max(1, int(min_frames))
        self.inside: dict[str, dict] = {}        # key -> {key,name,entered_at}

    def reset(self, prefix: str | None = None) -> None:
        """Forget tracked side/inside state — all keys, or only those starting
        with `prefix`. Lets a test re-cross the same name from a clean slate."""
        if prefix:
            for k in [k for k in list(self._prev) if str(k).startswith(prefix)]:
                self._prev.pop(k, None)
            for k in [k for k in list(self._seen) if str(k).startswith(prefix)]:
                self._seen.pop(k, None)
            for k in [k for k in list(self.inside) if str(k).startswith(prefix)]:
                self.inside.pop(k, None)
        else:
            self._prev.clear()
            self._seen.clear()
            self.inside.clear()

    def set_line(self, line: dict | None) -> None:
        self.line = line
        self._prev.clear()
        self.inside.clear()
        if line:
            s = _side(line.get("inside_x", 0.5), line.get("inside_y", 0.9),
                      line["x1"], line["y1"], line["x2"], line["y2"])
            self._inside_sign = 1 if s >= 0 else -1

    def update(self, people: list, frame_w: float, frame_h: float, now: float) -> list[dict]:
        """Feed this frame's people; return crossing events {key,name,direction,ts,duration_sec?}."""
        if not self.line:
            return []
        fw = float(frame_w) or 1.0
        fh = float(frame_h) or 1.0
        ax, ay, bx, by = self.line["x1"], self.line["y1"], self.line["x2"], self.line["y2"]
        events = []
        for p in people:
            box = p["box"]
            key = p.get("name") or f'#{p["id"]}'
            self._seen[key] = self._seen.get(key, 0) + 1
            fx = ((box[0] + box[2]) / 2.0) / fw
            fy = box[3] / fh                       # feet = bottom-centre
            raw = _side(fx, fy, ax, ay, bx, by)
            side = 1 if ((1 if raw >= 0 else -1) == self._inside_sign) else -1  # +1 inside
            prev = self._prev.get(key)
            self._prev[key] = side
            # Require a track to persist a few frames before its crossing counts —
            # a flicker/churn track (choppy decode spawning a 1-frame id) must not
            # fire a phantom entry. A real person is seen approaching the line.
            if prev is None or self._seen[key] < self._min_frames:
                continue
            if prev < 0 and side > 0:              # crossed IN
                self.inside[key] = {"key": key, "name": p.get("name"), "entered_at": now}
                events.append({"key": key, "name": p.get("name"), "direction": "in", "ts": now})
            elif prev > 0 and side < 0:            # crossed OUT
                ent = self.inside.pop(key, None)
                dur = (now - ent["entered_at"]) if ent else None
                events.append({"key": key, "name": p.get("name"), "direction": "out",
                               "ts": now, "duration_sec": dur})
        return events

    def snapshot(self, now: float) -> dict:
        inside = [{"key": v["key"], "name": v.get("name"), "entered_at": v["entered_at"],
                   "duration_sec": max(0.0, now - v["entered_at"])}
                  for v in self.inside.values()]
        inside.sort(key=lambda x: x["entered_at"])
        return {"inside": inside, "inside_count": len(inside), "line": self.line}
