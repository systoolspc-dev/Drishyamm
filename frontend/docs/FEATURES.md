# smart-cam-app — Features

One section per page. Each section: **what it does**, **where it lives**, **data it reads**, **data it writes**, **key components**, **common changes**.

---

## Login + Auth

Login page, register, forgot-password, reset-password flows.

- **Where**: [src/pages/Login.jsx](../src/pages/Login.jsx), [Register.jsx](../src/pages/Register.jsx), [ForgotPassword.jsx](../src/pages/ForgotPassword.jsx), [ResetPassword.jsx](../src/pages/ResetPassword.jsx)
- **Reads/Writes**: POST `/api/auth/login` → access JWT in axios memory + refresh in HTTP-only cookie. Zustand `authStore.login()` puts the user into state.
- **Components**: shadcn `Card`, `Input`, `Button`
- **Common changes**: add a field to register (e.g. company name), tweak the email-verify gate, change the brand logo.

---

## Dashboard

Building-wide overview tiles, hero stream, recent activity.

- **Where**: [src/pages/Dashboard.jsx](../src/pages/Dashboard.jsx)
- **Reads**: `useGroups()` for cameras; `aiService.peopleCount()` for live count (polled every 2 s); `useEvents()` for recent activity
- **Components**: `<DirectStreamPlayer forceHls quality="low">` for tiles, `<KpiTile>`, `<RecentActivityList>`
- **Common changes**: add a tile, change the tile poll cadence, rearrange the layout

---

## Live View

Single / 2×2 / 2×3 grid layouts for live camera viewing.

