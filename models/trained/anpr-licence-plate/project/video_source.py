"""
video_source.py — one way to read HLS / RTSP / files that works in every image.

Why: the pip `opencv-python` wheel's bundled FFmpeg fails on the corp8 LL-HLS
segments ("Error when loading first segment"), while PyAV's FFmpeg decodes the
same url in 0.6 s. The plain AI image has both plus the apt ffmpeg. Rather than
depend on which OpenCV happens to be installed, prefer PyAV, fall back to
OpenCV, and give the worker ONE interface:

    src = VideoSource(url)            # starts a decode thread for live urls
    frame, ts, epoch = src.read()     # newest frame (live) / next frame (file)

Live sources are decoded continuously in a thread and only the LATEST frame is
kept — the consumer can be as slow as it likes and never sees a backlog (the
old CAP_PROP_BUFFERSIZE=1 trick, but reliable). `epoch` increments on every
reconnect so the caller can reset tracker state: ids must never bridge a
reconnect or the provider's loop point. Reconnects back off 2 s → 30 s (the
Sentinel ingest rule).
"""

from __future__ import annotations

import os
import threading
import time

import numpy as np

_BACKOFF_MIN, _BACKOFF_MAX = 2.0, 30.0


def _is_live(url: str) -> bool:
    u = url.lower()
    return u.startswith(
        ("rtsp://", "rtsps://", "http://", "https://", "udp://", "srt://")
    ) or not os.path.exists(url)


_READ_TIMEOUT = float(
    os.getenv("ANPR_READ_TIMEOUT", "30")
)  # s; LL-HLS in-progress segment fetches block up to a segment
# A corrupt packet (InvalidDataError from avcodec_send_packet, a truncated
# LL-HLS part) is skipped and counted, NOT a reconnect. The connection is
# torn down only after this many CONSECUTIVE decode/demux errors, or when no
# decodable frame arrived for ANPR_READ_TIMEOUT s (storage-perf spec §A.4).
_DECODE_ERRORS_MAX = int(os.getenv("ANPR_DECODE_ERRORS_MAX", "25"))
# ffmpeg's hls demuxer returns EOF ("stream ended") when a LIVE playlist has
# not advanced after `max_reload` (default 3) reloads — a slow origin ends the
# stream every few minutes and every reopen resets the tracker. Poll instead;
# a dead origin is still bounded by the read timeout (interrupt callback).
_HLS_OPTS = {"max_reload": os.getenv("ANPR_HLS_MAX_RELOAD", "1000")}


def _short(e: BaseException, n: int = 120) -> str:
    # Redact BEFORE truncating (4 Oct 2026): FFmpeg errors embed the source URL
    # ('…processing input: rtsp://user:secret@host/…'), and 120 log lines held
    # the provider password in clear. Truncating first can also cut the URL
    # before its '@', which the redactor then no longer recognises.
    return f"{e.__class__.__name__}: {redact_url(str(e))[:n]}"


