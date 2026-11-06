#!/usr/bin/env python
"""Footfall DEMO publisher.

Purpose
-------
Make the product Footfall page (smart-cam-app → /ai-event/footfall) show LIVE
counting on a box that has no real IP cameras. It does two things:

  1. Loop-streams a bundled "people walking past a line" clip into MediaMTX as
     the RTSP path ``cam_<CODE>`` (so both the orchestrator AND the browser's
     WebRTC/MJPEG preview have a real source to read).
  2. Registers that path as a footfall-counting camera in the vms_face AI
     service via its HTTP API, with footfall ENABLED, then (re)starts the
     orchestrator so the counter actually runs.

It is intentionally self-healing and idempotent: if ffmpeg dies it is
restarted, and every ~30 s it re-asserts that the AI service still has the
camera running (covers an AI-service restart that left the camera OFFLINE).

This is a DEMO AID, not part of the product runtime. Remove the ``footfall-demo``
service from docker-compose.yml to turn it off; the seeded camera row can be
deleted from the vms_face Postgres ``cameras`` table.

Auth: the AI service runs with VMS_JWT_DEV_BYPASS=true in dev, so token-less
requests are accepted and bound to the default tenant.
"""
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

CODE       = os.environ.get("DEMO_CAMERA_CODE", "demo-entrance")
VIDEO      = os.environ.get("DEMO_VIDEO", "/demo/footfall.mp4")
MEDIAMTX   = os.environ.get("MEDIAMTX_HOST", "mediamtx")
RTSP_PORT  = os.environ.get("MEDIAMTX_RTSP_PORT", "8554")
AI_BASE    = os.environ.get("AI_BASE", "http://smart-cam-ai:8001").rstrip("/")
LINE_Y     = float(os.environ.get("DEMO_LINE_Y_FRAC", "0.5"))
DIRECTION  = os.environ.get("DEMO_DIRECTION", "down_is_in")
TARGET_FPS = os.environ.get("DEMO_TARGET_FPS", "8")
RTSP_URL   = f"rtsp://{MEDIAMTX}:{RTSP_PORT}/cam_{CODE}"

RECONFIG_INTERVAL_SEC = 30


def log(*a):
    print("[footfall-demo]", *a, flush=True)


def wait_tcp(host, port, timeout=240):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, int(port)), timeout=3):
                log(f"reachable: {host}:{port}")
                return True
        except OSError:
            time.sleep(2)
    log(f"TIMEOUT waiting for {host}:{port}")
    return False


def _request(method, path, *, json_body=None, form=None):
    """Return (status, text). Never raises for HTTP error codes."""
    url = AI_BASE + path
    data, headers = None, {}
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # connection refused, timeout, etc.
        return 0, str(e)


def start_ffmpeg():
    # Source is already H.264 / yuv420p / no B-frames, but we re-encode with a
    # tight 1 s GOP and no B-frames so new WebRTC viewers get a keyframe fast
    # and MediaMTX's muxers never choke on reordered frames.
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-re", "-stream_loop", "-1", "-i", VIDEO,
        "-an",
        "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1",
        "-pix_fmt", "yuv420p", "-preset", "veryfast", "-tune", "zerolatency",
        "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0",
        "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
        "-f", "rtsp", "-rtsp_transport", "tcp", RTSP_URL,
    ]
    log("starting ffmpeg ->", RTSP_URL)
    return subprocess.Popen(cmd)


def find_camera():
    st, body = _request("GET", "/footfall/cameras")
    if st != 200:
        return None
    try:
        for c in json.loads(body).get("cameras", []):
            if c.get("camera_code") == CODE:
                return c
    except Exception:
        return None
    return None


def full_configure():
    """Create the camera (if needed), enable footfall, and restart the
    orchestrator so it captures footfall=ENABLED at start (the orchestrator
    reads footfall config once at launch — a live PUT alone won't start it)."""
    st, body = _request("POST", "/set-camera", form={"monitor_id": CODE, "target_fps": TARGET_FPS})
    log("set-camera:", st, body[:200])
    if st != 200:
        return False
    try:
        cam_id = json.loads(body)["camera_id"]
    except Exception:
        log("could not parse camera_id"); return False

    st, body = _request("PUT", f"/footfall/cameras/{cam_id}/config", json_body={
        "enabled": True, "line_y_frac": LINE_Y,
        "direction": DIRECTION, "falls_enabled": False,
    })
    log("footfall config:", st, body[:200])
    if st != 200:
        return False

    # Clean restart so the running orchestrator re-reads footfall=enabled.
    _request("POST", "/stop-camera", form={"monitor_id": CODE})
    time.sleep(1.5)
    st, body = _request("POST", "/set-camera", form={"monitor_id": CODE, "target_fps": TARGET_FPS})
    log("restart set-camera:", st, body[:200])
    return st == 200


def ensure_running():
    """Lightweight reconcile. Only does the disruptive full_configure when the
    camera is missing or footfall is somehow off; otherwise just nudges a
    non-running camera back to running without resetting a healthy stream."""
    cam = find_camera()
    if cam is None or not cam.get("footfall_enabled"):
        return full_configure()
    if cam.get("camera_status") != "online":
        st, body = _request("POST", "/set-camera", form={"monitor_id": CODE, "target_fps": TARGET_FPS})
        log("nudge start:", st, body[:160])
    return True


def main():
    log("config:", json.dumps({"code": CODE, "rtsp": RTSP_URL, "ai": AI_BASE, "video": VIDEO}))
    ai = urllib.parse.urlparse(AI_BASE)
    wait_tcp(MEDIAMTX, RTSP_PORT)
    wait_tcp(ai.hostname, ai.port or 80)

    proc = start_ffmpeg()
    time.sleep(6)  # let the first frames publish before pointing the orchestrator at it
    full_configure()
    last_reconcile = time.time()

    while True:
        if proc.poll() is not None:
            log(f"ffmpeg exited rc={proc.returncode}; restarting in 3s")
            time.sleep(3)
            proc = start_ffmpeg()
            time.sleep(6)
            full_configure()
            last_reconcile = time.time()
        elif time.time() - last_reconcile > RECONFIG_INTERVAL_SEC:
            ensure_running()
            last_reconcile = time.time()
        time.sleep(5)


if __name__ == "__main__":
    main()
