"""Live attendance from vms_face's RECOGNISED detections — modelled as visit
SESSIONS, the way real VMS / access-control / attendance systems do it.

WHY SESSIONS (the "don't re-detect on every twitch" problem)
------------------------------------------------------------
A face recogniser fires many times a second. Logging each hit is noise: a person
standing still is "detected" 100× ; a person who shifts their head is not a new
arrival. Industry systems collapse a stream of detections of the SAME identity
into a *visit session*:

    enter → (many detections, ignored) → gap of silence → exit

Rules encoded here:
  * Re-detection WITHIN `session_gap` = the SAME session → logged ONCE (dedup).
  * Silence LONGER than `session_gap` = the person left; a later recognition is a
    NEW session (real re-entry). This is the debounce/hysteresis.
  * We log an IN at each session's first sighting and an OUT at its last sighting
    (once the gap confirms they've gone) — so the feed reads as real arrivals and
    departures with dwell time, not a wall of duplicate rows.
  * `min_session_sec` optionally drops flicker sessions (a face seen for <N s).

Source of truth is vms_face's persisted `detection_events` (name via
`persons.full_name`). Read-only on the AI DB; writes only to our own store.
"""
from __future__ import annotations

import datetime
import logging
import os
import threading
import time

log = logging.getLogger("activity_monitor.recognition_sync")

_IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

# Ordered per-person detection timestamps (+ the camera each was seen on) for
# today → clustered into sessions. `c.code` is the monitor_id the console maps
# to a friendly camera name, so the report can show/filter in-out BY CAMERA.
_QUERY = """
SELECT p.full_name AS name,
       extract(epoch FROM d.occurred_at)::bigint AS ts,
       c.code AS camera,
       d.similarity AS sim
FROM detection_events d
JOIN persons p ON p.id = d.person_id
LEFT JOIN cameras c ON c.id = d.camera_id
WHERE d.person_id IS NOT NULL
  AND p.full_name IS NOT NULL
  AND d.occurred_at >= %s
  {cam_filter}
ORDER BY p.full_name, d.occurred_at
"""


