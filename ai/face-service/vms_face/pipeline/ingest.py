from __future__ import annotations

import contextlib
import threading
import time
from dataclasses import dataclass
from typing import Iterator

import av
import numpy as np

from vms_face.config import settings
from vms_face.core.exceptions import StreamError
from vms_face.core.logging import get_logger
from vms_face.core.metrics import DECODE_ERRORS, HW_DECODE

log = get_logger(__name__)

AV_DECODE_ERRORS = tuple(
    exc
    for exc in (
        getattr(av, "AVError", None),
        getattr(getattr(av, "error", None), "FFmpegError", None),
        getattr(getattr(av, "error", None), "InvalidDataError", None),
    )
    if exc is not None
)


@dataclass(slots=True)
class Frame:
    """One decoded frame with monotonic ingest timestamp (epoch seconds)."""
    bgr: np.ndarray
    ts: float           # capture/ingest time
    pts: float | None   # presentation timestamp from the container (seconds)
    seq: int            # monotonic counter within this stream


def make_ingest(source: str, *, target_fps: float, camera_label: str, **kw):
    """RTSPIngest (PyAV, in-process) or FfmpegIngest (subprocess) per
    `settings.rtsp_ingest_backend`; both expose the same surface."""
    if str(settings.rtsp_ingest_backend).lower() == "ffmpeg":
        if int(settings.ffmpeg_group_size) > 1:
            from vms_face.pipeline.ingest_ffmpeg_group import GroupMember
            return GroupMember(source, target_fps=target_fps, camera_label=camera_label, **kw)
        from vms_face.pipeline.ingest_ffmpeg import FfmpegIngest
        return FfmpegIngest(source, target_fps=target_fps, camera_label=camera_label, **kw)
    return RTSPIngest(source, target_fps=target_fps, camera_label=camera_label, **kw)


