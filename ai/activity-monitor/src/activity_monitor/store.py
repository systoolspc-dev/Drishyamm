"""SQLite persistence for the activity ledger — durable across restarts.

Two tables:
  * phone_sessions  — one row per completed on_phone session (the "how many
    times / how long" evidence log).
  * daily_activity  — per-person, per-day rolled-up totals (upserted, so a
    mid-day restart resumes the running totals instead of losing them).

Writes are serialized under a lock (low write rate: sessions close infrequently,
daily totals flush ~every 30s). WAL mode keeps reads non-blocking.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
from pathlib import Path

log = logging.getLogger("activity_monitor.store")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS phone_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_key   TEXT NOT NULL,
  name         TEXT,
  stream       TEXT,
  date         TEXT NOT NULL,
  start_ts     REAL NOT NULL,
  end_ts       REAL NOT NULL,
  duration_sec REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_date ON phone_sessions(date);
CREATE INDEX IF NOT EXISTS ix_sessions_end  ON phone_sessions(end_ts);

CREATE TABLE IF NOT EXISTS daily_activity (
  date            TEXT NOT NULL,
  person_key      TEXT NOT NULL,
  name            TEXT,
  stream          TEXT,
  working_sec     REAL DEFAULT 0,
  not_working_sec REAL DEFAULT 0,
  on_phone_sec    REAL DEFAULT 0,
  talking_sec     REAL DEFAULT 0,
  phone_sessions  INTEGER DEFAULT 0,
  first_seen      REAL,
  last_seen       REAL,
  PRIMARY KEY (date, person_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crossings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_key   TEXT,
  name         TEXT,
  stream       TEXT,
  direction    TEXT NOT NULL,   -- 'in' | 'out'
  ts           REAL NOT NULL,
  date         TEXT NOT NULL,
  duration_sec REAL             -- time inside, on an 'out'
);
CREATE INDEX IF NOT EXISTS ix_crossings_date ON crossings(date);
CREATE INDEX IF NOT EXISTS ix_crossings_ts   ON crossings(ts);

-- Per-person, per-day attendance summary (the intelligent roll-up).
CREATE TABLE IF NOT EXISTS attendance (
  date               TEXT NOT NULL,
  name               TEXT NOT NULL,
  camera             TEXT,
  first_entry_ts     REAL,
  last_event_ts      REAL,
  in_count           INTEGER DEFAULT 0,
  out_count          INTEGER DEFAULT 0,
  total_inside_sec   REAL DEFAULT 0,
  currently_inside   INTEGER DEFAULT 0,
  current_entered_at REAL,
  PRIMARY KEY (date, name)
);

-- Policy alerts (watchlist / stranger / after-hours). `dedup_key` is UNIQUE so a
-- given (subject, type, session) fires ONCE — that's the per-identity cooldown.
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  ts           REAL NOT NULL,
  tier         TEXT NOT NULL,     -- 'info' | 'warning' | 'critical'
  type         TEXT NOT NULL,     -- 'watchlist' | 'stranger' | 'after_hours'
  subject      TEXT,              -- person name, or NULL/'Unknown'
  camera       TEXT,
  detail       TEXT,
  dedup_key    TEXT UNIQUE,
  acknowledged INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_alerts_ts ON alerts(ts);
"""