- **Where**: [src/pages/LiveView.jsx](../src/pages/LiveView.jsx)
- **Reads**: `useGroups()` for the camera list + sidebar; `?monitor=<id>` deep-link param
- **Writes**: nothing (read-only). `POST /api/cameras/:id/heal` for the heal button
- **Components**: `<DirectStreamPlayer>` (WebRTC-first), `<GroupAccordion>` (sidebar tree), `<LayoutPicker>`, `<StreamHealthPanel>` (the Face Quality Boost surface)
- **Common changes**: tweak the grid breakpoints, add a new layout option, change the auto-select fallback behavior
- **Notable bug fixed**: silent fallback to "first online camera" when a deep-link monitor wasn't found — now shows a `That camera isn't available to you` banner with the requested monitor id

---

## Monitor Wall

Wall-mounted display mode — full-screen grid, no chrome, auto-rotate.

- **Where**: [src/pages/MonitorWall.jsx](../src/pages/MonitorWall.jsx)
- **Reads**: same `useGroups()` data as Live View
- **Common changes**: rotate interval, max grid size, fullscreen API hooks

---

## Map

Leaflet map with camera markers. Click a marker → mini-stream preview.

- **Where**: [src/pages/Map.jsx](../src/pages/Map.jsx)
- **Reads**: `useGroups()` for `latitude`/`longitude` on each Camera; clustering via `leaflet.markercluster`
- **Common changes**: tile provider, marker icons by status, click-action

---

## Playback

Date-picker + clip list per camera; range-aware `<video>` element streams from S3 via the backend proxy.

- **Where**: [src/pages/Playback.jsx](../src/pages/Playback.jsx)
- **Reads**: `GET /api/recordings?cameraId=&date=` for clip list; `<video src="/api/recordings/<key>/stream">` for the player (Range requests pass through to S3)
- **Writes**: `DELETE /api/recordings/:key`, `GET /api/recordings/:key/download`
- **Common changes**: add timeline scrubber, add export-clip CTA, add bookmark feature

---

## Camera Setup

Add/edit camera groups + cameras + sites.

- **Where**: [src/pages/CameraSetup.jsx](../src/pages/CameraSetup.jsx)
- **Reads**: `useGroups()` and `useSites()`
- **Writes**: `POST/PATCH /api/groups`, `POST/PATCH /api/cameras`
- **Components**: device-probe flow (auto-fills channels after entering host + creds), validation forms
- **Common changes**: add new device type, add bulk-import CSV upload

---

## Camera Health

Per-camera uptime + stream stats + flap history.

- **Where**: [src/pages/CameraHealth.jsx](../src/pages/CameraHealth.jsx)
- **Reads**: `GET /api/health` building-wide, `GET /api/cameras/:id/health` per-camera
- **Components**: status pill, sparkline of bps over time
- **Common changes**: alert thresholds, add a "test connectivity" button

---

## AI Feed

Live overlay viewer — pick a camera, see boxes + identity labels as they happen.

- **Where**: [src/pages/AiFeed.jsx](../src/pages/AiFeed.jsx) (~1500 lines, the largest page)
- **Reads**: `aiService.peopleCount()` every 2 s for header KPIs; `fetch(`${AI_BASE}/api/detections/<id>`)` every 1 s for per-camera bbox state; WS `ai.event` channel for the activity ticker
- **Components**: `<DirectStreamPlayer>` plus the `<AIOverlay>` SVG layer that paints bboxes
- **Common changes**: add a new event-type filter, change the overlay style, add an in-feed CTA

---

## AI Alerts

Event list + detail modal. Today's bucket, search, filters (watchlist / recognised / unknown), `EnhanceFaceDialog` per event.

- **Where**: [src/pages/Alerts.jsx](../src/pages/Alerts.jsx)
- **Reads**: `aiService.listEvents({limit: 200})` initially, then WS `ai.event` to prepend; `aiService.getSnapshotUrl(eventId)` for thumbnails (signed S3 URL)
- **Writes**: `aiService.acknowledge(eventId)`
- **Components**: `<EventCard>`, `<EventDetailModal>` (has the `<EnhanceFaceDialog>` Enhance button in the snapshot pane)
- **Common changes**: new filter, new tone/colour for a kind, new bulk-action button

**Recent fixes worth knowing**:
- Camera name no longer fabricated from hex (was `Cam 28c7a6`, now falls back to `Unnamed camera`). [services/ai.js:173-186](../src/services/ai.js#L173)
- Modal layered with snapshot fallback so live preview never goes fully black

---

## Watchlist

Single-face upload + ZIP dataset upload (for training a new identity model).

- **Where**: [src/pages/Watchlist.jsx](../src/pages/Watchlist.jsx)
- **Reads**: `aiService.listDatasets()`
- **Writes**: `aiService.uploadFace(name, file)`, `aiService.handleUploadDataset(zipFile)`
- **Common changes**: add bulk-delete, add face preview before upload, add quality preview

---

## Face Learning

Operator queue for unknown faces the AI suggests for enrollment. Approve → adds to gallery; Reject → never asks again.

- **Where**: [src/pages/FaceLearning.jsx](../src/pages/FaceLearning.jsx)
- **Reads**: `aiService.listFaceLearningSamples({status: 'pending'})` every 2.5 s; `aiService.getFaceLearningSnapshot(id)` for the crop
- **Writes**: `aiService.approveFaceLearningSample(id)`, `aiService.rejectFaceLearningSample(id, reason)`
- **Components**: `<SampleCard>` with full-image lightbox, `<EnhanceFaceDialog>` in the lightbox for blurry crops
- **Common changes**: bulk approve/reject, similarity-score filter, name-suggestion UI

---

## Personnel Search

Find a person by name / ID / department. Click → "Last seen at" details + Live + Journey buttons.

- **Where**: [src/pages/PersonnelSearch.jsx](../src/pages/PersonnelSearch.jsx)
- **Reads**: GET `${AI_BASE}/personnel/search?q=…&role=…` (direct to AI service for speed)
- **Components**: `<PersonRow>` (click-to-select), `<SelectedPersonPanel>` (mirrors clicked person)
- **Common changes**: extra columns (last camera channel, similarity), saved-search support, role-presets

**Recent fixes**:
- Click-to-select wired (panel was hard-coded to `people[0]` before, so every Live click hit the same camera)
- Dummy fallback data ("Jordan Lee" etc.) removed — empty state shows "AI search service is not reachable" instead

---

## Camera Mapping

Pin cameras to map + define detection zones (polygons).

- **Where**: [src/pages/CameraMapping.jsx](../src/pages/CameraMapping.jsx)
- **Reads**: `aiService.listCameraMapping()`
- **Writes**: `aiService.updateCameraMapping(cameraId, { latitude, longitude, zone, risk })`
- **Common changes**: edit-zone polygon UI, bulk-import positions

---

## Journey Map

Person-by-person chronology — for a selected person, draw their stops on the map ordered by time.

- **Where**: [src/pages/JourneyMap.jsx](../src/pages/JourneyMap.jsx)
- **Reads**: GET `${AI_BASE}/journey/<personId>?from=&to=`
- **Components**: Leaflet `<Polyline>` connecting stops, click-stop snapshot popups
- **Common changes**: dwell-time threshold UI, replay/animate the journey, export PDF report

---

## Footfall

Customer-counter dashboard — per-camera line-crossing, hourly trend, before/after WebRTC preview.

- **Where**: [src/pages/Footfall.jsx](../src/pages/Footfall.jsx)
- **Reads**: `aiService.footfallCameras()` every 5 s; `aiService.footfallTimeseries(...)` every 60 s
- **Writes**: `aiService.footfallPutConfig(cameraId, { enabled, line_y_frac, direction, falls_enabled })`
- **Components**:
  - `<InlineLivePreview>` — wraps `<WebRTCStream>` with MJPEG fallback when WebRTC offline >6 s
  - `<TrendChart>` — hand-rolled SVG smooth-area chart with hover crosshair + tooltip
  - `<CameraCard>`, `<AllCameraRow>` — Tracking vs idle states
  - `<ConfigDrawer>` — line slider, direction picker, falls toggle
  - `<LivePreviewModal>` — full-screen view with `<ModalLiveStream>`
- **Common changes**: add per-camera breakdown to the chart, daily/weekly comparison overlays, threshold alerts

**Recent decisions worth knowing**:
- Architecture is **WebRTC primary + MJPEG fallback**. Decided after a research-agent comparison concluded LiveKit was overkill, MediaMTX's existing WHEP already works for our case, and MJPEG is what Frigate/Shinobi/BlueIris ship for preview tiles. See `smart-cam-ai/docs/FEATURES.md#face-reconstruction` for the snapshot endpoint that powers the MJPEG fallback.
- "World class" face enhancement (the Enhance button) routes through `/api/ai/enhance` → CodeFormer + Real-ESRGAN service. Same dialog (`<EnhanceFaceDialog>`) used here and in AI Alerts + Face Learning.

