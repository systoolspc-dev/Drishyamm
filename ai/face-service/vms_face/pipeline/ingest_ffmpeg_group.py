"""Decoder groups: one ffmpeg process decodes K cameras on ONE CUDA context.

Why: with one ffmpeg per camera (pipeline/ingest_ffmpeg.py) every decoder is
its own CUDA context — ~270 MB RSS / ~105 MB PSS per camera, and on this box
(Docker Desktop, WSL2 GPU-PV) the driver layer failed once ~60 contexts were
alive. A group shares the context: `-init_hw_device cuda=gpu` once, every
input decodes on it, every input gets its own rawvideo output on its own pipe.

    ffmpeg -init_hw_device cuda=gpu -filter_hw_device gpu
           [-hwaccel cuda -hwaccel_device gpu -hwaccel_output_format cuda -i URL_i]*
           [-map i:v -vf fps=8,hwdownload,format=nv12 -pix_fmt bgr24 -f rawvideo pipe:FD_i]*

Members that ask to open within `ffmpeg_group_window_sec` of each other (up to
`ffmpeg_group_size`) start together. A member whose input dies stops getting
frames — its orchestrator times out, closes the member and reopens into the
next group; the process keeps running for the others. When every member of a
group has closed, the process is terminated. Same surface as RTSPIngest.
"""
from __future__ import annotations

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

_OUT_RE = re.compile(r"^Output #(\d+),")
_SIZE_RE = re.compile(r"Video: rawvideo.*?(\d{2,5})x(\d{2,5})")
_BAD_INPUT_RE = re.compile(r"Error opening input file (\S+?)\.?$")


class _Pending:
    def __init__(self, member: "GroupMember") -> None:
        self.member = member
        self.done = threading.Event()
        self.error: str | None = None


class DecoderGroup:
    """One ffmpeg process, N inputs, N rawvideo pipes."""

    def __init__(self, members: list["GroupMember"]) -> None:
        self.members = members
        self._proc: subprocess.Popen | None = None
        self._pipes: list[tuple[int, int]] = []       # (read fd, write fd) per member
        self._threads: list[threading.Thread] = []
        self._alive = 0
        self._lock = threading.Lock()
        self._stderr_tail: list[str] = []
        self.hw = True

    # ── start ────────────────────────────────────────────────────────────

    def _command(self, urls: list[str], fps: list[float], write_fds: list[int]) -> list[str]:
        cmd = [settings.ffmpeg_binary, "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
               "-init_hw_device", "cuda=gpu", "-filter_hw_device", "gpu"]
        for url in urls:
            cmd += ["-rtsp_transport", "tcp", "-timeout", str(int(settings.rtsp_timeout_sec) * 1_000_000),
                    "-max_delay", str(int(max(0.1, float(settings.rtsp_max_delay_sec)) * 1_000_000)),
                    "-reorder_queue_size", "500", "-fflags", "+discardcorrupt+genpts+nobuffer",
                    "-flags", "low_delay", "-err_detect", "ignore_err",
                    "-probesize", "1000000", "-analyzeduration", "1000000",
                    "-hwaccel", "cuda", "-hwaccel_device", "gpu", "-hwaccel_output_format", "cuda",
                    "-i", url]
        for i, (f, fd) in enumerate(zip(fps, write_fds)):
            cmd += ["-map", f"{i}:v", "-an", "-sn", "-dn", "-vf", f"fps={f:g},hwdownload,format=nv12",
                    "-pix_fmt", "bgr24", "-f", "rawvideo", f"pipe:{fd}"]
        return cmd

    def start(self) -> None:
        from vms_face.infra.cuda_gate import cuda_init_gate

        urls = [m.source for m in self.members]
        fps = [m.target_fps for m in self.members]
        self._pipes = [os.pipe() for _ in self.members]
        write_fds = [w for _r, w in self._pipes]
        for r, _w in self._pipes:
            os.set_inheritable(r, False)
        cmd = self._command(urls, fps, write_fds)
        sizes: dict[int, tuple[int, int]] = {}
        # One CUDA context per group: the gate is held for the whole start.
        with cuda_init_gate(f"ffmpeg group x{len(self.members)}"):
            try:
                self._proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                              stderr=subprocess.PIPE, pass_fds=write_fds, bufsize=0)
            except OSError as e:
                self._close_pipes()
                raise StreamError(f"ffmpeg not runnable: {e}") from e
            for _r, w in self._pipes:
                os.close(w)           # the child holds the write ends now
            assert self._proc.stderr is not None
            deadline = time.monotonic() + int(settings.rtsp_timeout_sec) + 15
            current_out = -1
            while len(sizes) < len(self.members):
                if time.monotonic() > deadline:
                    self._kill()
                    raise StreamError("ffmpeg group did not report every output stream in time")
                line = self._proc.stderr.readline()
                if not line:
                    rc = self._proc.poll()
                    tail = " | ".join(self._stderr_tail[-6:])
                    self._kill()
                    raise StreamError(f"ffmpeg group exited (rc={rc}) before producing video: {tail}")
                text = line.decode("utf-8", "replace").rstrip()
                self._stderr_tail = (self._stderr_tail + [text])[-20:]
                m = _OUT_RE.match(text)
                if m:
                    current_out = int(m.group(1))
                    continue
                m = _SIZE_RE.search(text)
                if m and current_out >= 0 and current_out not in sizes:
                    sizes[current_out] = (int(m.group(1)), int(m.group(2)))
        self._alive = len(self.members)
        for i, member in enumerate(self.members):
            member._attach(self, self._pipes[i][0], sizes[i])
            HW_DECODE.labels(camera_id=member.camera_label).set(1)
        drain = threading.Thread(target=self._drain_stderr, name="ffmpeg-group-log", daemon=True)
        drain.start()
        self._threads.append(drain)
        for member in self.members:
            t = threading.Thread(target=member._reader_loop, name=f"ffmpeg-reader-{member.camera_label}", daemon=True)
            t.start()
            self._threads.append(t)
        log.info("decoder group started", cameras=len(self.members), pid=self._proc.pid,
                 sizes=sorted({f"{w}x{h}" for w, h in sizes.values()}))

    # ── run / stop ───────────────────────────────────────────────────────

    def _drain_stderr(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw in iter(proc.stderr.readline, b""):
                text = raw.decode("utf-8", "replace").rstrip()
                self._stderr_tail = (self._stderr_tail + [text])[-20:]
                if "error" in text.lower() or "Could not find ref" in text:
                    for m in self.members:
                        m.frames_decode_failed += 1   # attribution per input is not in the log line
        except Exception:  # noqa: BLE001
            pass

    def member_closed(self) -> None:
        with self._lock:
            self._alive -= 1
            last = self._alive <= 0
        if last:
            self._kill()

    def _kill(self) -> None:
        proc = self._proc
        if proc is not None:
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
            try:
                if proc.stderr is not None:
                    proc.stderr.close()
            except Exception:  # noqa: BLE001
                pass
        self._close_pipes()

    def _close_pipes(self) -> None:
        for r, _w in self._pipes:
            try:
                os.close(r)
            except OSError:
                pass
        self._pipes = []

    @property
    def exited(self) -> bool:
        return self._proc is None or self._proc.poll() is not None


class GroupMember:
    """The per-camera object the orchestrator drives (same surface as RTSPIngest)."""

    def __init__(self, source: str, *, target_fps: float = 8.0, rtsp_transport: str = "tcp",
                 timeout_sec: int = 10, camera_label: str = "unknown") -> None:
        self.source = source
        self.target_fps = max(0.1, float(target_fps))
        self.camera_label = camera_label
        self._group: DecoderGroup | None = None
        self._fd: int | None = None
        self._size: tuple[int, int] | None = None
        self._latest_lock = threading.Lock()
        self._latest_frame: Frame | None = None
        self._latest_dropped_count = 0
        self._reader_eof = False
        self._closed = False
        self._seq = 0
        self.hw_decode: bool | None = None
        self.frames_decoded_ok = 0
        self.frames_decode_failed = 0
        self.packets_demux_failed = 0

    def open(self) -> None:
        self._closed = False
        self._reader_eof = False
        with self._latest_lock:
            self._latest_frame = None
        get_manager().open(self)   # blocks until our group has started (or failed)

    def _attach(self, group: DecoderGroup, read_fd: int, size: tuple[int, int]) -> None:
        self._group = group
        self._fd = read_fd
        self._size = size
        self.hw_decode = True

    def _reader_loop(self) -> None:
        fd, size = self._fd, self._size
        if fd is None or size is None:
            self._reader_eof = True
            return
        w, h = size
        nbytes = w * h * 3
        try:
            while True:
                buf = bytearray(nbytes)
                view = memoryview(buf)
                got = 0
                while got < nbytes:
                    try:
                        chunk = os.readv(fd, [view[got:]])
                    except OSError:
                        chunk = 0
                    if not chunk:
                        self._reader_eof = True
                        return
                    got += chunk
                if self._closed:
                    continue          # keep draining so the process never blocks on this pipe
                self._seq += 1
                self.frames_decoded_ok += 1
                frame = Frame(bgr=np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3), ts=time.time(), pts=None, seq=self._seq)
                with self._latest_lock:
                    if self._latest_frame is not None:
                        self._latest_dropped_count += 1
                    self._latest_frame = frame
        except Exception as e:  # noqa: BLE001
            log.warning("group reader thread crashed", camera=self.camera_label, err=str(e))
            self._reader_eof = True

    def read_frame(self) -> Frame | None:
        if self._group is None:
            raise StreamError("ingest not opened")
        while True:
            if self._closed:
                return None
            with self._latest_lock:
                f = self._latest_frame
                if f is not None:
                    self._latest_frame = None
                    return f
            if self._reader_eof or self._group.exited:
                if self._group.exited:
                    self.packets_demux_failed += 1
                    DECODE_ERRORS.labels(camera_id=self.camera_label, kind="demux").inc()
                return None
            time.sleep(0.010)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with self._latest_lock:
            self._latest_frame = None
        g = self._group
        self._group = None
        if g is not None:
            g.member_closed()


class GroupManager:
    """Batches concurrent opens into groups of up to `ffmpeg_group_size`."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: list[_Pending] = []
        self._timer: threading.Timer | None = None

    def open(self, member: GroupMember) -> None:
        p = _Pending(member)
        launch: list[_Pending] | None = None
        with self._lock:
            self._pending.append(p)
            if len(self._pending) >= max(1, int(settings.ffmpeg_group_size)):
                launch, self._pending = self._pending, []
                if self._timer is not None:
                    self._timer.cancel()
                    self._timer = None
            elif self._timer is None:
                self._timer = threading.Timer(float(settings.ffmpeg_group_window_sec), self._flush)
                self._timer.daemon = True
                self._timer.start()
        if launch is not None:
            self._launch(launch)
        if not p.done.wait(timeout=float(settings.rtsp_timeout_sec) + 60):
            raise StreamError("decoder group start timed out")
        if p.error:
            raise StreamError(p.error)

    def _flush(self) -> None:
        with self._lock:
            launch, self._pending = self._pending, []
            self._timer = None
        if launch:
            self._launch(launch)

    def _launch(self, batch: list[_Pending]) -> None:
        pendings = list(batch)
        for _attempt in range(2):
            group = DecoderGroup([p.member for p in pendings])
            try:
                group.start()
                for p in pendings:
                    p.done.set()
                return
            except StreamError as e:
                msg = str(e)
                bad = _BAD_INPUT_RE.search(msg)
                bad_url = bad.group(1).rstrip(".") if bad else None
                failed = [p for p in pendings if bad_url and p.member.source == bad_url]
                if not failed or len(pendings) == 1:
                    for p in pendings:
                        p.error = msg
                        p.done.set()
                    return
                # Drop the input ffmpeg named and start the rest once more.
                for p in failed:
                    p.error = msg
                    p.done.set()
                pendings = [p for p in pendings if p not in failed]
        for p in pendings:
            p.error = "decoder group failed twice"
            p.done.set()


_manager: GroupManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> GroupManager:
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = GroupManager()
    return _manager