# ── decoder-side damage signal (4 Sep 2026) ──────────────────────────────────
# The provider's streams are lossy and carry no IDR frames. After a lost packet
# the h264 decoder conceals with stale references and the picture "melts" for
# seconds — crisp OSD text over a smeared scene; two thirds of the evidence
# clips saved on 3 Sep looked like that, and a tracker fed melted pixels
# invents vehicles. libavcodec says so the moment it happens ("concealing …
# errors", "missed N packets", "reference picture missing"): those log lines
# are captured per packet, AV_FRAME_FLAG_CORRUPT is honoured, and every frame
# is reported suspect until a key frame arrives or _CORRUPT_RECOVER_SEC pass
# without new damage. The worker skips suspect frames for evidence and OCR.
_CORRUPT_RECOVER_SEC = float(os.getenv("ANPR_CORRUPT_RECOVER_SEC", "5.0"))  # a key frame ends it early
_EMPTY_RUN_DAMAGE = int(os.getenv("ANPR_EMPTY_RUN_DAMAGE", "8"))  # packets in a row with no frame out
# Stream time running this far AHEAD of wall time since the previous frame = a
# discontinuity, not jitter (same idea as vms_face pipeline_pts_cut_gap_sec).
# The grid's gap camera drops 1.55 s of frames: that is a gap, not a cut.
_PTS_JUMP_SEC = float(os.getenv("ANPR_PTS_JUMP_SEC", "2.0"))
# Stream time going BACK by more than this from the previous frame = a loop
# point / restamp. Decoded frames leave the decoder in presentation order, so
# a sane stream never steps back at all; the margin only absorbs rounding.
_PTS_BACK_SEC = float(os.getenv("ANPR_PTS_BACK_SEC", "0.25"))
# Behind the clock by more than this = a stall with continuous pts (or a
# backlog): re-anchor at "now" instead of stamping every later frame late.
_LAG_REANCHOR_SEC = float(os.getenv("ANPR_LAG_REANCHOR_SEC", "3.0"))
# RTSP live edge (2 Oct 2026). av.open() buffers packets while it probes the
# stream (0.06-2.24 s on the Sentinel rehearsal grid), so the first frame out
# of the decoder is already stale. Anchoring pts to THAT moment made every
# timestamp on the connection late by a constant. For RTSP the clock is
# anchored to the earliest (arrival - pts) any frame has shown, and the open's
# backlog is drained (not delivered) until the anchor stops moving.
# ANPR_LIVE_EDGE=0 restores the old first-frame anchor.
_LIVE_EDGE = os.getenv("ANPR_LIVE_EDGE", "1") != "0"
_EDGE_EPS = float(os.getenv("ANPR_EDGE_EPS_SEC", "0.002"))  # a smaller offset than this is jitter
_EDGE_QUIET = int(os.getenv("ANPR_EDGE_QUIET_FRAMES", "3"))  # frames in a row with no new edge = drained
_EDGE_MAX_WAIT = float(os.getenv("ANPR_EDGE_MAX_WAIT_SEC", "4.0"))  # never hold frames longer than this
_EDGE_MAX_FRAMES = int(os.getenv("ANPR_EDGE_MAX_FRAMES", "400"))
# Stamp packet k from when packet k-1 left the demuxer (= when k's first bytes
# arrived; see _PyAvReader._next_frame). 0 = from its own demux time, which is
# one frame interval late with FFmpeg's RTSP parser.
_EDGE_PREV_PACKET = os.getenv("ANPR_EDGE_PREV_PACKET", "1") != "0"
_DAMAGE_RE = __import__("re").compile(
    r"conceal|missed \d+ packets|reference picture missing|Missing reference|no frame!|error while decoding"
    r"|Invalid NAL|corrupt|decode_slice_header|cabac decode|top block unavailable|out of range"
    # HEVC (cam06 / cam12 on the grid) says it differently: a lost packet leaves a frame whose
    # reference set cannot be built, and the decoder drops it — the picture melts and stutters.
    r"|Could not find ref with POC|Error constructing the frame RPS|Skipping invalid undecodable NALU"
    r"|RTP: missed",
    __import__("re").I,
)


def redact_url(u) -> str:
    """rtsp://user:secret@host/… → rtsp://***@host/… — every log line that
    names a source goes through this, so a credentialed URL never lands in a
    container log."""
    return __import__("re").sub(r"//[^/@]+@", "//***@", str(u))


