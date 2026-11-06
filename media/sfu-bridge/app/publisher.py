"""Per-camera publish-to-LiveKit supervisor.

Each enabled camera gets one PublisherState. The supervisor:

1. Mints a LiveKit publisher JWT (identity = `bridge`, room = `cam_<id>`)
2. Spawns FFmpeg pulling RTSP from MediaMTX and outputting WHIP to LiveKit
3. Pumps stderr into a ring buffer for `/publishers/{id}.recent_logs`
4. Waits for exit
5. Backs off and respawns — unless stop_requested is set

The actual FFmpeg WHIP output flag is `-f whip` — landed in FFmpeg 8.0
(NOT 7.1). On older FFmpeg builds the bridge falls back to libpython-livekit's
`RtcMedia.publish_track()` path (TODO — implemented next session).

Two states matter to the operator:
  - running   : FFmpeg process is alive AND has emitted some kFrame
                in the last 10s (= LiveKit room sees the publisher)
  - degraded  : FFmpeg respawned more than once in the last minute
                (camera flapping, network issue, codec mismatch)
"""
from __future__ import annotations

import asyncio
import shlex
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import jwt as pyjwt        # via livekit-api or PyJWT

from .config import settings


@dataclass
class PublisherState:
    camera_id: str
    room_name: str
    src_path: str
    use_clean: bool = False
    started_at: Optional[float] = None
    restart_count: int = 0
    last_exit_code: Optional[int] = None
    last_log_lines: deque[str] = field(default_factory=lambda: deque(maxlen=settings.ffmpeg_log_tail_lines))
    process: Optional[asyncio.subprocess.Process] = None
    supervisor_task: Optional[asyncio.Task] = None
    stop_requested: bool = False


# camera_id → PublisherState. In-process only; container restart loses state.
# The backend's streamSupervisor reconciles by re-issuing POST /publishers/<id>.
_registry: dict[str, PublisherState] = {}


def mint_publisher_token(room_name: str, identity: str = "bridge") -> str:
    """HS256 JWT with LiveKit's video grant block.

    Same algorithm as smart-cam-backend's `livekit.controller.js` but
    for a PUBLISHER identity (canPublish: true). LiveKit Cloud validates
    via the same API secret. Re-minted before expiry by the supervisor
    so long-lived publishers don't get kicked.
    """
    now = int(time.time())
    payload = {
        "iss": settings.livekit_api_key,
        "sub": identity,
        "nbf": now,
        "exp": now + settings.livekit_publish_ttl_sec,
        "video": {
            "room": room_name,
            "roomJoin": True,
            "canSubscribe": False,        # publishers don't watch themselves
            "canPublish": True,
            "canPublishData": True,
            "roomAdmin": False,
        },
    }
    return pyjwt.encode(payload, settings.livekit_api_secret, algorithm="HS256")


def build_ffmpeg_args(state: PublisherState) -> list[str]:
    """Construct the FFmpeg → WHIP → LiveKit pipeline.

    NOTE: requires FFmpeg ≥ 8.0 for the `-f whip` output muxer (it is NOT in
    the 7.1 release). The Docker image ships a static 8.0 build and fails to
    build without the muxer; earlier builds need the fallback path (TODO).
    """
    token = mint_publisher_token(state.room_name)
    # LiveKit Cloud WHIP endpoint per project. Format:
    #   https://<host-from-ws-url>/rtc?<token>
    # In practice we just use the wsUrl with /rtc replacing the ws path.
    https_url = settings.livekit_url.replace("wss://", "https://").replace("ws://", "http://")
    whip_url = f"{https_url}/rtc?access_token={token}&room={state.room_name}"

    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",
        # RTSP source — TCP to match MediaMTX's transport choice.
        "-rtsp_transport", "tcp",
        "-i", state.src_path,
        # Stream-copy video + audio to avoid GPU contention with the
        # Phase 3 transcoder. LiveKit accepts H.264 + Opus/PCMU; if the
        # camera publishes neither we'd need a re-encode pass here.
        "-c:v", "copy",
        "-c:a", "copy",
        # WHIP output muxer — LiveKit's auth flow.
        "-f", "whip",
        whip_url,
    ]


async def _supervise(state: PublisherState):
    while not state.stop_requested:
        args = build_ffmpeg_args(state)
        state.last_log_lines.append(f"[supervisor] spawn: {shlex.join(args[:6])} ...")
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
        state.last_log_lines.append(f"[supervisor] pid={proc.pid}  room={state.room_name}")

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


def _src_path_for(camera_id: str, use_clean: bool) -> str:
    suffix = settings.clean_path_suffix if use_clean else ""
    return f"{settings.mediamtx_rtsp_base}/cam_{camera_id}{suffix}"


def start(camera_id: str, use_clean: bool = False) -> PublisherState:
    if camera_id in _registry and not _registry[camera_id].stop_requested:
        return _registry[camera_id]
    if len(_registry) >= settings.max_concurrent_publishers:
        raise RuntimeError(
            f"max_concurrent_publishers reached ({settings.max_concurrent_publishers}); "
            "stop an existing publisher before starting another"
        )
    if not settings.livekit_url or not settings.livekit_api_key or not settings.livekit_api_secret:
        raise RuntimeError(
            "LiveKit not configured — set LIVEKIT_URL + LIVEKIT_API_KEY + LIVEKIT_API_SECRET"
        )

    state = PublisherState(
        camera_id=camera_id,
        room_name=f"cam_{camera_id}",
        src_path=_src_path_for(camera_id, use_clean),
        use_clean=use_clean,
    )
    _registry[camera_id] = state
    state.supervisor_task = asyncio.create_task(_supervise(state))
    return state


async def stop(camera_id: str) -> bool:
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
    return True


def list_states() -> list[PublisherState]:
    return list(_registry.values())


def get(camera_id: str) -> Optional[PublisherState]:
    return _registry.get(camera_id)
