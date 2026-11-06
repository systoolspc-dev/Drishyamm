"""
rehearsal.py — run the judge tasks against the LIVE stack and print the answers
the way a judge should read them (docs/JUDGE_TASKS.md is the playbook).

    Camera GNR-GATE-01 · 12:15 PM IST · Vehicle detected: GJ01AB1234 · Location: Gandhinagar Sec-18 Gate · 91%

For every plate (args; default: GJ01AB1234 + GJ18CD7788 from the test data and
the newest REAL plate from /sightings) it prints
    T1  one line per sighting                      (/api/ai/anpr/route/<plate>)
    T2  the Vehicle Movement History block         (/api/ai/anpr/report/<plate> when it answers 200,
                                                    else self-formatted from /route?format=geojson — it says which)
    T4  the watchlist status                       (/api/ai/anpr/watchlist)
    T3  last seen + where next (forward cone)      (route.next)
    T7/T8 flags: possible reads, near matches, fast / impossible legs, cloned-plate suspect
    T12 registration and lists, camera side only    (POST /api/ai/anpr/vehicle {plate}: record null,
                                                    registry "ask", a hot-list block or hotlist_state;
                                                    VAHAN itself is asked only through the purpose bar)
then the watchlist round-trip (POST a throw-away entry → GET → DELETE) and the
alert drill (POST one is_test sighting of the watchlisted GJ01AB1234 → read the
resulting 'ALERT — STOLEN VEHICLE DETECTED' back from /api/ai/events).

Every answer is a LEAD for an officer, never a verdict — the lines say so.

Run inside the trainer container (never the worker):
    docker exec -w /srv/anpr trinetra-anpr-trainer python rehearsal.py
    docker exec -w /srv/anpr trinetra-anpr-trainer python rehearsal.py GJ21CB5525 GJ01AB1234
    docker exec -w /srv/anpr trinetra-anpr-trainer python rehearsal.py --no-alert     # read-only pass
    docker exec -w /srv/anpr trinetra-anpr-trainer python rehearsal.py --reset        # + demo rows back to the seed at the end
    docker exec -w /srv/anpr trinetra-anpr-trainer python rehearsal.py --reset-labs   # … and drop drill / lab test rows > 1 h old
Env: ANPR_BACKEND_URL (default http://trinetra-backend:5000), ANPR_EMAIL, ANPR_PASSWORD.
Transcript: data/reports/rehearsal_<YYYYmmdd_HHMM>.txt. Exit 1 if any task FAILS.

The alert drill posts at GNR-GATE-01 (the first demo-route camera) and expects
the alert there — the six demo cameras exist in the backend once
`scripts/add-demo-cameras.js` has been run, so the forwarder delivers it. Only
if nothing arrives does it retry at corp8_21, a live feed the backend always
owns, and says why.

What it leaves behind: the throw-away watch entry is deactivated again; the
alert-drill sighting is an `is_test` row (hidden from the default console view)
and its alert row stays in the Alerts list until an officer marks it reviewed.
With --reset the drill row (and any other drift on the demo plates) is removed
again at the end through POST /api/ai/anpr/demo/reset, which re-applies the
seed so GJ01AB1234 is exactly the 6-stop route — is_test rows only, real reads
are never touched.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time
from typing import Any

import re

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30), "IST")
LEAD = "A lead, not a verdict — an officer confirms against the evidence."
TEST_PLATES = {"GJ01AB1234", "GJ18CD7788", "GJ05CD5678"}
ROUNDTRIP_PLATE = "GJ98RH0001"  # never a real vehicle in our data
ROUNDTRIP_REASON = "rehearsal — delete me"
ALERT_PLATE = "GJ01AB1234"  # watchlisted in the seed: 'stolen — FIR 123/2026'
ALERT_CAMERA = ("GNR-GATE-01", "Gandhinagar Sec-18 Gate", 23.2245, 72.652)  # first stop of the demo route
FALLBACK_CAMERA = (
    "corp8_21",
    "Patan - Dethali Char Rasta",
    23.85,
    72.126,
)  # a live feed the backend always owns


# ── plain-text helpers ─────────────────────────────────────────────────────


def parse_ts(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def clock(ts: Any) -> str:
    """'10:42 AM' in IST."""
    t = ts if isinstance(ts, dt.datetime) else parse_ts(ts)
    if t is None:
        return "??:??"
    return t.astimezone(IST).strftime("%I:%M %p").lstrip("0")


def stamp(ts: Any) -> str:
    """'27 Aug 2026, 12:15 PM IST'."""
    t = ts if isinstance(ts, dt.datetime) else parse_ts(ts)
    if t is None:
        return "unknown time"
    return t.astimezone(IST).strftime("%d %b %Y, ") + clock(t) + " IST"


def pct(c: Any) -> str:
    try:
        return f"{round(float(c) * 100)}%"
    except (TypeError, ValueError):
        return "—"


def dur(seconds: Any) -> str:
    try:
        s = int(float(seconds))
    except (TypeError, ValueError):
        return "—"
    h, m = divmod(s // 60, 60)
    return f"{h} h {m:02d} min" if h else f"{m} min"


def alert_title(reason: str | None, explicit: str | None = None) -> str:
    """Same rule as the console (Alerts page + toast): backend title if present,
    else derived from the watch reason."""
    if explicit:
        return str(explicit)
    full = (reason or "").lower()
    if full.startswith("registry mismatch"):
        return "ALERT — REGISTRY MISMATCH"
    # "On the representative <category> list (…)" is demonstration data and
    # never makes the title read as fact (same rule as the backend + console).
    rep = re.search(r"on the representative ([a-z]+) list[^·]*", full)
    r = full.replace(rep.group(0), "") if rep else full
    kind = (
        "STOLEN"
        if "stolen" in r
        else "WANTED"
        if "wanted" in r
        else "SUSPECT"
        if "suspect" in r
        else None
    )
    if kind is None and rep:
        base = f"ALERT — ON A REPRESENTATIVE {rep.group(1).upper()} LIST (NOT GOVERNMENT DATA)"
    else:
        base = f"ALERT — {kind or 'WATCHLISTED'} VEHICLE DETECTED"
    return f"POSSIBLE READ — {base}" if r.startswith("possible read") else base


class Transcript:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.results: list[tuple[str, str, str]] = []  # (task, PASS|FAIL|NOTE, detail)

    def say(self, s: str = "") -> None:
        print(s, flush=True)
        self.lines.append(s)

    def head(self, s: str) -> None:
        self.say("")
        self.say("=" * 78)
        self.say(s)
        self.say("=" * 78)

    def result(self, task: str, ok: bool | None, detail: str = "") -> None:
        status = "PASS" if ok else "FAIL" if ok is False else "NOTE"
        self.results.append((task, status, detail))
        self.say(f"[{status}] {task}{' — ' + detail if detail else ''}")

    @property
    def failed(self) -> bool:
        return any(s == "FAIL" for _, s, _ in self.results)


# ── API ────────────────────────────────────────────────────────────────────


class Api:
    def __init__(self, base: str, email: str, password: str) -> None:
        self.base = base.rstrip("/")
        self.email, self.password = email, password
        self.token: str | None = None
        self.s = requests.Session()

    def login(self) -> None:
        r = self.s.post(
            f"{self.base}/api/auth/login", json={"email": self.email, "password": self.password}, timeout=20
        )
        r.raise_for_status()
        j = r.json()
        self.token = j.get("token") or (j.get("data") or {}).get("token") or j.get("accessToken")
        if not self.token:
            raise RuntimeError(f"login answered without a token: {str(j)[:200]}")
        self.s.headers["Authorization"] = f"Bearer {self.token}"

    def get(self, path: str, **params: Any) -> requests.Response:
        return self.s.get(f"{self.base}{path}", params=params or None, timeout=60)

    def post(self, path: str, body: dict[str, Any] | None = None, **params: Any) -> requests.Response:
        return self.s.post(f"{self.base}{path}", json=body, params=params or None, timeout=120)

    def delete(self, path: str) -> requests.Response:
        return self.s.delete(f"{self.base}{path}", timeout=30)


def _items(j: Any) -> list[dict[str, Any]]:
    if isinstance(j, list):
        return j
    if isinstance(j, dict):
        for k in ("items", "data", "events"):
            if isinstance(j.get(k), list):
                return j[k]
    return []


# ── per-plate answers ──────────────────────────────────────────────────────


def sighting_line(s: dict[str, Any]) -> str:
    """The one-line answer a judge reads at a glance."""
    plate = s.get("plate") or "?"
    tags = []
    if s.get("tier") == "possible":
        tags.append("POSSIBLE READ — too few frames, verify against the crop")
    if s.get("near_match") or s.get("hamming"):
        rp = s.get("read_plate") or ""
        tags.append(f"near match — camera read {rp}" if rp else "near match (1 char off)")
    if s.get("watch_hit"):
        tags.append("WATCHLIST HIT")
    if s.get("is_test"):
        tags.append("test data")
    line = (
        f"Camera {s.get('camera_code') or '?'} · {clock(s.get('ts'))} IST · "
        f"Vehicle detected: {plate} · Location: {s.get('camera_name') or s.get('camera_code') or '?'} · "
        f"{pct(s.get('confidence'))}"
    )
    return line + (f"   [{'; '.join(tags)}]" if tags else "")


def fetch_route(api: Api, plate: str, include_test: bool) -> dict[str, Any]:
    r = api.get(
        f"/api/ai/anpr/route/{plate}", format="geojson", include_test=1 if include_test else 0, limit=500
    )
    r.raise_for_status()
    return r.json()


def format_history(
    plate: str, route: dict[str, Any], watch: dict[str, Any] | None, generated: dt.datetime
) -> str:
    """Self-formatted Vehicle Movement History (used when /report is not live).
    Same wording the judges see on the console."""
    stops = route.get("stops") or []
    legs = [
        f.get("properties") or {}
        for f in (route.get("features") or [])
        if (f.get("properties") or {}).get("kind") == "leg"
    ]
    leg_after = {lg.get("from_seq"): lg for lg in legs}
    summ = route.get("summary") or {}
    out = [
        f"VEHICLE MOVEMENT HISTORY — {plate}",
        f"Generated {stamp(generated)} · {len(stops)} sighting(s) on {summ.get('cameras', '?')} camera(s)",
    ]
    if stops:
        out[-1] += f" · {stamp(stops[0].get('ts'))} → {clock(stops[-1].get('ts'))} IST"
    if watch:
        out.append(
            f"Watchlist: YES — {watch.get('reason') or 'watchlisted'} ({watch.get('severity') or 'critical'})"
        )
    else:
        out.append("Watchlist: not listed")
    out.append("")
    if not stops:
        out.append(f"No sighting of {plate} on any camera in the window. Say so — do not guess.")
    for i, s in enumerate(stops, 1):
        out.append(
            f"{i:2d}. {clock(s.get('ts'))} IST · Camera {s.get('camera_code')} · "
            f"{s.get('camera_name') or ''} · {pct(s.get('confidence'))}"
            + ("  · WATCHLIST HIT" if s.get("watch_hit") else "")
            + ("  · possible read" if s.get("tier") == "possible" else "")
            + (f"  · near match (read {s.get('read_plate')})" if s.get("read_plate") else "")
        )
        lg = leg_after.get(i)
        if lg:
            flag = lg.get("flag") or "ok"
            out.append(
                f"      ↓ {lg.get('road_km', '?')} km by road · {dur(lg.get('dt_s'))} · "
                f"{lg.get('implied_kmh', '?')} km/h · {flag.upper() if flag in ('fast', 'impossible') else flag}"
                + (f" — {lg.get('reason')}" if lg.get("reason") and flag != "ok" else "")
            )
    out.append("")
    if stops:
        out.append(
            f"Summary: {summ.get('road_km', 0)} km by road in {dur(summ.get('duration_s'))}"
            + (f" · avg {summ.get('avg_kmh')} km/h" if summ.get("avg_kmh") else "")
            + f" · {summ.get('n_fast', 0)} fast leg(s) · {summ.get('n_impossible', 0)} impossible leg(s)"
            + f" · cloned-plate suspect: {'YES' if summ.get('cloned_suspect') else 'no'}"
        )
        if summ.get("cloned_suspect") and summ.get("note"):
            out.append(f"!! {summ['note']}")
        last = stops[-1]
        out.append(
            f"Last seen: {clock(last.get('ts'))} IST · {last.get('camera_name')} ({last.get('camera_code')})"
        )
        nxt = route.get("next") or {}
        cands = (nxt.get("candidates") or [])[:3]
        if cands:
            out.append(
                "Where next (forward cone): "
                + " · ".join(
                    f"{c.get('camera_name')} {c.get('road_km')} km, ETA {clock(c.get('eta_from'))}–{clock(c.get('eta_to'))}, "
                    f"p={c.get('p')} ({c.get('basis')})"
                    for c in cands
                )
            )
    out.append(LEAD)
    return "\n".join(out)


def movement_history(
    api: Api, plate: str, route: dict[str, Any], watch: dict[str, Any] | None, include_test: bool
) -> tuple[str, str]:
    """(text, source). Prefers the backend report endpoint when it is live."""
    try:
        r = api.get(f"/api/ai/anpr/report/{plate}", format="text", include_test=1 if include_test else 0)
        if r.status_code == 200 and r.text.strip():
            return r.text.strip(), "GET /api/ai/anpr/report/<plate>?format=text"
        src_note = f"report endpoint answered {r.status_code}"
    except requests.RequestException as e:
        src_note = f"report endpoint unreachable ({e.__class__.__name__})"
    return (
        format_history(plate, route, watch, dt.datetime.now(dt.timezone.utc)),
        f"self-formatted from /route?format=geojson ({src_note} — not live yet)",
    )


REGISTRY_ASK = (
    "Registry: not fetched here. VAHAN is asked only through the purpose bar (Ask VAHAN) — for a case or an "
    "alert, with a reason, on the audit chain — and owner fields come back masked."
)


def camera_side_check(status: int, j: Any) -> tuple[bool, list[str], str]:
    """T12, read from the CAMERA side of a plate (POST /api/ai/anpr/vehicle {plate}).

    What Trinetra may say about a plate WITHOUT asking a government database:
    whether it is on a hot list held here (synced by the gateway, matched
    locally). The contract (docs/govt/API.md §3, §7.4): `record` is null,
    `registry` is "ask", and there is either a `hotlist` block or a
    `hotlist_state` that says in words why there is none — an empty answer is
    never read as "clean". A registry record here would be a FAIL: it would
    mean a government call with no purpose, case or reason.

    Returns (ok, lines to print, detail for the result line)."""
    if status != 200 or not isinstance(j, dict):
        return False, [f"Camera side: not available ({status})"], f"HTTP {status}"
    problems = []
    if j.get("record") is not None:
        problems.append("a registry record came back (it must be null: no government call off the purpose bar)")
    if j.get("registry") != "ask":
        problems.append(f"registry is {j.get('registry')!r}, not 'ask'")
    hot, state = j.get("hotlist"), j.get("hotlist_state")
    lines = []
    if isinstance(hot, dict) and isinstance(hot.get("onList"), bool):
        lines.append(f"Hot lists: {hot.get('words') or ('ON A LIST' if hot['onList'] else 'not on a list held here')}")
    elif isinstance(state, dict) and state.get("state"):
        words = state.get("words")
        words = " ".join(words) if isinstance(words, list) else (words or state["state"])
        lines.append(f"Hot lists: {words} — not a clean result.")
    else:
        problems.append("neither a hotlist block nor a hotlist_state")
    lines.append(REGISTRY_ASK)
    for p in problems:
        lines.append(f"PROBLEM: {p}")
    detail = "; ".join(problems) if problems else (
        "record null, registry 'ask', " + ("hotlist block" if isinstance(hot, dict) else f"hotlist_state {state.get('state')}")
    )
    return not problems, lines, detail


def camera_side(api: Api, plate: str) -> tuple[bool, list[str], str]:
    try:
        r = api.post("/api/ai/anpr/vehicle", {"plate": plate})  # the plate in the body, never in the URL
        try:
            j = r.json()
        except ValueError:
            j = None
        return camera_side_check(r.status_code, j)
    except requests.RequestException as e:
        return False, [f"Camera side: unreachable ({e.__class__.__name__})"], "unreachable"


def run_plate(
    api: Api,
    tr: Transcript,
    plate: str,
    watch_by_plate: dict[str, dict[str, Any]],
    expect_sightings: bool,
    real_only: bool,
) -> None:
    tr.head(f"Vehicle Number: {plate} — find it")
    include_test = False
    try:
        route = fetch_route(api, plate, include_test=False)
        if not route.get("stops") and not real_only:
            route = fetch_route(api, plate, include_test=True)
            include_test = bool(route.get("stops"))
    except requests.RequestException as e:
        tr.result(f"T1 find {plate}", False, f"route call failed: {e}")
        return
    stops = route.get("stops") or []
    if include_test:
        tr.say(
            "(no real sighting — answering from TEST DATA; the console needs the 'Test data' button for this)"
        )

    # T1 — one line per sighting (chronological)
    tr.say("")
    tr.say("T1  Where was it seen?")
    if not stops:
        tr.say(f"    No sighting of {plate} on any camera in the window. Say so — do not guess.")
    for s in stops[:12]:
        tr.say("    " + sighting_line(s))
    if len(stops) > 12:
        tr.say(f"    … and {len(stops) - 12} more (see the movement history)")
    tr.result(
        f"T1 find {plate}",
        (len(stops) > 0) if expect_sightings else None,
        f"{len(stops)} sighting(s)" + (" [test data]" if include_test else ""),
    )

    # T4 — watchlist status
    tr.say("")
    tr.say("T4  Watchlist")
    w = watch_by_plate.get(plate)
    if w:
        tr.say(
            f"    {plate} is WATCHLISTED — {w.get('reason') or 'no reason given'} · severity {w.get('severity')}"
            f" · added {stamp(w.get('created_at'))} by {w.get('created_by') or '?'}"
            + (" · test entry" if w.get("is_test") else "")
        )
        tr.say(f"    Alert title on a hit: {alert_title(w.get('reason'))}")
    else:
        tr.say(f"    {plate} is not on the watchlist.")
    tr.result(f"T4 watchlist status {plate}", True, "watchlisted" if w else "not listed")

    # T2 — movement history
    tr.say("")
    tr.say("T2  Vehicle Movement History")
    text, source = movement_history(api, plate, route, w, include_test)
    tr.say(f"    (source: {source})")
    for ln in text.splitlines():
        tr.say("    " + ln)
    tr.result(f"T2 movement history {plate}", True, source.split(" (")[0])

    # T3 — last seen + where next
    tr.say("")
    tr.say("T3  Last seen + where next")
    if stops:
        last = stops[-1]
        tr.say(
            f"    Last seen {stamp(last.get('ts'))} at {last.get('camera_name')} (Camera {last.get('camera_code')}) · {pct(last.get('confidence'))}"
        )
        nxt = route.get("next") or {}
        cands = nxt.get("candidates") or []
        if cands:
            for c in cands[:5]:
                tr.say(
                    f"    → {c.get('camera_name')} ({c.get('camera_code')}) · {c.get('road_km')} km by road · "
                    f"ETA {clock(c.get('eta_from'))}–{clock(c.get('eta_to'))} IST · p={c.get('p')} · {c.get('basis')}"
                    + (f" n={c.get('n')}" if c.get("n") else "")
                )
            tr.say(
                "    Pursuit mode raises those cameras' read rate for 15 min — a hit there is a lead, an officer decides."
            )
        else:
            tr.say("    No forward cone (camera has no position or no neighbours).")
        tr.result(f"T3 where next {plate}", True, f"{len(cands)} candidate camera(s)")
    else:
        tr.result(f"T3 where next {plate}", None, "no sightings")

    # T7 / T8 — flags
    tr.say("")
    tr.say("T7/T8  Flags")
    summ = route.get("summary") or {}
    n_possible = sum(1 for s in stops if s.get("tier") == "possible")
    n_near = sum(1 for s in stops if s.get("read_plate") or s.get("near_match"))
    flags = []
    if n_possible:
        flags.append(f"{n_possible} possible read(s) — too few frames; verify against the crop")
    if n_near:
        flags.append(f"{n_near} near match(es) — a camera read 1 char off; compare crops")
    if summ.get("n_fast"):
        flags.append(f"{summ['n_fast']} fast leg(s) > 120 km/h — worth a look")
    if summ.get("n_impossible"):
        flags.append(f"{summ['n_impossible']} impossible leg(s) > 150 km/h")
    if summ.get("cloned_suspect"):
        flags.append("CLONED-PLATE SUSPECT — two places at once; misread or cloned plate")
    if route.get("fuzzy_plates"):
        flags.append(f"fuzzy neighbours: {', '.join(route['fuzzy_plates'])}")
    tr.say(
        "    " + ("; ".join(flags) if flags else "none — every leg plausible by road, every read confirmed")
    )
    if summ.get("note"):
        tr.say(f"    {summ['note']}")
    tr.result(f"T7/T8 flags {plate}", True, "; ".join(flags) if flags else "none")

    # T12 — registration and lists: the camera side only. The registry is a
    # purpose-bar ask (a case or an alert + a reason), never a side effect of
    # looking at a plate; this checks that no record comes back here.
    tr.say("")
    tr.say("T12 Registration and lists (camera side — no government database asked; owner masked when asked)")
    ok12, lines12, detail12 = camera_side(api, plate)
    for line in lines12:
        tr.say("    " + line)
    tr.result(f"T12 camera side {plate}", ok12, detail12)


# ── watchlist round-trip ───────────────────────────────────────────────────


def watchlist_roundtrip(api: Api, tr: Transcript) -> None:
    tr.head(
        f"T4  Watchlist round-trip — add {ROUNDTRIP_PLATE} ('{ROUNDTRIP_REASON}'), read it back, remove it"
    )
    ok = True
    try:
        r = api.post(
            "/api/ai/anpr/watchlist",
            {
                "plate": ROUNDTRIP_PLATE,
                "reason": ROUNDTRIP_REASON,
                "severity": "critical",
                "created_by": "rehearsal.py",
                "test": True,
            },
        )
        tr.say(f"    POST /api/ai/anpr/watchlist → {r.status_code} {r.text[:120]}")
        ok &= r.status_code == 200
        r = api.get("/api/ai/anpr/watchlist", include_test=1)
        rows = [w for w in _items(r.json()) if w.get("plate") == ROUNDTRIP_PLATE]
        tr.say(
            f"    GET  /api/ai/anpr/watchlist?include_test=1 → {r.status_code}, entry present: {bool(rows)}"
            + (
                f" — {rows[0].get('reason')} · {rows[0].get('severity')} · by {rows[0].get('created_by')}"
                if rows
                else ""
            )
        )
        ok &= bool(rows)
        if rows:
            tr.say(
                f"    Status line: {ROUNDTRIP_PLATE} is WATCHLISTED — {rows[0].get('reason')} · a sighting now raises "
                f"'{alert_title(rows[0].get('reason'))}'"
            )
    finally:
        r = api.delete(f"/api/ai/anpr/watchlist/{ROUNDTRIP_PLATE}")
        tr.say(f"    DELETE /api/ai/anpr/watchlist/{ROUNDTRIP_PLATE} → {r.status_code} {r.text[:80]}")
        ok &= r.status_code == 200
        r = api.get("/api/ai/anpr/watchlist", include_test=1)
        gone = not any(w.get("plate") == ROUNDTRIP_PLATE for w in _items(r.json()))
        tr.say(f"    GET again → entry gone: {gone} (deactivated, audit trail kept)")
        ok &= gone
    tr.result("T4 watchlist add/read/remove", ok)


# ── alert drill ────────────────────────────────────────────────────────────


def _alert_rows(api: Api, plate: str, camera_code: str) -> list[dict[str, Any]]:
    """Newest vehicle alerts for THIS plate at THIS camera (the top of the list
    a judge sees, then the type-filtered list), newest first, de-duplicated."""
    out: list[dict[str, Any]] = []
    ids: set[str] = set()
    for params in ({"limit": 10}, {"limit": 10, "eventType": "vehicle.alert"}):
        try:
            r = api.get("/api/ai/events", **params)
            if r.status_code != 200:
                continue
        except requests.RequestException:
            continue
        for e in _items(r.json()):
            p = e.get("payload") or {}
            if e.get("eventType") != "vehicle.alert" and p.get("kind") != "anpr":
                continue
            if (p.get("plate") or p.get("matchedName")) != plate:
                continue
            if (e.get("monitorId") or p.get("camera_code")) != camera_code:
                continue
            if e.get("id") in ids:
                continue
            ids.add(e.get("id"))
            out.append(e)
    return out


def _alert_when(e: dict[str, Any]) -> dt.datetime | None:
    """When the row last fired: the fold timestamp the backend writes when it
    folds a repeat into an open row (payload.lastSeenTs), else its own ts."""
    p = e.get("payload") or {}
    return parse_ts(p.get("lastSeenTs")) or parse_ts(e.get("ts") or e.get("createdAt"))


def _find_alert(
    api: Api, plate: str, camera_code: str, since: dt.datetime, seen_ids: set[str]
) -> dict[str, Any] | None:
    """The alert THIS drill raised: a row for the plate AT THE POSTED CAMERA
    that is new since the post, or an open row the backend folded the post
    into (payload.lastSeenTs / count move). A row for another camera, or an
    older row for this one, is never accepted — that would pass the drill on
    somebody else's alert."""
    floor = since - dt.timedelta(seconds=5)
    for e in _alert_rows(api, plate, camera_code):
        p = e.get("payload") or {}
        created = parse_ts(e.get("ts") or e.get("createdAt"))
        folded = parse_ts(p.get("lastSeenTs"))
        if e.get("id") not in seen_ids and created is not None and created >= floor:
            e["_fresh"] = True
            return e
        if folded is not None and folded >= floor:
            e["_fresh"] = False
            return e
    return None


