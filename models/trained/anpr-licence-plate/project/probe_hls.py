"""
probe_hls.py — which video-read path actually decodes a given HLS/RTSP url here?

Tries, each under its own timeout:  requests (playlist chain) → OpenCV/FFMPEG →
PyAV → ffmpeg CLI.  Prints one line per path with open time and frames/sec so
the worker can be pointed at the path that works in THIS image/network.

    python probe_hls.py https://live.corp8.cloud/live/stream/13/index.m3u8
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import threading
import time

URL = sys.argv[1] if len(sys.argv) > 1 else "https://live.corp8.cloud/live/stream/13/index.m3u8"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20


def run_with_timeout(fn, seconds, label):
    out = {}

    def target():
        try:
            out["r"] = fn()
        except Exception as e:  # noqa: BLE001
            out["e"] = f"{e.__class__.__name__}: {e}"

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        print(f"{label:10s} TIMEOUT after {seconds}s", flush=True)
        return None
    if "e" in out:
        print(f"{label:10s} ERROR {out['e']}", flush=True)
        return None
    print(f"{label:10s} {out['r']}", flush=True)
    return out["r"]


def probe_playlist():
    import requests

    t0 = time.time()
    r = requests.get(URL, timeout=10)
    lines = [l.strip() for l in r.text.splitlines() if l.strip() and not l.startswith("#")]
    info = f"master {r.status_code} in {time.time()-t0:.2f}s; entries={lines[:2]}"
    base = URL.rsplit("/", 1)[0]
    if lines and lines[0].endswith(".m3u8"):
        v = requests.get(base + "/" + lines[0], timeout=10)
        vt = v.text
        segs = [l.strip() for l in vt.splitlines() if l.strip() and not l.startswith("#")]
        tags = sorted({l.split(":")[0] for l in vt.splitlines() if l.startswith("#EXT-X")})
        info += f" | variant {v.status_code} segs={len(segs)} first={segs[:1]} tags={tags}"
        if segs:
            s0 = segs[0]
            surl = s0 if s0.startswith("http") else base + "/" + s0
            t1 = time.time()
            sr = requests.get(surl, timeout=15)
            info += f" | seg {sr.status_code} {len(sr.content)//1024}KB in {time.time()-t1:.2f}s"
    return info


def probe_cv2(url):
    import cv2

    t0 = time.time()
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    ok = cap.isOpened()
    t_open = time.time() - t0
    if not ok:
        return f"open FAILED in {t_open:.1f}s"
    n = 0
    t1 = time.time()
    shape = None
    while n < N and time.time() - t1 < 25:
        r, f = cap.read()
        if not r:
            break
        n += 1
        shape = f.shape
    cap.release()
    return f"open {t_open:.1f}s, {n} frames in {time.time()-t1:.1f}s, shape={shape}"


def probe_pyav(url):
    import av

    t0 = time.time()
    c = av.open(url, timeout=15.0, options={"rtsp_transport": "tcp", "allowed_extensions": "ALL"})
    s = c.streams.video[0]
    s.thread_type = "AUTO"
    t_open = time.time() - t0
    n = 0
    t1 = time.time()
    shape = None
    for fr in c.decode(s):
        img = fr.to_ndarray(format="bgr24")
        shape = img.shape
        n += 1
        if n >= N or time.time() - t1 > 25:
            break
    c.close()
    return f"open {t_open:.1f}s, {n} frames in {time.time()-t1:.1f}s, shape={shape}, codec={s.codec_context.name}"


def probe_ffmpeg(url):
    exe = shutil.which("ffmpeg")
    if not exe:
        return "ffmpeg CLI not installed"
    t0 = time.time()
    p = subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error", "-i", url, "-frames:v", str(N), "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=45,
    )
    return f"rc={p.returncode} {N} frames in {time.time()-t0:.1f}s {p.stderr.strip()[:160]}"


if __name__ == "__main__":
    print("url:", URL, flush=True)
    run_with_timeout(probe_playlist, 30, "playlist")
    run_with_timeout(lambda: probe_cv2(URL), 45, "cv2")
    run_with_timeout(lambda: probe_pyav(URL), 45, "pyav")
    run_with_timeout(lambda: probe_ffmpeg(URL), 60, "ffmpeg")
