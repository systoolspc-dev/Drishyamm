"""Real-time person tracker — WHO is WHERE, right now, across every camera.

Consumes the same `vms.cam.state:*` frames vms_face already publishes (each box
carries name + conf), and maintains a live track per recognised person:

    camera they're on now · since when · confidence · full hop-by-hop trail
    ACTIVE → TRANSIT (predicting the next camera) → LOST

The logic is deliberately defensive — a demo-grade tracker that never lies:

  * K-of-N CONFIRMATION   a person must be seen in >= K frames within a short
                          window on a camera before we believe they're there.
                          One-frame face matches (the classic false positive)
                          can never move a track.
  * HANDOFF + TRAIL       confirmed on a new camera → the current hop closes
                          (with dwell time) and a new hop opens. The trail is
                          the person's journey through the building.
  * ANTI-TELEPORT GUARD   a jump between two cameras faster than the learned
                          (or minimum) transit time demands a STRONGER
                          confirmation (K + teleport_extra) before we accept
                          it — a lookalike on a far camera can't yank the track.
  * LEARNED MOVEMENT GRAPH  consecutive same-person sightings in vms_face's
                          persisted detection_events teach us which cameras
                          are adjacent and the median walk time between them.
                          Used to rank "predicted next camera" while in
                          TRANSIT, and to power the teleport guard. Fail-soft:
                          no DB → fully-connected graph with a floor time.

Zero new load on cameras/NVRs: it only listens to Redis frames that already
exist and (optionally) reads Postgres for the movement graph.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque

log = logging.getLogger("activity_monitor.live_tracker")


def _env_f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except Exception:
        return default


def _env_i(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


class LiveTracker:
    # Track lifecycle states
    ACTIVE = "active"      # confirmed on a camera, seen within active_ttl
    TRANSIT = "transit"    # dropped off a camera; expected to reappear nearby
    LOST = "lost"          # not seen anywhere for lost_ttl

    def __init__(self, redis_url: str, channel_prefix: str = "vms.cam.state",
                 pg_dsn: str | None = None):
        self.redis_url = redis_url
        self.pattern = f"{channel_prefix}:*"
        # Same source of truth as recognition_sync (vms_face's persisted events).
        self._pg_dsn = (pg_dsn or os.environ.get("TRACK_PG_DSN")
                        or os.environ.get("RECOGNITION_PG_DSN")
                        or "postgresql://vms:vms@postgres:5432/vms_face")

        # ── Tunables (env-overridable; defaults tuned for ~6 fps face frames) ──
        self.confirm_hits = _env_i("TRACK_CONFIRM_HITS", 3)          # K
        self.confirm_window = _env_f("TRACK_CONFIRM_WINDOW_SEC", 5)  # N-window
        self.min_conf = _env_f("TRACK_MIN_CONF", 0.0)                # optional det-score gate
        self.active_ttl = _env_f("TRACK_ACTIVE_TTL_SEC", 6)          # ACTIVE → TRANSIT
        self.lost_ttl = _env_f("TRACK_LOST_TTL_SEC", 120)            # TRANSIT → LOST
        self.min_transit = _env_f("TRACK_MIN_TRANSIT_SEC", 2)        # teleport floor
        self.teleport_extra = _env_i("TRACK_TELEPORT_EXTRA_HITS", 2) # K bonus on suspicious jumps
        self.handoff_quiet = _env_f("TRACK_HANDOFF_QUIET_SEC", 2.0)  # overlap-contention guard
        self.rehop_gap = _env_f("TRACK_REHOP_GAP_SEC", 60)           # revisit → NEW hop after this
        self.adj_lookback_days = _env_i("TRACK_ADJ_LOOKBACK_DAYS", 14)
        self.adj_refresh_sec = _env_f("TRACK_ADJ_REFRESH_SEC", 900)  # relearn every 15 min
        self.trail_cap = _env_i("TRACK_TRAIL_CAP", 60)               # hops kept per person

        self._lock = threading.RLock()
        # (camera, name) -> deque[(ts, conf)] recent sightings, for K-of-N voting
        self._sightings: dict[tuple, deque] = {}
        # name -> track dict (see _new_track)
        self._tracks: dict[str, dict] = {}
        # learned movement graph: (camA, camB) -> {"count": int, "median_sec": float}
        self._graph: dict[tuple, dict] = {}
        self._graph_learned_at = 0.0
        self._frames_seen = 0
        self._started_at = time.time()

        self._stop = threading.Event()
        self._pubsub = None
        self._sub_thread = threading.Thread(target=self._run_sub, name="track-sub", daemon=True)
        self._tick_thread = threading.Thread(target=self._run_tick, name="track-tick", daemon=True)

    # ── lifecycle ──────────────────────────────────────────────────────────
    def start(self):
        self._sub_thread.start()
        self._tick_thread.start()
        log.info("live tracker: K=%d/%ss window, active_ttl=%ss, lost_ttl=%ss, "
                 "min_transit=%ss (+%d hits on teleport)",
                 self.confirm_hits, self.confirm_window, self.active_ttl,
                 self.lost_ttl, self.min_transit, self.teleport_extra)

    def stop(self):
        self._stop.set()
        try:
            if self._pubsub is not None:
                self._pubsub.close()
        except Exception:
            pass

    # ── redis subscription (same resilient pattern as attendance/identity) ──
    def _run_sub(self):
        try:
            import redis
        except Exception:
            log.warning("live tracker OFF: `redis` package not installed")
            return
        while not self._stop.is_set():
            try:
                client = redis.Redis.from_url(self.redis_url, decode_responses=True)
                self._pubsub = client.pubsub()
                self._pubsub.psubscribe(self.pattern)
                log.info("live tracker: subscribed to %s", self.pattern)
                for msg in self._pubsub.listen():
                    if self._stop.is_set():
                        break
                    if msg.get("type") != "pmessage":
                        continue
                    self._ingest(msg.get("data"))
            except Exception as e:  # noqa: BLE001 — reconnect on any bus error
                if self._stop.is_set():
                    break
                log.warning("live tracker: subscribe error (%s); retrying in 3s", e)
                if self._stop.wait(3.0):
                    break

    # ── frame ingestion ─────────────────────────────────────────────────────
    def _ingest(self, raw):
        try:
            p = json.loads(raw)
        except Exception:
            return
        if p.get("event") != "frame":
            return
        cam = p.get("camera_code")
        if not cam:
            return
        now = time.time()
        with self._lock:
            self._frames_seen += 1
            for b in (p.get("boxes") or []):
                nm = b.get("name")
                if not nm or nm == "Unknown":
                    continue                      # tracker follows IDENTIFIED people
                conf = float(b.get("conf") or 0.0)
                if self.min_conf and conf < self.min_conf:
                    continue
                self._observe(nm, cam, now, conf)

    def _observe(self, name: str, cam: str, now: float, conf: float):
        # 1. record the sighting for K-of-N voting
        key = (cam, name)
        dq = self._sightings.get(key)
        if dq is None:
            dq = deque(maxlen=32)
            self._sightings[key] = dq
        dq.append((now, conf))
        recent = [(t, c) for (t, c) in dq if now - t <= self.confirm_window]

        tr = self._tracks.get(name)

        # 2. how many confirmations does THIS transition need?
        need = self.confirm_hits
        if tr and tr["camera"] and tr["camera"] != cam:
            elapsed = now - tr["last_seen"]
            expected = self._expected_transit(tr["camera"], cam)
            if elapsed < max(self.min_transit, 0.5 * expected):
                # Faster than a human could plausibly walk it → demand more proof.
                need += self.teleport_extra

        if len(recent) < need:
            return                                 # not confirmed here (yet)

        # 2b. CAMERA-CONTENTION GUARD — overlapping fields of view. If the
        # CURRENT camera has also seen them in the last handoff_quiet seconds,
        # only hand off when the new camera's recent evidence is strictly
        # stronger. Two cameras watching the same doorway must not ping-pong
        # the track (and spam fake hops) while the person stands still.
        if tr and tr["camera"] and tr["camera"] != cam:
            cur_dq = self._sightings.get((tr["camera"], name)) or ()
            cur_recent = [t for (t, _) in cur_dq if now - t <= self.confirm_window]
            still_on_current = cur_recent and (now - max(cur_recent)) <= self.handoff_quiet
            if still_on_current and len(recent) <= len(cur_recent):
                return                             # current camera still owns the track

        best_conf = max(c for _, c in recent)

        # 3. confirmed sighting → update / hand off the track
        if tr is None:
            tr = self._new_track(name)
            self._tracks[name] = tr

        # A REVISIT after a long silence (walked away, came back to the same
        # camera) is a new stop on the journey — not a continuation of the old
        # hop, which would inflate its dwell time absurdly.
        revisit = (tr["camera"] == cam and tr["status"] != self.ACTIVE
                   and tr["last_seen"] and (now - tr["last_seen"]) > self.rehop_gap)

        if tr["camera"] != cam or revisit:         # ── HANDOFF / REVISIT ──
            prev = tr["camera"]
            if prev is not None and tr["trail"]:
                hop = tr["trail"][-1]
                if hop["exit"] is None:
                    hop["exit"] = tr["last_seen"]
                    hop["dwell_sec"] = round(max(0.0, hop["exit"] - hop["enter"]), 1)
            tr["trail"].append({
                "camera": cam, "enter": now, "exit": None,
                "dwell_sec": None, "best_conf": round(best_conf, 3),
                "from": prev,
                "transit_sec": round(now - tr["last_seen"], 1) if prev else None,
            })
            del tr["trail"][:-self.trail_cap]      # cap memory
            tr["camera"] = cam
            tr["entered_at"] = now
            tr["hops"] += 1 if prev else 0
        else:
            hop = tr["trail"][-1] if tr["trail"] else None
            if hop is not None:
                hop["best_conf"] = round(max(hop["best_conf"], best_conf), 3)

        tr["status"] = self.ACTIVE
        tr["last_seen"] = now
        tr["sightings"] += 1
        # EMA confidence — smooth, decays naturally when matches weaken
        tr["confidence"] = round(0.7 * tr["confidence"] + 0.3 * best_conf, 3) \
            if tr["confidence"] else round(best_conf, 3)
        tr["predicted_next"] = []

    @staticmethod
    def _new_track(name: str) -> dict:
        return {"name": name, "camera": None, "entered_at": None, "last_seen": 0.0,
                "status": LiveTracker.TRANSIT, "confidence": 0.0,
                "sightings": 0, "hops": 0, "trail": [], "predicted_next": [],
                "first_seen": time.time()}

    # ── periodic state machine tick ─────────────────────────────────────────
    def _run_tick(self):
        while not self._stop.wait(1.0):
            stale = self._tick_once(time.time())
            if stale:
                self._learn_graph()

    def _tick_once(self, now: float) -> bool:
        """One state-machine sweep at virtual time `now` (unit-testable).
        Returns True when the movement graph is due for a relearn."""
        with self._lock:
            for tr in self._tracks.values():
                gone = now - tr["last_seen"]
                if tr["status"] == self.ACTIVE and gone > self.active_ttl:
                    tr["status"] = self.TRANSIT
                    tr["predicted_next"] = self._predict_next(tr["camera"])
                    if tr["trail"]:
                        hop = tr["trail"][-1]
                        if hop["exit"] is None:
                            hop["exit"] = tr["last_seen"]
                            hop["dwell_sec"] = round(max(0.0, hop["exit"] - hop["enter"]), 1)
                elif tr["status"] == self.TRANSIT and gone > self.lost_ttl:
                    tr["status"] = self.LOST
                    tr["predicted_next"] = []
            # hygiene: drop sighting buffers with nothing recent (bounded memory
            # no matter how many people/cameras pass through over weeks)
            dead = [k for k, dq in self._sightings.items()
                    if not dq or now - dq[-1][0] > 10 * self.confirm_window]
            for k in dead:
                del self._sightings[k]
            return now - self._graph_learned_at > self.adj_refresh_sec

    # ── learned movement graph ──────────────────────────────────────────────
    def _learn_graph(self):
        self._graph_learned_at = time.time()      # even on failure — retry later, don't spin
        if not self._pg_dsn:
            return
        try:
            import psycopg2
            conn = psycopg2.connect(self._pg_dsn, connect_timeout=5)
            cur = conn.cursor()
            # Consecutive sightings of the SAME person on DIFFERENT cameras,
            # within 10 min → one observed transition camA → camB.
            cur.execute("""
                WITH seq AS (
                  SELECT d.person_id,
                         c.code                                        AS cam,
                         extract(epoch FROM d.occurred_at)              AS ts,
                         LEAD(c.code) OVER w                            AS next_cam,
                         LEAD(extract(epoch FROM d.occurred_at)) OVER w AS next_ts
                  FROM detection_events d
                  JOIN cameras c ON c.id = d.camera_id
                  WHERE d.person_id IS NOT NULL
                    AND d.occurred_at >= now() - make_interval(days => %s)
                  WINDOW w AS (PARTITION BY d.person_id ORDER BY d.occurred_at)
                )
                SELECT cam, next_cam,
                       COUNT(*)                                                    AS n,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY next_ts - ts)   AS median_sec
                FROM seq
                WHERE next_cam IS NOT NULL AND next_cam <> cam
                  AND next_ts - ts BETWEEN 1 AND 600
                GROUP BY cam, next_cam
            """, (self.adj_lookback_days,))
            graph = {}
            for cam, nxt, n, med in cur.fetchall():
                graph[(cam, nxt)] = {"count": int(n), "median_sec": round(float(med), 1)}
            cur.close(); conn.close()
            with self._lock:
                self._graph = graph
            log.info("live tracker: movement graph learned — %d edges (%dd lookback)",
                     len(graph), self.adj_lookback_days)
        except Exception as e:  # noqa: BLE001 — graph is an enhancer, never a dependency
            log.warning("live tracker: movement-graph learn failed (%s) — using floor transit", e)

    def _expected_transit(self, cam_a: str, cam_b: str) -> float:
        edge = self._graph.get((cam_a, cam_b)) or self._graph.get((cam_b, cam_a))
        return edge["median_sec"] if edge else self.min_transit

    def _predict_next(self, cam: str | None):
        if not cam:
            return []
        outs = [(b, e) for (a, b), e in self._graph.items() if a == cam]
        outs.sort(key=lambda x: -x[1]["count"])
        total = sum(e["count"] for _, e in outs) or 1
        return [{"camera": b, "probability": round(e["count"] / total, 2),
                 "expected_sec": e["median_sec"]} for b, e in outs[:3]]

    # ── public API ───────────────────────────────────────────────────────────
    def snapshot(self, name: str | None = None) -> dict:
        now = time.time()
        with self._lock:
            def ser(tr):
                return {**{k: v for k, v in tr.items() if k != "trail"},
                        "seconds_since_seen": round(now - tr["last_seen"], 1) if tr["last_seen"] else None,
                        "trail_len": len(tr["trail"])}
            if name:
                tr = self._tracks.get(name)
                if not tr:
                    return {"found": False, "name": name}
                return {"found": True, **ser(tr), "trail": list(tr["trail"])}
            tracks = sorted((ser(t) for t in self._tracks.values()),
                            key=lambda t: -(t["last_seen"] or 0))
            # camera occupancy: who is ACTIVE where, right now
            occupancy: dict[str, list] = {}
            for t in tracks:
                if t["status"] == self.ACTIVE and t["camera"]:
                    occupancy.setdefault(t["camera"], []).append(t["name"])
            return {"tracks": tracks, "occupancy": occupancy,
                    "frames_seen": self._frames_seen,
                    "graph_edges": len(self._graph),
                    "uptime_sec": round(now - self._started_at, 1)}

    def graph(self) -> dict:
        with self._lock:
            return {"edges": [{"from": a, "to": b, **e} for (a, b), e in
                              sorted(self._graph.items(), key=lambda kv: -kv[1]["count"])],
                    "learned_at": self._graph_learned_at,
                    "lookback_days": self.adj_lookback_days}

    def reset(self) -> dict:
        with self._lock:
            n = len(self._tracks)
            self._tracks = {}
            self._sightings = {}
        return {"ok": True, "cleared": n}