def _say_alert(tr: Transcript, evt: dict[str, Any], j: dict[str, Any]) -> str:
    """Print the alert the way the console shows it; returns the title."""
    p = evt.get("payload") or {}
    title = alert_title(p.get("reason"), evt.get("title") or p.get("title"))
    cone = p.get("forward_cone") or []
    tr.say(
        f"    TITLE : {title}"
        + ("  (backend title)" if (evt.get("title") or p.get("title")) else "  (derived from the reason)")
    )
    tr.say(
        f"    BODY  : Camera {evt.get('monitorId')} · {clock(evt.get('ts'))} IST · Vehicle detected: {p.get('plate')} · "
        f"Location: {p.get('camera_name') or evt.get('monitorId')} · {pct(evt.get('confidence'))}"
    )
    tr.say(
        f"            Reason: {p.get('reason')} · severity {evt.get('severity')} (AI: {p.get('severity_ai')}) · tier {p.get('tier')}"
    )
    if cone:
        tr.say(
            "            Where next: "
            + " · ".join(
                f"{c.get('camera_name')} ({c.get('road_km')} km, ETA {clock(c.get('eta_from'))}–{clock(c.get('eta_to'))})"
                for c in cone[:3]
            )
        )
    tr.say(
        f"            Evidence: snapshot {'yes' if (evt.get('snapshot_uri') or p.get('snapshotUri')) else 'none (drill posted no image)'} · map {p.get('map_link')}"
    )
    tr.say(f"            {LEAD}")
    tr.say(
        "    Where it shows: Alerts page card + detail, toast + bell (console), push/email to alert recipients."
    )
    tr.say(
        f"    Left behind: sighting {j.get('sighting_id')} is an is_test row (hidden by default; --reset removes it"
        f" through /api/ai/anpr/demo/reset); the alert row {evt.get('id')} stays until an officer marks it reviewed."
    )
    return title


