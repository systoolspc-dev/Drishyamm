# How drisyam interfaces with an NVR / camera

> Short answer to the two common questions:
> 1. **Do we read/write the NVR?** We **read** the live stream + config; we **write** only encoder/PTZ/audio settings. Nothing else on the NVR is touched.
> 2. **Do we use the NVR's recordings?** **No.** drisyam records the stream itself (MediaMTX → S3). The NVR's own HDD is never read or modified.

This is enforced/described in code by `vendors.nvrInterface(deviceType)`
(`smart-cam-backend/src/services/vendors/index.js`).

---

## 1. Live stream — **read-only pull**

```
NVR / IP camera  ──RTSP(pull)──►  MediaMTX  ──WebRTC/HLS──►  browser
                                     │
                                     └──RTSP(pull)──►  AI service (footfall, etc.)
```

- MediaMTX **pulls** RTSP from the device: `rtsp://<user>:<pass>@<host>:<port><path>`.
  The `<path>` is built per-vendor by the driver registry
  (`buildRtspPath` / `buildSubPath`), e.g.
  - Hikvision `…/Streaming/Channels/101` (sub `/102`)
  - Dahua / CP Plus `…/cam/realmonitor?channel=1&subtype=0` (sub `subtype=1`)
  - Uniview `…/unicast/c1/s0/live` (sub `s1`)
  - Bosch `…/rtsp_tunnel?inst=1&line=1` (sub `inst=2`)
  - Hanwha `…/profile2/media.smp`
- **We never push video INTO the NVR.** The device is purely an RTSP source.
- We pull **two streams** when available: main (record + single-view) and sub
  (grid tiles), so the grid doesn't pull full-res from every camera.

## 2. Device config — **read some, write a little**

All over HTTP (ISAPI / CGI / ONVIF), implemented in `deviceProbe.service.js`:

| Operation | Direction | What | Used by |
|---|:--:|---|---|
| Device info / model | **read** | name, model, serial | onboarding |
| Per-channel names | **read** | the names the installer set on the NVR | auto-naming (`discoverChannelNames`, `/sync-names`) |
| Signal presence (`hasVideo`) | **read** | which channels have a live input | onboarding (skip empty channels) — Hikvision today |
| Encoder (bitrate/GOP/fps) | **write** | sharper stream + sub-1s pop-in | "Boost"/encoder endpoints |
| Keyframe interval (GOP) | **write** | fast viewer pop-in | keyframe endpoint |
| Two-way audio | **write** | operator → device speaker | talkback (Hik/Dahua today) |
| PTZ move/preset | **write** | pan/tilt/zoom | _planned (registry-ready)_ |

**We never write** the NVR's storage, recording schedule, user accounts,
network settings, or firmware. The write surface is exactly the rows above, and
only for vendors whose driver advertises that capability
(`driver.capabilities`). Everything else is read-only.

## 3. Recordings — **drisyam-owned, not the NVR's**

```
NVR RTSP ─► MediaMTX (records 10-min MP4 segments to a shared volume)
             │
             └─► Node recordingSync.service ─► stitch ─► upload to S3 ─► delete local
                                                                  │
                                       app playback (getRecordingPlayUrl / streamRecording) ◄─ S3
```

- We **do not** use the NVR's internal HDD recordings, ONVIF **Profile G**
  playback, or vendor playback APIs. There is **no code path** that reads
  recordings off the NVR.
- Continuous recording is done by **MediaMTX** on the stream it already pulls,
  then Node uploads to **S3** (`recordingSync.service.js`). All playback,
  thumbnails, and downloads in the app come from **S3**.
- Implication: recording continuity depends on the **MediaMTX pull** being up,
  not on the NVR's own recording. If MediaMTX/our pull is down, that window is
  not captured by us (even if the NVR recorded it locally).

### Why not use the NVR's recordings?

| | drisyam records (current) | Use NVR's own recordings |
|---|---|---|
| Central search/AI/clip/export | ✅ uniform across all vendors | ❌ per-vendor playback APIs, fragmented |
| Storage | ✅ S3 (durable, offsite, scalable) | ⚠️ NVR HDD (local, limited, fails) |
| Bandwidth | ⚠️ we pull every stream continuously | ✅ NVR already stored it |
| Survives our outage | ❌ gap if our pull is down | ✅ NVR keeps recording locally |

> **Optional future capability:** an *NVR-recordings playback* mode (ONVIF
> Profile G / vendor playback) could be added as a per-group toggle for
> deployments that prefer NVR storage or want a fallback for gaps. It is **not**
> built today — call it out if you want it scoped.
