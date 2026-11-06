"""Server-side in/out attendance from the EXISTING vms_face pipeline.

Subscribes to `vms.cam.state:*` (the recognised face/person boxes vms_face
publishes per frame — each with a `name` + bbox), and for every camera that has
a drawn in/out line, detects when a RECOGNISED person crosses it. Each crossing
is persisted and rolled up into a per-person daily summary:

    first entry · in/out counts · total time inside · currently in or out

This is the "intelligent" attendance the operator sees. It runs in its own
thread regardless of whether anyone is viewing the page, so attendance is
recorded continuously — not only while a browser is open.
"""
from __future__ import annotations

import json
import logging
import threading

from .crossing import LineCrosser
from .ledger import _local_date

log = logging.getLogger("activity_monitor.attendance")


def _blank(name, camera):
    return {"name": name, "camera": camera, "first_entry_ts": None, "last_event_ts": None,
            "in_count": 0, "out_count": 0, "total_inside_sec": 0.0,
            "currently_inside": False, "current_entered_at": None}


class AttendanceWatcher:
    def __init__(self, redis_url: str, store=None, channel_prefix: str = "vms.cam.state"):
        self.redis_url = redis_url
        self.pattern = f"{channel_prefix}:*"
        self._store = store
        self._lock = threading.RLock()
        self._crossers: dict[str, LineCrosser] = {}   # camera_code -> LineCrosser
        self._att: dict[str, dict] = {}                # name -> summary rec (today)
        self._ext_unknown_inside: set = set()          # unknown body keys inside (body-tracker path)
        self._date = None
        self._stop = threading.Event()
        self._pubsub = None
        self._thread = threading.Thread(target=self._run, name="attendance-sub", daemon=True)

    # -- config -----------------------------------------------------------
    def set_line(self, camera_code: str, line: dict | None) -> None:
        with self._lock:
            cr = self._crossers.get(camera_code)
            if cr is None:
                cr = LineCrosser()
                self._crossers[camera_code] = cr
            cr.set_line(line)

    def get_line(self, camera_code: str):
        cr = self._crossers.get(camera_code)
        return cr.line if cr else None

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        try:
            if self._pubsub is not None:
                self._pubsub.close()
        except Exception:
            pass
        with self._lock:
            if self._date:
                self._flush()

    # -- date rollover ----------------------------------------------------
    def _roll_date(self, now: float) -> None:
        d = _local_date(now)
        if d == self._date:
            return
        if self._date:
            self._flush()
        self._date = d
        self._att = self._store.load_attendance(d) if self._store else {}

    def _flush(self) -> None:
        if not self._store or not self._date:
            return
        for name, rec in self._att.items():
            try:
                self._store.upsert_attendance(self._date, name, rec)
            except Exception:
                log.exception("attendance flush failed for %s", name)

    # -- crossing → attendance -------------------------------------------
    def _log_crossing(self, ev: dict, camera: str) -> None:
        """Log EVERY crossing — recognised or unknown — for the complete feed."""
        if not self._store:
            return
        try:
            self._store.add_crossing(
                person_key=ev.get("key") or ev.get("name") or f'#{ev.get("track_id")}',
                name=ev.get("name"),                 # None → unknown person
                stream=camera, direction=ev["direction"], ts=ev["ts"],
                date=self._date or _local_date(ev["ts"]),
                duration_sec=ev.get("duration_sec"),
            )
        except Exception:
            log.exception("crossing log failed")

    def record_crossing(self, camera: str, ev: dict) -> None:
        """Ingest a crossing produced by an EXTERNAL body-tracker (a StreamWorker's
        YOLO person crosser) into the SAME feed + per-person rollup the face path
        uses — so whole-body in/out shows in the UI/report. Keyed by camera_code."""
        import time
        ts = ev.get("ts") or time.time()
        ev = {**ev, "ts": ts}
        with self._lock:
            self._roll_date(ts)
            self._log_crossing(ev, camera)                     # every crossing → the feed
            nm = ev.get("name")
            nm = nm if (nm and nm != "Unknown") else None      # "Unknown" is not a person
            if nm:
                self._apply(nm, ev["direction"], ts, camera)   # named → per-person rollup
            else:
                key = ev.get("key") or "#?"
                if ev["direction"] == "in":
                    self._ext_unknown_inside.add(key)
                else:
                    self._ext_unknown_inside.discard(key)

    def _apply(self, name: str, direction: str, ts: float, camera: str) -> None:
        """Roll up a RECOGNISED person's crossing into their daily summary."""
        r = self._att.get(name)
        if r is None:
            r = _blank(name, camera)
            self._att[name] = r
        r["camera"] = camera
        r["last_event_ts"] = ts
        if direction == "in":
            if not r["currently_inside"]:
                r["currently_inside"] = True
                r["current_entered_at"] = ts
                r["in_count"] += 1
                if r["first_entry_ts"] is None:
                    r["first_entry_ts"] = ts
        else:  # out
            if r["currently_inside"]:
                r["currently_inside"] = False
                r["total_inside_sec"] += max(0.0, ts - (r["current_entered_at"] or ts))
                r["current_entered_at"] = None
                r["out_count"] += 1
        if self._store:
            try:
                self._store.upsert_attendance(self._date, name, r)
            except Exception:
                log.exception("attendance persist failed")

    # -- subscriber -------------------------------------------------------
    def _run(self) -> None:
        try:
            import redis
        except Exception:
            log.warning("attendance OFF: `redis` package not installed")
            return
        while not self._stop.is_set():
            try:
                client = redis.Redis.from_url(self.redis_url, decode_responses=True)
                self._pubsub = client.pubsub()
                self._pubsub.psubscribe(self.pattern)
                log.info("attendance: subscribed to %s", self.pattern)
                for msg in self._pubsub.listen():
                    if self._stop.is_set():
                        break
                    if msg.get("type") != "pmessage":
                        continue
                    self._ingest(msg.get("data"))
            except Exception as e:  # noqa: BLE001
                if self._stop.is_set():
                    break
                log.warning("attendance: subscribe error (%s); retrying in 3s", e)
                if self._stop.wait(3.0):
                    break

    def _ingest(self, raw) -> None:
        import time
        try:
            p = json.loads(raw)
        except Exception:
            return
        if p.get("event") != "frame":
            return
        cam = p.get("camera_code")
        if not cam:
            return
        with self._lock:
            cr = self._crossers.get(cam)
            if cr is None or not cr.line:
                return  # no line drawn for this camera → nothing to do
            fw = float(p.get("frame_w") or 0) or 1.0
            fh = float(p.get("frame_h") or 0) or 1.0
            # Track EVERYONE — recognised faces (name) AND unknown people (name=None).
            people = []
            for b in (p.get("boxes") or []):
                nm = b.get("name")
                nm = nm if (nm and nm != "Unknown") else None
                x1, y1, x2, y2 = b.get("x1"), b.get("y1"), b.get("x2"), b.get("y2")
                if None in (x1, y1, x2, y2):
                    continue
                people.append({"id": b.get("track_id"), "name": nm, "box": [x1, y1, x2, y2]})
            now = time.time()
            self._roll_date(now)
            for ev in cr.update(people, fw, fh, now):
                self._log_crossing(ev, cam)                 # every crossing → the feed
                if ev.get("name"):
                    self._apply(ev["name"], ev["direction"], ev["ts"], cam)

    def reset(self, prefix: str | None = None) -> dict:
        """Clear attendance — all, or only names starting with `prefix` — from
        both memory and the DB, and forget the crossers' tracked state."""
        with self._lock:
            if prefix:
                for k in [k for k in list(self._att) if k.startswith(prefix)]:
                    self._att.pop(k, None)
            else:
                self._att = {}
            if prefix:
                self._ext_unknown_inside = {k for k in self._ext_unknown_inside if not str(k).startswith(prefix)}
            else:
                self._ext_unknown_inside = set()
            for cr in self._crossers.values():
                cr.reset(prefix)
        if self._store:
            try:
                self._store.clear_attendance(prefix)
            except Exception:
                log.exception("attendance reset: DB clear failed")
        return {"ok": True, "cleared": prefix or "ALL"}

    # -- query ------------------------------------------------------------
    def summary(self, now: float) -> dict:
        with self._lock:
            self._roll_date(now)
            # Read the per-person rollup from the STORE so it reflects BOTH the
            # line/face crossing (which also writes here via _apply) AND the
            # recognition-sync poller (real recognised people). Falls back to the
            # in-memory copy if there's no store.
            att = self._store.load_attendance(self._date) if (self._store and self._date) else self._att
            people = []
            for r in att.values():
                cur = (now - r["current_entered_at"]) if (r["currently_inside"] and r["current_entered_at"]) else 0.0
                people.append({
                    "name": r["name"],
                    "first_entry": r["first_entry_ts"],
                    "in_count": r["in_count"],
                    "out_count": r["out_count"],
                    "currently_inside": r["currently_inside"],
                    "since": r["current_entered_at"],
                    "current_inside_sec": round(cur, 1),
                    "total_inside_sec": round((r["total_inside_sec"] + cur), 1),
                    "last_event": r["last_event_ts"],
                })
            people.sort(key=lambda x: (not x["currently_inside"], -(x["first_entry"] or 0)))
            inside = [p for p in people if p["currently_inside"]]
            unknown_inside = len(self._ext_unknown_inside)   # body-tracker unknowns
            for cr in self._crossers.values():
                unknown_inside += sum(1 for k in cr.inside if str(k).startswith("#"))
            recent = self._store.recent_crossings(limit=50) if self._store else []
            date = self._date
        totals = {"in": 0, "out": 0, "in_known": 0, "in_unknown": 0}
        if self._store and date:
            try:
                totals = {
                    "in": self._store.count_crossings(date, "in"),
                    "out": self._store.count_crossings(date, "out"),
                    "in_known": self._store.count_crossings(date, "in", named=True),
                    "in_unknown": self._store.count_crossings(date, "in", named=False),
                }
            except Exception:
                pass
        return {"date": date, "people": people, "inside": inside,
                "inside_count": len(inside), "unknown_inside": unknown_inside,
                "recent": recent, "totals": totals}
