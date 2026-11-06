"""Forward live head counts to the VMS backend (occupancy ingest).

Every `interval_sec`, this reads the manager's per-stream counts and POSTs them
to the backend's ``/api/internal/ai/occupancy``, which stores a live gauge (for
the headcount page) and raises debounced occupancy-threshold alerts. Stdlib-only
(urllib) so it adds no dependency; best-effort — a failed POST is logged and the
loop keeps going.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.request

log = logging.getLogger("headcount.forwarder")


def _resolve(cfg) -> tuple[str, str]:
    """backend_url / service_token from config, falling back to env vars shared
    with the AI + backend services."""
    backend = (getattr(cfg, "backend_url", "") or os.environ.get("BACKEND_URL", "")).rstrip("/")
    token = getattr(cfg, "service_token", "") or os.environ.get("SERVICE_TOKEN", "")
    return backend, token


def _build_payload(manager, monitor_by_stream: dict[str, str]) -> dict:
    """One tick per stream, WITH the reliability signals.

    The backend must be able to tell "the room is empty" (heads=0, reliable) from
    "we cannot see the room" (camera offline / count stale). Sending only `heads`
    made those indistinguishable, so a dead camera would be logged as an empty
    room. We therefore ship the same reliability fields the dashboard shows:
    `reliable` (the service's own freshness verdict), `ageSec` (seconds since the
    count was last VERIFIED by the model), `degraded` (motion gate saturated —
    noisy camera), and `tracked` (confirmed persistent tracks) for auditing.
    """
    streams = []
    for snap in manager.all_snapshots():
        sid = snap.get("id")
        counts = snap.get("counts") or {}
        heads = counts.get("heads")
        if heads is None:  # no 'heads' detector → sum whatever was counted
            heads = sum(int(v) for v in counts.values()) if counts else 0
        connected = bool(snap.get("connected"))
        streams.append({
            "monitorId": monitor_by_stream.get(sid, sid),
            # heads stays a number; the backend decides whether to TRUST it.
            "heads": int(heads),
            "connected": connected,
            "reliable": bool(snap.get("count_reliable", True)) and connected,
            "ageSec": snap.get("count_age_s"),
            "degraded": bool(snap.get("gate_saturated", False)),
            "tracked": snap.get("tracked"),
            "status": snap.get("status"),
        })
    return {"source": "head-count", "streams": streams}


def _post(url: str, token: str, payload: dict) -> int:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Service-Token", token)
    with urllib.request.urlopen(req, timeout=6.0) as resp:  # noqa: S310 (trusted internal URL)
        return resp.status


def _loop(manager, cfg, backend: str, token: str, stop_event: threading.Event) -> None:
    url = f"{backend}/api/internal/ai/occupancy"
    monitor_by_stream = dict(getattr(cfg, "monitor_by_stream", {}) or {})
    interval = float(cfg.interval_sec)
    while not stop_event.is_set():
        try:
            payload = _build_payload(manager, monitor_by_stream)
            if payload["streams"]:
                _post(url, token, payload)
        except urllib.error.HTTPError as e:  # 401/4xx/5xx from the backend
            log.warning("occupancy POST rejected: %s %s", e.code, e.reason)
        except Exception as e:  # noqa: BLE001 — never let the forwarder die
            log.warning("occupancy POST failed: %s", e)
        stop_event.wait(interval)


def start_forwarder(manager, cfg, stop_event: threading.Event):
    """Start the background forwarder thread. Returns the thread, or None if
    forwarding is disabled / unconfigured (the dashboard still works either way)."""
    if not getattr(cfg, "enabled", False):
        log.info("count forwarder disabled (forward.enabled=false)")
        return None
    backend, token = _resolve(cfg)
    if not backend or not token:
        log.warning("count forwarder OFF: BACKEND_URL / SERVICE_TOKEN not set "
                    "— counts will not reach the VMS")
        return None
    t = threading.Thread(
        target=_loop, args=(manager, cfg, backend, token, stop_event),
        name="headcount-forwarder", daemon=True,
    )
    t.start()
    log.info("count forwarder started → %s/api/internal/ai/occupancy every %.1fs",
             backend, float(cfg.interval_sec))
    return t
