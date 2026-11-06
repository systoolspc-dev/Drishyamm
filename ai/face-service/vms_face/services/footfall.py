"""Per-camera customer-footfall counter.

This service does two things:

  1. **Frame-by-frame**: when the orchestrator has fresh person (or face)
     boxes for a camera, it calls `registry.update(camera, w, h, boxes)`.
     The per-camera tracker assigns stable IDs via simple Euclidean
     distance matching, detects when each tracked person's anchor point
     crosses the operator's counting line -- a segment a->b at any angle --
     and increments either IN or OUT (which side is IN is up to the
     operator). Optional fall heuristic: bbox width > 1.2 * height triggers
     a fall once per track.

  2. **Periodic flush**: every few seconds a background task UPSERTs the
     in-memory deltas into `footfall_minute_buckets` for the current
     wall-clock minute. Crash-safety = at most ~5 s of counts lost. We
     deliberately don't write per crossing — that'd be hundreds of writes
     per minute on a busy mall camera.

Design choices worth remembering:

- The tracker is process-local. If you scale to multiple orchestrator
  processes per camera (you shouldn't), centroids won't match across them.
- The line is a SEGMENT, not a full-width height: a crossing counts only
  when the step that changed sides passes between a and b (plus half a box
  of slack at each end), so a short line across one doorway ignores people
  walking past its ends, and two doors on one camera don't count each other.
- Side test is the cross product of a->b with the anchor point. A dead band
  of a few percent of the box height either side of the line absorbs
  detector jitter: a point inside the band leaves the committed side alone.
- Each track counts every real crossing (in, then out again, counts both),
  with a short per-track cooldown so a person dithering on the line doesn't
  yo-yo the counter. A flip inside the cooldown is not committed, so if the
  person really stays on the new side it counts once the cooldown ends.
- Direction policy: `right_is_in` / `left_is_in`, relative to a->b as seen
  on screen (y grows down). The pre-angle values `down_is_in` / `up_is_in`
  and `line_y_frac` are still read, and map onto a full-width line, so a
  gate saved before the change counts exactly as it did.
- All of it lives in the camera's config_json, so no DB migration.

For wiring details see api/routes/footfall.py (REST surface),
pipeline/orchestrator.py (where update() is called from), and the
0005_footfall.py migration (table schema).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import math
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable

from sqlalchemy.dialects.postgresql import insert as pg_insert

from vms_face.core.logging import get_logger
from vms_face.domain.models import FootfallMinuteBucket
from vms_face.infra.postgres import session_scope

log = get_logger(__name__)


# ── Config ────────────────────────────────────────────────────────────────

# Centroid-match radius (pixels). Centroids closer than this between
# consecutive frames are considered the same tracked person. 60 px works
# well for 1080p at 8 fps — at 25 fps you could shrink it.
_TRACK_MATCH_RADIUS_PX = 60.0

# How long an unmatched track stays alive before we forget it. Bumps
# resilience to one-frame detector misses (person walks behind another).
_TRACK_TTL_SEC = 2.0

# How often the registry flushes in-memory deltas to Postgres.
_FLUSH_INTERVAL_SEC = 5.0

# Dead band either side of the line: a point closer than this (pixels) has
# not cleared the line yet. Scales with the box so a near, tall person and a
# far, small one get the same tolerance relative to their own jitter.
_BAND_BOX_FRAC = 0.08
_BAND_MIN_PX = 3.0

# A track must have been seen this many frames before a crossing counts --
# the same guard as activity-monitor's LineCrosser (min_frames=3). Kills the
# one-frame ghost a detector spawns on the line.
_MIN_TRACK_FRAMES = 3

# After a track counts, a flip back within this window is not committed yet.
_RECOUNT_COOLDOWN_SEC = 1.0

# Slack past each end of the segment, as a fraction of its length, capped:
# half the box width, so a person whose anchor passes just beyond the end
# but whose body walks through the door still counts.
_END_TOLERANCE_MAX = 0.25


# ── Line geometry (pure; pixel space) ─────────────────────────────────────

# A line shorter than this (normalised) cannot be told apart from a point.
_MIN_LINE_LEN = 0.03

# Where a gate with no line saved yet starts: across the frame a bit below
# centre (typical entrance cam), inset so both handles are on the picture.
_DEFAULT_LINE = (0.1, 0.6, 0.9, 0.6)

_DIRECTIONS = ("right_is_in", "left_is_in")
_LEGACY_DIRECTIONS = ("down_is_in", "up_is_in")


def signed_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """Distance of (px, py) from the line through a->b, signed: positive is
    the RIGHT of a->b as seen on screen (image y grows downward), so for a
    left-to-right line, positive is below it. Same cross product as
    activity-monitor's crossing._side, divided by |a->b| to get pixels."""
    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy)
    if length <= 0.0:
        return 0.0
    return (dx * (py - ay) - dy * (px - ax)) / length


