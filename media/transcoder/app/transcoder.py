"""FFmpeg subprocess manager — one process per camera path.

The transcoder pipeline:

    rtsp://mediamtx/cam_<id>          (camera-published, may be ugly)
        ↓ -c:v h264_cuvid             (NVDEC hardware decode)
        ↓ -c:v h264_nvenc             (NVENC hardware encode)
        ↓ -profile:v baseline         (no B-frames; HLS muxer friendly)
        ↓ -g <fps * gop_seconds>      (short GOP, e.g. 50 for 2s @ 25fps)
        ↓ -b:v 4000k -maxrate 5000k   (CBR-ish)
        ↓ -c:a copy                   (audio passthrough, no re-encode)
        ↓ -f rtsp                     (re-publish)
    rtsp://mediamtx/cam_<id>_clean

Why each piece:
- NVDEC + NVENC keep the GPU encoder busy on raw frames; no CPU codec
  passes. Each transcoder costs ~1 NVENC slot (modern NVIDIA cards
  have 3-8 depending on model).
- Baseline profile + zero B-frames → MediaMTX HLS muxer stops choking
  on "unable to extract DTS" errors that Hikvision firmware causes.
- 2s GOP keeps glass-to-glass latency low while making sure dropped
  packets don't freeze the picture for more than a keyframe interval.
- 'll' tune + 'p4' preset is the NVENC equivalent of x264's "veryfast
  zerolatency" — what every low-latency live stream uses.
- Audio copy: re-encoding audio adds ~50ms of latency for no quality
  win on CCTV. Skip it.

Why simple subprocess instead of a real process supervisor:
- We restart FFmpeg with a 5-second backoff on death — that's the only
  recovery primitive a streaming transcoder needs. systemd / supervisord
  add complexity for no payoff.
- Logging is captured to a deque (last N lines) so the /status endpoint
  can return recent stderr for diagnostics without writing to disk.
"""
from __future__ import annotations

import asyncio
import shlex
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from .config import settings


@dataclass
class TranscoderState:
    """Live state for one camera's transcoder.

    `process` is the running FFmpeg subprocess, or None when stopped /
    crashed-pre-respawn. The supervisor task in `start()` will spawn a
    replacement after ffmpeg_restart_backoff_sec.
    """
    camera_id: str
    src_path: str
    dst_path: str
    bitrate_kbps: int
    started_at: Optional[float] = None
    restart_count: int = 0
    last_exit_code: Optional[int] = None
    last_log_lines: deque[str] = field(default_factory=lambda: deque(maxlen=settings.ffmpeg_log_tail_lines))
    process: Optional[asyncio.subprocess.Process] = None
    supervisor_task: Optional[asyncio.Task] = None
    stop_requested: bool = False


# camera_id → TranscoderState
_registry: dict[str, TranscoderState] = {}


def build_ffmpeg_args(state: TranscoderState) -> list[str]:
    """Construct the FFmpeg command line for this transcoder.

    Returns the args list (not a shell string) so the subprocess module
    quotes everything correctly.
    """
    s = settings
    gop_frames = int(round(s.nvenc_fps * s.nvenc_gop_seconds))

    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        # NVDEC decode — fall through to software if the camera codec
        # isn't H.264 (e.g. HEVC). h264_cuvid only handles H.264 input.
        "-hwaccel", "cuda",
        "-hwaccel_output_format", "cuda",
        # RTSP input options. Transport TCP matches our MediaMTX config
        # (camera→broker is already TCP; broker→transcoder same).
        "-rtsp_transport", "tcp",
        "-i", state.src_path,

        # ── VIDEO ──
        "-c:v", s.nvenc_codec,
        "-preset", s.nvenc_preset,
        "-tune", s.nvenc_tune,
        "-profile:v", s.nvenc_profile,
        # Bitrate control: CBR-ish. NVENC's CBR is closer to capped VBR;
        # for true CBR set bufsize == maxrate.
        "-b:v", f"{state.bitrate_kbps}k",
        "-maxrate", f"{s.nvenc_maxrate_kbps}k",
        "-bufsize", f"{s.nvenc_maxrate_kbps}k",
        "-g", str(gop_frames),
        "-keyint_min", str(gop_frames),
        # No B-frames — required for low-latency HLS muxers (and what
        # makes baseline profile baseline).
        "-bf", "0",
        # Lock frame rate so the receiver sees a steady cadence.
        "-r", str(s.nvenc_fps),
        # Force key frame on scene change too — helps the player recover
        # if a packet drops at exactly the wrong moment.
        "-force_key_frames", f"expr:gte(t,n_forced*{s.nvenc_gop_seconds})",

        # ── AUDIO ──
        "-c:a", s.nvenc_audio,

        # ── OUTPUT ──
        "-f", "rtsp",
        "-rtsp_transport", "tcp",
        state.dst_path,
    ]


