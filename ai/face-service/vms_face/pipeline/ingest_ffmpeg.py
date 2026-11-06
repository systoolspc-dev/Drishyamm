"""RTSP ingest through one ffmpeg process per camera — decode leaves Python.

Why (docs/FACE_SYSTEM_DESIGN.md, Phase 2.5): with inference in the service,
four camera shards still spent ~19 ms of CPU per emitted frame, almost all
of it in the per-camera PyAV threads — every source frame decoded at 25 fps
to emit 8, the NV12 download and the BGR conversion done while holding the
interpreter lock, which starved the event loop past ~10 cameras per process.

Here ffmpeg does all of that in its own process: NVDEC decode, `fps=N`
applied to the CUDA frames *before* the download (so only the frames we keep
cross the bus), one NV12→BGR conversion per kept frame, raw BGR over a pipe.
The reader thread's per-frame Python is a `readinto()` that releases the GIL
and a `frombuffer()`. Same surface as `RTSPIngest`: `open()`, `read_frame()`
(freshest frame, drop-old), `close()`, the decode counters `stats()` reads.

    ffmpeg -rtsp_transport tcp -hwaccel cuda -hwaccel_output_format cuda -i URL
           -an -vf fps=8,hwdownload,format=nv12 -pix_fmt bgr24 -f rawvideo pipe:1

Falls back to software decode (`-vf fps=8`) when the hardware pipeline cannot
start and `rtsp_hwaccel_fallback` allows it. Closing is a SIGTERM to a child
process: no shared libav state, nothing to race.
"""
from __future__ import annotations

import contextlib
import os
import re
import subprocess
import threading
import time

import numpy as np

from vms_face.config import settings
from vms_face.core.exceptions import StreamError
from vms_face.core.logging import get_logger
from vms_face.core.metrics import DECODE_ERRORS, HW_DECODE
from vms_face.pipeline.ingest import Frame

log = get_logger(__name__)

_SIZE_RE = re.compile(r"Video: rawvideo.*?(\d{2,5})x(\d{2,5})")
_ERROR_RE = re.compile(r"\b(error|Error|invalid|corrupt|missing reference|Could not find ref)\b")


