# Camera Placement & Detection Quality Specs — Drishyam VMS

*Practical field spec for face detection/recognition quality (Sharda deployment).
Based on IEC 62676-4 (DORI) + our pipeline's measured behaviour (SCRFD detector,
8 fps, 960 px detection input, track-confirm K=3).*

---

## 1. The one number that decides everything: pixels on the face

| Goal | Face width needed (native pixels) | DORI class | px/metre |
|---|---|---|---|
| **Identify** (watchlist match, name a person) | **≥ 110 px** | Identify | 250 px/m |
| **Recognize** (same person across cameras, ReID) | ≥ 60 px | Recognize | 125 px/m |
| **Detect / count** (headcount, occupancy, intrusion) | ≥ 25 px | Detect | 25–62 px/m |

Everything else (lens, distance, mounting) is just a way of achieving the pixel
count. If a face is smaller than ~60 px on the recorded frame, no software
setting will make recognition reliable.

## 2. Maximum distance for RECOGNITION by lens (1080p camera)

| Lens | Horizontal FOV | Identify (watchlist) | Recognize | Detect/count |
|---|---|---|---|---|
| 2.8 mm | ~105° | **≤ 3 m** | ≤ 6 m | ≤ 15 m |
| 4 mm | ~85° | **≤ 4.5 m** | ≤ 9 m | ≤ 22 m |
| 6 mm | ~55° | **≤ 7 m** | ≤ 14 m | ≤ 35 m |
| 12 mm | ~28° | **≤ 14 m** | ≤ 28 m | ≤ 70 m |

- 4K camera ≈ **double** each distance.
- Our AI resizes frames to 960 px for detection — faces already near the minimum
  at native resolution get halved again, so **stay well inside these ranges**
  (treat the Identify column as the practical limit, not the theoretical one).

## 3. Placement rules (these matter more than megapixels)

1. **Chokepoints, not open areas.** Doors, gates, turnstiles, corridors — where
   every person MUST pass close and face forward. One camera covers a
   **2.5–3.5 m wide** gate at identify quality; a wide hall camera is
   count-only, never recognition.
2. **Mounting height 2.2–2.5 m, downward tilt ≤ 15°.** Ceiling-height cameras
   (3 m+, steep tilt) see the top of heads — recognition drops to near zero.
   (Measured on our own fleet: eye-level entry cam 70% recognition, overhead
   cam 5%.)
3. **Face angle ≤ 30°** off frontal (yaw or pitch). Place the camera facing the
   direction people WALK, not sideways.
4. **Light on the face, not behind it.** ≥ 200 lux at the face. A gate with the
   sun/outdoor light BEHIND the walker silhouettes the face — enable **WDR** or
   re-aim. Avoid IR-only night mode for recognition (detection still works).
5. **One clean second.** At 8 fps with 3-hit confirm, a person must be fully in
   frame ≥ ~0.5 s. Don't aim at spots where people appear for 2–3 frames only
   (e.g., a doorway seen edge-on).

## 4. Camera & stream settings

| Setting | Requirement | Why |
|---|---|---|
| Resolution (main stream) | **1080p minimum** (4K for wide gates) | AI runs on the main stream |
| FPS | ≥ 12 at the camera (AI samples 8) | motion blur, track continuity |
| Shutter | ≤ 1/100 s in walk areas | face blur kills matching |
| Codec | H.264 preferred (or H.265 via relay transcode) | browser + pipeline compatibility |
| Bitrate | ≥ 2 Mbps per 1080p camera | compression artefacts destroy small faces |
| WDR / BLC | ON at entrances facing outside light | backlight silhouettes |

## 5. Enrollment quality (the other half of recognition)

- Enroll **3–5 photos per person**, ≥ 200 px face width, frontal ± slight angles.
- Best: capture enrollment photos **from the actual camera's angle** (a frame
  grab of the person at the gate beats a passport photo).
- Poor phone selfies at odd angles = missed matches even with perfect placement.

## 6. Quick health test per camera (after installing)

1. Stand at the farthest point recognition should work; walk through normally.
2. Check Alerts: a `person.unknown` (or watchlist) event with a **sharp snapshot
   where the face is ≥ 110 px wide** = camera passes.
3. Blurry / tiny / top-of-head snapshot = re-aim, zoom, or reclassify the camera
   as count-only.

## 7. Sharda demo fleet — current classification

| Camera use | Recommendation |
|---|---|
| Gate / door cams (people ≤ 4–5 m, frontal) | Recognition + watchlist ON |
| Corridor cams (side view or > 6 m) | Detection/count + presence alerts |
| Overhead / wide-area cams | Headcount & occupancy ONLY — turn watchlist alerts off (saves GPU + kills junk alerts) |
</content>
