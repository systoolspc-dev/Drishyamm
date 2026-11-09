"""zone-guard — person-in-restricted-zone detector.

Pulls a camera's cloud stream, runs YOLO person detection+tracking, and posts
the person boxes to the backend's /api/internal/ai/overlay channel. The existing
zoneIntrusion engine (K-of-N confirm + dwell + per-track cooldown) evaluates them
against the restricted zone and fires the alert. This detects ANY person in the
zone regardless of whether their face is visible (people looking down at screens),
which the face detector can't do.
"""
import os, time, base64, requests, cv2
from ultralytics import YOLO

CAM      = os.environ["CAM_RTSP"]
MID      = os.environ["MID"]
USERID   = os.environ["USER_ID"]
BACKEND  = os.environ.get("BACKEND", "http://smart-cam-backend:5000")
STOKEN   = os.environ["STOKEN"]
CONF     = float(os.environ.get("CONF", "0.35"))
INTERVAL = float(os.environ.get("INTERVAL", "0.5"))
MODEL    = os.environ.get("MODEL", "yolov8n.pt")

print(f"[zone-guard] cam={CAM} mid={MID} model={MODEL}", flush=True)
model = YOLO(MODEL)
url = f"{BACKEND}/api/internal/ai/overlay"
hdr = {"X-Service-Token": STOKEN}

def open_cap():
    c = cv2.VideoCapture(CAM, cv2.CAP_FFMPEG)
    return c

cap = open_cap()
last = 0.0
while True:
    ok, frame = cap.read()
    if not ok or frame is None:
        print("[zone-guard] read fail, reopening", flush=True)
        cap.release(); time.sleep(2); cap = open_cap(); continue
    now = time.time()
    if now - last < INTERVAL:
        continue
    last = now
    h, w = frame.shape[:2]
    try:
        res = model.track(frame, classes=[0], conf=CONF, persist=True, verbose=False)
    except Exception as e:
        print("[zone-guard] track err", e, flush=True); continue
    boxes = []
    for r in res:
        if r.boxes is None:
            continue
        for b in r.boxes:
            x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
            tid = int(b.id[0]) if b.id is not None else None
            # crop the person → small JPEG → base64 so the alert card + email
            # can show WHO was in the zone. Downscaled to keep the payload light.
            snap = None
            try:
                cx1, cy1 = max(0, int(x1)), max(0, int(y1))
                crop = frame[cy1:int(y2), cx1:int(x2)]
                if crop.size:
                    if crop.shape[0] > 260:
                        sc = 260.0 / crop.shape[0]
                        crop = cv2.resize(crop, (max(1, int(crop.shape[1] * sc)), 260))
                    ok2, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 62])
                    if ok2:
                        snap = base64.b64encode(buf).decode("ascii")
            except Exception:
                snap = None
            boxes.append({"bbox": [x1, y1, x2, y2],
                          "trackId": (f"p{tid}" if tid is not None else None),
                          "conf": float(b.conf[0]) if b.conf is not None else None,
                          "name": None, "snap": snap})
    if boxes:
        try:
            requests.post(url, json={"userId": USERID, "monitorId": MID, "frameW": w,
                                     "frameH": h, "boxes": boxes, "ts": int(now * 1000)},
                          headers=hdr, timeout=4)
            print(f"[zone-guard] posted {len(boxes)} person(s)", flush=True)
        except Exception as e:
            print("[zone-guard] post err", e, flush=True)