class PtsClock:
    """Stream time (pts, seconds) → wall time, for ONE connection. Pure logic:
    no FFmpeg, no sleeping, so it is unit-tested frame by frame
    (tests/test_video_source_pts.py).

    stamp(t, arr) takes a frame's pts and the wall time it arrived and returns
    (due, cut, hold):

      due   the wall time the frame belongs to (the sighting timestamp)
      cut   a stream-time discontinuity: the loop point of a looping feed, a
            gateway restamp. The caller starts a new epoch, so the tracker
            resets and no plate vote bridges the two scenes.
      hold  live-edge mode only: the frame is part of the backlog the open
            buffered; drop it, a fresher one is already queued.

    Cuts are judged against the PREVIOUS frame, never against the anchor. The
    anchor-based test it replaces (2 Oct 2026, Sentinel rehearsal) missed every
    loop after the first: once anchored at a loop's first pts, every later loop
    lands on that same pts, so "back past the anchor" never fired and the
    far-behind rule re-anchored silently (cam04: 4 of 4 loops missed).

    Two anchoring modes:
      paced (HLS, files)  the first frame anchors pts to wall time and later
            frames are released on that clock (an HLS segment arrives as one
            burst; pacing spreads it out).
      live edge (RTSP)    frames arrive in real time, so the anchor is the
            frame with the smallest (arrival - pts) seen so far: it only ever
            moves EARLIER, which drains the open's backlog at decode speed and
            makes `due` the moment the frame was sent (plus network delay)
            instead of the moment the first frame left the decoder.
    """

    def __init__(self, live_edge: bool = False):
        self.edge = bool(live_edge)
        self.anchor_pts: float | None = None
        self.anchor_wall: float | None = None
        self.prev_pts: float | None = None
        self.prev_wall: float | None = None
        self.cuts = 0
        self.settling = self.edge  # live edge: still draining the open's backlog
        self.held = 0  # frames dropped as backlog while settling
        # how late the first frame was (what the old anchor stamped every frame by);
        # None when a cut fell inside the backlog (the two halves are not comparable)
        self.backlog_s: float | None = 0.0
        self._settle_n = 0
        self._quiet = 0
        self._settle_t0: float | None = None
        self._first_offset: float | None = None

    @property
    def offset(self) -> float | None:
        """wall - pts on the current anchor."""
        return None if self.anchor_pts is None else self.anchor_wall - self.anchor_pts

    def is_cut(self, t: float, arr: float) -> bool:
        if self.prev_pts is not None:
            dp = t - self.prev_pts
            if dp < -_PTS_BACK_SEC:
                return True  # went back: a loop point, however many loops came before
            if dp > (arr - self.prev_wall) + _PTS_JUMP_SEC:
                return True  # leapt ahead of the wall clock: a restamp / loop that skipped forward
        if (
            not self.edge
            and self.anchor_pts is not None
            and (t - self.anchor_pts) > (arr - self.anchor_wall) + _PTS_JUMP_SEC
        ):
            # Paced mode: due more than _PTS_JUMP_SEC in the future. Pacing it
            # out used to sleep 1 s per frame until wall time caught up.
            return True
        return False

    def stamp(self, t: float, arr: float) -> tuple[float, bool, bool]:
        cut = self.is_cut(t, arr)
        old = self.offset
        if old is None or cut:
            self.anchor_pts, self.anchor_wall = t, arr
        elif self.edge and (arr - t) < old:
            self.anchor_pts, self.anchor_wall = t, arr  # sooner than any frame before: the anchor was late
        if cut:
            self.cuts += 1
        self.prev_pts, self.prev_wall = t, arr
        due = self.anchor_wall + (t - self.anchor_pts)
        hold = False
        if self.settling:
            if self._settle_t0 is None:
                self._settle_t0, self._first_offset = arr, arr - t
            self._settle_n += 1
            moved = old is None or cut or (old - self.offset) > _EDGE_EPS
            self._quiet = 0 if moved else self._quiet + 1
            if (
                self._quiet >= _EDGE_QUIET
                or self._settle_n >= _EDGE_MAX_FRAMES
                or arr - self._settle_t0 >= _EDGE_MAX_WAIT
            ):
                self.settling = False
                self.held = self._settle_n - 1
                self.backlog_s = max(0.0, (self._first_offset or 0.0) - self.offset) if not self.cuts else None
            else:
                hold = True
        return due, cut, hold

    def behind(self, t: float, now: float) -> tuple[float, bool]:
        """Far behind the clock (> _LAG_REANCHOR_SEC): re-anchor at `now`. A
        re-anchor that moves the anchor's pts BACKWARDS is a discontinuity, not
        a stall, and is counted as a cut. → (due, cut)"""
        cut = self.anchor_pts is not None and t < self.anchor_pts - 1e-6
        if cut:
            self.cuts += 1
        self.anchor_pts, self.anchor_wall = t, now
        return now, cut


