"""zone-sim — the PERSON-box producer the restricted-zone engine was waiting for.

Why this exists
---------------
The restricted-zone engine (smart-cam-backend/src/services/zoneIntrusion.service.js)
is already complete: it holds the zone polygons, the dwell / K-of-N confirm, the
re-alert heartbeat and the clear timer, and it fans a confirmed intrusion out to
toast + notification bell + email + push. What it does NOT have on this stack is
anything feeding it boxes.

It listens on the `ai.live.overlay` channel, which today only the FACE pipeline
publishes to. A face box only exists when a face is resolvable, so a person who
walks through a restricted zone with their back to the camera, in poor light, or
too far away produces no box at all — and the zone stays silent. That is the gap
this service closes: YOLO person detection, posted to the same ephemeral overlay
channel, so the engine sees a body whether or not there is a usable face.

What is simulated and what is real
----------------------------------
Simulated: the VIDEO. The demo camera is a bundled clip looped into the stream
service by the `local-demo-cam` container, because the real cameras sit on a site
LAN that a dev machine cannot reach.

Real: everything after the frame. The camera is a normal camera row, the zone is
a normal DB row drawn in the Restricted Zone UI, the detection is a real model on
real pixels, and the alert travels the product's real path. Nothing in this file
fabricates an alert or writes one directly — it only reports what it sees, and
the engine decides whether that is worth alerting on.

Not a single-camera demo
------------------------
No camera identity is baked in here. Cameras are read from the backend's own
registry (`/api/internal/cameras`) and selected by `ZONE_SIM_MONITORS`, so
pointing this at real cameras is a config change, not a code change. Set it to
`all` and every camera in the deployment gets person-box coverage.

Environment
-----------
  BACKEND_URL          backend base URL          (default http://smart-cam-backend:5000)
  SERVICE_TOKEN        internal-API shared secret (required)
  ZONE_SIM_MONITORS    comma list of monitorIds, or `all`  (default: all)
  ZONE_SIM_SOURCES     optional `monitorId=rtsp://...` overrides, comma separated
  ZONE_SIM_MODEL       YOLO weights path         (default /models/yolov8n.pt)
  ZONE_SIM_FPS         frames analysed per second per camera (default 4)
  ZONE_SIM_CONF        person confidence floor   (default 0.35)
  ZONE_SIM_IMGSZ       model input size          (default 640)
  ZONE_SIM_DEVICE      torch device, e.g. cuda:0 or cpu (default: auto)
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

import cv2

logging.basicConfig(
    level=os.environ.get("ZONE_SIM_LOG", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("zone-sim")

BACKEND_URL = os.environ.get("BACKEND_URL", "http://smart-cam-backend:5000").rstrip("/")
SERVICE_TOKEN = os.environ.get("SERVICE_TOKEN", "")
MONITORS = os.environ.get("ZONE_SIM_MONITORS", "all").strip()
MODEL_PATH = os.environ.get("ZONE_SIM_MODEL", "/models/yolov8n.pt")
FPS = float(os.environ.get("ZONE_SIM_FPS", "4"))
CONF = float(os.environ.get("ZONE_SIM_CONF", "0.35"))
IMGSZ = int(os.environ.get("ZONE_SIM_IMGSZ", "640"))
DEVICE = os.environ.get("ZONE_SIM_DEVICE", "").strip()
REGISTRY_REFRESH_S = float(os.environ.get("ZONE_SIM_REGISTRY_REFRESH", "60"))
# Consecutive inference failures before a worker gives up on the GPU.
INFER_FAIL_LIMIT = int(os.environ.get("ZONE_SIM_INFER_FAIL_LIMIT", "10"))

# COCO class 0 is `person`. This is the only class we ask the model for — a zone
# breach is about people, and filtering at inference is cheaper than filtering
# the results afterwards.
PERSON_CLASS = 0


def _sources_override() -> dict[str, str]:
    """`ZONE_SIM_SOURCES=mon1=rtsp://a,mon2=rtsp://b` — escape hatch for a camera
    whose registry URL is not what we want to analyse (e.g. read the always-on
    publisher path directly instead of the on-demand `cam_*` egress)."""
    out: dict[str, str] = {}
    for chunk in os.environ.get("ZONE_SIM_SOURCES", "").split(","):
        chunk = chunk.strip()
        if not chunk or "=" not in chunk:
            continue
        mon, _, url = chunk.partition("=")
        out[mon.strip()] = url.strip()
    return out


def _http_json(url: str, method: str = "GET", payload: dict | None = None, timeout: float = 6.0):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("X-Service-Token", SERVICE_TOKEN)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (trusted internal URL)
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)


def fetch_cameras() -> list[dict]:
    """Cameras this service should analyse, straight from the backend registry.

    The registry is the only source of the monitorId → (userId, rtsp) mapping, so
    a camera renamed or re-homed in the UI is picked up here without a redeploy.
    """
    try:
        _, data = _http_json(f"{BACKEND_URL}/api/internal/cameras")
    except Exception as err:  # noqa: BLE001 — any failure is "try again next tick"
        log.warning("camera registry unreachable: %s", err)
        return []

    cams = (data or {}).get("cameras") or []
    wanted = None if MONITORS.lower() in ("all", "*", "") else {
        m.strip() for m in MONITORS.split(",") if m.strip()
    }
    overrides = _sources_override()

    picked = []
    for c in cams:
        mon = c.get("monitorId")
        if not mon or (wanted is not None and mon not in wanted):
            continue
        url = overrides.get(mon) or c.get("rtsp")
        if not url:
            log.warning("camera %s has no RTSP egress URL; skipping", mon)
            continue
        picked.append({
            "monitorId": mon,
            "userId": c.get("userId"),
            "name": c.get("name") or mon,
            "url": url,
        })

    if wanted is not None:
        missing = wanted - {c["monitorId"] for c in picked}
        for mon in sorted(missing):
            log.warning("ZONE_SIM_MONITORS names %s, which is not in the camera registry", mon)
    return picked


def post_overlay(cam: dict, w: int, h: int, boxes: list[dict]) -> None:
    """Publish one frame's person boxes on the ephemeral overlay channel.

    This is the SAME endpoint the face pipeline uses. It is never persisted and
    never becomes an alert on its own — the zone engine subscribes to it and
    applies the zone's own dwell / confirm / cooldown rules before anything
    reaches an operator.
    """
    payload = {
        "userId": cam["userId"],
        "monitorId": cam["monitorId"],
        "ts": int(time.time() * 1000),
        "frameW": w,
        "frameH": h,
        "boxes": boxes,
    }
    try:
        _http_json(f"{BACKEND_URL}/api/internal/ai/overlay", method="POST", payload=payload)
    except urllib.error.HTTPError as err:
        log.warning("[%s] overlay POST rejected: %s %s", cam["name"], err.code, err.reason)
    except Exception as err:  # noqa: BLE001
        log.warning("[%s] overlay POST failed: %s", cam["name"], err)


def open_capture(url: str) -> cv2.VideoCapture | None:
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        cap.release()
        return None
    # A 1-frame buffer keeps us on the live edge. Without it OpenCV queues frames
    # and the boxes drift steadily behind the picture the operator is watching,
    # which makes a zone alert look like it fired at the wrong moment.
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:  # noqa: BLE001 — not supported on every backend
        pass
    return cap


def camera_worker(cam: dict, stop: threading.Event) -> None:
    """One thread per camera: decode → detect people → publish boxes.

    Each camera gets its OWN model instance because the tracker carries per-stream
    state; sharing one across threads would blend identities between cameras.
    """
    from ultralytics import YOLO

    name = cam["name"]
    model = YOLO(MODEL_PATH)
    kw = {"device": DEVICE} if DEVICE else {}
    min_gap = 1.0 / FPS if FPS > 0 else 0.0
    # Tracking gives stable ids, which the on-video overlay prefers for smoothing
    # its boxes. But ultralytics' tracker pulls `lap` and will try to pip-install
    # it AT RUNTIME on first use — a demo that needs a working package index the
    # moment the container boots is not a demo you want to give. So we try the
    # tracker once and fall back to plain detection for the life of the worker if
    # it is not available. The zone engine ignores trackId entirely; only the
    # overlay's box smoothing benefits, and it has a positional fallback.
    use_track = os.environ.get("ZONE_SIM_TRACK", "true").lower() not in ("0", "false", "no")
    # A CUDA context can go bad for reasons that have nothing to do with us (a
    # second process grabbing the GPU, a driver hiccup) and every subsequent
    # inference then throws. Left alone the worker would sit there logging the
    # same error forever while the zone silently stopped being watched — the
    # worst failure mode for a security feature, because nothing looks broken.
    # After a run of consecutive failures we rebuild the model on the CPU: much
    # slower, but a watched zone beats an unwatched one.
    fail_streak = 0
    on_cpu = DEVICE.lower() == "cpu"

    cap: cv2.VideoCapture | None = None
    backoff = 1.0
    last_post = 0.0
    logged_shape = False

    log.info("[%s] worker starting — source=%s", name, cam["url"])

    while not stop.is_set():
        if cap is None:
            cap = open_capture(cam["url"])
            if cap is None:
                log.warning("[%s] cannot open source; retrying in %.0fs", name, backoff)
                stop.wait(backoff)
                backoff = min(backoff * 2, 30.0)
                continue
            log.info("[%s] source open", name)
            backoff = 1.0

        ok, frame = cap.read()
        if not ok or frame is None:
            log.warning("[%s] stream ended or stalled; reconnecting", name)
            cap.release()
            cap = None
            stop.wait(1.0)
            continue

        # Pace the MODEL, not the decoder. We still read every frame (so the
        # decoder stays on the live edge and does not build a backlog) but only
        # infer at ZONE_SIM_FPS — the engine's dwell window is measured in
        # seconds, so 4 fps is ample and leaves the GPU free for everything else.
        now = time.monotonic()
        if now - last_post < min_gap:
            continue
        last_post = now

        h, w = frame.shape[:2]
        if not logged_shape:
            log.info("[%s] frame %dx%d", name, w, h)
            logged_shape = True

        try:
            if use_track:
                try:
                    results = model.track(
                        frame, persist=True, classes=[PERSON_CLASS],
                        conf=CONF, imgsz=IMGSZ, verbose=False, **kw,
                    )
                except Exception as err:  # noqa: BLE001 — tracker unavailable
                    log.warning("[%s] tracker unavailable (%s); continuing without track ids", name, err)
                    use_track = False
                    continue
            else:
                results = model.predict(
                    frame, classes=[PERSON_CLASS],
                    conf=CONF, imgsz=IMGSZ, verbose=False, **kw,
                )
        except Exception as err:  # noqa: BLE001 — a bad frame must not kill the worker
            fail_streak += 1
            log.warning("[%s] inference failed (%d in a row): %s", name, fail_streak, err)
            if fail_streak >= INFER_FAIL_LIMIT and not on_cpu:
                log.error("[%s] falling back to CPU inference after %d failures", name, fail_streak)
                try:
                    model = YOLO(MODEL_PATH)
                    kw = {"device": "cpu"}
                    on_cpu = True
                    fail_streak = 0
                except Exception as reload_err:  # noqa: BLE001
                    log.error("[%s] CPU fallback failed: %s", name, reload_err)
            stop.wait(0.5)
            continue
        fail_streak = 0

        boxes: list[dict] = []
        for res in results or []:
            det = getattr(res, "boxes", None)
            if det is None:
                continue
            xyxy = det.xyxy.tolist() if det.xyxy is not None else []
            confs = det.conf.tolist() if det.conf is not None else []
            ids = det.id.tolist() if getattr(det, "id", None) is not None else []
            for i, box in enumerate(xyxy):
                x1, y1, x2, y2 = (float(v) for v in box[:4])
                entry = {
                    # The engine takes the bottom-centre of the box as the
                    # person's ground position, so a body box puts the point at
                    # the feet — where they actually stand. That is why a person
                    # detector and not a face detector belongs on this channel.
                    "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "conf": round(float(confs[i]), 3) if i < len(confs) else None,
                }
                if i < len(ids) and ids[i] is not None:
                    entry["trackId"] = int(ids[i])
                # Deliberately NO `name`: an unidentified body is exactly what the
                # engine treats as an intruder. Naming it here would silently
                # match the zone's authorised list and suppress the alert.
                boxes.append(entry)

        if boxes:
            post_overlay(cam, w, h, boxes)

    if cap is not None:
        cap.release()
    log.info("[%s] worker stopped", name)


def main() -> None:
    if not SERVICE_TOKEN:
        raise SystemExit("SERVICE_TOKEN is not set — the internal API would reject every post")

    log.info(
        "zone-sim starting — backend=%s monitors=%s model=%s fps=%.1f conf=%.2f",
        BACKEND_URL, MONITORS, MODEL_PATH, FPS, CONF,
    )

    stop = threading.Event()
    workers: dict[str, threading.Thread] = {}

    # Poll the registry rather than reading it once: a camera added, renamed or
    # re-pathed in the UI should start being covered without restarting this
    # service. Threads are only ever ADDED here — a worker exits on its own when
    # `stop` is set, and a camera that disappears simply stops reconnecting.
    while not stop.is_set():
        for cam in fetch_cameras():
            mon = cam["monitorId"]
            alive = workers.get(mon)
            if alive is not None and alive.is_alive():
                continue
            t = threading.Thread(target=camera_worker, args=(cam, stop), name=f"cam-{mon}", daemon=True)
            workers[mon] = t
            t.start()

        if not workers:
            log.warning("no cameras matched ZONE_SIM_MONITORS=%s — nothing to analyse", MONITORS)

        stop.wait(REGISTRY_REFRESH_S)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("interrupted; exiting")
