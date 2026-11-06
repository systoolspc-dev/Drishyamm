"""The ALERT layer — turns recognition sessions into policy-gated alerts.

Detections and sessions are DATA; an alert is a *decision that a human must be
told*. This applies explicit, config-tunable policies and records each at most
once per session — the UNIQUE `dedup_key` in the store IS the per-identity
cooldown, so one lingering person is one alert, not fifty.

Policies (each independently toggleable; all off-by-default-safe):
  * watchlist   (critical) — a named person on the watch list, seen at all.
  * after_hours (warning)  — a known person present outside business hours.
  * stranger    (warning)  — an UNKNOWN face dwelling in view past a threshold.

Tuning (env):
  ALERTS_ENABLED=1
  ALERT_WATCHLIST="Name One,Name Two"        (case-insensitive)
  ALERT_BUSINESS_HOURS="07:00-21:00"          (IST)
  ALERT_AFTER_HOURS=1  ALERT_STRANGER=1  ALERT_WATCHLIST_ON=1
  ALERT_STRANGER_DWELL_SEC=120  ALERT_STRANGER_GAP_SEC=60
"""
from __future__ import annotations

import datetime
import logging
import os

log = logging.getLogger("activity_monitor.alert_policy")

_IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

_STRANGER_QUERY = """
SELECT extract(epoch FROM d.occurred_at)::bigint AS ts, c.code AS camera
FROM detection_events d
LEFT JOIN cameras c ON c.id = d.camera_id
WHERE d.person_id IS NULL
  AND d.occurred_at >= %s
  {cam_filter}
ORDER BY d.camera_id, d.occurred_at
"""


def _truthy(v: str | None) -> bool:
    return str(v).strip().lower() not in ("0", "false", "no", "off", "", "none")


class AlertPolicy:
    def __init__(self, store):
        self._store = store
        self.enabled = _truthy(os.environ.get("ALERTS_ENABLED", "1"))
        self._bh_start, self._bh_end = self._parse_hours(os.environ.get("ALERT_BUSINESS_HOURS", "07:00-21:00"))
        self._watchlist = {n.strip().lower() for n in os.environ.get("ALERT_WATCHLIST", "").split(",") if n.strip()}
        self._stranger_dwell = int(os.environ.get("ALERT_STRANGER_DWELL_SEC", "120"))
        self._stranger_gap = int(os.environ.get("ALERT_STRANGER_GAP_SEC", "60"))
        # An unknown face during a busy workday is usually a visitor, not a threat.
        # By default only escalate strangers OUTSIDE business hours. Kills the
        # daytime stranger flood.
        self._stranger_after_hours_only = _truthy(os.environ.get("ALERT_STRANGER_AFTER_HOURS_ONLY", "1"))
        # SECURE zones — camera codes where an unknown face matters even in daytime
        # (server room, back entrance, cash office). A stranger here is unauthorised
        # ACCESS, so it fires CRITICAL regardless of hours.
        self._stranger_zones = {z.strip() for z in os.environ.get("ALERT_STRANGER_ZONES", "").split(",") if z.strip()}
        self._on_after_hours = _truthy(os.environ.get("ALERT_AFTER_HOURS", "1"))
        self._on_stranger = _truthy(os.environ.get("ALERT_STRANGER", "1"))
        self._on_watchlist = _truthy(os.environ.get("ALERT_WATCHLIST_ON", "1"))
        log.info("alert policy: enabled=%s hours=%02d:%02d-%02d:%02d watchlist=%d "
                 "stranger_dwell=%ss secure_zones=%d",
                 self.enabled, self._bh_start // 60, self._bh_start % 60,
                 self._bh_end // 60, self._bh_end % 60, len(self._watchlist),
                 self._stranger_dwell, len(self._stranger_zones))

    @staticmethod
    def _parse_hours(s: str) -> tuple[int, int]:
        try:
            a, b = s.split("-")
            def mins(x):
                h, m = x.split(":")
                return int(h) * 60 + int(m)
            return mins(a), mins(b)
        except Exception:
            return 7 * 60, 21 * 60

    @staticmethod
    def _local_date(ts: float) -> str:
        return datetime.datetime.fromtimestamp(ts, _IST).strftime("%Y-%m-%d")

    def _is_after_hours(self, ts: float) -> bool:
        dt = datetime.datetime.fromtimestamp(ts, _IST)
        m = dt.hour * 60 + dt.minute
        return not (self._bh_start <= m < self._bh_end)

    def _fire(self, *, ts, tier, type, subject, camera, detail, session_key) -> None:
        date = self._local_date(ts)
        dedup = f"{date}|{type}|{(subject or 'unknown').lower()}|{session_key}"
        if self._store.add_alert(date=date, ts=ts, tier=tier, type=type, subject=subject,
                                 camera=camera, detail=detail, dedup_key=dedup):
            log.info("ALERT [%s/%s] %s @ %s — %s", tier, type, subject or "Unknown", camera, detail)

    # -- known-person policies (per session, from recognition_sync) --------
    def evaluate_known(self, name: str, sessions: list[dict]) -> None:
        if not self.enabled:
            return
        for s in sessions:
            enter = s["enter"]
            cam = s.get("enter_cam") or "recognition"
            skey = int(enter)
            if self._on_watchlist and self._watchlist and name.lower() in self._watchlist:
                self._fire(ts=enter, tier="critical", type="watchlist", subject=name,
                           camera=cam, detail=f"Watchlisted person “{name}” seen", session_key=skey)
            if self._on_after_hours and self._is_after_hours(enter):
                hh = datetime.datetime.fromtimestamp(enter, _IST).strftime("%H:%M")
                self._fire(ts=enter, tier="warning", type="after_hours", subject=name,
                           camera=cam, detail=f"{name} present at {hh} — outside business hours", session_key=skey)

    # -- stranger dwell (once per cycle, sharing the sync's DB cursor) ------
    def evaluate_strangers(self, cursor, today_start_utc, cameras) -> None:
        if not self.enabled or not self._on_stranger:
            return
        cam_filter = ""
        params: list = [today_start_utc]
        if cameras:
            cam_filter = "AND d.camera_id::text = ANY(%s)"
            params.append(cameras)
        cursor.execute(_STRANGER_QUERY.format(cam_filter=cam_filter), params)
        percam: dict[str, list[float]] = {}
        for ts, cam in cursor.fetchall():
            percam.setdefault(cam or "recognition", []).append(float(ts))
        for cam, times in percam.items():
            times.sort()
            start = prev = times[0]
            for t in times[1:]:
                if t - prev > self._stranger_gap:
                    self._maybe_stranger(cam, start, prev)
                    start = t
                prev = t
            self._maybe_stranger(cam, start, prev)

    def _maybe_stranger(self, cam: str, start: float, end: float) -> None:
        dwell = end - start
        if dwell < self._stranger_dwell:
            return
        after = self._is_after_hours(start)
        in_secure_zone = cam in self._stranger_zones
        # Skip a daytime stranger in an OPEN area — that's a visitor, not a threat.
        if self._stranger_after_hours_only and not (after or in_secure_zone):
            return
        mins = int(dwell // 60)
        if in_secure_zone:                           # unauthorised access to a secure area
            self._fire(ts=start, tier="critical", type="stranger", subject=None, camera=cam,
                       detail=f"Unrecognised person in a SECURE zone ~{mins}m", session_key=int(start))
        else:                                        # after-hours presence in an open area
            self._fire(ts=start, tier="warning", type="stranger", subject=None, camera=cam,
                       detail=f"Unrecognised person after-hours ~{mins}m", session_key=int(start))
