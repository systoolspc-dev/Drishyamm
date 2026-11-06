"""(monitor_id, timestamp) → (recording file path, seek offset seconds).

Ported from person-tracker with two verified corrections for THIS deployment:

  * The recordings dir is keyed by the MediaMTX **monitor_id**, which in
    vms_face is `Camera.code` (a 24-hex id), NOT the Camera UUID. Callers must
    pass the code, not str(camera_id).
  * The real segment filenames are `HH-MM-SS-<micros>.mp4` (e.g.
    `09-04-19-251155.mp4`), not the `HHMMSS-` form person-tracker assumed.

Layout (verified against ./mediamtx-recordings):

  /recordings/cam_<monitor_id>/YYYY-MM-DD/HH-MM-SS-<micros>.mp4

Each file covers a contiguous segment; the filename time is the segment START.
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from pathlib import Path

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

# HH-MM-SS-<micros>.mp4  (the trailing group is sub-second uniqueness, ignored)
_FNAME_RE = re.compile(r"^(\d{2})-(\d{2})-(\d{2})-\d+\.mp4$", re.IGNORECASE)


@dataclass(slots=True)
class RecordingLocator:
    path: Path
    seek_sec: float
    segment_started_at: dt.datetime


@dataclass(slots=True)
class WindowSegment:
    """One recording segment overlapping a requested time window, with the
    sub-range (seek_sec .. seek_sec+take_sec) inside that file to extract."""
    path: Path
    seek_sec: float
    take_sec: float
    segment_started_at: dt.datetime


def _collect_segments(monitor_id: str, day_utc: dt.date) -> list[tuple[dt.datetime, Path]]:
    """All (segment_start_utc, path) for one camera/day, sorted by start."""
    day_dir = _camera_dir(monitor_id) / day_utc.strftime("%Y-%m-%d")
    if not day_dir.is_dir():
        return []
    segs: list[tuple[dt.datetime, Path]] = []
    for p in day_dir.iterdir():
        if not p.is_file() or p.suffix.lower() != ".mp4":
            continue
        m = _FNAME_RE.match(p.name)
        if not m:
            continue
        hh, mm, ss = m.group(1), m.group(2), m.group(3)
        try:
            seg_start = dt.datetime.strptime(
                f"{day_utc.strftime('%Y-%m-%d')} {hh}:{mm}:{ss}", "%Y-%m-%d %H:%M:%S"
            ).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        segs.append((seg_start, p))
    segs.sort(key=lambda sp: sp[0])
    return segs


def locate_window(
    monitor_id: str,
    start: dt.datetime,
    end: dt.datetime,
    *,
    max_segment_sec: float = 600.0,
) -> list[WindowSegment]:
    """Every recording segment overlapping [start, end], in order, with the slice
    to take from each. Unlike `locate` (single segment, start-only) this spans the
    short ~30–90 s segments MediaMTX actually writes, so a multi-minute sighting
    isn't truncated to its first segment — and recording GAPS inside the window
    just yield no footage there (FFmpeg reads each file to EOF) rather than a seek
    past the end. A segment's end is bounded by the next segment's start (the real
    coverage), capped at max_segment_sec for the final segment."""
    start_utc = start.astimezone(dt.timezone.utc)
    end_utc = end.astimezone(dt.timezone.utc)
    if end_utc <= start_utc:
        end_utc = start_utc + dt.timedelta(seconds=1)

    # Gather both day-dirs in case the window straddles midnight UTC.
    segs: list[tuple[dt.datetime, Path]] = []
    seen_days: set[dt.date] = set()
    for d in (start_utc.date(), end_utc.date()):
        if d in seen_days:
            continue
        seen_days.add(d)
        segs.extend(_collect_segments(monitor_id, d))
    segs.sort(key=lambda sp: sp[0])
    if not segs:
        return []

    out: list[WindowSegment] = []
    for idx, (seg_start, path) in enumerate(segs):
        if idx + 1 < len(segs):
            seg_end = segs[idx + 1][0]
        else:
            seg_end = seg_start + dt.timedelta(seconds=max_segment_sec)
        ov_start = max(start_utc, seg_start)
        ov_end = min(end_utc, seg_end)
        if ov_start < ov_end:
            out.append(
                WindowSegment(
                    path=path,
                    seek_sec=max(0.0, (ov_start - seg_start).total_seconds()),
                    take_sec=(ov_end - ov_start).total_seconds(),
                    segment_started_at=seg_start,
                )
            )
    return out


def _camera_dir(monitor_id: str) -> Path:
    # MediaMTX path convention: cam_<monitor_id>  (monitor_id == Camera.code).
    # H.265 cameras are transcoded to a `_h264` companion path, and THAT is what
    # actually records to disk (the raw H.265 path is only muxed on demand). So
    # prefer cam_<id>_h264 when present — otherwise the stitch worker finds no
    # segments for transcoded cameras ("no clips could be extracted").
    root = Path(settings.recordings_root)
    h264 = root / f"cam_{monitor_id}_h264"
    if h264.is_dir():
        return h264
    return root / f"cam_{monitor_id}"


def locate(monitor_id: str, when: dt.datetime) -> RecordingLocator | None:
    """Find the segment covering wall-clock `when` for the camera whose MediaMTX
    monitor_id (== Camera.code) is given. Returns None when nothing covers it."""
    when_utc = when.astimezone(dt.timezone.utc)
    cam_dir = _camera_dir(monitor_id)
    day_dir = cam_dir / when_utc.strftime("%Y-%m-%d")
    if not day_dir.is_dir():
        log.debug("no recordings day dir", monitor_id=monitor_id, day=str(day_dir))
        return None

    segments: list[tuple[dt.datetime, Path]] = []
    for p in day_dir.iterdir():
        if not p.is_file() or p.suffix.lower() != ".mp4":
            continue
        m = _FNAME_RE.match(p.name)
        if not m:
            continue
        hh, mm, ss = m.group(1), m.group(2), m.group(3)
        try:
            seg_start = dt.datetime.strptime(
                f"{when_utc.strftime('%Y-%m-%d')} {hh}:{mm}:{ss}", "%Y-%m-%d %H:%M:%S"
            ).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        segments.append((seg_start, p))

    if not segments:
        return None

    # Closest segment whose start <= when. If all start after `when`, the
    # recording rotated past us → None.
    candidates = [(s, p) for s, p in segments if s <= when_utc]
    if not candidates:
        return None
    seg_start, path = max(candidates, key=lambda sp: sp[0])
    seek = max(0.0, (when_utc - seg_start).total_seconds())
    return RecordingLocator(path=path, seek_sec=seek, segment_started_at=seg_start)


def list_cameras() -> list[str]:
    """Best-effort enumeration of `cam_<monitor_id>` directories under root —
    used by diagnostics / the worker startup self-check."""
    root = Path(settings.recordings_root)
    if not root.is_dir():
        return []
    return [p.name[4:] for p in root.iterdir() if p.is_dir() and p.name.startswith("cam_")]