class FfmpegIngest:
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
        self._rtsp_transport = rtsp_transport
        self._timeout_sec = int(timeout_sec)
        self._camera_label = camera_label
        self._proc: subprocess.Popen | None = None
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._reader_stop = threading.Event()
        self._latest_lock = threading.Lock()
        self._latest_frame: Frame | None = None
        self._latest_dropped_count = 0
        self._reader_eof = False
        self._size: tuple[int, int] | None = None
        self._first_frame: Frame | None = None
        self._seq = 0
        self.hw_decode: bool | None = None
        self.frames_decoded_ok = 0
        self.frames_decode_failed = 0
        self.packets_demux_failed = 0
        self._stderr_tail: list[str] = []

    # ── command line ────────────────────────────────────────────────────

    def _command(self, *, hw: bool) -> list[str]:
        fps = f"{self._target_fps:g}"
        cmd = [
            settings.ffmpeg_binary, "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
            "-rtsp_transport", self._rtsp_transport,
            # socket timeout (µs) so a dead source errors out instead of hanging
            "-timeout", str(self._timeout_sec * 1_000_000),
            "-max_delay", str(int(max(0.1, float(settings.rtsp_max_delay_sec)) * 1_000_000)),
            "-reorder_queue_size", "500",
            "-fflags", "+discardcorrupt+genpts+nobuffer",
            "-flags", "low_delay",
            "-err_detect", "ignore_err",
            "-probesize", "1000000", "-analyzeduration", "1000000",
        ]
        if hw:
            cmd += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
        else:
            cmd += ["-threads", str(max(1, int(settings.ffmpeg_sw_threads)))]
        cmd += ["-i", self._source, "-an", "-sn", "-dn"]
        if hw:
            # fps before hwdownload: dropped frames never leave the GPU.
            cmd += ["-vf", f"fps={fps},hwdownload,format=nv12"]
        else:
            cmd += ["-vf", f"fps={fps}"]
        cmd += ["-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"]
        return cmd

    # ── lifecycle ───────────────────────────────────────────────────────

    def open(self) -> None:
        want_hw = (settings.rtsp_hwaccel or "").strip().lower() == "cuda"
        attempts = [True, False] if (want_hw and settings.rtsp_hwaccel_fallback) else [want_hw]
        last_err = ""
        for hw in attempts:
            try:
                self._start(hw=hw)
                return
            except StreamError as e:
                last_err = str(e)
                self._kill()
                if hw and len(attempts) > 1:
                    low = last_err.lower()
                    if not any(k in low for k in ("cuda", "hwaccel", "nvdec", "cuvid", "hwdownload", "device")):
                        # The source, not the decoder, failed (timeout, RTSP error):
                        # a software retry would only add 0.4 core per camera.
                        break
                    log.warning("hardware decode pipeline failed; falling back to software",
                                camera=self._camera_label, err=last_err[:200])
        raise StreamError(f"failed to open {self._source!r}: {last_err}")

    def _start(self, *, hw: bool) -> None:
        cmd = self._command(hw=hw)
        # An NVDEC decoder creates a CUDA context; on this platform that must
        # not overlap with any other context creation on the box
        # (infra/cuda_gate.py). Hold the gate from spawn until ffmpeg reports
        # its output stream — the context exists by then — but never longer
        # than a few seconds: a source that does not answer creates nothing.
        gate = contextlib.ExitStack()
        if hw:
            from vms_face.infra.cuda_gate import cuda_init_gate
            gate.enter_context(cuda_init_gate("ffmpeg nvdec"))
        gate_until = time.monotonic() + 15.0
        try:
            try:
                self._proc = subprocess.Popen(
                    cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                )
            except OSError as e:
                raise StreamError(f"ffmpeg not runnable: {e}") from e
            assert self._proc.stderr is not None
            # Read ffmpeg's header until the output stream line tells us the
            # frame size, or the process dies (bad URL, no NVDEC, ...).
            deadline = time.monotonic() + self._timeout_sec + 10
            size = None
            while size is None:
                now = time.monotonic()
                if now > deadline:
                    raise StreamError("ffmpeg did not report an output stream in time")
                if now > gate_until:
                    gate.close()   # release the box-wide gate; keep waiting
                line = self._proc.stderr.readline()
                if not line:
                    rc = self._proc.poll()
                    raise StreamError(f"ffmpeg exited (rc={rc}) before producing video: {' | '.join(self._stderr_tail[-4:])}")
                text = line.decode("utf-8", "replace").rstrip()
                self._stderr_tail = (self._stderr_tail + [text])[-12:]
                m = _SIZE_RE.search(text)
                if m and "Output" not in text:
                    size = (int(m.group(1)), int(m.group(2)))
            # The decoder (and its CUDA context) only exists once frames flow:
            # read the first frame here, still inside the gate.
            first = self._read_first_frame(size, deadline)
        finally:
            gate.close()
        self._size = size
        self._first_frame = first
        self.hw_decode = hw
        HW_DECODE.labels(camera_id=self._camera_label).set(1 if hw else 0)
        with self._latest_lock:
            self._latest_frame = first
            self._latest_dropped_count = 0
        self._reader_eof = False
        self._reader_stop.clear()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, name=f"ffmpeg-log-{self._camera_label}", daemon=True)
        self._stderr_thread.start()
        self._reader_thread = threading.Thread(target=self._reader_loop, name=f"ffmpeg-reader-{self._camera_label}", daemon=True)
        self._reader_thread.start()
        log.info("decoder", source=self._source, hw=hw, backend="ffmpeg", size=f"{size[0]}x{size[1]}",
                 fps=self._target_fps, pid=self._proc.pid)

    def _read_first_frame(self, size: tuple[int, int], deadline: float) -> Frame:
        assert self._proc is not None and self._proc.stdout is not None
        w, h = size
        nbytes = w * h * 3
        buf = bytearray(nbytes)
        view = memoryview(buf)
        got = 0
        while got < nbytes:
            if time.monotonic() > deadline:
                raise StreamError("ffmpeg produced no frame in time")
            n = self._proc.stdout.readinto(view[got:])
            if not n:
                rc = self._proc.poll()
                raise StreamError(f"ffmpeg exited (rc={rc}) before the first frame: {' | '.join(self._stderr_tail[-4:])}")
            got += n
        self._seq += 1
        self.frames_decoded_ok += 1
        return Frame(bgr=np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3), ts=time.time(), pts=None, seq=self._seq)

    def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw in iter(proc.stderr.readline, b""):
                text = raw.decode("utf-8", "replace").rstrip()
                self._stderr_tail = (self._stderr_tail + [text])[-12:]
                if _ERROR_RE.search(text):
                    self.frames_decode_failed += 1
                    DECODE_ERRORS.labels(camera_id=self._camera_label, kind="decode").inc()
        except Exception:  # noqa: BLE001 - pipe closed under us
            pass

    def _reader_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None or self._size is None:
            self._reader_eof = True
            return
        w, h = self._size
        nbytes = w * h * 3
        stdout = proc.stdout
        try:
            while not self._reader_stop.is_set():
                buf = bytearray(nbytes)
                view = memoryview(buf)
                got = 0
                while got < nbytes:
                    n = stdout.readinto(view[got:])   # releases the GIL
                    if not n:
                        self._reader_eof = True
                        return
                    got += n
                self._seq += 1
                self.frames_decoded_ok += 1
                frame = Frame(
                    bgr=np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3),
                    ts=time.time(), pts=None, seq=self._seq,
                )
                with self._latest_lock:
                    if self._latest_frame is not None:
                        self._latest_dropped_count += 1
                    self._latest_frame = frame
        except Exception as e:  # noqa: BLE001
            log.warning("ffmpeg reader thread crashed", source=self._source, camera=self._camera_label, err=str(e))
            self._reader_eof = True

    def read_frame(self) -> Frame | None:
        if self._proc is None:
            raise StreamError("ingest not opened")
        while True:
            if self._reader_stop.is_set():
                return None
            with self._latest_lock:
                f = self._latest_frame
                if f is not None:
                    self._latest_frame = None
                    return f
            if self._reader_eof:
                rc = self._proc.poll()
                if rc not in (None, 0):
                    self.packets_demux_failed += 1
                    DECODE_ERRORS.labels(camera_id=self._camera_label, kind="demux").inc()
                    log.warning("ffmpeg exited", camera=self._camera_label, rc=rc, tail=" | ".join(self._stderr_tail[-3:]))
                return None
            time.sleep(0.010)

    def _kill(self) -> None:
        proc = self._proc
        if proc is None:
            return
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2.0)
        except Exception:  # noqa: BLE001
            pass
        for pipe in (proc.stdout, proc.stderr):
            try:
                if pipe is not None:
                    pipe.close()
            except Exception:  # noqa: BLE001
                pass
        self._proc = None

    def close(self) -> None:
        self._reader_stop.set()
        self._kill()   # the reader unblocks on EOF once the pipe closes
        t = self._reader_thread
        if t is not None and t.is_alive():
            t.join(timeout=2.0)
        self._reader_thread = None
        self._stderr_thread = None
        with self._latest_lock:
            self._latest_frame = None

    def __enter__(self) -> "FfmpegIngest":
        self.open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()