class ActivityStore:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        log.info("activity store ready at %s", self.path)

    def add_session(self, *, person_key, name, stream, date, start_ts, end_ts, duration_sec):
        with self._lock:
            self._conn.execute(
                "INSERT INTO phone_sessions(person_key,name,stream,date,start_ts,end_ts,duration_sec)"
                " VALUES(?,?,?,?,?,?,?)",
                (person_key, name, stream, date, start_ts, end_ts, duration_sec),
            )
            self._conn.commit()

    def upsert_daily(self, date: str, key: str, agg: dict):
        """Overwrite the per-day row with the ledger's current absolute totals
        (the ledger holds authoritative running totals in memory)."""
        with self._lock:
            self._conn.execute(
                """INSERT INTO daily_activity
                     (date,person_key,name,stream,working_sec,not_working_sec,
                      on_phone_sec,talking_sec,phone_sessions,first_seen,last_seen)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(date,person_key) DO UPDATE SET
                     name=excluded.name, stream=excluded.stream,
                     working_sec=excluded.working_sec,
                     not_working_sec=excluded.not_working_sec,
                     on_phone_sec=excluded.on_phone_sec,
                     talking_sec=excluded.talking_sec,
                     phone_sessions=excluded.phone_sessions,
                     first_seen=excluded.first_seen,
                     last_seen=excluded.last_seen""",
                (date, key, agg.get("name"), agg.get("stream"),
                 agg["working_sec"], agg["not_working_sec"], agg["on_phone_sec"],
                 agg["talking_sec"], agg["phone_sessions"],
                 agg["first_seen"], agg["last_seen"]),
            )
            self._conn.commit()

    def load_daily(self, date: str) -> dict:
        """{person_key: agg} for one day — used to resume after a restart."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT person_key,name,stream,working_sec,not_working_sec,on_phone_sec,"
                "talking_sec,phone_sessions,first_seen,last_seen FROM daily_activity WHERE date=?",
                (date,),
            )
            rows = cur.fetchall()
        out = {}
        for r in rows:
            out[r[0]] = {
                "name": r[1], "stream": r[2], "working_sec": r[3], "not_working_sec": r[4],
                "on_phone_sec": r[5], "talking_sec": r[6], "phone_sessions": r[7],
                "first_seen": r[8], "last_seen": r[9],
            }
        return out

    def history(self, days: int = 7) -> dict:
        """Per-person daily totals across the most recent `days` days present in
        the store. Returns {days:[...], people:[{key,name,by_date,totals}]}."""
        with self._lock:
            dates = [r[0] for r in self._conn.execute(
                "SELECT DISTINCT date FROM daily_activity ORDER BY date DESC LIMIT ?",
                (max(1, days),),
            ).fetchall()]
            if not dates:
                return {"days": [], "people": []}
            placeholders = ",".join("?" * len(dates))
            rows = self._conn.execute(
                f"SELECT date,person_key,name,working_sec,not_working_sec,on_phone_sec,"
                f"talking_sec,phone_sessions FROM daily_activity WHERE date IN ({placeholders})",
                dates,
            ).fetchall()
        people: dict[str, dict] = {}
        for date, key, name, w, nw, op, tk, ps in rows:
            pk = name or key
            p = people.setdefault(pk, {
                "key": key, "name": name, "by_date": {},
                "totals": {"working_sec": 0.0, "not_working_sec": 0.0,
                           "on_phone_sec": 0.0, "talking_sec": 0.0, "phone_sessions": 0},
            })
            p["by_date"][date] = {"working_sec": w, "not_working_sec": nw,
                                  "on_phone_sec": op, "talking_sec": tk, "phone_sessions": ps}
            p["totals"]["working_sec"] += w or 0
            p["totals"]["not_working_sec"] += nw or 0
            p["totals"]["on_phone_sec"] += op or 0
            p["totals"]["talking_sec"] += tk or 0
            p["totals"]["phone_sessions"] += ps or 0
        return {
            "days": sorted(dates),
            "people": sorted(people.values(), key=lambda x: -x["totals"]["on_phone_sec"]),
        }

    def recent_sessions(self, limit: int = 100, date: str | None = None) -> list[dict]:
        q = ("SELECT person_key,name,stream,date,start_ts,end_ts,duration_sec FROM phone_sessions"
             + (" WHERE date=?" if date else "")
             + " ORDER BY end_ts DESC LIMIT ?")
        args = (date, limit) if date else (limit,)
        with self._lock:
            rows = self._conn.execute(q, args).fetchall()
        return [{"person_key": r[0], "name": r[1], "stream": r[2], "date": r[3],
                 "start_ts": r[4], "end_ts": r[5], "duration_sec": r[6]} for r in rows]

    # -- settings (line config etc.) --------------------------------------
    def get_setting(self, key: str):
        with self._lock:
            r = self._conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if not r:
            return None
        try:
            return json.loads(r[0])
        except Exception:
            return None

    def all_lines(self) -> dict:
        """{camera_code: line} for every saved in/out line — so the watcher can
        reload them all on start, not just the cameras in config."""
        with self._lock:
            rows = self._conn.execute("SELECT key,value FROM settings WHERE key LIKE 'line:%'").fetchall()
        out = {}
        for k, v in rows:
            cam = k[len("line:"):]
            try:
                out[cam] = json.loads(v)
            except Exception:
                out[cam] = None
        return out

    def set_setting(self, key: str, value) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO settings(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )
            self._conn.commit()

    # -- crossings (in/out log) -------------------------------------------
    def add_crossing(self, *, person_key, name, stream, direction, ts, date, duration_sec=None) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO crossings(person_key,name,stream,direction,ts,date,duration_sec) "
                "VALUES(?,?,?,?,?,?,?)",
                (person_key, name, stream, direction, ts, date, duration_sec),
            )
            self._conn.commit()

    def count_crossings(self, date: str, direction: str | None = None,
                        named: bool | None = None) -> int:
        q = "SELECT COUNT(*) FROM crossings WHERE date=?"
        args: list = [date]
        if direction:
            q += " AND direction=?"; args.append(direction)
        if named is True:
            q += " AND name IS NOT NULL"
        elif named is False:
            q += " AND name IS NULL"
        with self._lock:
            return int(self._conn.execute(q, args).fetchone()[0])

    def recent_crossings(self, limit: int = 50, date: str | None = None) -> list[dict]:
        q = ("SELECT person_key,name,stream,direction,ts,duration_sec FROM crossings"
             + (" WHERE date=?" if date else "")
             + " ORDER BY ts DESC LIMIT ?")
        args = (date, limit) if date else (limit,)
        with self._lock:
            rows = self._conn.execute(q, args).fetchall()
        return [{"person_key": r[0], "name": r[1], "stream": r[2], "direction": r[3],
                 "ts": r[4], "duration_sec": r[5]} for r in rows]

    # -- policy alerts -----------------------------------------------------
    def add_alert(self, *, date, ts, tier, type, subject, camera, detail, dedup_key) -> bool:
        """Insert an alert. Returns True if it's new, False if this
        (subject, type, session) already fired — the UNIQUE dedup_key IS the
        per-identity cooldown."""
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO alerts(date,ts,tier,type,subject,camera,detail,dedup_key) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (date, ts, tier, type, subject, camera, detail, dedup_key),
                )
                self._conn.commit()
                return True
            except sqlite3.IntegrityError:
                return False

    def recent_alerts(self, limit: int = 100, date: str | None = None,
                      tier: str | None = None) -> list[dict]:
        q = "SELECT id,date,ts,tier,type,subject,camera,detail,acknowledged FROM alerts"
        cond, args = [], []
        if date:
            cond.append("date=?"); args.append(date)
        if tier:
            cond.append("tier=?"); args.append(tier)
        if cond:
            q += " WHERE " + " AND ".join(cond)
        q += " ORDER BY ts DESC LIMIT ?"; args.append(limit)
        with self._lock:
            rows = self._conn.execute(q, args).fetchall()
        return [{"id": r[0], "date": r[1], "ts": r[2], "tier": r[3], "type": r[4],
                 "subject": r[5], "camera": r[6], "detail": r[7], "acknowledged": bool(r[8])}
                for r in rows]

    def count_alerts(self, date: str, tier: str | None = None) -> int:
        q = "SELECT COUNT(*) FROM alerts WHERE date=?"
        args = [date]
        if tier:
            q += " AND tier=?"; args.append(tier)
        with self._lock:
            return int(self._conn.execute(q, args).fetchone()[0])

    def ack_alert(self, alert_id: int) -> None:
        with self._lock:
            self._conn.execute("UPDATE alerts SET acknowledged=1 WHERE id=?", (alert_id,))
            self._conn.commit()

    def clear_alerts(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM alerts")
            self._conn.commit()

    # -- attendance summary (per-person, per-day) -------------------------
    def upsert_attendance(self, date: str, name: str, rec: dict) -> None:
        with self._lock:
            self._conn.execute(
                """INSERT INTO attendance
                     (date,name,camera,first_entry_ts,last_event_ts,in_count,out_count,
                      total_inside_sec,currently_inside,current_entered_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(date,name) DO UPDATE SET
                     camera=excluded.camera,
                     first_entry_ts=excluded.first_entry_ts,
                     last_event_ts=excluded.last_event_ts,
                     in_count=excluded.in_count, out_count=excluded.out_count,
                     total_inside_sec=excluded.total_inside_sec,
                     currently_inside=excluded.currently_inside,
                     current_entered_at=excluded.current_entered_at""",
                (date, name, rec.get("camera"), rec.get("first_entry_ts"), rec.get("last_event_ts"),
                 rec.get("in_count", 0), rec.get("out_count", 0), rec.get("total_inside_sec", 0.0),
                 1 if rec.get("currently_inside") else 0, rec.get("current_entered_at")),
            )
            self._conn.commit()

    def clear_attendance(self, prefix: str | None = None) -> None:
        """Delete attendance + crossings — all of them, or only names starting
        with `prefix` (used for test cleanup / an admin 'reset today')."""
        with self._lock:
            if prefix:
                like = prefix + "%"
                self._conn.execute("DELETE FROM attendance WHERE name LIKE ?", (like,))
                self._conn.execute("DELETE FROM crossings WHERE name LIKE ?", (like,))
            else:
                self._conn.execute("DELETE FROM attendance")
                self._conn.execute("DELETE FROM crossings")
            self._conn.commit()

    def load_attendance(self, date: str) -> dict:
        with self._lock:
            rows = self._conn.execute(
                "SELECT name,camera,first_entry_ts,last_event_ts,in_count,out_count,"
                "total_inside_sec,currently_inside,current_entered_at FROM attendance WHERE date=?",
                (date,),
            ).fetchall()
        out = {}
        for r in rows:
            out[r[0]] = {
                "name": r[0], "camera": r[1], "first_entry_ts": r[2], "last_event_ts": r[3],
                "in_count": r[4], "out_count": r[5], "total_inside_sec": r[6],
                "currently_inside": bool(r[7]), "current_entered_at": r[8],
            }
        return out

    def close(self):
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass
