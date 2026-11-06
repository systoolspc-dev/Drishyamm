"""Analysis heartbeat (forensic search, 4 Oct 2026).

Once a minute, per process: for every camera this process reads, how many
frames the reader decoded, how many reached the detector, how many the
corrupt-picture gate skipped, and - when nothing was decoded - WHY, as one
word from a fixed list. Posted to the AI service, which keeps it as run-length
"analysis spans" (POST /forensic/analysis/heartbeat, X-Service-Token). That is
what lets a search answer "not found on 26 of 30 cameras that were reading
plates; corp8_12 was locked out by the provider 18:20-18:36" instead of
"not found".

Why a direct call to the AI service and not through the backend: the worker
reaches the AI service only through explicit backend proxy routes, and the
backend is not this change's to edit. The AI service already holds the same
SERVICE_TOKEN (it uses it to call the backend), so this adds no secret.

state  reading      the reader decoded at least one frame in the minute
                    (a smeared picture is still "reading"; corrupt_frames says
                    how much of it the gate threw away)
       not_reading  nothing decoded; reason:
reason provider_lockout  the provider answered 401 / 403
       network           we could not get bytes from the host: refused,
                         TCP timeout, unreachable, DNS, reset
       camera_down       the host answered but had no usable video for this
                         camera (404, invalid data, stream ended, no
                         decodable frame, read timeout after connect)
       unknown           no error recorded since the last frame (a stall)
A camera turned off in the console sends nothing: the AI side reads that
absence as not_assigned.

Network vs camera_down is decided per error class, then corrected per host:
if THIS process decoded frames from another camera on the same host in the
same minute, the host was reachable, so a "network" error on one camera is
re-labelled camera_down. (Only within one process; three processes each see
about a third of the cameras on a host.)

Raw error text never leaves this file: stream URLs carry credentials, so the
`detail` sent is a fixed phrase from _RULES.
"""

from __future__ import annotations

import datetime as dt
import os
import re
import threading
import time
from collections import deque
from typing import Callable
from urllib.parse import urlsplit

AI_URL = os.getenv("ANPR_AI_URL", "http://trinetra-ai:8001").rstrip("/")
EVERY = float(os.getenv("ANPR_ANALYSIS_EVERY", "60"))
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")
ENABLED = os.getenv("ANPR_ANALYSIS_HEARTBEAT", "1") == "1" and bool(SERVICE_TOKEN)
PENDING_MAX = int(os.getenv("ANPR_ANALYSIS_PENDING_MAX", "3000"))  # rows kept while the AI is unreachable

# (pattern, reason, detail) — first match wins. "401" must not match
# "after 401 frames" in a reason string, hence the look-ahead.
_RULES: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"\b401\b(?!\s*frames)|unauthori[sz]ed"), "provider_lockout", "401 from provider"),
    (re.compile(r"\b403\b(?!\s*frames)|forbidden"), "provider_lockout", "403 from provider"),
    (re.compile(r"connection refused|errno 111\b"), "network", "connection refused"),
    (re.compile(r"no route to host|network is unreachable|host is down|errno 11[13]\b|errno 101\b"), "network", "host unreachable"),
    (re.compile(r"name or service not known|name resolution|nodename nor servname|errno -[23]\b"), "network", "name lookup failed"),
    (re.compile(r"connection reset|broken pipe|errno 104\b|errno 32\b"), "network", "connection reset"),
    # ExitError "Immediate exit requested" = our own read-timeout callback fired
    # after the connection was made: the host answered, the camera sent nothing.
    (re.compile(r"immediate exit requested"), "camera_down", "no data after connect"),
    (re.compile(r"timed out|errno 110\b|timeouterror"), "network", "connection timed out"),
    (re.compile(r"\b404\b(?!\s*frames)|not found"), "camera_down", "stream not found"),
    (re.compile(r"no decodable frame"), "camera_down", "no decodable frame"),
    (re.compile(r"invalid data"), "camera_down", "no usable video from server"),
    (re.compile(r"stream ended"), "camera_down", "stream ended"),
]


def classify(reason: str | None) -> tuple[str, str | None]:
    """Reader error text → (reason word, fixed detail phrase)."""
    r = (reason or "").lower()
    if not r or r == "first connection":
        return "unknown", None
    for pat, word, detail in _RULES:
        if pat.search(r):
            return word, detail
    return "camera_down", "reader error"


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat()


def _host(url: str | None) -> str | None:
    try:
        return urlsplit(url or "").hostname
    except ValueError:
        return None


class _Prev:
    __slots__ = ("t", "decoded", "analysed", "corrupt", "src_id", "pf", "ps")

    def __init__(self, t: float, decoded: int, analysed: int, corrupt: int, src_id: int, pf: int = 0, ps: int = 0):
        self.t, self.decoded, self.analysed, self.corrupt, self.src_id = t, decoded, analysed, corrupt, src_id
        self.pf, self.ps = pf, ps  # people: cumulative frames counted, cumulative sum


def _take_people_max(w) -> int:
    """The camera thread's max-since-last-sample, reset to 0 (a race with the
    frame loop can only lose one frame's max into the next interval)."""
    m = int(getattr(w, "people_max", 0) or 0)
    if hasattr(w, "people_max"):
        w.people_max = 0
    return m