def crosses_segment(
    p: tuple[float, float], q: tuple[float, float],
    dp: float, dq: float,
    ax: float, ay: float, bx: float, by: float,
    tolerance: float = 0.0,
) -> bool:
    """Does the step p->q (whose signed distances dp, dq have opposite signs)
    cross the line WITHIN the segment a-b? `tolerance` widens the segment by
    that fraction of its length at each end."""
    if dp == dq:
        return False
    alpha = dp / (dp - dq)
    xx = p[0] + alpha * (q[0] - p[0])
    yy = p[1] + alpha * (q[1] - p[1])
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    if len2 <= 0.0:
        return False
    t = ((xx - ax) * dx + (yy - ay) * dy) / len2
    return -tolerance <= t <= 1.0 + tolerance


def parse_line(raw: Any) -> tuple[float, float, float, float] | None:
    """{"a":[x,y],"b":[x,y]} (or activity-monitor's {x1,y1,x2,y2}),
    normalised 0..1 -> (ax, ay, bx, by), clamped to the frame. None when it
    is missing, malformed or too short to be a line."""
    if not isinstance(raw, dict):
        return None
    try:
        if "a" in raw and "b" in raw:
            (ax, ay), (bx, by) = raw["a"], raw["b"]
        else:
            ax, ay, bx, by = raw["x1"], raw["y1"], raw["x2"], raw["y2"]
        pts = [float(v) for v in (ax, ay, bx, by)]
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in pts):
        return None
    ax, ay, bx, by = (round(max(0.0, min(1.0, v)), 4) for v in pts)
    if math.hypot(bx - ax, by - ay) < _MIN_LINE_LEN:
        return None
    return ax, ay, bx, by


# ── Per-camera config (mirrored from cameras.config_json) ─────────────────


@dataclass(slots=True)
class FootfallConfig:
    """What the operator picked for this camera. Mirrored from the camera's
    `config_json["footfall"]` block at orchestrator startup (and refreshed
    whenever the API saves new settings). Sensible defaults below cover the
    'enable it and forget it' case."""

    enabled: bool = False
    # The counting line, a->b, normalised to the frame (0,0 top-left,
    # 1,1 bottom-right). Any angle.
    ax: float = 0.1
    ay: float = 0.6
    bx: float = 0.9
    by: float = 0.6
    # "right_is_in" = crossing toward the right of a->b (on screen) counts
    # as IN; "left_is_in" inverts that. Operator-driven; see config UI.
    direction: str = "right_is_in"
    # Optional fall detection. Off by default — the heuristic
    # (bbox.w > 1.2 * bbox.h) has a non-trivial false-positive rate on
    # crouching, bending or carrying-large-items, and most deployments
    # don't want those alerts.
    falls_enabled: bool = False

    @property
    def line(self) -> dict[str, list[float]]:
        return {"a": [self.ax, self.ay], "b": [self.bx, self.by]}

    @property
    def line_y_frac(self) -> float:
        """Height of the line's midpoint: the pre-angle field, still served
        so an older client reads something sensible. Exact for a level line."""
        return round((self.ay + self.by) / 2.0, 3)

    @property
    def in_sign(self) -> int:
        """Sign of signed_distance() on the IN side."""
        return 1 if self.direction == "right_is_in" else -1

    @classmethod
    def from_camera_config(cls, config_json: dict | None) -> "FootfallConfig":
        """Read the footfall sub-block from cameras.config_json. Missing
        block → all-defaults (disabled). Bad types are coerced silently —
        we'd rather start a camera with a working config than fail the
        whole orchestrator on a stray string.

        Pre-angle blocks ({line_y_frac, down_is_in|up_is_in}) are read as a
        full-width level line, so they count exactly as before.

        Defaults are written literally rather than read via `cls.<field>`
        because @dataclass(slots=True) replaces the class-level attribute
        with a slot descriptor — `cls.ay` evaluates to a `member_descriptor`,
        not 0.6, and arithmetic on it blows up with TypeError at runtime."""
        block = (config_json or {}).get("footfall") or {}

        line = parse_line(block.get("line"))
        if line is None and block.get("line_y_frac") is not None:
            try:
                y = float(block["line_y_frac"])
            except (TypeError, ValueError):
                y = 0.6
            y = round(max(0.05, min(0.95, y)), 4)
            line = (0.0, y, 1.0, y)
        if line is None:
            line = _DEFAULT_LINE
        ax, ay, bx, by = line

        direction = str(block.get("direction", "")).strip().lower()
        if direction in _LEGACY_DIRECTIONS:
            # "Down" is the right of a->b when a->b runs left to right.
            down_is_right = (bx - ax) >= 0
            wants_down = direction == "down_is_in"
            direction = "right_is_in" if wants_down == down_is_right else "left_is_in"
        elif direction not in _DIRECTIONS:
            direction = "right_is_in"

        return cls(
            enabled=bool(block.get("enabled", False)),
            ax=ax, ay=ay, bx=bx, by=by,
            direction=direction,
            falls_enabled=bool(block.get("falls_enabled", False)),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "line": self.line,
            "direction": self.direction,
            "falls_enabled": self.falls_enabled,
            # Read-only echo for pre-angle clients; `line` wins on read.
            "line_y_frac": self.line_y_frac,
        }


# ── Per-camera tracker state ──────────────────────────────────────────────


@dataclass(slots=True)
class _Track:
    x: float                  # anchor point last seen (pixels)
    y: float
    last_seen: float
    side: int                 # committed side: -1 left of a->b, 1 right,
                              # 0 = has not cleared the dead band yet
    rx: float = 0.0           # last point seen clear on the committed side;
    ry: float = 0.0           # a crossing is the step from here
    frames: int = 1
    last_count_t: float = float("-inf")
    fall_counted: bool = False


@dataclass(slots=True)
class _CameraState:
    # camera_id is the dict key, but we also carry the tenant for flush.
    tenant_id: uuid.UUID
    config: FootfallConfig
    next_id: int = 1
    tracks: dict[int, _Track] = field(default_factory=dict)
    # Pending deltas: counts accumulated since the last flush, keyed by the
    # minute they happened in. We accumulate per-minute so a late flush
    # doesn't merge crossings from 10:59:58 into the 11:00 bucket.
    pending: dict[dt.datetime, dict[str, int]] = field(default_factory=dict)
    # Lightweight stats for the live API. These are cumulative since the
    # service started; persisted totals come from Postgres.
    live_in: int = 0
    live_out: int = 0
    live_falls: int = 0
    last_update_ts: float = 0.0


def _side_of(distance: float, box_h: float) -> int:
    """-1 / 1 for a point clear of the line's dead band, 0 inside it."""
    band = max(_BAND_MIN_PX, _BAND_BOX_FRAC * box_h)
    if distance > band:
        return 1
    if distance < -band:
        return -1
    return 0


def _minute_bucket(now: dt.datetime) -> dt.datetime:
    """Truncate to the minute, keep timezone."""
    return now.replace(second=0, microsecond=0)


# ── The registry (singleton-ish; lives for the lifetime of the API process) ─


