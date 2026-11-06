"""FFmpeg clip extraction + overlay + concat. Ported from person-tracker.

Corrections vs source: uses sighting.camera_code (the MediaMTX monitor_id) to
locate recordings (not the Camera UUID); the drawtext font path is configurable
(settings.stitch_font_path) because the image installs fonts-dejavu-core; logging
via get_logger; work_dir prefix `vms-stitch-`. Stream-copy first, transcode
fallback — same resilient two-pass approach person-tracker proved."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.journey import recordings
from vms_face.journey.contracts import Sighting

log = get_logger(__name__)


def _run(cmd: list[str], *, capture: bool = True) -> subprocess.CompletedProcess:
    log.info("ffmpeg", cmd=" ".join(cmd))
    return subprocess.run(cmd, capture_output=capture, check=False, text=True)


def _extract_piece(src: Path, seek: float, length: float, out_path: Path) -> bool:
    """Extract [seek, seek+length] from one segment file. FFmpeg stops at EOF, so
    an over-long `length` (recording gap) just yields the footage that exists.

    Keyframe handling: a `-ss` before `-i` with `-c copy` seeks to the nearest
    PRIOR keyframe and copies — when the seek lands mid-GOP the leading frames
    reference a keyframe that's now gone → the clip opens BLACK/frozen. So when we
    seek more than ~1 s into a segment we re-encode (decodes then re-keys cleanly);
    a seek at/near a segment start (keyframe-aligned) can safely stream-copy."""
    s = max(0.0, seek)
    t = max(0.1, length)
    # Always RE-ENCODE and ZERO-BASE both streams: MediaMTX segments carry large
    # stream-relative PTS, so a `-c copy` piece keeps that offset and the concat
    # demuxer turns it into a frozen gap (and a mid-GOP seek would open black).
    #   video: setpts=PTS-STARTPTS  → 0-based, clean keyframe
    #   audio: pcm → AAC (browser-friendly) + aresample=async=1:first_pts=0 to
    #          0-base it AND fill/trim so audio stays in sync with video.
    # FFmpeg stops at EOF, so an over-long `length` (recording gap) yields what
    # exists. `-map 0 ... ?` is avoided; if a source has no audio FFmpeg simply
    # produces a video-only clip (concat re-encode fallback handles mixed sets).
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{s:.3f}",
           "-i", str(src), "-t", f"{t:.3f}",
           "-vf", "setpts=PTS-STARTPTS", "-af", "aresample=async=1:first_pts=0",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out_path)]
    r = _run(cmd)
    return r.returncode == 0 and out_path.exists() and out_path.stat().st_size > 1024


def extract_clip(*, sighting: Sighting, out_path: Path) -> bool:
    """Extract a padded clip for one sighting. Spans the short ~30–90 s segments
    MediaMTX writes (and skips recording gaps) so a multi-minute sighting isn't
    truncated to its first segment. Returns True on success, False when no
    recording overlaps the window / FFmpeg errored (the worker skips False)."""
    monitor_id = sighting.camera_code
    if not monitor_id:
        log.warning("sighting has no camera_code (monitor_id); cannot locate recording",
                    camera_id=str(sighting.camera_id))
        return False

    import datetime as dt
    # Cap to the "key moment" so a long linger doesn't render minutes of footage.
    cap = float(getattr(settings, "clip_max_sec", 20) or 20)
    eff_end = min(sighting.ended_at, sighting.started_at + dt.timedelta(seconds=cap))
    win_start = sighting.started_at - dt.timedelta(seconds=settings.clip_pad_before_sec)
    win_end = eff_end + dt.timedelta(seconds=settings.clip_pad_after_sec)
    segs = recordings.locate_window(monitor_id, win_start, win_end)
    if not segs:
        log.warning("no recording covers window", monitor_id=monitor_id,
                    start=str(win_start), end=str(win_end))
        return False

    # Single overlapping segment → one extract, straight to out_path.
    if len(segs) == 1:
        s = segs[0]
        return _extract_piece(s.path, s.seek_sec, s.take_sec, out_path)

    # Multiple segments → extract each overlapping slice, then concat in order.
    pieces: list[Path] = []
    for j, s in enumerate(segs):
        piece = out_path.parent / f"{out_path.stem}_seg{j:03d}.mp4"
        if _extract_piece(s.path, s.seek_sec, s.take_sec, piece):
            pieces.append(piece)
    if not pieces:
        return False
    if len(pieces) == 1:
        pieces[0].replace(out_path)
        return True
    return concat(pieces, out_path=out_path)


def apply_overlay(*, src: Path, dst: Path, label: str) -> bool:
    """Burn a single-line label top-left. Font path is configurable; if the font
    is missing FFmpeg returns non-zero and the worker falls back to the raw clip."""
    safe = label.replace(":", r"\:").replace("'", r"\'").replace(",", r"\,")
    drawtext = (
        f"drawtext=fontfile={settings.stitch_font_path}:"
        f"text='{safe}':fontcolor=white:fontsize=22:"
        f"box=1:boxcolor=black@0.6:boxborderw=8:x=14:y=14"
    )
    # setpts=PTS-STARTPTS zeroes the timeline; the source clip's audio is already
    # 0-based AAC (from _extract_piece) so copy it through unchanged.
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
           "-vf", f"{drawtext},setpts=PTS-STARTPTS", "-c:v", "libx264", "-preset", "veryfast",
           "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "copy", str(dst)]
    return _run(cmd).returncode == 0


def concat(clip_paths: list[Path], *, out_path: Path) -> bool:
    """Concat MP4s via the concat demuxer (copy first, re-encode fallback)."""
    if not clip_paths:
        return False
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        for p in clip_paths:
            f.write(f"file '{p.as_posix()}'\n")
        listfile = f.name
    try:
        base = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "0", "-i", listfile]
        r = _run(base + ["-c", "copy", "-movflags", "+faststart", str(out_path)])
        if r.returncode != 0:
            log.warning("concat copy failed; re-encoding", rc=r.returncode, err=(r.stderr or "")[:200])
            r = _run(base + ["-vf", "setpts=PTS-STARTPTS", "-af", "aresample=async=1:first_pts=0",
                             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(out_path)])
        return r.returncode == 0 and out_path.exists() and out_path.stat().st_size > 1024
    finally:
        try:
            Path(listfile).unlink()
        except FileNotFoundError:
            pass


def work_dir() -> Path:
    p = Path(tempfile.gettempdir()) / f"vms-stitch-{uuid.uuid4().hex[:8]}"
    p.mkdir(parents=True, exist_ok=True)
    return p


def cleanup(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
