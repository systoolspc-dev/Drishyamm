"""
clip_recorder.py — per-camera rolling buffer → short H.264 evidence clip.

Every captured frame is downscaled and JPEG-encoded into a ring buffer that
holds the last PRE + POST + LAG seconds (≈26 s at 5 fps). At the worker's
1280 px that is ~10-20 MB per camera (80-120 KB a frame at q90, ~30 % less
at q80); an idle scene is captured at `idle_fps` instead, which cuts both the
memory and the JPEG encodes. When a plate is confirmed the worker calls
`request(t0, ...)`; the recorder keeps collecting for POST seconds and then
hands a finished MP4 (libx264, yuv420p — plays in every browser) to the
callback on a background thread. The hot path never waits on encoding.

Encoding uses the static ffmpeg from the `imageio-ffmpeg` wheel (or a system
ffmpeg): raw BGR frames are piped in, so no OpenCV codec support is needed
(the pip OpenCV wheels have no H.264 encoder).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from collections import deque

import cv2
import numpy as np


def ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return shutil.which("ffmpeg")


class ClipRecorder:
    def __init__(
        self,
        *,
        fps: float = 5.0,
        pre_sec: float = 6.0,
        post_sec: float = 4.0,
        width: int = 640,
        jpeg_q: int = 80,
        lag_sec: float = 14.0,
        play_fps: float = 25.0,
        crf: int = 20,
        idle_fps: float = 0.0,
    ):
        self.fps = max(1.0, float(fps))
        # Capture rate while the caller reports an idle scene (no vehicle, no
        # motion). Slowed, never stopped: a clip's pre-roll can reach back
        # before the vehicle appeared, and that footage must still exist.
        # 0 = always capture at `fps`.
        self.idle_fps = min(max(0.0, float(idle_fps)), self.fps)
        self.idle_skipped = 0
        self.pre = float(pre_sec)
        self.post = float(post_sec)
        # How far in the PAST a request's t0 may be. The worker asks for a clip
        # centred on the vehicle's best frame, but only once the track has been
        # finalised — TRACK_TTL frames after the vehicle was last seen, which is
        # several seconds later. Without this headroom the pre-roll has already
        # been evicted by the time the request arrives, and the clip silently
        # falls back to unrelated recent frames.
        self.lag = max(0.0, float(lag_sec))
        self.width = int(width)
        self.jpeg_q = int(jpeg_q)
        # Playback frame rate of the written file. The camera gives us 1-2 fps;
        # a file encoded at 1 fps is valid H.264 that browsers scrub and stall
        # on, which is what "the clip lags" means. Writing a constant 25 fps and
        # holding each captured frame for its real duration keeps the evidence
        # and the wall-clock length identical while playing smoothly anywhere.
        # play_fps <= 0 restores the old behaviour (encode at the capture rate).
        self.play_fps = float(play_fps)
        self.crf = int(crf)
        self._buf: deque[tuple[float, bytes]] = deque()
        self._lock = threading.Lock()
        self._pending: list[dict] = []
        self._last_ts = 0.0
        self.exe = ffmpeg_exe()

    # ── hot path ──
    def push(self, frame: np.ndarray, ts: float, idle: bool = False) -> None:
        if ts - self._last_ts < 1.0 / self.fps - 1e-3:
            return
        # idle: capture at idle_fps, unless a clip is still collecting post-roll
        if idle and self.idle_fps > 0 and not self._pending and ts - self._last_ts < 1.0 / self.idle_fps - 1e-3:
            self.idle_skipped += 1
            return
        self._last_ts = ts
        h, w = frame.shape[:2]
        if w > self.width:
            frame = cv2.resize(frame, (self.width, int(h * self.width / w)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_q])
        if not ok:
            return
        data = buf.tobytes()
        with self._lock:
            self._buf.append((ts, data))
            # cut clips whose post-roll has elapsed BEFORE evicting: the
            # pre-roll must still be in the buffer when the clip is built
            done = [p for p in self._pending if ts >= p["t0"] + self.post]
            for p in done:
                self._cut(p)
            horizon = ts - self.pre - self.post - self.lag - 2.0
            # never evict below what an outstanding request will still need
            if self._pending:
                horizon = min(horizon, min(p["t0"] for p in self._pending) - self.pre - 1.0)
            while self._buf and self._buf[0][0] < horizon:
                self._buf.popleft()

    def _cut(self, p: dict) -> None:
        """Assemble the frames for a request and encode on a thread. Lock held."""
        if p in self._pending:
            self._pending.remove(p)
        timer = p.get("timer")
        if timer is not None:
            timer.cancel()
        frames = [(t, d) for (t, d) in self._buf if p["t0"] - self.pre <= t <= p["t0"] + self.post]
        if len(frames) < 3:
            # Starved window (slow loop, stall, or the request arrived very late).
            # This used to fall back to "the most recent frames", which on a busy
            # road are a DIFFERENT vehicle — an evidence clip that contradicts the
            # plate it is filed under. In an evidentiary system that is worse than
            # having no clip at all, so widen the search around t0 once and, if
            # there still is not enough, abandon the clip rather than attach a
            # misleading one. The sighting keeps its stills either way.
            lo, hi = p["t0"] - self.pre - self.lag, p["t0"] + self.post + 2.0
            frames = [(t, d) for (t, d) in self._buf if lo <= t <= hi]
            if len(frames) < 3:
                return
        threading.Thread(target=self._encode, args=(frames, p), daemon=True).start()

    def _force_cut(self, p: dict) -> None:
        """Timer fallback: frames stopped arriving (stall / reconnect / end)
        before the post-roll elapsed — cut with whatever we have."""
        with self._lock:
            if p in self._pending:
                self._cut(p)

    # ── request ──
    def request(self, t0: float, out_path: str, on_done, meta: dict | None = None) -> None:
        # The buffer is keyed on time.time(); a caller that hands over an ISO
        # string (the sighting timestamp) must not poison every later cut with
        # a TypeError in the hot path - coerce here, fall back to now.
        if isinstance(t0, str):
            try:
                from datetime import datetime, timezone

                d = datetime.fromisoformat(t0.replace("Z", "+00:00"))
                t0 = (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()
            except ValueError:
                t0 = time.time()
        try:
            t0 = float(t0)
        except (TypeError, ValueError):
            t0 = time.time()
        p = {"t0": t0, "out": out_path, "cb": on_done, "meta": meta or {}}
        p["timer"] = threading.Timer(self.post + 3.0, self._force_cut, args=(p,))
        p["timer"].daemon = True
        with self._lock:
            self._pending.append(p)
        p["timer"].start()

    # ── background encode ──
    def _encode(self, frames: list[tuple[float, bytes]], p: dict) -> None:
        out = p["out"]
        proc = None
        try:
            if not frames or self.exe is None:
                raise RuntimeError("no frames or no ffmpeg")
            first = cv2.imdecode(np.frombuffer(frames[0][1], np.uint8), cv2.IMREAD_COLOR)
            h, w = first.shape[:2]
            w -= w % 2
            h -= h % 2
            os.makedirs(os.path.dirname(out), exist_ok=True)
            # Real-time playback: the clip's frame rate is what was actually
            # captured (frames over their timestamp span), clamped so a
            # starved 3-frame clip still lasts long enough to read.
            span = max(0.0, frames[-1][0] - frames[0][0])
            capture_fps = (
                len(frames) / span if span > 0.5 and len(frames) > 1 else min(self.fps, len(frames) / 2.0)
            )
            capture_fps = float(min(max(capture_fps, 0.2), 30.0))
            smooth = self.play_fps > 0 and self.play_fps > capture_fps
            out_fps = float(self.play_fps) if smooth else float(min(max(capture_fps, 1.0), 30.0))
            proc = subprocess.Popen(
                [
                    self.exe,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "bgr24",
                    "-s",
                    f"{w}x{h}",
                    "-r",
                    f"{out_fps:.3f}",
                    "-i",
                    "-",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    str(self.crf),
                    "-pix_fmt",
                    "yuv420p",
                    # every frame a keyframe candidate is wasteful; 1 s GOP keeps
                    # seeking inside a short clip instant without bloating it
                    "-g",
                    str(max(1, int(round(out_fps)))),
                    "-movflags",
                    "+faststart",
                    out,
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            # Hold each captured frame for the time it actually covered, so the
            # clip runs at real speed however fast the file is written.
            written = 0
            for idx, (fts, d) in enumerate(frames):
                img = cv2.imdecode(np.frombuffer(d, np.uint8), cv2.IMREAD_COLOR)
                if img is None:
                    continue
                if img.shape[1] != w or img.shape[0] != h:
                    img = cv2.resize(img, (w, h))
                raw = img.tobytes()
                if not smooth:
                    proc.stdin.write(raw)
                    written += 1
                    continue
                nxt = frames[idx + 1][0] if idx + 1 < len(frames) else fts + (1.0 / max(capture_fps, 0.2))
                hold = max(1, int(round(max(0.0, nxt - fts) * out_fps)))
                for _ in range(hold):
                    proc.stdin.write(raw)
                written += hold
            try:
                # communicate() closes stdin itself (closing it first makes
                # its internal flush raise "flush of closed file")
                _, err_b = proc.communicate(timeout=60)
            except subprocess.TimeoutExpired:
                proc.kill()
                raise RuntimeError("ffmpeg encode timed out")
            err = (err_b or b"").decode(errors="ignore")
            if proc.returncode != 0 or not os.path.exists(out):
                raise RuntimeError(f"ffmpeg rc={proc.returncode}: {err[-200:]}")
            p["cb"](
                out,
                {
                    "frames": len(frames),
                    "fps": round(out_fps, 2),
                    "capture_fps": round(capture_fps, 2),
                    "width": w,
                    "height": h,
                    "duration": round((written / out_fps) if written else (len(frames) / out_fps), 2),
                    **p["meta"],
                },
            )
        except Exception as e:  # noqa: BLE001
            if proc is not None and proc.poll() is None:
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
            try:
                p["cb"](None, {"error": str(e), **p["meta"]})
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    rec = ClipRecorder(fps=5, pre_sec=1, post_sec=1)
    done = {}
    t = time.time()
    for i in range(20):
        f = np.full((360, 640, 3), (i * 12) % 255, np.uint8)
        cv2.putText(f, str(i), (40, 200), cv2.FONT_HERSHEY_SIMPLEX, 4, (255, 255, 255), 6)
        rec.push(f, t + i * 0.2)
        if i == 8:
            rec.request(t + i * 0.2, "/tmp/clip_test.mp4", lambda path, m: done.update({"path": path, **m}))
    time.sleep(3)
    print("ffmpeg:", rec.exe, "→", done)
    # frames stop arriving → the timer must still cut the clip
    done2 = {}
    rec.request(t + 19 * 0.2, "/tmp/clip_test2.mp4", lambda path, m: done2.update({"path": path, **m}))
    time.sleep(rec.post + 4.5)
    print("timer cut →", done2)
    assert done.get("path") and done2.get("path"), "clip not produced"
