Build the backend side of "relay missed-footage backfill" in smart-cam-backend. The relay script is already written; your job is the three API routes it calls, plus the storage/stitching rules below. Build and test locally only. Do not deploy to prod; report back when done.

## Background

Customer sites with private-LAN NVRs run a Windows relay (edge-relay/drishyam-site-relay.ps1). It pulls each NVR channel and pushes it to the cloud stream service as `rtsps://103.109.7.36:8555/edge_<site>_<token>_ch<N>`. A Drishyam camera then points at host `mediamtx`, port 8554, path `/edge_<site>_<token>_ch<N>`, and the cloud records `cam_<monitorId>` as usual: RECORD_PATH in services/streaming/StreamServiceEngine.js, then services/recordingSync.service.js stitches and uploads to S3 as `recordings/<userId>/<group>/<camera>/<YYYY-MM-DD>/HH-MM-SS_to_HH-MM-SS_Nm.mp4`.

When the relay PC or its internet goes down, nothing reaches the cloud, so cloud recording has a hole, but the NVR keeps recording to its own disk. The new relay version fills that hole after it comes back:
1. It asks the cloud which time ranges are missing (`GET /gaps`).
2. It copies those ranges from NVR playback in about 60-second MP4 files.
3. It uploads each one (`PUT /backfill`), labelled with its original UTC start time.

You make the cloud answer those calls and drop the files into the normal recording pipeline, so they show up in Cloud Playback at the right time.

Read edge-relay/drishyam-site-relay.ps1 for the exact client behaviour: functions Bf-Register, Bf-Plan, Bf-Put, Bf-Drain. The contract below is what it already sends and expects. Don't change the contract without telling me, because the script would then have to change too.

## Common to all three routes

- Base path: `/api/relay/v1`. It is reached through nginx and the Cloudflare tunnel (`https://demo.indyatools.com/api/...`). These routes are NOT user-JWT routes; they use the relay key below.
- Headers on every call:
  - `Authorization: Bearer <key>`, where key is 64 lowercase hex chars, generated once per relay install
  - `X-Relay-Prefix: edge_<site>_<token>`, which must match `^edge_[a-z0-9]+_[a-z0-9]+$`
  - `X-Relay-Version: 2026.10.26`
- `stream` query param must match `^edge_[a-z0-9]+_[a-z0-9]+_ch\d+$` and must start with `<X-Relay-Prefix>_ch`. Otherwise return 403.
- Times are ISO-8601 UTC, `YYYY-MM-DDTHH:mm:ssZ` (URL-encoded in query strings).

## Auth model: trust on first use

Live RTSPS publish is unauthenticated today; the unguessable token in the stream name is the only protection. That is a separate, known issue; don't fix it here. For uploads we add a per-relay key:
- Store `sha256(key)` per prefix in a new table, e.g. `relay_sites`:
  - `prefix` (unique), `key_hash`, `streams` (JSON), `brand`, `version`, `hostname`
  - `first_seen_at`, `last_seen_at`, `revoked_at` (nullable)
  - a counter or last-upload time for visibility
- Add it with a migration in the repo's existing style; check the current migration numbering yourself. Do NOT rely on Sequelize `sync({alter})`, which caused the ER_TOO_MANY_KEYS crash-loop before.
- The first register for a prefix stores the key. Later calls must present the same key.
  - Compare with `crypto.timingSafeEqual` on the hashes.
  - Unknown prefix on gaps or backfill: 401.
  - Wrong key or revoked: 403.
- Add an admin-only way to reset a binding, e.g. `DELETE /api/admin/relay-sites/:prefix`, plus a list endpoint. This is for when a relay PC is replaced. Reuse the existing admin auth middleware.
- Rate-limit per prefix and per IP:
  - register: about 10 per hour
  - gaps: about 60 per hour per stream
  - backfill: at most 2 concurrent uploads per prefix and about 200 per hour

## Route 1: `POST /api/relay/v1/register`

