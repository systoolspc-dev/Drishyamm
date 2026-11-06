"""Dynamic camera source — headcount is user-controlled per camera.

Polls the VMS backend's camera registry (``/api/internal/cameras``) and keeps the
running stream workers matched to the set of cameras that have head-count enabled
(``settings.headcount.enabled``). Users toggle the feature per camera in the VMS
UI; this loop picks the change up on the next poll and adds/removes workers via
``manager.reconcile``. Stdlib-only (urllib); best-effort — a failed poll is logged
and the current worker set is left untouched.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.request

from .config import StreamConfig

log = logging.getLogger("headcount.source")


def _resolve(cfg) -> tuple[str, str]: 
    backend = (getattr(cfg, "backend_url", "") or os.environ.get("BACKEND_URL", "")).rstrip("/")
    token = getattr(cfg, "service_token", "") or os.environ.get("SERVICE_TOKEN", "")
    return backend, token


def _fetch_cameras(url: str, token: str) -> list[dict]:
    req = urllib.request.Request(url, method="GET")
    req.add_header("X-Service-Token", token)
    with urllib.request.urlopen(req, timeout=8.0) as resp:  # noqa: S310 (trusted internal URL)
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("cameras", []) or []


# Hostnames that are OUR OWN relay, not a camera/NVR. Reading one of these
# costs the recorder nothing: the stream service holds a single upstream pull
# and fans it out to readers, so N head-count workers on a relay path are still
# ONE session at the NVR.
RELAY_HOSTS = {
    h.strip().lower()
    for h in os.environ.get(
        "HEADCOUNT_RELAY_HOSTS",
        "stream-service,drishyam-stream-service,mediamtx,localhost,127.0.0.1",
    ).split(",")
    if h.strip()
}


def _rtsp_host(rtsp: str) -> str:
    try:
        return rtsp.split("://", 1)[1].split("/", 1)[0].split("@")[-1].split(":")[0].lower()
    except Exception:  # noqa: BLE001
        return "unknown"


def _host_of(cam: dict, rtsp: str) -> tuple[str, bool]:
    """Return (host, is_relay) for per-recorder concurrency capping.

    The cap exists to protect a RECORDER from concurrent RTSP sessions, so it
    must key on the device we actually dial. When the backend hands us a relay
    URL — the normal pull deployment — every camera shares one authority, and
    capping on it throttles the whole service while protecting nothing.
    """
    h = cam.get("host") or cam.get("ip")
    if h:
        return str(h).lower(), False
    host = _rtsp_host(rtsp)
    return host, host in RELAY_HOSTS


# A camera the VMS reports as offline is not worth dialling. Beyond the wasted
# work, OpenCV's FFmpeg backend serialises avformat_open_input behind a global
# mutex, so each dead camera burning a 30s open timeout BLOCKS every healthy
# camera's (re)connect — one unreachable NVR could stall the whole service.
SKIP_OFFLINE = os.environ.get("HEADCOUNT_SKIP_OFFLINE", "true").lower() != "false"
_OFFLINE = {"offline", "unreachable", "error", "disabled"}


def _is_offline(cam: dict) -> bool:
    """Only an EXPLICIT offline verdict skips a camera; unknown means try."""
    return SKIP_OFFLINE and str(cam.get("status") or "").lower() in _OFFLINE


def _to_streams(cams: list[dict], prefer_sub: bool,
                max_streams: int = 8, max_per_host: int = 4) -> list[StreamConfig]:
    """Enabled cameras → stream configs, capped so we can never flood an NVR.

    Entry NVRs stop answering past a handful of concurrent RTSP sessions and
    take EVERY camera offline (observed twice). Excess cameras are skipped with
    a warning rather than silently, so operators can see why a camera they
    enabled isn't counting.

    Two independent caps, because they defend different things:
      • per-host — protects the RECORDER. Skipped for relay sources, which add
        no upstream session (see RELAY_HOSTS).
      • max_streams — protects OUR OWN GPU/CPU. Always applies.

    Cameras the VMS already knows are offline are dropped first — the VMS is the
    authority on liveness, and dialling them starves the live ones (see
    SKIP_OFFLINE).
    """
    out: list[StreamConfig] = []
    per_host: dict[str, int] = {}
    deferred: list[str] = []
    offline = 0
    for c in cams:
        settings = c.get("settings") or {}
        hc = settings.get("headcount") or {}
        if hc.get("enabled") is not True:
            continue
        rtsp = (c.get("rtspSub") if prefer_sub else None) or c.get("rtsp")
        monitor = c.get("monitorId")
        if not rtsp or not monitor:
            continue
        name = c.get("name") or str(monitor)
        if _is_offline(c):
            offline += 1
            continue
        host, is_relay = _host_of(c, rtsp)
        if len(out) >= max_streams:
            deferred.append(f"{name} (service cap {max_streams})")
            continue
        if not is_relay:
            if per_host.get(host, 0) >= max_per_host:
                deferred.append(f"{name} (recorder {host} cap {max_per_host})")
                continue
            per_host[host] = per_host.get(host, 0) + 1
        # Counting zones the operator drew in the VMS. Normalised polygons, so
        # they survive any resolution change. Absent/empty = count everyone.
        zones = hc.get("zones") or []
        out.append(StreamConfig(id=str(monitor), name=name, source=rtsp,
                                zones=zones if isinstance(zones, list) else []))
    if deferred:
        log.warning("head-count: %d camera(s) enabled but NOT started: %s",
                    len(deferred), "; ".join(deferred[:6]))
    if offline:
        log.info("head-count: %d enabled camera(s) skipped — VMS reports them offline",
                 offline)
    return out


def _loop(manager, cfg, backend: str, token: str, stop_event: threading.Event) -> None:
    url = f"{backend}/api/internal/cameras"
    prefer_sub = bool(getattr(cfg, "prefer_sub", True))
    interval = float(cfg.poll_interval_sec)
    last_ids: set[str] = set()
    while not stop_event.is_set():
        try:
            streams = _to_streams(_fetch_cameras(url, token), prefer_sub,
                                  max_streams=int(getattr(cfg, 'max_streams', 8)),
                                  max_per_host=int(getattr(cfg, 'max_streams_per_host', 4)))
            ids = {s.id for s in streams}
            if ids != last_ids:
                log.info("head-count cameras changed: %s", sorted(ids) or "(none)")
                last_ids = ids
            manager.reconcile(streams)
        except urllib.error.HTTPError as e:
            log.warning("camera poll rejected: %s %s", e.code, e.reason)
        except Exception as e:  # noqa: BLE001 — never let the poller die
            log.warning("camera poll failed: %s", e)
        stop_event.wait(interval)


def start_source(manager, cfg, stop_event: threading.Event):
    """Start the dynamic camera poller. Returns the thread, or None if disabled /
    unconfigured (static config.streams is then used as-is)."""
    if not getattr(cfg, "enabled", False):
        log.info("dynamic camera source disabled (source.enabled=false)")
        return None
    backend, token = _resolve(cfg)
    if not backend or not token:
        log.warning("dynamic camera source OFF: BACKEND_URL / SERVICE_TOKEN not set")
        return None
    t = threading.Thread(
        target=_loop, args=(manager, cfg, backend, token, stop_event),
        name="headcount-source", daemon=True,
    )
    t.start()
    log.info("dynamic camera source started → %s/api/internal/cameras every %.0fs",
             backend, float(cfg.poll_interval_sec))
    return t
