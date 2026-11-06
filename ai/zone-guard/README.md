# zone-guard — restricted-zone person detection

`zone_sim.py` runs YOLOv8 person detection on the cameras that have
restricted zones and posts **body** boxes to the backend's live overlay
channel (`POST /api/internal/ai/overlay`). The backend's zone engine
(`backend/src/services/zoneIntrusion.service.js`) listens on that channel and
fires the alert, so a zone triggers on anyone — whether or not a face is
visible.

There is no separate image: compose runs this script inside the head-count
image, which already has Ultralytics + OpenCV.

| Setting (root `.env`) | Default | Meaning |
|---|---|---|
| `ZONE_GUARD_MONITORS` | `all` | `all` cameras from the backend's registry (`/api/internal/cameras`), or a comma list of monitorIds |
| `ZONE_GUARD_SOURCES` | empty | `monitorId=rtsp://…` overrides, e.g. to read the demo publisher: `<id>=rtsp://stream-service:8554/demo_src` |

Fixed in `docker-compose.yml`: model `models/person/yolov8n.pt`, 4 fps,
confidence 0.35.

Zone logic (in the backend, per zone): foot-point inside the polygon → dwell
5 s (min 0.8 s) before firing → re-alert after 5 min → clear after 8 s empty.
Design and test results: [MODEL.md](MODEL.md),
[../../docs/RESTRICTED_ZONE_DETECTION.md](../../docs/RESTRICTED_ZONE_DETECTION.md).

Known limits: recall drops sharply for overlapping people (21 % in the test
harness vs 90 % isolated), and when the scene is empty the script posts
nothing, so the zone clears on the backend's timeout rather than on an
explicit "empty" frame.