Body (JSON):
```json
{ "prefix": "edge_poc_mt9lc2", "streams": ["edge_poc_mt9lc2_ch3", "edge_poc_mt9lc2_ch4"], "brand": "hikvision", "version": "2026.10.26", "hostname": "VIDIT-HP" }
```
- Body `prefix` must equal the header. Every stream must start with `prefix + "_ch"`.
- No row yet: create it and return 201 `{ ok: true }`.
- Row exists with the same key: update `streams`, `version`, `hostname`, `last_seen_at` and return 200 `{ ok: true }`.
- Row exists with a different key: return 409 `{ ok: false, reason: "prefix registered to another key" }`.

## Route 2: `GET /api/relay/v1/gaps?stream=<s>&from=<iso>&to=<iso>`

The relay sends `from = now - 24h` and `to = now - 180s`.

1. Find every camera whose stream source is this edge stream: effective host is the stream service (`mediamtx` / stream-service alias), and the path is `/<stream>` after normalising the leading slash and stripping any query.
   - Cameras inside a group take host/port from the group (group.host overrides). Follow however buildCamConfig and the stream engine resolve it.
   - Several cameras or accounts can point at the same edge stream.
   - No camera uses it: return 404 `{ ok: false, reason: "no camera uses this stream" }`.
2. Keep only cameras with cloud recording enabled. If none, return 200 `{ stream, recording: false, gaps: [] }`.
3. Coverage per camera is the union of:
   - S3 objects for that camera on the dates overlapping `[from - 1 day, to]`. Parse `HH-MM-SS_to_HH-MM-SS` in the filename; an end earlier than the start means it crossed midnight.
   - Local, not-yet-synced files in `RECORDINGS_DIR/cam_<monitorId>/<YYYY-MM-DD>/HH-MM-SS-ffffff.mp4`. Start comes from the name. For the end, use ffprobe duration if cheap; otherwise the next file's start, or mtime for the newest file still being written.
   - This includes backfill files already accepted but not yet synced (they live in the same folder, see route 3). That is required: the relay re-plans every few minutes and must not be told again about a minute it already uploaded.
   - Merge pieces that are at most 3 s apart.
4. A gap is a hole in coverage that has coverage on BOTH sides, inside `[from, to]`.
   - A hole before the first recording or after the last one is not a gap. We can't tell whether the camera existed or was recording then, and the live push may simply be running.
   - Ignore holes shorter than 20 s.
   - Clamp `from` to at least `now - 7 days` and inside the camera's retention window.
   - Cap the response at 500 gaps.
   - With several cameras, report the union of holes: a range is a gap if any recording camera is missing it.
5. Respond 200:
```json
{ "stream": "edge_poc_mt9lc2_ch3", "recording": true, "gaps": [ { "start": "2026-10-26T04:10:00Z", "end": "2026-10-26T05:02:13Z" } ] }
```
6. Keep it cheap. Cache S3 listings per camera and date for about 60 s; this is called every few minutes per channel.

## Route 3: `PUT /api/relay/v1/backfill?stream=<s>&start=<iso>`

The body is raw `video/mp4`: H.264 or H.265, about 60 s (always 130 s or less), usually 5–40 MB.

1. Stream the body to a temp file under `RECORDINGS_DIR/.relay-incoming/`, on the same filesystem so the final rename is atomic.
   - Don't buffer it in memory, and don't let `express.json()` or any body parser touch this route. Mount it before them, or exclude it.
   - Reject over 95 MB with 413. Cloudflare's per-request limit is 100 MB.
   - Allow up to 30 minutes per request: the relay caps its upload speed.
2. Validate, and return 422 with a reason if any check fails:
   - `start` parses and lies in `[now - 7 days, now - 60 s]`
   - ffprobe shows exactly one video stream with codec h264 or hevc
   - duration is 1–130 s
3. Work out the target cameras: the recording-enabled cameras for this stream (as in route 2) whose coverage overlaps `[start, start + duration]` by at most 10 s.
   - NVR playback starts on the previous key frame, so a few seconds of overlap are normal and fine.
   - No target camera left: 409 `{ ok: false, reason: "already have it" }`.
   - The same stream+start received before: also 409.
   - No camera uses the stream: 404.