def alert_drill(
    api: Api,
    tr: Transcript,
    camera: tuple[str, str, float, float],
    fallback: tuple[str, str, float | None, float | None] | None,
) -> None:
    tr.head(f"T5  ALERT — post one is_test sighting of watchlisted {ALERT_PLATE} and read the alert back")
    tried: list[str] = []
    for cam in [camera] + ([fallback] if fallback else []):
        code, name, lat, lng = cam
        tried.append(code)
        # rows for THIS plate at THIS camera before the post: only a row that
        # is new (or folded) after it counts as this drill's alert
        seen = {e.get("id") for e in _alert_rows(api, ALERT_PLATE, code)}
        now = dt.datetime.now(dt.timezone.utc)
        body = {
            "plate": ALERT_PLATE,
            "camera_code": code,
            "camera_name": name,
            "ts": now.isoformat(),
            "confidence": 0.93,
            "test": True,
            "vehicle_type": "car",
            "meta": {
                "frames": 5,
                "agreement": 0.96,
                "tier": "confirmed",
                "readers_agree": 0.95,
                "source": "rehearsal.py",
                "drill": True,
                "note": "drill — is_test row",
            },
        }
        if lat is not None and lng is not None:
            body["latitude"], body["longitude"] = lat, lng
        try:
            r = api.post("/api/ai/anpr/sighting", body)
        except requests.RequestException as e:
            tr.result("T5 alert drill", False, f"sighting POST failed: {e}")
            return
        tr.say(f"    POST /api/ai/anpr/sighting ({ALERT_PLATE} @ {code}, test=true) → {r.status_code}")
        if r.status_code != 200:
            tr.result("T5 alert drill", False, f"AI refused the test sighting: {r.text[:200]}")
            return
        j = r.json()
        tr.say(
            f"    AI: watch_hit={j.get('watch_hit')} · reason={j.get('watch_reason')!r} · tier={j.get('tier')} · sighting_id={j.get('sighting_id')}"
        )
        if not j.get("watch_hit"):
            tr.result(
                "T5 alert drill",
                False,
                f"{ALERT_PLATE} is not watchlisted in this tenant — seed the demo watch entries",
            )
            return
        tr.say(f"    Expected title: {alert_title(j.get('watch_reason'))}")
        evt = None
        waited = 0.0
        for _ in range(12):
            time.sleep(1.0)
            waited += 1.0
            evt = _find_alert(api, ALERT_PLATE, code, now, seen)
            if evt:
                break
        if evt:
            tr.say("")
            tr.say(
                f"    GET /api/ai/events → {'new alert row' if evt.get('_fresh') else 'existing open row updated'} for "
                f"{code} after {waited:.0f} s"
                + (
                    ""
                    if evt.get("_fresh")
                    else " (folded: same plate + camera within the 120 s dedup window)"
                )
            )
            title = _say_alert(tr, evt, j)
            tr.result("T5 alert drill", True, f"alert at {code}: {title}")
            return
        tr.say(f"    No new vehicle alert for {ALERT_PLATE} at {code} on /api/ai/events within 12 s.")
        # an alert for this plate at this camera that fired in the last 3 min:
        # the pipeline de-duplicates the same plate + camera (120 s window), so
        # this drill added nothing — that open row IS the exhibit; say so.
        recent = [
            e
            for e in _alert_rows(api, ALERT_PLATE, code)
            if (w := _alert_when(e)) is not None and (now - w).total_seconds() <= 180
        ]
        if recent:
            tr.say(
                f"    An alert for {ALERT_PLATE} at {code} is already open (raised {clock(_alert_when(recent[0]))} IST) — "
                f"the same plate + camera within 120 s is de-duplicated, so this drill did not add a row. "
                f"That row is the T5 exhibit; rerun after 2 min for a fresh one:"
            )
            title = _say_alert(tr, recent[0], j)
            tr.result(
                "T5 alert drill",
                None,
                f"alert at {code} already open from {clock(_alert_when(recent[0]))} IST ({title}) — "
                f"drill de-duplicated (120 s window); rerun after 2 min for a fresh row",
            )
            return
        if fallback and cam is camera:
            tr.say(
                f"    ({code} is a demo-route camera. The AI→backend forwarder delivers alerts only for cameras the backend "
                f"owns; the six demo cameras exist there once `docker exec trinetra-backend node scripts/add-demo-cameras.js` "
                f"has been run. Either it has not been run on this box or the forwarder is down — retrying at "
                f"{fallback[0]} {fallback[1]}, a live feed the backend always owns.)"
            )
            continue
    tr.result(
        "T5 alert drill",
        False,
        f"no alert row after posting at {', '.join(tried)} — check `docker logs trinetra-ai | grep forwarder` "
        f"(camera map, SERVICE_TOKEN), run scripts/add-demo-cameras.js in the backend for the demo route, "
        f"and remember the backend AI_EVENT_DEDUP_SEC window",
    )