class _PyAvReader:
    """PyAV decode with REAL-TIME PACING.

    ffmpeg's HLS demuxer starts ~3 segments behind live and then hands over a
    whole segment at once: with 10 s segments that is a burst of 100 frames in
    a few hundred ms, then nothing for 10 s. A 'newest frame only' consumer
    would see ONE usable frame per burst. So frames are released on their
    presentation clock: the first frame anchors pts→wall, later frames sleep
    until due. If the decoder is far behind (start-up burst, reconnect
    backlog) it does not sleep — the backlog is drained at full speed and the
    consumer simply skips it. `last_frame_time` is the pts-derived wall time,
    which is what the sighting timestamp should carry.

    RTSP is not paced but anchored at the live edge, and every loop point is a
    cut: see PtsClock."""

    name = "pyav"

    def __init__(self, url: str):
        import av

        self._av = av
        opts = {"rtsp_transport": "tcp", "allowed_extensions": "ALL"}
        if url.lower().startswith("rtsp"):
            opts["timeout"] = str(int(_READ_TIMEOUT * 1_000_000))  # FFmpeg ≥ 5 spelling of stimeout
        elif url.lower().startswith(("http://", "https://")):
            opts.update(_HLS_OPTS)
        self.c = av.open(url, timeout=_READ_TIMEOUT, options=opts)
        self.s = self.c.streams.video[0]
        # Bounded decoder threads: with 30 cameras per process, "AUTO" (one
        # pool per stream sized to the machine) oversubscribes the CPU ~10×.
        self.s.thread_type = "FRAME"
        self.s.codec_context.thread_count = int(os.getenv("ANPR_DECODE_THREADS", "2"))
        if self.s.codec_context.name == "hevc":
            # HEVC (4 Sep 2026): with frame threads the decoder reports damage
            # ("Could not find ref with POC", "Error constructing the frame
            # RPS") from its own threads, invisible to the thread-local log
            # capture the corrupt-frame gate relies on, and the frame flag
            # never fires for HEVC. Decoding on this thread keeps the signal;
            # the grid has two HEVC cameras, so the CPU cost is small.
            self.s.thread_type = "NONE"
            self.s.codec_context.thread_count = 1
        self._pkts = None  # demux generator; re-created after a demux error
        self._pending: list = []  # frames a packet decoded beyond the first
        self.codec = self.s.codec_context.name
        self.fps = float(self.s.average_rate) if self.s.average_rate else None
        self._tb = float(self.s.time_base) if self.s.time_base else None
        # RTSP frames arrive in real time: anchor at the live edge. HLS arrives
        # a segment at a time and keeps the paced first-frame anchor.
        self.clock = PtsClock(live_edge=_LIVE_EDGE and url.lower().startswith(("rtsp://", "rtsps://")))
        self._pkt_wall: dict = {}  # packet pts -> wall time its data arrived (live edge)
        self._last_demux: float | None = None  # when the previous packet left the demuxer
        self.last_frame_time = 0.0
        self.decode_errors = 0  # packets skipped on this connection
        self.consecutive_errors = 0
        self.last_error: str | None = None
        self._last_good = time.time()
        self.last_corrupt = False  # the frame read() just returned is decoder concealment
        self.corrupt_frames = 0
        self._damaged_at = 0.0  # wall time of the last lost/undecodable packet
        self._empty_run = 0  # consecutive packets that produced no frame
        av.logging.set_level(av.logging.INFO)  # "concealing …" is logged at INFO
        # Errors that mean the CONNECTION is gone (interrupt/timeout, transport,
        # HTTP status) — skipping packets cannot help; reconnect at once.
        self._fatal = tuple(
            c
            for c in (
                getattr(av.error, n, None)
                for n in (
                    "ExitError",
                    "TimeoutError",
                    "HTTPError",
                    "ConnectionResetError",
                    "ConnectionRefusedError",
                    "ConnectionAbortedError",
                    "BrokenPipeError",
                    "EOFError",
                )
            )
            if isinstance(c, type)
        )

    def _bad(self, e: BaseException, where: str):
        """One bad packet: count it, keep going — unless the budget is spent."""
        self.decode_errors += 1
        self.consecutive_errors += 1
        self.last_error = _short(e)
        if isinstance(e, self._fatal):
            raise e
        if self.consecutive_errors >= _DECODE_ERRORS_MAX:
            raise RuntimeError(f"{self.consecutive_errors} consecutive {where} errors ({self.last_error})")
        if time.time() - self._last_good > _READ_TIMEOUT:
            raise RuntimeError(f"no decodable frame for {_READ_TIMEOUT:.0f}s ({where}: {self.last_error})")

    def _next_frame(self):
        """Manual demux → decode so ONE corrupt packet is skipped instead of
        ending the generator (container.decode() cannot be resumed after it
        raised). None = clean EOF."""
        av = self._av
        while True:
            if self._pending:
                return self._pending.pop(0)
            if self._pkts is None:
                self._pkts = self.c.demux(self.s)
            try:
                # The RTSP demuxer reports loss on OUR thread ("RTP: missed N
                # packets"); the decoder's own threads log concealment where a
                # thread-local capture cannot see it, so the frame flag below
                # is the other half of the signal.
                with av.logging.Capture(local=True) as dlogs:
                    pkt = next(self._pkts, None)
                if any(_DAMAGE_RE.search(str(r[2])) for r in dlogs):
                    self._damaged_at = time.time()
                if pkt is not None and self.clock.edge:
                    # When this frame's data reached us, before the decoder's
                    # own latency (frame threads hold a frame back). FFmpeg's
                    # RTSP demuxer parses H.264 / H.265 into access units and
                    # can only hand one over once the NEXT one starts arriving,
                    # so the moment packet k-1 left the demuxer is when packet
                    # k's first bytes arrived = when it was sent (+ network).
                    # Measured on the grid: stamping packet k from its own
                    # demux time was late by exactly one frame interval
                    # (34-148 ms at 30-7 fps).
                    t_dmx = time.time()
                    if pkt.pts is not None:
                        prev = self._last_demux if _EDGE_PREV_PACKET else None
                        pw = self._pkt_wall
                        pw[pkt.pts] = t_dmx if prev is None else prev
                        if len(pw) > 256:
                            for k in list(pw)[:128]:
                                del pw[k]
                    self._last_demux = t_dmx
            except av.FFmpegError as e:
                self._pkts = None  # the generator is finished; a fresh one resumes the container
                self._bad(e, "demux")
                self._damaged_at = time.time()
                continue
            if pkt is None:
                return None
            try:
                with av.logging.Capture(local=True) as logs:
                    frames = pkt.decode()
            except av.FFmpegError as e:
                self._bad(e, "decode")
                self._damaged_at = time.time()
                continue
            if getattr(pkt, "is_corrupt", False) or any(_DAMAGE_RE.search(str(r[2])) for r in logs):
                self._damaged_at = time.time()
            if not frames:
                # Decoder buffering (B-frames) yields a few empty packets at the
                # start and never more than the reorder depth in a row. HEVC
                # damage is silent (no log, no corrupt flag): the decoder simply
                # discards frames whose references are gone, so a long run of
                # empty packets IS the damage (4 Sep 2026: 59 in a row on the
                # grid's HEVC cameras vs 5 on a clean H.264 one).
                self._empty_run += 1
                if self._empty_run >= _EMPTY_RUN_DAMAGE:
                    self._damaged_at = time.time()
                continue
            self._empty_run = 0
            self.consecutive_errors = 0
            self._last_good = time.time()
            self._pending.extend(frames[1:])
            return frames[0]

    @property
    def pts_cuts(self) -> int:
        """Stream-time discontinuities seen on this connection (loop points)."""
        return self.clock.cuts

    def read(self):
        # Return the decoded av.VideoFrame itself; the BGR conversion (the
        # expensive part at 1080p) happens lazily in VideoSource.read(), so
        # frames the consumer never asks for are never converted.
        while True:
            fr = self._next_frame()
            if fr is None:
                return None
            now = time.time()
            if getattr(fr, "is_corrupt", False):
                self._damaged_at = now  # concealment happened: everything predicted from here drifts
            elif getattr(fr, "key_frame", False):
                self._damaged_at = 0.0  # a key frame restarts prediction from scratch
            pts = fr.pts
            due = None
            if pts is not None and self._tb:
                t = pts * self._tb
                arr = now
                if self.clock.edge:
                    a = self._pkt_wall.pop(pts, None)
                    if a is not None and a <= now:
                        arr = a
                # Loop point / restamp → clock.cuts += 1 → VideoSource starts a
                # new epoch (tracker reset, no vote bridges the seam).
                due, _cut, hold = self.clock.stamp(t, arr)
                if hold:
                    continue  # the open's backlog: a fresher frame is already queued
            self.last_corrupt = (now - self._damaged_at) < _CORRUPT_RECOVER_SEC
            if self.last_corrupt:
                self.corrupt_frames += 1
            if due is None:
                self.last_frame_time = now
                return fr
            lag = now - due
            if lag < -0.005:
                time.sleep(min(-lag, 1.0))  # ahead of real time → pace
            elif lag > _LAG_REANCHOR_SEC:
                # far behind (burst / backlog / a stall with continuous pts):
                # re-anchor so we don't try to 'catch up' by sleeping less
                # forever; stale frames are simply delivered fast and skipped
                # by the newest-frame consumer. A re-anchor that moves pts
                # BACKWARDS is a cut (PtsClock.behind).
                due, _cut = self.clock.behind(t, now)
            self.last_frame_time = due
            return fr

    def close(self):
        try:
            self.c.close()
        except Exception:  # noqa: BLE001
            pass