class RecognitionSync:
    def __init__(self, store, dsn: str | None = None, interval_sec: float = 20.0,
                 cameras: list[str] | None = None, session_gap_sec: int = 600,
                 min_session_sec: int = 0, alerts=None):
        self._store = store
        self._alerts = alerts                        # AlertPolicy or None
        self._dsn = (dsn or os.environ.get("RECOGNITION_PG_DSN")
                     or "postgresql://vms:vms@postgres:5432/vms_face")
        self._interval = float(os.environ.get("RECOGNITION_SYNC_SEC", interval_sec))
        env_cams = [c.strip() for c in os.environ.get("RECOGNITION_CAMERAS", "").split(",") if c.strip()]
        self._cameras = cameras or env_cams          # empty = all cameras (office-wide presence)
        # A person unseen for longer than this counts as HAVING LEFT; a later
        # recognition is a NEW visit. This is the debounce that stops a person who
        # merely shifts/looks away from being logged as a second arrival.
        self._gap = int(os.environ.get("RECOGNITION_SESSION_GAP_SEC", session_gap_sec))
        self._min_session = int(os.environ.get("RECOGNITION_MIN_SESSION_SEC", min_session_sec))
        # A visit must be SEEN this many times before it's logged as a real arrival.
        # A one-frame recognition is almost always a false match or a fleeting pass,
        # not someone clocking in — this is the "don't log on a flimsy sighting" gate.
        # (An OPEN session — someone on camera right now — is always kept.)
        self._min_detections = max(1, int(os.environ.get("RECOGNITION_MIN_DETECTIONS", "3")))
        # (1) Directional in/out: camera codes that are the DOOR/gate/reception. When
        # set, IN is logged at the first door sighting of a visit and OUT at the last —
        # a real crossing, not just a presence gap. Empty = presence-based (first/last
        # seen anywhere).
        self._entry_cameras = {z.strip() for z in os.environ.get("RECOGNITION_ENTRY_CAMERAS", "").split(",") if z.strip()}
        # (2) Confidence gate: a visit's BEST face match must clear this cosine score
        # to be logged as that person — a weak/uncertain match never becomes an arrival.
        self._min_similarity = float(os.environ.get("RECOGNITION_MIN_SIMILARITY", "0") or 0)
        # (3) Break tracking: a mid-visit silence this long counts as "stepped out" —
        # excluded from time-on-site (but not long enough to end the visit).
        self._break_gap = int(os.environ.get("RECOGNITION_BREAK_GAP_SEC", "900"))
        self._logged_in: set = set()                 # (date, name, enter_ts) already fed as IN
        self._logged_out: set = set()                # (date, name, exit_ts) already fed as OUT
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="recognition-sync", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def reset(self) -> None:
        """Forget which crossings we've already fed, so a store reset rebuilds the
        in/out feed from detection_events on the next cycle (otherwise the in-memory
        dedup silently blocks re-adding them)."""
        self._logged_in.clear()
        self._logged_out.clear()

    @staticmethod
    def _local_date(ts: float) -> str:
        return datetime.datetime.fromtimestamp(ts, _IST).strftime("%Y-%m-%d")

    @staticmethod
    def _today_start_utc() -> datetime.datetime:
        now = datetime.datetime.now(_IST)
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return midnight.astimezone(datetime.timezone.utc)

    def metrics(self, date: str | None = None) -> dict:
        """Health metrics for the detection funnel — the 'know it's working' layer.
        Dedup ratio (detections→events collapse), recognition rate per camera, and
        session sanity (re-entry churn), for any IST calendar day (default today).
        Cheap count queries, safe to poll."""
        import psycopg2
        d0 = None
        if date:
            try:
                d0 = datetime.datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=_IST)
            except Exception:
                d0 = None
        if d0 is None:
            date = self._local_date(time.time())
            d0 = datetime.datetime.now(_IST).replace(hour=0, minute=0, second=0, microsecond=0)
        start = d0.astimezone(datetime.timezone.utc)
        end = (d0 + datetime.timedelta(days=1)).astimezone(datetime.timezone.utc)
        det_total = det_recog = 0
        per_camera: list[dict] = []
        try:
            conn = psycopg2.connect(self._dsn, connect_timeout=5)
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT count(*), count(*) FILTER (WHERE person_id IS NOT NULL) "
                                "FROM detection_events WHERE occurred_at >= %s AND occurred_at < %s", [start, end])
                    det_total, det_recog = cur.fetchone()
                    cur.execute("SELECT COALESCE(c.code, left(d.camera_id::text,8)), count(*), "
                                "count(*) FILTER (WHERE d.person_id IS NOT NULL) "
                                "FROM detection_events d LEFT JOIN cameras c ON c.id = d.camera_id "
                                "WHERE d.occurred_at >= %s AND d.occurred_at < %s GROUP BY 1 ORDER BY 2 DESC", [start, end])
                    for code, tot, rec in cur.fetchall():
                        per_camera.append({"camera": code, "detections": int(tot),
                                           "recognized": int(rec),
                                           "recognition_rate": round(rec / tot, 3) if tot else 0.0})
            finally:
                conn.close()
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}
        events = self._store.count_crossings(date) if self._store else 0
        att = self._store.load_attendance(date) if self._store else {}
        reentries = [int(r.get("in_count", 0)) for r in att.values()]
        return {
            "date": date,
            "detections_today": int(det_total),
            "recognized_today": int(det_recog),
            "events_today": int(events),
            "dedup_ratio": round(det_total / events, 1) if events else None,
            "recognition_rate": round(det_recog / det_total, 3) if det_total else None,
            "per_camera": per_camera,
            "people_today": len(att),
            "max_reentries": max(reentries) if reentries else 0,
            "avg_reentries": round(sum(reentries) / len(reentries), 1) if reentries else 0,
            "alerts_today": self._store.count_alerts(date) if self._store else 0,
            "alerts_critical": self._store.count_alerts(date, "critical") if self._store else 0,
        }

    def _cluster(self, items: list[tuple[float, str, float]], now: float) -> list[dict]:
        """Ordered (timestamp, camera, similarity) rows for ONE person → visit
        sessions, each summarised with directional door in/out, best match score,
        break time and active (on-site) seconds. A silence > session_gap starts a
        new visit; a silence >= break_gap inside a visit is a 'stepped out' break."""
        if not items:
            return []
        groups: list[list] = [[items[0]]]
        for it in items[1:]:
            if it[0] - groups[-1][-1][0] > self._gap:      # silence → a new visit
                groups.append([it])
            else:
                groups[-1].append(it)
        return [self._summarise(g, now) for g in groups]

    def _summarise(self, g: list[tuple[float, str, float]], now: float) -> dict:
        enter, exit = g[0][0], g[-1][0]
        max_sim = max((it[2] or 0.0) for it in g)
        # first / last sighting at a DOOR camera (directional in/out point)
        door_in = next(((t, c) for t, c, _ in g if c in self._entry_cameras), None)
        door_out = next(((t, c) for t, c, _ in reversed(g) if c in self._entry_cameras), None)
        # sum the mid-visit silences long enough to be a break (stepped out)
        break_sec = sum((g[i][0] - g[i - 1][0]) for i in range(1, len(g))
                        if (g[i][0] - g[i - 1][0]) >= self._break_gap)
        span = exit - enter
        return {
            "enter": enter, "exit": exit, "count": len(g),
            "enter_cam": g[0][1], "exit_cam": g[-1][1],
            "max_sim": round(max_sim, 3), "door_in": door_in, "door_out": door_out,
            "break_sec": break_sec, "active_sec": max(0.0, span - break_sec),
            "open": (now - exit) <= self._gap,
        }

    def _run(self) -> None:
        try:
            import psycopg2  # noqa: F401
        except Exception:
            log.warning("recognition sync OFF: psycopg2 not installed")
            return
        # Preload dedup sets so a restart doesn't duplicate the feed.
        try:
            for c in (self._store.recent_crossings(limit=5000) or []):
                nm, ts = c.get("name"), c.get("ts")
                if not nm or ts is None:
                    continue
                key = (self._local_date(ts), nm, int(ts))
                (self._logged_in if c.get("direction") == "in" else self._logged_out).add(key)
        except Exception:
            pass
        log.info("recognition sync: %s every %ss (gap=%ss, min_det=%d, min_sim=%.2f, "
                 "break=%ss, door_cams=%d, cameras=%s)",
                 self._dsn.split("@")[-1], self._interval, self._gap, self._min_detections,
                 self._min_similarity, self._break_gap, len(self._entry_cameras), self._cameras or "ALL")
        while not self._stop.is_set():
            try:
                self._sync_once()
            except Exception as e:  # noqa: BLE001
                log.warning("recognition sync error: %s", e)
            if self._stop.wait(self._interval):
                break

    def _sync_once(self) -> None:
        import psycopg2
        cam_filter = ""
        params: list = [self._today_start_utc()]
        if self._cameras:
            cam_filter = "AND d.camera_id::text = ANY(%s)"
            params.append(self._cameras)
        q = _QUERY.format(cam_filter=cam_filter)
        now = time.time()
        present = 0
        per: dict[str, list[tuple[float, str]]] = {}
        conn = psycopg2.connect(self._dsn, connect_timeout=5)
        try:
            with conn.cursor() as cur:
                cur.execute(q, params)
                for name, ts, camera, sim in cur.fetchall():
                    per.setdefault(name, []).append((float(ts), camera or "recognition", float(sim or 0)))

                for name, items in per.items():
                    items.sort(key=lambda x: x[0])
                    # Log a visit only if OPEN (present now) or a REAL presence: seen
                    # enough times, on-site long enough, AND a confident-enough match.
                    sessions = [s for s in self._cluster(items, now)
                                if s["open"] or (s["count"] >= self._min_detections
                                                 and s["active_sec"] >= self._min_session
                                                 and s["max_sim"] >= self._min_similarity)]
                    if not sessions:
                        continue
                    date = self._local_date(sessions[0]["enter"])
                    open_s = next((s for s in sessions if s["open"]), None)
                    inside = open_s is not None
                    present += 1 if inside else 0
                    # time ON SITE = span minus 'stepped-out' breaks (open visit → now)
                    total = sum(max(0.0, (now if s["open"] else s["exit"]) - s["enter"] - s["break_sec"])
                                for s in sessions)
                    self._store.upsert_attendance(date, name, {
                        "camera": "recognition",
                        "first_entry_ts": sessions[0]["enter"],
                        "last_event_ts": sessions[-1]["exit"],
                        "in_count": len(sessions),
                        "out_count": sum(1 for s in sessions if not s["open"]),
                        "total_inside_sec": total,
                        "currently_inside": inside,
                        "current_entered_at": (open_s["enter"] if open_s else None),
                    })
                    for s in sessions:
                        # directional: log IN/OUT at the DOOR sighting when known,
                        # else fall back to first/last seen anywhere (presence-based).
                        in_ts, in_cam = s["door_in"] if s["door_in"] else (s["enter"], s["enter_cam"])
                        ik = (date, name, int(in_ts))
                        if ik not in self._logged_in:
                            self._store.add_crossing(person_key=name, name=name, stream=in_cam,
                                                     direction="in", ts=in_ts, date=date, duration_sec=None)
                            self._logged_in.add(ik)
                        if not s["open"]:
                            out_ts, out_cam = s["door_out"] if s["door_out"] else (s["exit"], s["exit_cam"])
                            ok = (date, name, int(out_ts))
                            if ok not in self._logged_out:
                                self._store.add_crossing(person_key=name, name=name, stream=out_cam,
                                                         direction="out", ts=out_ts, date=date,
                                                         duration_sec=max(0.0, out_ts - in_ts - s["break_sec"]))
                                self._logged_out.add(ok)
                    # ── ALERT layer: evaluate this person's sessions against policy ──
                    if self._alerts is not None:
                        self._alerts.evaluate_known(name, sessions)

                # stranger-dwell policy shares this cursor (queries unknown faces).
                if self._alerts is not None:
                    self._alerts.evaluate_strangers(cur, self._today_start_utc(), self._cameras)
        finally:
            conn.close()
        log.info("recognition sync: %d people today, %d inside now", len(per), present)