# ── demo reset ─────────────────────────────────────────────────────────────


def demo_reset(api: Api, tr: Transcript, labs: bool) -> None:
    """POST /api/ai/anpr/demo/reset — the demo (is_test) rows back to the seed:
    drift on the demo plates (drill rows, reads at corp8_* cameras, anything
    after the seed day) is deleted, seed_gis_demo.sql is re-applied, and the
    AI asserts that not one real row changed. Audited as anpr_demo_reset."""
    tr.head(
        "Demo reset — POST /api/ai/anpr/demo/reset"
        + ("?labs=1" if labs else "")
        + " (is_test rows only; real reads are never touched)"
    )
    try:
        r = api.post("/api/ai/anpr/demo/reset", None, **({"labs": 1} if labs else {}))
    except requests.RequestException as e:
        tr.result("demo reset", False, f"request failed: {e}")
        return
    if r.status_code != 200:
        tr.result("demo reset", False, f"{r.status_code} {r.text[:200]}")
        return
    j = r.json()
    d = j.get("deleted") or {}
    after = j.get("after") or {}
    exp = j.get("expected") or {}
    tr.say(
        f"    deleted: {d.get('demo_drift', 0)} drifted demo-plate row(s)"
        + (f" · {d.get('labs', 0)} drill / lab row(s) older than 1 h" if labs else "")
        + f" · real rows untouched: {j.get('real_rows_untouched')}"
    )
    tr.say(
        f"    after the seed: GJ01AB1234 {after.get('GJ01AB1234')} stop(s) · GJ18CD7788 {after.get('GJ18CD7788')} stop(s)"
        f" · GJ05CD5678 {after.get('GJ05CD5678')} · audited as anpr_demo_reset"
    )
    ok = bool(exp) and all(after.get(p) == n for p, n in exp.items())
    tr.result(
        "demo reset",
        ok,
        f"GJ01AB1234 route {after.get('GJ01AB1234')} stop(s) (expected {exp.get('GJ01AB1234')})"
        + ("" if ok else f" — after={after}"),
    )