class _FfmpegReader:
    """ffmpeg CLI → raw BGR frames over a pipe. Uses the static binary from the
    `imageio-ffmpeg` wheel when present (no compile, works in every image),
    else a system ffmpeg. Probes size with ffprobe-free trick: ask ffmpeg to
    scale to a known width? No — we read the size from the stream header via
    a short `-t 0` probe on stderr, which is cheap and needs no extra tool."""

    name = "ffmpeg"

    def __init__(self, url: str):
        import re
        import subprocess

        exe = None
        try:
            import imageio_ffmpeg

            exe = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:  # noqa: BLE001
            import shutil

            exe = shutil.which("ffmpeg")
        if not exe:
            raise RuntimeError("no ffmpeg binary")
        common = ["-hide_banner", "-loglevel", "error", "-nostdin"]
        if url.lower().startswith("rtsp"):
            common += ["-rtsp_transport", "tcp"]
        # probe the resolution from the stream info (stderr of a 1-frame run)
        p = subprocess.run(
            [exe, "-hide_banner", "-loglevel", "info", "-nostdin"]
            + (["-rtsp_transport", "tcp"] if url.lower().startswith("rtsp") else [])
            + ["-i", url, "-frames:v", "1", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", p.stderr)
        if not m:
            raise RuntimeError(f"ffmpeg could not probe {redact_url(url)}: {p.stderr.strip()[-200:]}")
        self.w, self.h = int(m.group(1)), int(m.group(2))
        cm = re.search(r"Video: (\w+)", p.stderr)
        self.codec = cm.group(1) if cm else "?"
        self.fps = None
        self.proc = subprocess.Popen(
            [exe] + common + ["-i", url, "-an", "-sn", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=self.w * self.h * 3 * 4,
        )
        self._n = self.w * self.h * 3

    def read(self):
        buf = self.proc.stdout.read(self._n)
        if not buf or len(buf) < self._n:
            return None
        return np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3).copy()

    def close(self):
        try:
            self.proc.kill()
        except Exception:  # noqa: BLE001
            pass


class _Cv2Reader:
    name = "cv2"

    def __init__(self, url: str):
        import cv2

        # FORCE RTSP OVER TCP. The PyAV reader above already passes
        # rtsp_transport=tcp in its options, and the ffmpeg subprocess path
        # passes it on the command line — this fallback was the one way in
        # that did not, so a stream opened here could negotiate UDP.
        #
        # Sentinel's own integrator guide is blunt about why that matters:
        # "UDP fails across NAT/firewalls and produces corrupt frames that look
        # like model bugs." Exactly so — the failure does not present as a
        # network error, it presents as the detector missing plates, which is
        # the most expensive kind of bug to chase.
        #
        # OpenCV takes it through an environment variable rather than an
        # argument, and reads it when the capture is CONSTRUCTED, so it has to
        # be set immediately before.
        if url.lower().startswith("rtsp"):
            prev = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
            try:
                self.cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            finally:
                # Restore, so this never leaks into an unrelated capture in the
                # same process (each camera thread opens its own).
                if prev is None:
                    os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
                else:
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = prev
        else:
            self.cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        if not self.cap.isOpened():
            raise RuntimeError("cv2 cannot open source")
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.codec = "?"
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or None
        self.decode_errors = 0
        self.consecutive_errors = 0
        self.last_error: str | None = None
        self._last_good = time.time()

    def read(self):
        # cv2 reports a corrupt frame and EOF the same way (False); tolerate a
        # few in a row (a bad segment) before calling the stream ended.
        while True:
            ok, f = self.cap.read()
            if ok and f is not None:
                self.consecutive_errors = 0
                self._last_good = time.time()
                return f
            self.decode_errors += 1
            self.consecutive_errors += 1
            self.last_error = "cv2 read failed"
            if self.consecutive_errors >= _DECODE_ERRORS_MAX or time.time() - self._last_good > _READ_TIMEOUT:
                return None
            time.sleep(0.02)

    def close(self):
        self.cap.release()


_READERS = {"pyav": _PyAvReader, "ffmpeg": _FfmpegReader, "cv2": _Cv2Reader}


def open_reader(url: str, prefer: str = "auto", failures: list | None = None):
    """First reader in preference order that opens. `failures` (optional
    list) receives 'backend: Error: why' for every reader that did NOT open,
    so the caller can say why the higher-priority one was passed over."""
    order = {
        "auto": ("pyav", "ffmpeg", "cv2"),
        "pyav": ("pyav",),
        "ffmpeg": ("ffmpeg",),
        "cv2": ("cv2",),
    }.get(prefer, ("pyav", "ffmpeg", "cv2"))
    tried: list[str] = []
    for k in order:
        try:
            return _READERS[k](url)
        except Exception as e:  # noqa: BLE001
            tried.append(f"{k}: {_short(e)}")
            if failures is not None:
                failures.append(tried[-1])
    # Redact BEFORE slicing: a slice cut through the scheme and the redactor no
    # longer recognised user:pass@ — the password tail leaked into every log.
    raise RuntimeError(f"no reader could open {redact_url(url)[-40:]} — " + "; ".join(tried))


def to_bgr(f):
    """Decoder frame → BGR ndarray. A PyAV VideoFrame is converted (a full
    frame colour conversion plus a ~6 MB allocation at 1080p); an ndarray from
    the ffmpeg/cv2 backends is already BGR and comes back unchanged."""
    conv = getattr(f, "to_ndarray", None)
    return f if conv is None else conv(format="bgr24")


def frame_size(f) -> tuple[int, int]:
    """(width, height) of a raw or converted frame, without converting it."""
    w = getattr(f, "width", None)
    if w is not None:
        return int(w), int(f.height)
    return int(f.shape[1]), int(f.shape[0])


class VideoSource:
    def __init__(self, url: str, prefer: str | None = None, max_reconnects: int = 0):
        self.url = url
        self.prefer = prefer or os.getenv("ANPR_VIDEO_BACKEND", "auto")
        self.live = _is_live(url)
        self.max_reconnects = max_reconnects
        self.reconnects = 0
        self.cuts = 0  # in-connection stream-time cuts (loop points)
        self.epoch = 0
        self.backend = None
        self.codec = None
        self.decode_errors = 0  # packets skipped, all connections (spec §A.4)
        self.last_reason = "first connection"  # why the previous connection ended
        # Analysis heartbeat (forensic search, 4 Oct 2026): when last_reason was
        # set and when the last frame arrived (wall clock), so "no frames this
        # minute" can be attributed to the error that came AFTER the last frame.
        self.last_reason_at = 0.0
        self.last_frame_wall = 0.0
        self._file_frames = 0  # frames returned by a non-live (file) source
        self.open_note = ""  # 'pyav: InvalidDataError: …' when a lower-priority reader is in use
        self._reader = None
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._frame = None
        self._ts = 0.0
        self._idx = 0
        self._last_read_idx = 0
        self._stop = False
        self._dead = False
        self._new_conn = False  # bump epoch WITH the first frame of a new connection
        self._conn_started = 0.0
        self._thread = None
        if self.live:
            self._thread = threading.Thread(
                target=self._loop, daemon=True, name=f"vsrc:{redact_url(url)[-24:]}"
            )
            self._thread.start()
        else:
            self._reader = open_reader(url, self.prefer)
            self.backend, self.codec = self._reader.name, self._reader.codec

    def _tag(self) -> str:
        return redact_url(self.url)[-40:]

    # ── live decode loop ──
    def _loop(self):
        backoff = _BACKOFF_MIN
        while not self._stop:
            conn_frames = 0
            conn_cuts = 0
            self._conn_started = time.time()  # open time counts toward the connection's age
            try:
                failures: list[str] = []
                self._reader = open_reader(self.url, self.prefer, failures)
                self.backend, self.codec = self._reader.name, self._reader.codec
                self.open_note = "; ".join(failures)
                if failures:
                    # once per connection: which backend is in use and why the
                    # preferred one(s) did not open (spec §A.4)
                    print(
                        f"[video] {self._tag()}: reader={self.backend} ({self.codec}) — {self.open_note}",
                        flush=True,
                    )
                self._new_conn = True
                while not self._stop:
                    f = self._reader.read()
                    if f is None:
                        raise RuntimeError(
                            "stream ended"
                            + (
                                f" ({self._reader.last_error})"
                                if getattr(self._reader, "last_error", None)
                                else ""
                            )
                        )
                    conn_frames += 1
                    if conn_frames == 5:
                        backoff = _BACKOFF_MIN  # the connection is genuinely delivering
                    ft = getattr(self._reader, "last_frame_time", 0.0) or time.time()
                    rc = int(getattr(self._reader, "pts_cuts", 0) or 0)
                    with self._cv:
                        if self._new_conn:
                            self.epoch += 1  # ids never bridge a gap / loop point
                            self._new_conn = False
                            conn_cuts = rc
                        elif rc != conn_cuts:
                            # A loop point INSIDE one connection: Sentinel's feeds
                            # loop without dropping RTSP, so no reconnect ever
                            # fires. New epoch = the tracker resets, exactly as
                            # for a reconnect.
                            conn_cuts = rc
                            self.cuts += 1
                            self.epoch += 1
                        self._frame, self._ts = f, ft
                        self._corrupt = bool(getattr(self._reader, "last_corrupt", False))
                        self._idx += 1
                        self.last_frame_wall = time.time()
                        self._cv.notify_all()
            except Exception as e:  # noqa: BLE001
                if self._stop:
                    break
                self._new_conn = True
                conn_secs = time.time() - self._conn_started
                clean_eof = str(e).startswith("stream ended")
                healthy = conn_frames >= 5 and conn_secs >= 5.0
                self.last_reason = (
                    f"{_short(e)} after {conn_frames} frames/{conn_secs:.0f}s via {self.backend}"
                    + (
                        f", {getattr(self._reader, 'decode_errors', 0)} packet(s) skipped"
                        if getattr(self._reader, "decode_errors", 0)
                        else ""
                    )
                )
                self.last_reason_at = time.time()
                if clean_eof and healthy:
                    # A playlist that ends (looping recordings, VOD-style HLS,
                    # or ffmpeg giving up on an in-progress LL-HLS part) after
                    # delivering real video is not a failure: reopen at once,
                    # no backoff, and don't count it toward the give-up limit.
                    time.sleep(0.2)
                    continue
                self.reconnects += 1
                if self.max_reconnects and self.reconnects > self.max_reconnects:
                    print(
                        f"[video] {redact_url(self.url)}: giving up after {self.reconnects} reconnects ({e})",
                        flush=True,
                    )
                    self._dead = True
                    with self._cv:
                        self._cv.notify_all()
                    break
                print(f"[video] {self._tag()}: {self.last_reason} — reconnect in {backoff:.0f}s", flush=True)
                time.sleep(backoff)
                backoff = min(_BACKOFF_MAX, backoff * 2)
            finally:
                if self._reader is not None:
                    self.decode_errors += int(getattr(self._reader, "decode_errors", 0) or 0)
                    self._reader.close()
                    self._reader = None

    @property
    def decode_errors_total(self) -> int:
        """Packets skipped so far: closed connections + the live one."""
        r = self._reader
        return self.decode_errors + int(getattr(r, "decode_errors", 0) or 0)

    # ── consumer API ──
    @staticmethod
    def _to_bgr(f):
        return to_bgr(f)

    def read(self, timeout: float = 30.0, raw: bool = False):
        """→ (frame, ts, epoch) or None (file ended / live source dead).
        Live: blocks until a frame NEWER than the last one returned exists.

        raw=True hands back the decoder's frame unconverted (a PyAV VideoFrame,
        or an ndarray from the ffmpeg/cv2 backends): a caller that drops most
        frames on a rate check converts only the ones it keeps, via to_bgr()."""
        if not self.live:
            f = self._reader.read()
            self.last_corrupt = bool(getattr(self._reader, "last_corrupt", False))
            if f is None:
                return None
            self._file_frames += 1
            self.last_frame_wall = time.time()
            return (f if raw else to_bgr(f)), time.time(), 0
        deadline = time.time() + timeout
        with self._cv:
            while self._idx == self._last_read_idx and not self._dead:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None if self._dead else (None, 0.0, self.epoch)
                self._cv.wait(remaining)
            if self._dead and self._idx == self._last_read_idx:
                return None
            self._last_read_idx = self._idx
            self.last_corrupt = bool(getattr(self, "_corrupt", False))
            f, ts, ep = self._frame, self._ts, self.epoch
        return (f if raw else to_bgr(f)), ts, ep  # convert OUTSIDE the lock

    @property
    def frames_decoded(self) -> int:
        """Frames delivered by the reader since this source was created (all
        connections). Read by the analysis heartbeat."""
        return self._idx + self._file_frames

    @property
    def alive(self) -> bool:
        return not self._dead

    def close(self):
        self._stop = True
        if self._reader is not None and not self.live:
            self._reader.close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)


if __name__ == "__main__":
    import sys

    src = VideoSource(
        sys.argv[1] if len(sys.argv) > 1 else "https://live.corp8.cloud/live/stream/13/index.m3u8"
    )
    t0 = time.time()
    n = 0
    while n < 30 and time.time() - t0 < 40:
        r = src.read(timeout=20)
        if r is None:
            print("dead")
            break
        f, ts, ep = r
        if f is None:
            print("no frame yet")
            continue
        n += 1
    print(
        f"backend={src.backend} codec={src.codec} {n} frames in {time.time()-t0:.1f}s shape={None if f is None else f.shape}"
    )
    src.close()