async def _supervise(state: TranscoderState):
    """Run-and-restart loop. Spawns FFmpeg, waits for exit, backs off,
    repeats — unless stop_requested is set.

    Each restart bumps restart_count and resets started_at. The
    /status endpoint surfaces both so operators can spot a camera that
    flaps every few seconds vs one that's been steady for hours.
    """
    while not state.stop_requested:
        args = build_ffmpeg_args(state)
        state.last_log_lines.append(f"[supervisor] spawn: {shlex.join(args)}")
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            state.last_log_lines.append(f"[supervisor] ffmpeg not found: {e}")
            await asyncio.sleep(settings.ffmpeg_restart_backoff_sec)
            continue

        state.process = proc
        state.started_at = asyncio.get_event_loop().time()
        state.last_log_lines.append(f"[supervisor] pid={proc.pid}")

        # Pump stderr lines into the ring buffer. We DON'T buffer stdout
        # because FFmpeg doesn't write status messages there.
        async def _drain_stderr():
            assert proc.stderr is not None
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                state.last_log_lines.append(line.decode(errors="replace").rstrip())

        drain_task = asyncio.create_task(_drain_stderr())
        try:
            state.last_exit_code = await proc.wait()
        finally:
            drain_task.cancel()
            try:
                await drain_task
            except asyncio.CancelledError:
                pass
            state.process = None

        if state.stop_requested:
            state.last_log_lines.append(f"[supervisor] stopped (exit={state.last_exit_code})")
            return

        state.restart_count += 1
        state.last_log_lines.append(
            f"[supervisor] ffmpeg exited code={state.last_exit_code}; "
            f"restart #{state.restart_count} in {settings.ffmpeg_restart_backoff_sec}s"
        )
        await asyncio.sleep(settings.ffmpeg_restart_backoff_sec)


def make_paths(camera_id: str) -> tuple[str, str]:
    """Build the (src, dst) RTSP URLs for a given camera_id.

    The camera_id is what MediaMTX uses inside the path name — that's
    the `monitor_id` (not the Sequelize UUID) per drisyam convention.
    Callers MUST pass the same identifier that's already in MediaMTX,
    or the FFmpeg input will 404 against MediaMTX's path namespace.
    """
    src = f"{settings.mediamtx_rtsp_base}/cam_{camera_id}"
    dst = f"{settings.mediamtx_rtsp_base}/cam_{camera_id}{settings.clean_path_suffix}"
    return src, dst


def start(camera_id: str, bitrate_kbps: Optional[int] = None) -> TranscoderState:
    """Begin transcoding the given camera. Idempotent — if already
    running, returns the existing state."""
    if camera_id in _registry and not _registry[camera_id].stop_requested:
        return _registry[camera_id]

    if len(_registry) >= settings.max_concurrent_transcoders:
        # Capacity gate. The encoder slot ceiling is hard — NVENC will
        # reject the OpenSession call once exhausted, which we'd see as
        # repeated FFmpeg exits. Better to refuse upfront.
        raise RuntimeError(
            f"max_concurrent_transcoders reached ({settings.max_concurrent_transcoders}); "
            "stop an existing transcoder before starting another"
        )

    src, dst = make_paths(camera_id)
    state = TranscoderState(
        camera_id=camera_id,
        src_path=src,
        dst_path=dst,
        bitrate_kbps=bitrate_kbps or settings.nvenc_bitrate_kbps,
    )
    _registry[camera_id] = state
    state.supervisor_task = asyncio.create_task(_supervise(state))
    return state


async def stop(camera_id: str) -> bool:
    """Stop a running transcoder. Returns True if one was found + stopped."""
    state = _registry.get(camera_id)
    if not state:
        return False
    state.stop_requested = True
    if state.process and state.process.returncode is None:
        try:
            state.process.terminate()
            try:
                await asyncio.wait_for(state.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                state.process.kill()
                await state.process.wait()
        except ProcessLookupError:
            pass
    if state.supervisor_task and not state.supervisor_task.done():
        try:
            await asyncio.wait_for(state.supervisor_task, timeout=2)
        except asyncio.TimeoutError:
            state.supervisor_task.cancel()
    # Keep the state object around so /status still shows the last logs.
    return True


def list_states() -> list[TranscoderState]:
    return list(_registry.values())


def get(camera_id: str) -> Optional[TranscoderState]:
    return _registry.get(camera_id)