# ── main ───────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "plates", nargs="*", help="plates to answer for (default: GJ01AB1234, GJ18CD7788, newest real plate)"
    )
    ap.add_argument("--backend", default=os.getenv("ANPR_BACKEND_URL", "http://trinetra-backend:5000"))
    ap.add_argument("--email", default=os.getenv("ANPR_EMAIL", "<redacted>"))
    ap.add_argument("--password", default=os.getenv("ANPR_PASSWORD", "<redacted>"))
    ap.add_argument(
        "--alert-camera",
        default=ALERT_CAMERA[0],
        help="camera_code for the alert drill (default GNR-GATE-01, the demo route's first stop; "
        "falls back to corp8_21 only if no alert arrives)",
    )
    ap.add_argument("--no-alert", action="store_true", help="skip the alert drill (posts nothing)")
    ap.add_argument("--no-roundtrip", action="store_true", help="skip the watchlist add/remove round-trip")
    ap.add_argument("--real-only", action="store_true", help="never fall back to test data for a plate")
    ap.add_argument(
        "--reset",
        action="store_true",
        help="at the end, POST /api/ai/anpr/demo/reset: demo (is_test) rows back to the seed — "
        "the drill row goes, GJ01AB1234 is the 6-stop route again; real reads are never touched",
    )
    ap.add_argument(
        "--reset-labs",
        action="store_true",
        help="like --reset, and also drop drill / lab-upload test rows older than 1 h (labelled rows stay)",
    )
    ap.add_argument("--out", default=os.path.join(HERE, "data", "reports"))
    args = ap.parse_args()

    tr = Transcript()
    started = dt.datetime.now(dt.timezone.utc)
    tr.say(f"Trinetra ANPR — judge-task rehearsal · {stamp(started)} · backend {args.backend}")
    tr.say(LEAD)

    api = Api(args.backend, args.email, args.password)
    try:
        api.login()
        tr.result("login", True, args.email)
    except Exception as e:  # noqa: BLE001
        tr.result("login", False, str(e))
        return _finish(tr, args.out, started)

    # watchlist (both real and test entries) — one call, reused per plate
    watch_by_plate: dict[str, dict[str, Any]] = {}
    try:
        r = api.get("/api/ai/anpr/watchlist", include_test=1)
        watch_by_plate = {w.get("plate"): w for w in _items(r.json())}
        tr.result("watchlist read", r.status_code == 200, f"{len(watch_by_plate)} active entries")
    except requests.RequestException as e:
        tr.result("watchlist read", False, str(e))

    # newest real plate + a backend-owned camera for the alert fallback
    newest: dict[str, Any] | None = None
    try:
        r = api.get("/api/ai/anpr/sightings", limit=20)
        real = [s for s in _items(r.json()) if not s.get("is_test")]
        newest = real[0] if real else None
        tr.result(
            "real sightings read",
            r.status_code == 200,
            f"{len(real)} real of {len(_items(r.json()))} newest; newest {newest.get('plate') if newest else '—'} "
            f"@ {newest.get('camera_name') if newest else '—'}",
        )
    except requests.RequestException as e:
        tr.result("real sightings read", False, str(e))

    plates: list[tuple[str, bool]] = []
    if args.plates:
        plates = [(p.upper().replace(" ", "").replace("-", ""), False) for p in args.plates]
    else:
        plates = [("GJ01AB1234", True), ("GJ18CD7788", True)]
        if newest:
            plates.append((newest["plate"], True))
    for plate, expect in plates:
        run_plate(api, tr, plate, watch_by_plate, expect_sightings=expect, real_only=args.real_only)

    if not args.no_roundtrip:
        watchlist_roundtrip(api, tr)

    if not args.no_alert:
        cam = (
            ALERT_CAMERA
            if args.alert_camera == ALERT_CAMERA[0]
            else (args.alert_camera, args.alert_camera, None, None)
        )
        # GNR-GATE-01 first (the demo route's first stop); corp8_21 — a live
        # feed the backend always owns — only if no alert arrives there
        fallback: tuple[str, str, float | None, float | None] | None = None
        if cam[0] != FALLBACK_CAMERA[0]:
            fallback = FALLBACK_CAMERA
            if (
                newest
                and newest.get("camera_code") == FALLBACK_CAMERA[0]
                and newest.get("latitude") is not None
            ):
                fallback = (
                    FALLBACK_CAMERA[0],
                    newest.get("camera_name") or FALLBACK_CAMERA[1],
                    newest.get("latitude"),
                    newest.get("longitude"),
                )
        alert_drill(api, tr, cam, fallback)

    if args.reset or args.reset_labs:
        demo_reset(api, tr, labs=args.reset_labs)

    return _finish(tr, args.out, started)


def _finish(tr: Transcript, out_dir: str, started: dt.datetime) -> int:
    tr.head("Summary")
    for task, status, detail in tr.results:
        tr.say(f"  {status:4s}  {task}{' — ' + detail if detail else ''}")
    n_fail = sum(1 for _, s, _ in tr.results if s == "FAIL")
    tr.say("")
    tr.say(
        f"{'REHEARSAL FAILED' if n_fail else 'REHEARSAL PASSED'} — {n_fail} failure(s), "
        f"{sum(1 for _, s, _ in tr.results if s == 'PASS')} passed, took {round((dt.datetime.now(dt.timezone.utc) - started).total_seconds(), 1)} s"
    )
    try:
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, started.astimezone(IST).strftime("rehearsal_%Y%m%d_%H%M.txt"))
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(tr.lines) + "\n")
        print(f"transcript: {path}")
    except OSError as e:
        print(f"could not write transcript: {e}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