4. For each target camera, place the file at `RECORDINGS_DIR/cam_<monitorId>/<YYYY-MM-DD>/<HH-MM-SS>-000000.mp4` (hardlink or copy, then rename).
   - Use exactly the date/time convention `parseStartTime()` in recordingSync.service.js reads back. It uses the Node process's local time, which must equal the stream-service container's TZ.
   - Verify both are UTC and keep UTC. Don't "fix" names to IST.
   - Never overwrite an existing file. On a name clash, bump the microsecond field.
5. Return 201 `{ ok: true, cameras: ["<monitorId>", ...], durationSec }`.
6. Check disk space: if free space on the recordings volume is below a safe threshold, return 503 so the relay retries later.
7. From here the existing recordingSync S3 loop uploads the file.
   - **Stitching rule you must add.** Backfill files are short (about 60 s, under STITCH_BELOW_SEC), so the stitcher will try to `concat -c copy` them with neighbours. Their codec, resolution or profile can differ from the live recording next to them (NVR main recording vs relay sub-stream/transcode). Concatenating mismatched streams makes a broken MP4.
   - Make the stitcher merge only files with identical video codec, width and height; probe these, or mark backfill files and stitch backfill only with backfill.
   - Consecutive backfill pieces should still merge into normal-length records.
8. If simple, tag the S3 object (metadata, e.g. `source=relay-backfill`) and write an audit/log line per accepted file.

## How the relay reacts to each status (match these exactly)

| Route | Status | Relay does |
|---|---|---|
| register | 200 / 201 | proceeds |
| register | 409, 401, 403 | stops backfill for 15 min and logs "ask Drishyam to reset it" |
| register | anything else | retries in 60 s |
| gaps | 200 | uses `gaps`. `recording: false` means skip this channel |
| gaps | 401 / 403 | treats the key as rejected and pauses |
| gaps | anything else (incl. 404) | skips this channel for this round |
| backfill | 200 / 201 | deletes its local file |
| backfill | 409 | deletes its local file (cloud already has it) |
| backfill | 400, 404, 413, 415, 422 | sets the file aside permanently, never retries |
| backfill | 401 / 403 | treats the key as rejected and pauses |
| backfill | 0 / 429 / 5xx / anything else | keeps the file and retries later |

## Also needed

- **nginx (nginx.prod.conf, which is where the prod body limit is set; mirror it in the local nginx.conf).** Add `location /api/relay/` with:
  - `client_max_body_size 100m;`
  - `proxy_request_buffering off;`
  - `proxy_read_timeout 1800s;` and `proxy_send_timeout 1800s;`
- **Recording vs on-demand.** Check whether a recording-enabled camera's `cam_<mid>` path is always pulled (sourceOnDemand false). Otherwise "recording" only happens while someone watches, and the gap logic would report every unwatched hour as missing. Tell me what you find; don't silently change on-demand behaviour, because NVR load is a known problem.
- **Tests.**
  - Unit tests for the gap calculation: midnight crossing, the "bounded on both sides" rule, 3 s merge, 20 s minimum, local + S3 union, multi-camera union.
  - Route tests using a generated MP4 (`ffmpeg -f lavfi -i testsrc2 -t 60 -c:v libx264 x.mp4`):
    - register: 201, then 200, then 409 with a different key
    - auth: 401 and 403
    - stream not under prefix: 403
    - wrong file: 422
    - duplicate: 409
    - file lands in the right `cam_<mid>/<date>/` folder with the right name
    - the stitcher does not merge a 640x360 file with a 1920x1080 neighbour
- Follow the codebase's existing patterns: controllers/services/routes layout, logger, Joi validation, error handling.

## When you finish, report

- what files changed
- the migration name
- test results
- the recording/on-demand finding
- any place where the contract above didn't fit the codebase
