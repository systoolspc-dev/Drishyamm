"""Owns the shared detectors and all stream workers; aggregates their state."""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from threading import Lock

from .attendance import AttendanceWatcher
from .config import AppConfig
from .crossing import LineCrosser
from .identity import IdentityProvider
from .ledger import ActivityLedger, _local_date
from .alert_policy import AlertPolicy
from .model import Detector
from .recognition_sync import RecognitionSync
from .store import ActivityStore
from .stream_worker import StreamWorker

log = logging.getLogger("activity_monitor.manager")


class StreamManager:
    def __init__(self, config: AppConfig):
        self.config = config
        self._started_at = time.time()
        # Load each detector once and share it across all stream workers.
        self.detectors = [Detector(dc) for dc in config.detectors]
        self._model_lock = Lock()  # shared hardware → serialize inference
        self.activity_enabled = config.activity.enabled

        # Per-person over-time ledger (time-in-state + phone-usage sessions).
        self.ledger = None
        self._store = None
        if config.activity.enabled and config.activity.ledger_enabled:
            self._store = ActivityStore(config.activity.store_path)
            self.ledger = ActivityLedger(
                self._store, flush_interval=config.activity.ledger_flush_sec,
                session_gap=config.activity.session_gap_sec,
                min_present_sec=config.activity.min_present_sec,
            )

        self._sweeper_stop = threading.Event()
        self._sweeper = threading.Thread(target=self._sweep_loop, name="ledger-sweeper", daemon=True)

        # Optional face-identity fusion (names the anonymous body tracks).
        self.identity = None
        if config.activity.enabled and config.identity.enabled:
            self.identity = IdentityProvider(
                config.identity.redis_url,
                channel_prefix=config.identity.channel_prefix,
                ttl_sec=config.identity.ttl_sec,
                head_region=config.identity.head_region,
            )

        # Per-stream line crossers (legacy pose-based; kept dormant).
        self.crossers: dict[str, LineCrosser] = {}
        if config.activity.enabled:
            for stream in config.streams:
                self.crossers[stream.id] = LineCrosser()

        # Server-side in/out attendance from vms_face cam-state (the real feature):
        # subscribes to recognised boxes, crosses them against the per-camera line,
        # persists + rolls up per-person attendance. Keyed by camera_code.
        self.attendance_watcher = None
        self._default_camera = None
        if config.activity.enabled and config.identity.enabled and self._store:
            self.attendance_watcher = AttendanceWatcher(
                config.identity.redis_url, store=self._store,
                channel_prefix=config.identity.channel_prefix,
            )
            for stream in config.streams:
                if stream.vms_camera and self._default_camera is None:
                    self._default_camera = stream.vms_camera
            # A camera we run a body-tracker StreamWorker on (vms_camera set) does
            # its in/out crossing on whole PERSON boxes via that worker's crosser
            # — reliable at any angle. Every OTHER camera with a saved line falls
            # back to the face-box crossing inside the watcher. Load ALL saved
            # lines (survive restarts) and route each to the right path.
            body_cams = {s.vms_camera: s.id for s in config.streams if s.vms_camera}
            for cam, ln in self._store.all_lines().items():
                if not ln:
                    continue
                self._default_camera = self._default_camera or cam
                if cam in body_cams and body_cams[cam] in self.crossers:
                    self.crossers[body_cams[cam]].set_line(ln)   # body-based path
                else:
                    self.attendance_watcher.set_line(cam, ln)    # face-based fallback

        # Live attendance from vms_face's RECOGNISED detections (the reliable
        # source of truth). Rolls real named people + arrival times into the
        # store, independent of the fragile line crossing. Off only if no store.
        self.recognition_sync = None
        self.alert_policy = None
        if self._store is not None:
            self.alert_policy = AlertPolicy(self._store)
            self.recognition_sync = RecognitionSync(self._store, alerts=self.alert_policy)

        # Real-time person tracker — who is where RIGHT NOW + hop-by-hop trail.
        # Rides the same vms.cam.state frames as identity/attendance; no camera
        # pull, no AI restart, zero NVR load. See live_tracker.py.
        self.live_tracker = None
        if config.identity.enabled:
            from .live_tracker import LiveTracker
            self.live_tracker = LiveTracker(
                config.identity.redis_url,
                channel_prefix=config.identity.channel_prefix,
            )

        self.workers: dict[str, StreamWorker] = {}
        for stream in config.streams:
            # Activity trackers are stateful per camera → one analyzer per stream.
            analyzer = None
            if config.activity.enabled:
                from .activity import ActivityAnalyzer
                analyzer = ActivityAnalyzer(config.activity)
            self.workers[stream.id] = StreamWorker(
                stream, self.detectors, self._model_lock, config.pipeline,
                preview=config.api.preview, jpeg_quality=config.api.jpeg_quality,
                activity=analyzer, phone_detector_id=config.activity.phone_detector_id,
                ledger=self.ledger, identity=self.identity, vms_camera=stream.vms_camera,
                crosser=self.crossers.get(stream.id), crossing_sink=self._record_crossing,
            )

        # Activity cameras chosen by the operator in the product UI. These are
        # added/removed at RUNTIME by reconcile_streams() (no restart); the static
        # config.streams above are never touched by it. This is what makes
        # phone-usage/activity a per-camera, whole-product feature — not a hardcode.
        self._dynamic_ids: set[str] = set()
        self._reconcile_lock = Lock()

    def _record_crossing(self, stream_id: str, ev: dict) -> None:
        """A body-tracker crossing from a StreamWorker → the SAME attendance feed
        + per-person rollup the UI/report reads. Attributed to the camera_code the
        operator drew the line on (not the internal stream id)."""
        if self._store is None:
            return
        cam = next((s.vms_camera for s in self.config.streams if s.id == stream_id), None) or stream_id
        try:
            if self.attendance_watcher is not None:
                self.attendance_watcher.record_crossing(cam, ev)
            else:
                self._store.add_crossing(
                    person_key=ev.get("key"), name=ev.get("name"), stream=cam,
                    direction=ev["direction"], ts=ev["ts"], date=_local_date(ev["ts"]),
                    duration_sec=ev.get("duration_sec"),
                )
        except Exception:
            log.exception("failed recording crossing")

    def _sweep_loop(self) -> None:
        """Close phone sessions for people who left mid-session + periodic flush."""
        while not self._sweeper_stop.wait(1.0):
            if self.ledger is not None:
                try:
                    self.ledger.close_stale(time.time())
                except Exception:
                    log.exception("ledger sweep failed")

    def start(self) -> None:
        log.info("starting %d stream worker(s) with %d detector(s)",
                 len(self.workers), len(self.detectors))
        if self.identity is not None:
            self.identity.start()
        if self.attendance_watcher is not None:
            self.attendance_watcher.start()
        if self.recognition_sync is not None:
            self.recognition_sync.start()
        if self.live_tracker is not None:
            self.live_tracker.start()
        for w in self.workers.values():
            w.start()
        if self.ledger is not None:
            self._sweeper.start()
        # Restore the operator's activity-camera selection (durable across reboots)
        # so phone-usage monitoring resumes on the chosen cameras without a re-push.
        if self._store is not None and self.config.activity.enabled:
            saved = self._store.get_setting("activity_cameras") or []
            if saved:
                try:
                    self.reconcile_streams(saved, persist=False)
                    log.info("activity: restored %d saved camera(s)", len(saved))
                except Exception:
                    log.exception("failed restoring saved activity cameras")

    def stop(self) -> None:
        log.info("stopping stream workers")
        self._sweeper_stop.set()
        for w in self.workers.values():
            w.stop()
        for w in self.workers.values():
            w.join(timeout=5.0)
        if self.identity is not None:
            self.identity.stop()
        if self.attendance_watcher is not None:
            self.attendance_watcher.stop()
        if self.recognition_sync is not None:
            self.recognition_sync.stop()
        if self.live_tracker is not None:
            self.live_tracker.stop()
        if self.ledger is not None:
            self.ledger.flush()   # persist final running totals
        if self._store is not None:
            self._store.close()

    # -- dynamic activity cameras (user-selected, whole-product) ----------
    def _make_worker(self, sc) -> StreamWorker:
        """Build one activity StreamWorker (its own stateful analyzer + crosser)."""
        analyzer = None
        if self.config.activity.enabled:
            from .activity import ActivityAnalyzer
            analyzer = ActivityAnalyzer(self.config.activity)
        crosser = LineCrosser()
        self.crossers[sc.id] = crosser
        return StreamWorker(
            sc, self.detectors, self._model_lock, self.config.pipeline,
            preview=self.config.api.preview, jpeg_quality=self.config.api.jpeg_quality,
            activity=analyzer, phone_detector_id=self.config.activity.phone_detector_id,
            ledger=self.ledger, identity=self.identity, vms_camera=sc.vms_camera,
            crosser=crosser, crossing_sink=self._record_crossing,
        )

    def reconcile_streams(self, desired: list[dict], persist: bool = True) -> dict:
        """Make the live activity workers match `desired` at RUNTIME — no restart.
        Each item: {id, name, source, vms_camera}. Only dynamically-added cameras
        are touched; static config.streams are left alone. The set is persisted so
        it survives a reboot. This is the whole-product, per-camera control path."""
        from .config import StreamConfig
        if not self.config.activity.enabled:
            return {"ok": False, "error": "activity analysis disabled in config", "cameras": []}
        with self._reconcile_lock:
            want: dict[str, dict] = {}
            for d in desired or []:
                sid = str(d.get("id") or d.get("vms_camera") or "").strip()
                if sid and d.get("source") not in (None, ""):
                    want[sid] = d
            # remove cameras no longer wanted
            for sid in list(self._dynamic_ids):
                if sid not in want:
                    w = self.workers.pop(sid, None)
                    if w is not None:
                        try:
                            w.stop(); w.join(timeout=5.0)
                        except Exception:
                            log.exception("failed stopping activity worker %s", sid)
                    self.crossers.pop(sid, None)
                    self._dynamic_ids.discard(sid)
                    log.info("activity: stopped worker %s", sid)
            # add newly wanted cameras
            for sid, d in want.items():
                if sid in self.workers:
                    continue
                try:
                    sc = StreamConfig(id=sid, name=d.get("name") or sid,
                                      source=d["source"], vms_camera=d.get("vms_camera"))
                except Exception as e:  # noqa: BLE001
                    log.warning("skip invalid activity camera %s: %s", sid, e)
                    continue
                w = self._make_worker(sc)
                self.workers[sid] = w
                self._dynamic_ids.add(sid)
                w.start()
                log.info("activity: started worker %s (%s) source=%s", sid, sc.name, sc.source)
            if persist and self._store is not None:
                self._store.set_setting("activity_cameras", list(want.values()))
            return self.activity_cameras()

    def activity_cameras(self) -> dict:
        """The cameras currently running the pose/phone activity pipeline + status."""
        cams = []
        for sid in sorted(self._dynamic_ids):
            w = self.workers.get(sid)
            snap = w.snapshot() if w is not None else {}
            cams.append({
                "id": sid,
                "name": snap.get("name", sid),
                "vms_camera": getattr(w, "vms_camera", None) if w else None,
                "online": bool(snap.get("connected")),
                "frames": snap.get("frames_processed", 0),
                "activity": snap.get("activity"),
                "last_error": snap.get("last_error"),
            })
        return {"ok": True, "count": len(cams), "cameras": cams}

    # -- activity ledger queries (per-person over time) -------------------
    def activity_people(self) -> dict:
        if self.ledger is None:
            return {"date": None, "people": [], "total": 0}
        return self.ledger.people(now=time.time())

    def activity_sessions(self, limit: int = 100, date: str | None = None) -> dict:
        if self.ledger is None:
            return {"sessions": [], "total": 0}
        return self.ledger.sessions(limit=limit, date=date)

    def activity_history(self, days: int = 7) -> dict:
        if self.ledger is None:
            return {"days": [], "people": []}
        return self.ledger.history(days=days)

    # -- in/out attendance (server-side, cam-state driven) ----------------
    def attendance(self) -> dict:
        if self.attendance_watcher is None:
            return {"people": [], "inside": [], "inside_count": 0, "recent": []}
        return self.attendance_watcher.summary(time.time())

    def reset_attendance(self, prefix: str | None = None) -> dict:
        # Also clear the recognition-sync feed dedup so a reset actually rebuilds the
        # in/out crossings from detection_events (not just the watcher's summary).
        if self.recognition_sync is not None and not prefix:
            self.recognition_sync.reset()
        if self.attendance_watcher is None:
            return {"ok": False, "error": "attendance not enabled"}
        return self.attendance_watcher.reset(prefix)

    def activity_crossings(self, limit: int = 200, date: str | None = None) -> dict:
        """The complete entry/exit feed — every crossing (recognised + unknown)."""
        if self._store is None:
            return {"crossings": [], "total": 0}
        rows = self._store.recent_crossings(limit=min(max(limit, 1), 1000), date=date)
        return {"crossings": rows, "total": len(rows)}

    # -- real-time person tracker -------------------------------------------
    def track_live(self, name: str | None = None) -> dict:
        if self.live_tracker is None:
            return {"tracks": [], "occupancy": {}, "disabled": True}
        return self.live_tracker.snapshot(name)

    def track_graph(self) -> dict:
        if self.live_tracker is None:
            return {"edges": [], "disabled": True}
        return self.live_tracker.graph()

    def track_reset(self) -> dict:
        if self.live_tracker is None:
            return {"ok": False, "disabled": True}
        return self.live_tracker.reset()

    # -- unified event log -------------------------------------------------
    def event_log(self, types: list[str] | None = None, camera: str | None = None,
                  name: str | None = None, date: str | None = None, limit: int = 300) -> dict:
        """One filterable, newest-first timeline merging every meaningful event —
        attendance in/out + policy alerts (camera-health joins once persisted).
        These are already debounced/deduped, so the log stays signal, not noise."""
        if self._store is None:
            return {"events": [], "total": 0}
        want = set(types) if types else None
        events: list[dict] = []
        if not want or "attendance" in want:
            for c in self._store.recent_crossings(limit=1000, date=date):
                d = c.get("direction")
                dur = c.get("duration_sec")
                events.append({
                    "ts": c["ts"], "kind": "attendance", "type": d,
                    "subject": c.get("name"), "camera": c.get("stream"), "severity": "info",
                    "detail": ("Entered" if d == "in" else "Left")
                              + (f" · {int(dur // 60)}m on-site" if dur else ""),
                })
        if not want or "alert" in want:
            for a in self._store.recent_alerts(limit=500, date=date):
                events.append({
                    "ts": a["ts"], "kind": "alert", "type": a["type"],
                    "subject": a.get("subject"), "camera": a.get("camera"),
                    "detail": a.get("detail"), "severity": a.get("tier"),
                })
        nq = (name or "").lower()
        events = [e for e in events
                  if (not camera or e.get("camera") == camera)
                  and (not nq or nq in (e.get("subject") or "").lower())]
        events.sort(key=lambda e: e.get("ts") or 0, reverse=True)
        total = len(events)
        return {"events": events[:max(1, min(limit, 1000))], "total": total}

    # -- policy alerts -----------------------------------------------------
    def alerts(self, limit: int = 100, date: str | None = None, tier: str | None = None) -> dict:
        if self._store is None:
            return {"alerts": [], "total": 0, "counts": {}}
        rows = self._store.recent_alerts(limit=min(max(limit, 1), 500), date=date, tier=tier)
        from .ledger import _local_date
        import time as _t
        today = _local_date(_t.time())
        counts = {t: self._store.count_alerts(today, t) for t in ("critical", "warning", "info")}
        return {"alerts": rows, "total": len(rows), "counts": counts}

    def ack_alert(self, alert_id: int) -> dict:
        if self._store is not None:
            self._store.ack_alert(alert_id)
        return {"ok": True}

    def clear_alerts(self) -> dict:
        if self._store is not None:
            self._store.clear_alerts()
        return {"ok": True}

    # -- funnel health metrics --------------------------------------------
    def health_metrics(self, date: str | None = None) -> dict:
        if self.recognition_sync is not None:
            return self.recognition_sync.metrics(date=date)
        return {"error": "recognition sync not enabled"}

    def _body_stream_for(self, cam: str) -> str | None:
        """The StreamWorker id running a body-tracker for this camera_code, if any."""
        for s in self.config.streams:
            if s.vms_camera == cam:
                return s.id
        return None

    def get_line(self, camera: str | None) -> dict:
        cam = camera or self._default_camera
        ln = None
        if cam:
            sid = self._body_stream_for(cam)
            if sid and sid in self.crossers:
                ln = self.crossers[sid].line                    # body-tracker path
            elif self.attendance_watcher is not None:
                ln = self.attendance_watcher.get_line(cam)      # face fallback
        return {"camera": cam, "line": ln}

    def set_line(self, camera: str | None, line: dict | None) -> dict:
        cam = camera or self._default_camera
        if not cam:
            return {"ok": False, "error": "camera (camera_code) required"}
        # Route the line to the SAME crosser that actually records for this camera:
        # the body-tracker's per-stream crosser when we run one, else the watcher.
        sid = self._body_stream_for(cam)
        if sid and sid in self.crossers:
            self.crossers[sid].set_line(line)
        elif self.attendance_watcher is not None:
            self.attendance_watcher.set_line(cam, line)
        if self._store:
            self._store.set_setting(f"line:{cam}", line)
        return {"ok": True, "camera": cam, "line": line}

    # -- queries used by the API ------------------------------------------
    def get(self, stream_id: str) -> dict | None:
        w = self.workers.get(stream_id)
        return w.snapshot() if w else None

    def worker(self, stream_id: str):
        return self.workers.get(stream_id)

    def all_snapshots(self) -> list[dict]:
        return [w.snapshot() for w in self.workers.values()]

    def counts(self) -> dict:
        snaps = self.all_snapshots()
        per_stream = {s["id"]: s["counts"] for s in snaps}
        totals: dict[str, int] = defaultdict(int)
        for s in snaps:
            for label, n in s["counts"].items():
                totals[label] += n
        out = {
            "counts": per_stream,
            "totals": dict(totals),
            "streams_online": sum(1 for s in snaps if s["connected"]),
            "streams_total": len(snaps),
        }
        if self.activity_enabled:
            act: dict[str, int] = defaultdict(int)
            for s in snaps:
                for state, n in (s.get("activity") or {}).items():
                    act[state] += n
            out["activity"] = {s["id"]: s.get("activity", {}) for s in snaps}
            out["activity_totals"] = dict(act)
            out["conversations"] = {s["id"]: s.get("conversations", []) for s in snaps}
        return out

    def conversations(self) -> dict:
        """Who is talking to whom, per stream + a flat list."""
        snaps = self.all_snapshots()
        per_stream = {s["id"]: s.get("conversations", []) for s in snaps}
        flat = [{"stream": sid, "pair": pair}
                for sid, pairs in per_stream.items() for pair in pairs]
        return {"conversations": per_stream, "pairs": flat, "total": len(flat)}

    def health(self) -> dict:
        snaps = self.all_snapshots()
        online = sum(1 for s in snaps if s["connected"])
        status = "healthy" if online == len(snaps) and snaps else (
            "degraded" if online > 0 else "unhealthy"
        )
        return {
            "status": status,
            "uptime_seconds": round(time.time() - self._started_at, 1),
            "device": self.detectors[0].device if self.detectors else "n/a",
            "detectors": [{"id": d.id, "label": d.label} for d in self.detectors],
            "streams_online": online,
            "streams_total": len(snaps),
            "version": __import__("activity_monitor").__version__,
        }