---

## Stream Health Panel (Boost)

Lives inside Live View, not its own page. The "Face Quality Boost" button that pushes a sharper encoder profile to the camera.

- **Where**: [src/components/StreamHealthPanel.jsx](../src/components/StreamHealthPanel.jsx)
- **Writes**: `POST /api/groups/:groupId/cameras/:monitorId/encoder` with `{bitrateKbps: 8192, gopSec: 1, fps: 25}`
- **Notable**: the toast on failure includes the device's own response — Hikvision NVRs return `statusCode 6: Invalid XML Content` when they reject the write, and the operator copy-paste that to support. Don't break that path.

---

## EnhanceFaceDialog

Reusable Enhance modal — Original / Enhanced side-by-side, triage chips, fidelity slider, Download button.

- **Where**: [src/components/EnhanceFaceDialog.jsx](../src/components/EnhanceFaceDialog.jsx)
- **Usage**: `<EnhanceFaceDialog imageUrl={url}><Button>Enhance face</Button></EnhanceFaceDialog>` — children render as the trigger
- **Writes**: POST `/api/ai/enhance` (multipart) → response keys `triage`, `original_image`, `final_enhanced_image`, `reconstruction_image`, `enhancement_stages[]`, `device`, `fidelity_weight`
- **Common changes**: add ESRGAN-only / CodeFormer-only toggles, add face-crop region selector, add bulk-enhance from Alerts list
