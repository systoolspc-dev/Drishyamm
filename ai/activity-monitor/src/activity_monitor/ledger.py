"""Per-person, over-time activity aggregation.

Turns the per-frame *instantaneous* state (working / not_working / on_phone /
talking) into the numbers an operations lead actually wants:
  * time spent in each state today (seconds), per person
  * phone-usage SESSIONS: how many times + how long each person was on their phone

A person is keyed by their recognised **name** when identity is available
(fused from the face pipeline — see identity fusion), else by an anonymous
`"{stream}#{track}"` key. Anonymous keys reset when a person leaves and returns,
so counts are per-visit until names are wired; named keys are stable across
visits and across cameras.

Durable via ActivityStore: sessions are logged on close, daily totals flushed
periodically so a mid-day restart resumes rather than resets.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime

log = logging.getLogger("activity_monitor.ledger")

STATES = ("working", "not_working", "on_phone", "talking")
ON_PHONE = "on_phone"

_MAX_DT = 5.0        # cap time attributed between two observations (stalled-stream guard)
_SESSION_GAP = 3.0   # close an open phone session if the person is unseen this long


def _local_date(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


class _Person:
    __slots__ = ("key", "name", "stream", "state_sec", "phone_sessions",
                 "first_seen", "last_seen", "last_state", "last_ts", "session_start")

    def __init__(self, key, name, stream, now):
        self.key = key
        self.name = name
        self.stream = stream
        self.state_sec = {s: 0.0 for s in STATES}
        self.phone_sessions = 0
        self.first_seen = now
        self.last_seen = now
        self.last_state = None
        self.last_ts = now
        self.session_start = None  # start ts of an open on_phone session, else None


class ActivityLedger:
    def __init__(self, store=None, flush_interval: float = 30.0,
                 session_gap: float = _SESSION_GAP, min_present_sec: float = 3.0):
        self._store = store
        self._flush_interval = flush_interval
        self._session_gap = session_gap
        self._min_present = min_present_sec
        self._lock = threading.RLock()
        self._date = None
        self._people: dict[str, _Person] = {}
        self._last_flush = 0.0

    # -- date rollover ----------------------------------------------------
    def _roll_date(self, now: float) -> None:
        d = _local_date(now)
        if d == self._date:
            return
        if self._date is not None:
            self._flush_all(self._date)   # persist the day we're leaving
        self._date = d
        self._people = {}
        if self._store:                    # resume today's totals after a restart
            for k, agg in self._store.load_daily(d).items():
                p = _Person(k, agg.get("name"), agg.get("stream"), now)
                p.state_sec = {
                    "working": agg["working_sec"], "not_working": agg["not_working_sec"],
                    "on_phone": agg["on_phone_sec"], "talking": agg["talking_sec"],
                }
                p.phone_sessions = agg["phone_sessions"]
                p.first_seen = agg.get("first_seen") or now
                p.last_seen = agg.get("last_seen") or now
                self._people[k] = p

    # -- ingestion --------------------------------------------------------
    def observe(self, stream: str, track, state: str, now: float, name: str | None = None) -> None:
        """Record one person's committed state for this frame."""
        if state not in STATES:   # 'unknown' etc. — can't attribute, skip
            return
        with self._lock:
            self._roll_date(now)
            key = name or f"{stream}#{track}"
            p = self._people.get(key)
            if p is None:
                p = _Person(key, name, stream, now)
                self._people[key] = p
                if state == ON_PHONE:      # first sighting already on the phone
                    p.session_start = now
            else:
                dt = min(max(0.0, now - p.last_ts), _MAX_DT)
                if p.last_state in p.state_sec:
                    p.state_sec[p.last_state] += dt
                if state == ON_PHONE and p.last_state != ON_PHONE:
                    p.session_start = now                       # phone picked up
                elif state != ON_PHONE and p.last_state == ON_PHONE:
                    self._close_session(p, now)                 # phone put down
            if name:
                p.name = name
            p.stream = stream
            p.last_state = state
            p.last_ts = now
            p.last_seen = now
            self._maybe_flush(now)

    def close_stale(self, now: float) -> None:
        """Close phone sessions for people who vanished mid-session, and let a
        re-appearance start a fresh session. Call periodically."""
        with self._lock:
            if self._date is None:
                return
            for p in self._people.values():
                if now - p.last_seen > self._session_gap:
                    if p.session_start is not None:
                        self._close_session(p, p.last_seen)
                    p.last_state = None   # next sighting is a fresh transition
            self._maybe_flush(now)

    def _close_session(self, p: _Person, end: float) -> None:
        start = p.session_start
        p.session_start = None
        if start is None:
            return
        dur = max(0.0, end - start)
        p.phone_sessions += 1
        if self._store:
            try:
                self._store.add_session(
                    person_key=p.key, name=p.name, stream=p.stream, date=self._date,
                    start_ts=start, end_ts=end, duration_sec=dur,
                )
            except Exception:
                log.exception("failed persisting phone session")

    # -- persistence ------------------------------------------------------
    def _maybe_flush(self, now: float) -> None:
        if self._store and now - self._last_flush >= self._flush_interval:
            self._flush_all(self._date)
            self._last_flush = now

    def _flush_all(self, date: str) -> None:
        if not self._store or not date:
            return
        for p in self._people.values():
            try:
                self._store.upsert_daily(date, p.key, {
                    "name": p.name, "stream": p.stream,
                    "working_sec": p.state_sec["working"],
                    "not_working_sec": p.state_sec["not_working"],
                    "on_phone_sec": p.state_sec["on_phone"],
                    "talking_sec": p.state_sec["talking"],
                    "phone_sessions": p.phone_sessions,
                    "first_seen": p.first_seen, "last_seen": p.last_seen,
                })
            except Exception:
                log.exception("failed flushing daily activity for %s", p.key)

    def flush(self) -> None:
        with self._lock:
            if self._date:
                self._flush_all(self._date)

    # -- queries (for the API) -------------------------------------------
    def people(self, now: float | None = None) -> dict:
        """Per-person totals for today, incl. any open phone session's live time."""
        with self._lock:
            out = []
            for p in self._people.values():
                live = dict(p.state_sec)
                open_sec = 0.0
                if p.session_start is not None and now is not None:
                    open_sec = max(0.0, now - p.session_start)
                    live["on_phone"] = live["on_phone"] + open_sec
                # Drop ghost tracks (seen only a frame or two) unless on-phone —
                # the fragmentation guard in the tracker + this keep the list clean.
                if sum(p.state_sec.values()) < self._min_present and p.session_start is None:
                    continue
                out.append({
                    "key": p.key,
                    "name": p.name,
                    "stream": p.stream,
                    "state_seconds": {k: round(v, 1) for k, v in live.items()},
                    "on_phone_seconds": round(live["on_phone"], 1),
                    "phone_sessions": p.phone_sessions,
                    "on_phone_now": p.session_start is not None,
                    "current_state": p.last_state,
                    "first_seen": p.first_seen,
                    "last_seen": p.last_seen,
                })
            out.sort(key=lambda r: r["on_phone_seconds"], reverse=True)
            return {"date": self._date, "people": out, "total": len(out)}

    def sessions(self, limit: int = 100, date: str | None = None) -> dict:
        rows = self._store.recent_sessions(limit=limit, date=date) if self._store else []
        return {"sessions": rows, "total": len(rows)}

    def history(self, days: int = 7) -> dict:
        """Per-person daily totals over the last `days`. Flushes today's running
        totals first so the latest day is current. Ghost tracks (negligible total
        presence across the window) are filtered out."""
        with self._lock:
            if self._date:
                self._flush_all(self._date)
        if not self._store:
            return {"days": [], "people": []}
        hist = self._store.history(days)
        hist["people"] = [
            p for p in hist.get("people", [])
            if sum(v for k, v in p["totals"].items() if k.endswith("_sec")) >= self._min_present
        ]
        return hist