class FootfallRegistry:
    """Holds per-camera tracker state and runs the periodic Postgres flush.
    One instance per process — the `get_registry()` helper below returns it.
    Thread-safe via an asyncio Lock; the orchestrator calls update() from
    its own asyncio task, the flush coroutine reads/clears pending under
    the same lock."""

    def __init__(self) -> None:
        self._cameras: dict[uuid.UUID, _CameraState] = {}
        self._lock = asyncio.Lock()
        self._flusher: asyncio.Task | None = None
        self._stop = asyncio.Event()

    # ── Lifecycle ────────────────────────────────────────────────────────

    def start(self) -> None:
        """Idempotently start the periodic flusher. Called from app lifespan."""
        if self._flusher is None or self._flusher.done():
            self._stop.clear()
            self._flusher = asyncio.create_task(self._flush_loop(), name="footfall-flusher")

    async def aclose(self) -> None:
        self._stop.set()
        if self._flusher is not None:
            self._flusher.cancel()
            try:
                await self._flusher
            except (asyncio.CancelledError, Exception):
                pass
            self._flusher = None
        # One last best-effort flush so we don't lose counts at shutdown.
        await self._flush_once()

    # ── Per-camera config / lifecycle ────────────────────────────────────

    async def configure_camera(
        self,
        camera_id: uuid.UUID,
        tenant_id: uuid.UUID,
        config: FootfallConfig,
    ) -> None:
        """Called when an orchestrator starts (or when the operator saves
        new footfall settings via the API). Creating fresh state per camera
        means stale tracks from a previous config don't carry over."""
        async with self._lock:
            self._cameras[camera_id] = _CameraState(tenant_id=tenant_id, config=config)

    async def remove_camera(self, camera_id: uuid.UUID) -> None:
        async with self._lock:
            state = self._cameras.pop(camera_id, None)
        # Drain any leftover deltas before we forget them.
        if state is not None and state.pending:
            await self._flush_one(camera_id, state, force=True)

    def get_config(self, camera_id: uuid.UUID) -> FootfallConfig | None:
        state = self._cameras.get(camera_id)
        return state.config if state else None

    # ── Per-frame update ─────────────────────────────────────────────────

    def update(
        self,
        camera_id: uuid.UUID,
        frame_w: int,
        frame_h: int,
        persons: Iterable[tuple[float, float, float, float, float]],
        *,
        anchor: str = "center",
    ) -> None:
        """Synchronous, non-blocking (no I/O). Safe to call from the
        orchestrator's hot loop. `persons` is (x1, y1, x2, y2, score) per
        detection, in pixels of a frame_w x frame_h picture.

        `anchor` is the point of each box tested against the line: "feet"
        (bottom-centre) for whole-body boxes, so the line is drawn on the
        floor across the doorway; "center" for face boxes, which have no
        feet."""
        state = self._cameras.get(camera_id)
        if state is None or not state.config.enabled or frame_w <= 0 or frame_h <= 0:
            return

        cfg = state.config
        line = (cfg.ax * frame_w, cfg.ay * frame_h, cfg.bx * frame_w, cfg.by * frame_h)
        feet = anchor == "feet"
        now_t = time.monotonic()
        now_dt = dt.datetime.now(dt.timezone.utc)
        bucket = _minute_bucket(now_dt)
        bucket_counts = state.pending.setdefault(
            bucket, {"in": 0, "out": 0, "falls": 0},
        )

        # Build (px, py, w, h) -- the anchor point and box size -- per detection.
        new_obs = []
        for box in persons:
            try:
                x1, y1, x2, y2, _score = box
            except (TypeError, ValueError):
                continue
            w, h = float(x2 - x1), float(y2 - y1)
            if w <= 0 or h <= 0:
                continue
            px = float(x1) + w * 0.5
            py = float(y2) if feet else float(y1) + h * 0.5
            new_obs.append((px, py, w, h))

        # Match each observation to its closest existing track within the
        # match radius. Greedy: not optimal (Hungarian would be), but at
        # ~5-10 people per frame the loss is invisible.
        used_tracks: set[int] = set()
        for px, py, w, h in new_obs:
            best_id, best_d = None, _TRACK_MATCH_RADIUS_PX + 1.0
            for tid, tr in state.tracks.items():
                if tid in used_tracks:
                    continue
                d = math.hypot(px - tr.x, py - tr.y)
                if d < best_d:
                    best_d, best_id = d, tid
            if best_id is not None and best_d <= _TRACK_MATCH_RADIUS_PX:
                tr = state.tracks[best_id]
                self._step_track(state, tr, px, py, w, h, line, bucket_counts, now_t, cfg)
                used_tracks.add(best_id)
            else:
                # Brand-new person — assign an id and note which side it is on.
                tid = state.next_id
                state.next_id += 1
                side = _side_of(signed_distance(px, py, *line), h)
                tr = _Track(x=px, y=py, last_seen=now_t, side=side, rx=px, ry=py)
                state.tracks[tid] = tr
                used_tracks.add(tid)
                # Fall heuristic check on first sight too.
                if cfg.falls_enabled and w > h * 1.2:
                    tr.fall_counted = True
                    bucket_counts["falls"] += 1
                    state.live_falls += 1

        # Age out stale tracks. Doing this every frame is O(N) but N is
        # tiny (active people on this camera). Without TTL, fallen_ids /
        # counted state would leak forever.
        stale = [tid for tid, tr in state.tracks.items() if now_t - tr.last_seen > _TRACK_TTL_SEC]
        for tid in stale:
            state.tracks.pop(tid, None)

        state.last_update_ts = now_t

    @staticmethod
    def _step_track(
        state: _CameraState,
        tr: _Track,
        px: float, py: float, w: float, h: float,
        line: tuple[float, float, float, float],
        bucket_counts: dict[str, int],
        now_t: float,
        cfg: FootfallConfig,
    ) -> None:
        tr.frames += 1
        side = _side_of(signed_distance(px, py, *line), h)

        if side != 0:
            if tr.side == 0 or side == tr.side:
                # First clear of the band, or still on the same side.
                tr.side, tr.rx, tr.ry = side, px, py
            elif tr.frames >= _MIN_TRACK_FRAMES and now_t - tr.last_count_t >= _RECOUNT_COOLDOWN_SEC:
                # A flip. It counts only if the step crossed the drawn
                # segment; one that went round the end of the line just
                # moves the track to the other side.
                ax, ay, bx, by = line
                seg_len = math.hypot(bx - ax, by - ay)
                tolerance = min(_END_TOLERANCE_MAX, (w * 0.5) / seg_len) if seg_len > 0 else 0.0
                d_ref = signed_distance(tr.rx, tr.ry, *line)
                d_now = signed_distance(px, py, *line)
                if crosses_segment((tr.rx, tr.ry), (px, py), d_ref, d_now, ax, ay, bx, by, tolerance):
                    if side == cfg.in_sign:
                        bucket_counts["in"] += 1
                        state.live_in += 1
                    else:
                        bucket_counts["out"] += 1
                        state.live_out += 1
                    tr.last_count_t = now_t
                tr.side, tr.rx, tr.ry = side, px, py
            # else: a flip from a track too young, or inside the cooldown.
            # Not committed -- the next frame re-checks, so someone who
            # really stays on the new side is counted once the guard lapses.

        # Fall heuristic — once per track only.
        if cfg.falls_enabled and not tr.fall_counted and w > h * 1.2:
            tr.fall_counted = True
            bucket_counts["falls"] += 1
            state.live_falls += 1

        tr.x, tr.y, tr.last_seen = px, py, now_t

    # ── Live read paths (no I/O) ─────────────────────────────────────────

    def live_snapshot(self) -> dict[uuid.UUID, dict[str, Any]]:
        """Return the current per-camera in-memory counters. Used by the
        live API endpoint — cheap and lock-free for read."""
        out: dict[uuid.UUID, dict[str, Any]] = {}
        for cam_id, st in self._cameras.items():
            out[cam_id] = {
                "tenant_id": str(st.tenant_id),
                "enabled": st.config.enabled,
                "line": st.config.line,
                "line_y_frac": st.config.line_y_frac,
                "direction": st.config.direction,
                "falls_enabled": st.config.falls_enabled,
                "in_count_session": st.live_in,
                "out_count_session": st.live_out,
                "falls_count_session": st.live_falls,
                "active_tracks": len(st.tracks),
                "last_update_age_sec": (
                    round(time.monotonic() - st.last_update_ts, 1)
                    if st.last_update_ts > 0 else None
                ),
            }
        return out

    # ── Flush loop ───────────────────────────────────────────────────────

    async def _flush_loop(self) -> None:
        log.info("footfall flusher started", interval_sec=_FLUSH_INTERVAL_SEC)
        try:
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=_FLUSH_INTERVAL_SEC)
                    break    # stop signal received
                except asyncio.TimeoutError:
                    pass
                try:
                    await self._flush_once()
                except Exception as e:
                    log.warning("footfall flush failed", err=str(e))
        finally:
            log.info("footfall flusher stopped")

    async def _flush_once(self) -> None:
        # Snapshot the pending deltas under the lock, then drain them
        # outside the lock so the orchestrator can keep updating.
        snapshots: list[tuple[uuid.UUID, _CameraState, dict[dt.datetime, dict[str, int]]]] = []
        async with self._lock:
            for cam_id, st in self._cameras.items():
                if not st.pending:
                    continue
                snapshots.append((cam_id, st, st.pending))
                st.pending = {}
        if not snapshots:
            return

        async with session_scope() as session:
            for cam_id, st, pending in snapshots:
                for bucket, counts in pending.items():
                    stmt = pg_insert(FootfallMinuteBucket).values(
                        tenant_id=st.tenant_id,
                        camera_id=cam_id,
                        bucket_minute=bucket,
                        in_count=counts["in"],
                        out_count=counts["out"],
                        falls_count=counts["falls"],
                    )
                    # The bucket exists when an earlier flush already wrote
                    # to the same (camera, minute). We add deltas; we never
                    # overwrite — multiple flush cycles per minute is the
                    # normal case (every 5 s).
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["camera_id", "bucket_minute"],
                        set_={
                            "in_count":    FootfallMinuteBucket.in_count + counts["in"],
                            "out_count":   FootfallMinuteBucket.out_count + counts["out"],
                            "falls_count": FootfallMinuteBucket.falls_count + counts["falls"],
                        },
                    )
                    await session.execute(stmt)
            await session.commit()

    async def _flush_one(self, camera_id: uuid.UUID, state: _CameraState, *, force: bool) -> None:
        """Drain just one camera (used on remove_camera). Mirrors _flush_once's
        logic but scoped tightly so it doesn't touch other cameras' state."""
        if not state.pending and not force:
            return
        pending = state.pending
        state.pending = {}
        if not pending:
            return
        async with session_scope() as session:
            for bucket, counts in pending.items():
                stmt = pg_insert(FootfallMinuteBucket).values(
                    tenant_id=state.tenant_id,
                    camera_id=camera_id,
                    bucket_minute=bucket,
                    in_count=counts["in"],
                    out_count=counts["out"],
                    falls_count=counts["falls"],
                )
                stmt = stmt.on_conflict_do_update(
                    index_elements=["camera_id", "bucket_minute"],
                    set_={
                        "in_count":    FootfallMinuteBucket.in_count + counts["in"],
                        "out_count":   FootfallMinuteBucket.out_count + counts["out"],
                        "falls_count": FootfallMinuteBucket.falls_count + counts["falls"],
                    },
                )
                await session.execute(stmt)
            await session.commit()


# Module-level singleton. Lazy-built so import order doesn't matter.

_registry: FootfallRegistry | None = None


def get_registry() -> FootfallRegistry:
    global _registry
    if _registry is None:
        _registry = FootfallRegistry()
    return _registry