def sample_rows(workers: list, prev: dict, now: float, started: float) -> list[dict]:
    """One row per camera for the interval since its previous sample. Pure
    apart from reading worker/source attributes; `prev` is updated."""
    rows: list[dict] = []
    for w in list(workers):
        stop = getattr(w, "_stop_requested", None)
        if stop is not None and stop.is_set():
            prev.pop(w.cam["monitorId"], None)
            continue  # turned off in the console: absence = not_assigned
        code = w.cam["monitorId"]
        src = getattr(w, "src", None)
        decoded = int(getattr(src, "frames_decoded", 0) or 0) if src is not None else 0
        stats = getattr(w, "stats", {}) or {}
        analysed = int(stats.get("frames", 0) or 0)
        corrupt = int(stats.get("corrupt_frames", 0) or 0)
        pf = int(getattr(w, "people_frames", 0) or 0)
        ps = int(getattr(w, "people_sum", 0) or 0)
        p = prev.get(code)
        if p is None or p.src_id != id(src):
            # first sample for this camera (or a new source object): count from
            # zero, starting when the heartbeat (or the worker) started
            p = _Prev(max(started, now - EVERY), 0, 0, 0, id(src))
        d_dec = max(0, decoded - p.decoded)
        d_ana = max(0, analysed - p.analysed)
        d_cor = max(0, corrupt - p.corrupt)
        row = {
            "camera_code": code,
            "from_ts": _iso(p.t),
            "to_ts": _iso(now),
            "frames": d_dec,
            "analysed_frames": d_ana,
            "corrupt_frames": d_cor,
            # people visible (count, not identity): frames counted, sum and max of
            # the per-frame counts in this interval
            "people_frames": max(0, pf - p.pf),
            "people_sum": max(0, ps - p.ps),
            "people_max": _take_people_max(w),
            "_host": _host(getattr(w, "url", None)),
        }
        if d_dec > 0:
            row["state"] = "reading"
        else:
            row["state"] = "not_reading"
            last_reason = getattr(src, "last_reason", None) if src is not None else None
            reason_at = float(getattr(src, "last_reason_at", 0.0) or 0.0) if src is not None else 0.0
            frame_at = float(getattr(src, "last_frame_wall", 0.0) or 0.0) if src is not None else 0.0
            if src is None or not w.is_alive() or (reason_at and reason_at >= frame_at):
                word, detail = classify(last_reason)
                if word == "unknown" and (src is None or not w.is_alive()):
                    word, detail = "camera_down", "reader stopped"
            else:
                word, detail = "unknown", None  # stalled, no error yet
            row["reason"], row["detail"] = word, detail
        prev[code] = _Prev(now, decoded, analysed, corrupt, id(src), pf, ps)
        rows.append(row)
    # host corrections (same process, same minute):
    #  - another camera on the host decoded → the host was reachable, so a
    #    "network" error here is this camera, not the network;
    #  - another camera on the host got a 401/403 → an "invalid data" answer
    #    on open is the same lockout. Measured 4 Oct 2026 over the worker log
    #    (2-4 Oct, "no frame for 60 s" lines): InvalidData only ever inside a 401 window,
    #    none outside one (bucketed by 10 min).
    live_hosts = {r["_host"] for r in rows if r["state"] == "reading" and r["_host"]}
    locked_hosts = {r["_host"] for r in rows if r.get("reason") == "provider_lockout" and r["_host"]}
    for r in rows:
        if r.get("reason") == "network" and r["_host"] in live_hosts:
            r["reason"], r["detail"] = "camera_down", (r.get("detail") or "") + " (host reachable)"
        elif r.get("detail") == "no usable video from server" and r["_host"] in locked_hosts:
            r["reason"], r["detail"] = "provider_lockout", "invalid data during provider 401s"
        r.pop("_host", None)
    return rows


def start(get_workers: Callable[[], list], tag: str = "", log: Callable[..., None] = print):
    """One daemon thread per process. get_workers() returns the CURRENT
    camera threads (the refresh loop rebinds its list)."""
    if not ENABLED:
        log(f"{tag}analysis heartbeat: off (ANPR_ANALYSIS_HEARTBEAT=0 or no SERVICE_TOKEN)")
        return None
    import requests

    url = AI_URL + "/forensic/analysis/heartbeat"
    started = time.time()
    prev: dict[str, _Prev] = {}
    pending: deque = deque(maxlen=PENDING_MAX)
    state = {"fail": 0, "ok": 0}

    def tick():
        now = time.time()
        pending.extend(sample_rows(get_workers(), prev, now, started))
        if not pending:
            return
        batch = list(pending)
        try:
            r = requests.post(
                url,
                json={"worker": tag.strip(" []") or "p0", "rows": batch},
                headers={"X-Service-Token": SERVICE_TOKEN},
                timeout=10,
            )
            ok = r.status_code == 200
            why = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001 — never raise into the worker
            ok, why = False, e.__class__.__name__
        if ok:
            pending.clear()
            if state["fail"]:
                log(f"{tag}analysis heartbeat: delivering again after {state['fail']} failure(s)")
            state["fail"] = 0
            state["ok"] += 1
            if state["ok"] == 1:
                log(f"{tag}analysis heartbeat: {len(batch)} camera row(s) → {url}")
        else:
            state["fail"] += 1
            if state["fail"] == 1 or state["fail"] % 10 == 0:
                log(f"{tag}analysis heartbeat: post failed ({state['fail']}×, {why}); {len(pending)} row(s) kept")

    def loop():
        next_t = time.time() + EVERY
        while True:
            time.sleep(1.0)
            if time.time() < next_t:
                continue
            next_t += EVERY
            try:
                tick()
            except Exception as e:  # noqa: BLE001
                log(f"{tag}analysis heartbeat: {e.__class__.__name__}: {e}")

    t = threading.Thread(target=loop, daemon=True, name="analysis-heartbeat")
    t.start()
    log(f"{tag}analysis heartbeat: every {EVERY:g}s → {url}")
    return t