class RTSPIngest:
    """PyAV-based RTSP/file ingest with frame-rate throttling.

    Why PyAV over OpenCV's cv2.VideoCapture:
      - lower CPU on RTSP (FFmpeg under the hood, not the cv2 wrapper)
      - reliable PTS / framerate
      - configurable transport (tcp), reconnect behavior

    Usage:
        ingest = RTSPIngest(url, target_fps=8)
        ingest.open()
        while True:
            frame = ingest.read_frame()       # blocks until next throttled frame
            if frame is None: break           # EOS / fatal error
            ...
        ingest.close()

    Throttling state lives on `self`, not on the inner generator. (Bug fix:
    earlier revisions wrapped each `read_frame` call as `next(iter(frames()))`
    which restarted the throttle on every call → target_fps was silently
    ignored and the orchestrator burned GPU at source FPS.)

    For Phase 2 this is replaced by DeepStream's `nvurisrcbin`."""

    def __init__(
        self,
        source: str,
        *,
        target_fps: float = 8.0,
        rtsp_transport: str = "tcp",
        timeout_sec: int = 10,
        camera_label: str = "unknown",
    ) -> None:
        self._source = source
        self._target_fps = max(0.1, float(target_fps))
        self._frame_period = 1.0 / self._target_fps
        # Emit scheduling (see _read_frame_blocking): the next due time and
        # how early a frame may be taken to hit it.
        self._emit_tolerance = min(0.25 * self._frame_period, 0.030)
        self._rtsp_transport = rtsp_transport
        self._timeout_sec = timeout_sec
        # Label used for the vms_decode_errors_total counter so operators can
        # see which camera is hot. Set by the orchestrator on construction.
        self._camera_label = camera_label
        self._container = None
        self._stream = None
        self._packet_iter: Iterator | None = None
        self._frame_iter: Iterator | None = None
        self._seq = 0
        self._last_emit_monotonic = 0.0
        self._next_emit_due = 0.0
        # Cheap counters that the orchestrator surfaces via /streams/debug.
        self.frames_decoded_ok = 0
        self.frames_decode_failed = 0
        self.packets_demux_failed = 0
        # ── Drop-old-frames reader thread ──
        # When settings.rtsp_drop_old_frames is True, open() spins up a
        # dedicated thread that continuously decodes frames at line-rate
        # and parks the most recent one in `_latest_frame`. read_frame()
        # then just pops from there. This eliminates the classic RTSP
        # buffer-lag bug where a slow orchestrator falls behind real-time
        # as old frames pile up in PyAV's demuxer queue.
        self._drop_old = bool(settings.rtsp_drop_old_frames)
        # Hardware decode: requested at open(), confirmed from the format of
        # the first decoded frame (nv12 = came through NVDEC).
        self._hw_requested = False
        self.hw_decode: bool | None = None
        self._reader_thread: threading.Thread | None = None
        self._reader_stop = threading.Event()
        self._latest_lock = threading.Lock()
        self._latest_frame: "Frame | None" = None
        self._latest_dropped_count = 0
        self._reader_eof = False
        self._close_on_reader_exit = False

    def __enter__(self) -> "RTSPIngest":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def open(self) -> None:
        # FFmpeg / PyAV options tuned for IP-camera-quality RTSP. The
        # MediaMTX logs we see in practice show RTP loss + FU-A reordering,
        # so we trade a little latency for a lot more decode success:
        #
        # - rtsp_transport=tcp: avoids UDP packet loss on the camera→MediaMTX
        #   hop. Set globally in mediamtx.yml too as defense-in-depth.
        # - stimeout: per-socket timeout for the RTSP control channel.
        # - max_delay: how long FFmpeg buffers before declaring a stream
        #   broken. 5_000_000 µs (5s) absorbs bursts of reordered packets
        #   without crashing the demuxer.
        # - reorder_queue_size: number of out-of-order RTP packets FFmpeg
        #   will hold to reorder. Default ~10. Bumping to 500 lets it
        #   handle 0.5s of reordering at 1000 packets/sec.
        # - fflags=+discardcorrupt+genpts: drop frames the decoder marks
        #   corrupt rather than passing junk down the pipeline; generate
        #   monotonic PTS so the throttling in read_frame() is sane.
        # - probesize / analyzeduration: how much data FFmpeg reads before
        #   it commits to a stream format. Defaults are conservative for
        #   live sources; bigger values let it lock onto codec parameters
        #   despite the first few packets being lost.
        # max_delay in microseconds. Smaller = less buffer lag, but lossy
        # streams will drop frames the demuxer would otherwise reorder. The
        # drop-old reader thread compensates by always returning the
        # freshest frame, so we don't need a big buffer here.
        max_delay_us = int(max(0.1, float(settings.rtsp_max_delay_sec)) * 1_000_000)
        options = {
            "rtsp_transport": self._rtsp_transport,
            "stimeout": str(self._timeout_sec * 1_000_000),
            "max_delay": str(max_delay_us),
            "reorder_queue_size": "500",
            "fflags": "+discardcorrupt+genpts+nobuffer",
            "flags": "low_delay",
            "err_detect": "ignore_err",
            "probesize": "5000000",
            "analyzeduration": "5000000",
            # buffer_size raises the kernel-level socket buffer so a burst
            # of RTP packets doesn't get dropped before user-space reads it.
            "buffer_size": "8388608",
        }
        # Hardware decode (RTSP_HWACCEL=cuda -> NVDEC). This has to be PyAV's
        # HWAccel object: passing "hwaccel" as a demuxer *option*, as the old
        # code did, is silently ignored by FFmpeg — the stream decoded in
        # software while the setting claimed otherwise. Measured with the real
        # API on this box: 1080p HEVC 15.1 -> 9.6 ms CPU per frame; what is
        # left is the download + NV12->BGR conversion (docs/FACE_SYSTEM_DESIGN.md
        # §1.2). Frames arrive as nv12 and `to_ndarray("bgr24")` converts them
        # like any other format, so nothing downstream changes.
        hwaccel = (settings.rtsp_hwaccel or "").strip().lower()
        hw = None
        if hwaccel:
            from av.codec.hwaccel import HWAccel

            hw = HWAccel(
                device_type=hwaccel,
                allow_software_fallback=bool(settings.rtsp_hwaccel_fallback),
            )
        self._hw_requested = hw is not None
        self.hw_decode = None
        # av.open with an HWAccel creates the CUDA device context right here
        # (faulthandler put every crash of 2026-09-22 on this line): one at a
        # time across the box, like every other context creation
        # (infra/cuda_gate.py).
        from vms_face.infra.cuda_gate import cuda_init_gate
        try:
            with (cuda_init_gate("pyav nvdec open") if hw is not None else contextlib.nullcontext()):
                self._container = av.open(
                    self._source, options=options, timeout=self._timeout_sec, hwaccel=hw
                )
        except Exception as e:
            raise StreamError(f"failed to open {self._source!r}: {e}") from e

        stream = next((s for s in self._container.streams if s.type == "video"), None)
        if stream is None:
            self._container.close()
            self._container = None
            raise StreamError(f"{self._source!r} has no video stream")
        stream.thread_type = "AUTO"
        # AUTO alone let FFmpeg spawn 16 frame threads per stream (measured
        # av:hevc:df0..15). Two keep a 1080p decode ahead of an 8 fps consumer;
        # a hardware decoder needs one.
        stream.thread_count = 1 if hw is not None else max(1, int(settings.rtsp_decode_threads))
        self._stream = stream
        self._packet_iter = self._container.demux(self._stream)
        self._frame_iter = None
        self._last_emit_monotonic = 0.0
        self._next_emit_due = 0.0
        # Reset reader-thread state for this open() — old thread (if any)
        # was stopped in close(); start a fresh one.
        with self._latest_lock:
            self._latest_frame = None
            self._latest_dropped_count = 0
        self._reader_eof = False
        self._close_on_reader_exit = False
        self._reader_stop.clear()
        if self._drop_old:
            self._reader_thread = threading.Thread(
                target=self._reader_loop,
                name=f"rtsp-reader-{self._camera_label}",
                daemon=True,
            )
            self._reader_thread.start()

    def close(self) -> None:
        # Stop the reader thread first so it doesn't try to demux a closed
        # container. If it has not come back within the join timeout it is
        # inside libav (a demux read waiting on the socket, or NVDEC), and
        # closing the container under it is a use-after-free: that took a
        # shard down with SIGSEGV on a mass stop (2026-09-21, ~20 s after the
        # stops, when the blocked reads finally returned into freed memory).
        # Hand the container to the thread instead — it closes it when it
        # exits, which the demux timeout bounds. The caller never waits
        # longer than the join timeout either way.
        t = self._reader_thread
        if t is not None and t.is_alive():
            self._reader_stop.set()
            t.join(timeout=2.0)
            if t.is_alive():
                self._close_on_reader_exit = True
                self._reader_thread = None
                with self._latest_lock:
                    self._latest_frame = None
                log.warning("rtsp reader busy at close; container closes when it exits",
                            source=self._source, camera=self._camera_label)
                return
        self._reader_thread = None
        self._release_container()

    def _release_container(self) -> None:
        container = self._container
        self._container = None
        self._stream = None
        self._packet_iter = None
        self._frame_iter = None
        with self._latest_lock:
            self._latest_frame = None
        if container is not None:
            # Context destruction bursts (a mass stop) go through the same gate
            # as creation; a close is milliseconds.
            from vms_face.infra.cuda_gate import cuda_init_gate
            try:
                with (cuda_init_gate("pyav close") if self._hw_requested else contextlib.nullcontext()):
                    container.close()
            except Exception:
                pass

    # ── Public read_frame: dispatches to thread or blocking path ─────────

    def read_frame(self) -> Frame | None:
        """Pull a frame. In drop-old mode this returns the freshest decoded
        frame the reader thread has parked (or blocks briefly waiting for one).
        In legacy mode this is a blocking pull of the next demuxed frame —
        the same behaviour the orchestrator used before the drop-old reader."""
        if self._container is None or self._stream is None or self._packet_iter is None:
            raise StreamError("ingest not opened")
        if self._drop_old:
            return self._pop_latest_frame()
        return self._read_frame_blocking()

    def _pop_latest_frame(self) -> Frame | None:
        """Drop-old mode reader. Blocks briefly until the reader thread has
        produced a fresh frame, then pops and returns it. Each call returns
        a *distinct* frame — the slot is cleared on pop so we never return
        the same frame twice. Returns None if the reader thread terminated
        (EOS / fatal error)."""
        # The orchestrator wraps this in an asyncio.wait_for(timeout=...),
        # so we just spin briefly here. 10ms is a good poll period —
        # short enough not to add visible latency, long enough not to
        # burn a thread.
        while True:
            if self._reader_stop.is_set():
                return None
            with self._latest_lock:
                f = self._latest_frame
                if f is not None:
                    self._latest_frame = None
                    return f
            if self._reader_eof:
                return None
            time.sleep(0.010)

    def _reader_loop(self) -> None:
        """Background thread: continuously decode frames and park the most
        recent one in `_latest_frame`, discarding any previous one. This is
        the textbook fix for the "RTSP camera buffer lag" problem — see
        e.g. StackOverflow #60816436."""
        try:
            while not self._reader_stop.is_set():
                frame = self._read_frame_blocking()
                if frame is None:
                    # Demuxer signalled EOS (or unrecoverable error).
                    self._reader_eof = True
                    return
                with self._latest_lock:
                    # If a previous frame is still here unconsumed, the
                    # orchestrator was slower than line-rate — count the
                    # drop so it shows up in /streams/debug.
                    if self._latest_frame is not None:
                        self._latest_dropped_count += 1
                    self._latest_frame = frame
        except Exception as e:
            # Reader thread should never crash silently. Log + set EOF so
            # the consumer's wait loop exits cleanly.
            log.warning(
                "rtsp reader thread crashed",
                source=self._source,
                camera=self._camera_label,
                err=str(e),
            )
            self._reader_eof = True
        finally:
            if self._close_on_reader_exit:
                self._release_container()

    def _read_frame_blocking(self) -> Frame | None:
        """The original blocking demux+decode logic. Called either from the
        reader thread (drop-old mode) or directly from read_frame() (legacy
        mode). Returns None on EOS."""
        if self._container is None or self._stream is None or self._packet_iter is None:
            return None
        while True:
            if self._reader_stop.is_set():
                return None   # close() asked; don't chase the next emit
            # Pull next decoded frame, refilling from the next packet as needed.
            if self._frame_iter is not None:
                try:
                    av_frame = next(self._frame_iter)
                except StopIteration:
                    self._frame_iter = None
                    av_frame = None
                except AV_DECODE_ERRORS as e:
                    self.frames_decode_failed += 1
                    DECODE_ERRORS.labels(camera_id=self._camera_label, kind="decode").inc()
                    log.warning("decode error", source=self._source, err=str(e))
                    self._frame_iter = None
                    av_frame = None
            else:
                av_frame = None

            if av_frame is None:
                try:
                    packet = next(self._packet_iter)
                except StopIteration:
                    return None
                except AV_DECODE_ERRORS as e:
                    self.packets_demux_failed += 1
                    DECODE_ERRORS.labels(camera_id=self._camera_label, kind="demux").inc()
                    log.warning("packet demux error", source=self._source, err=str(e))
                    continue
                try:
                    self._frame_iter = iter(packet.decode())
                except AV_DECODE_ERRORS as e:
                    self.frames_decode_failed += 1
                    DECODE_ERRORS.labels(camera_id=self._camera_label, kind="packet_decode").inc()
                    log.warning("packet decode failed", source=self._source, err=str(e))
                    self._frame_iter = None
                continue

            now = time.monotonic()
            # Schedule the next emit from the previous DUE time, not from when
            # the previous frame happened to arrive, and accept a frame a
            # little early. Measuring from the last emit quantised the rate to
            # the source's own frame interval: a 25 fps camera could only
            # clear a 125 ms bar every 4th-5th frame (6.25 fps) and an 8 fps
            # source with a hair of jitter only every other frame (~5 fps).
            # Measured before this fix: 4.8-6.0 fps against a target of 8, on
            # every camera, at every load.
            if now + self._emit_tolerance < self._next_emit_due:
                continue
            if now - self._next_emit_due > self._frame_period:
                self._next_emit_due = now          # fell behind: resync, never burst
            self._next_emit_due += self._frame_period
            self._last_emit_monotonic = now

            if self.hw_decode is None:
                fmt = getattr(getattr(av_frame, "format", None), "name", "") or ""
                self.hw_decode = fmt in ("nv12", "cuda")
                HW_DECODE.labels(camera_id=self._camera_label).set(1 if self.hw_decode else 0)
                if self._hw_requested and not self.hw_decode:
                    log.warning(
                        "hardware decode requested but frames are software-decoded",
                        source=self._source, frame_format=fmt,
                    )
                else:
                    log.info(
                        "decoder", source=self._source, hw=self.hw_decode, frame_format=fmt,
                        threads=getattr(self._stream, "thread_count", None),
                    )
            bgr = av_frame.to_ndarray(format="bgr24")
            pts = (
                float(av_frame.pts * av_frame.time_base)
                if av_frame.pts is not None and av_frame.time_base
                else None
            )
            self._seq += 1
            self.frames_decoded_ok += 1
            return Frame(bgr=bgr, ts=time.time(), pts=pts, seq=self._seq)

    # Legacy helper retained for any code that still iterates frames; new code
    # should use read_frame().
    def frames(self) -> Iterator[Frame]:
        while True:
            f = self.read_frame()
            if f is None:
                return
            yield f
