/**
 * talkback.service.js
 *
 * Two-way audio (push-to-talk) — browser microphone → camera speaker.
 *
 * Vendor coverage in this MVP:
 *   hikvision  — ISAPI Two-Way Audio v2 (most common in the field)
 *   dahua      — POST /cgi-bin/audio.cgi?action=postAudio (chunked)
 *   onvif      — not yet (requires RTSP backchannel via ANNOUNCE/RECORD)
 *
 * Per-camera session lifecycle:
 *   open()    — opens the device-side audio sink. Hikvision returns a sessionId
 *               we keep in memory, plus a long-lived HTTP POST stream into which
 *               we pipe browser audio chunks. Dahua opens the POST stream
 *               directly with chunked transfer-encoding.
 *   write()   — append a chunk of audio bytes (PCM µ-law @ 8 kHz, ~160 bytes/20ms)
 *   close()   — close the session, free the device-side resource.
 *
 * Audio format (browser → backend → camera):
 *   PCM µ-law, 8 kHz, 8-bit mono. This is what Hikvision speakers natively
 *   accept; Dahua too. The frontend converts the browser's 48 kHz Float32 PCM
 *   to 8 kHz µ-law before posting (downsample + companding).
 *
 * Session sharing:
 *   Only one talkback session per camera at a time. If a second user clicks
 *   "talk" we 409 them — the first session has the floor. Pre-empt by closing
 *   the first session if you want a different policy.
 */

const axios = require('axios');
const stream = require('node:stream');

const logger = require('../config/logger');
const { digestRequest } = require('../utils/digestAuth');

// in-memory session map: monitorId → { vendor, channel, hikvSessionId,
//                                       writer (http.IncomingMessage), closer }
const _sessions = new Map();

// ── Hikvision ISAPI v2 ──────────────────────────────────────────────────────

/**
 * Open a Hikvision two-way audio session.
 *
 * Hikvision exposes two different endpoint families depending on firmware:
 *   (A) Direct camera: PUT /ISAPI/System/TwoWayAudio/channels/{ch}/open
 *   (B) NVR-attached:  PUT /ISAPI/ContentMgmt/InputProxy/channels/{ch}/twoWayAudio/open
 *
 * Standalone IP cameras + DS-2CDxxx series use (A). Cameras attached to a
 * Hikvision NVR are reached via the NVR's REST surface using (B). We try (A)
 * first and fall back to (B) on 400/404 — most "doesn't work" reports come
 * from the NVR case where we were hitting the wrong namespace.
 *
 * Some firmwares also require an explicit XML body announcing the codec; the
 * empty-PUT shortcut works on most modern devices but not all. We try empty
 * first, then a standard G.711U body if the empty form 400s.
 *
 * If both endpoint families return 400 we surface the device's response body
 * so the operator can see exactly why the camera refused — usually it's "this
 * device does not support two-way audio" at the hardware level.
 */
// Hikvision DVRs/NVRs ship in two camps:
//   * European/Asian SKUs default to G.711 a-law (PCMA)
//   * North American Turbo HD DVRs default to G.711 µ-law (PCMU)
// We try both. Whichever the device accepts is the codec we then use to
// encode our chunks — but since we send µ-law from the browser regardless,
// the device that accepted a-law will mis-decode our audio. To avoid this
// we have the frontend negotiate by trying µ-law first; if open() succeeded
// with the alaw body, the audio path will be wrong-sounding but at least the
// session is established. Production fix is to encode the matching codec.
const HIKV_OPEN_BODIES = [
  `<?xml version="1.0" encoding="UTF-8"?>
<TwoWayAudioChannel><id>1</id><enabled>true</enabled>
  <audioCompressionType>G.711ulaw</audioCompressionType>
  <speakerVolume>80</speakerVolume>
</TwoWayAudioChannel>`,
  `<?xml version="1.0" encoding="UTF-8"?>
<TwoWayAudioChannel><id>1</id><enabled>true</enabled>
  <audioCompressionType>G.711alaw</audioCompressionType>
  <speakerVolume>80</speakerVolume>
</TwoWayAudioChannel>`,
];

async function _hikvOpenAttempt(base, urlPath, username, password, body) {
  const res = await digestRequest({
    url: `${base}${urlPath}`,
    method: 'PUT',
    username, password,
    timeout: 5000,
    headers: { 'Content-Type': 'application/xml' },
    data: body || '',
  });
  return { status: res.status, body: String(res.data || '') };
}

async function openHikvisionSession({ host, httpPort, username, password, channel }) {
  const base = `http://${host}:${httpPort || 80}`;
  const ch = channel || 1;

  // Try, in order, the four most common open paths × two body variants.
  const candidates = [
    `/ISAPI/System/TwoWayAudio/channels/${ch}/open`,                          // direct camera, modern
    `/ISAPI/System/TwoWayAudio/channels/1/open`,                              // direct camera, single-channel
    `/ISAPI/ContentMgmt/InputProxy/channels/${ch}/twoWayAudio/open`,          // NVR-attached
    `/ISAPI/ContentMgmt/InputProxy/channels/${ch}/twoWayAudio/channels/1/open`,
  ];
  const bodies = ['', ...HIKV_OPEN_BODIES];

  let attemptedPath = null;
  let openRes = null;
  let acceptedBody = null;            // remember the codec body the device accepted
  let lastErr = null;
  outer: for (const path of candidates) {
    for (const body of bodies) {
      try {
        const r = await _hikvOpenAttempt(base, path, username, password, body);
        if (r.status >= 200 && r.status < 300) {
          attemptedPath = path;
          openRes = r;
          acceptedBody = body;
          break outer;
        }
        lastErr = { path, status: r.status, body: r.body.slice(0, 240) };
      } catch (err) { lastErr = { path, error: err.message }; }
    }
  }
  if (!openRes) {
    const detail = lastErr ? `${lastErr.path} → ${lastErr.status || lastErr.error}${lastErr.body ? ` :: ${lastErr.body}` : ''}` : 'no response';
    throw new Error(`Hikvision open failed (camera may not support two-way audio): ${detail}`);
  }
  const sid = openRes.body.match(/<id>([^<]+)<\/id>/i)?.[1] || '0';

  // Determine which codec the device accepted. The frontend currently only
  // sends G.711 µ-law (PCMU) so if the device wanted a-law we log a warning;
  // sound will be there but distorted until we add a-law encoding to the
  // browser side.
  const negotiatedCodec = acceptedBody && /alaw/i.test(acceptedBody) ? 'G.711alaw' :
                          acceptedBody && /ulaw/i.test(acceptedBody) ? 'G.711ulaw' :
                          'unknown';
  if (negotiatedCodec === 'G.711alaw') {
    logger.warn('talkback: device wants G.711 a-law but browser sends µ-law — audio will be distorted',
                { path: attemptedPath });
  }
  logger.info('talkback: hikvision open ok',
              { path: attemptedPath, sessionId: sid, codec: negotiatedCodec });

  // 2) Audio-data path mirrors whatever open() worked. Direct cameras use
  //    `/audioData`, NVR-attached use `/twoWayAudio/audioData`.
  const audioPath = attemptedPath
    .replace(/\/open$/, '/audioData')
    + (sid !== '0' ? `?sessionID=${sid}` : '');
  const probeUrl = `${base}${audioPath}`;

  // 3) Build the streaming POST. We use a passthrough so the controller can
  //    push chunks via writer.write(buf).
  const writer = new stream.PassThrough();
  let closed = false;

  // Hikvision firmwares vary on the Content-Type they accept for the audio-
  // data POST. We map our negotiated codec to the most-likely matching MIME:
  //   G.711 µ-law  → audio/G711U  (some firmwares: application/binary)
  //   G.711 a-law  → audio/G711A
  //   unknown      → application/binary (the historical default)
  const audioContentType = negotiatedCodec === 'G.711ulaw' ? 'audio/G711U'
                         : negotiatedCodec === 'G.711alaw' ? 'audio/G711A'
                         : 'application/binary';

  // Build basic auth as a fallback — most Hikvision firmwares accept either
  // Basic or Digest on this endpoint after the open() call has authorized.
  const basicAuth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  const reqPromise = axios.post(probeUrl, writer, {
    auth: { username, password },                 // axios native digest fallback
    headers: {
      'Content-Type':       audioContentType,
      'Authorization':      basicAuth,
      'Transfer-Encoding':  'chunked',
      'Connection':         'keep-alive',
    },
    timeout: 0,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
    responseType: 'stream',
  }).then((r) => {
    // Surface the device's response status — many Hikvisions return 200 with
    // an XML body that says 'invalid sessionID' or similar; that's the most
    // common cause of "session opens but no sound".
    if (!closed) {
      let captured = '';
      r.data.on('data', (chunk) => {
        captured += String(chunk).slice(0, 200);
        if (captured.length > 400) r.data.destroy();
      });
      r.data.on('end', () => {
        logger.info('hikvision talkback POST stream closed by device',
                    { status: r.status, body: captured.slice(0, 240) });
      });
    }
  }).catch((err) => {
    if (!closed) logger.warn('hikvision talkback POST stream errored', { error: err.message });
  });

  return {
    vendor: 'hikvision',
    sessionId: sid,
    writer,
    close: async () => {
      if (closed) return;
      closed = true;
      try { writer.end(); } catch (_) { /* swallow */ }
      try { await reqPromise; } catch (_) { /* swallow */ }
      // Close path mirrors the open path family that worked.
      const closePath = attemptedPath.replace(/\/open$/, '/close')
        + (sid !== '0' ? `?sessionID=${sid}` : '');
      try {
        await digestRequest({
          url: `${base}${closePath}`,
          method: 'PUT',
          username, password, timeout: 3000,
          data: '',
        });
      } catch (err) {
        logger.debug('hikvision close failed (non-fatal)', { error: err.message });
      }
    },
  };
}

// ── Dahua CGI (chunked POST) ────────────────────────────────────────────────

async function openDahuaSession({ host, httpPort, username, password, channel }) {
  const base = `http://${host}:${httpPort || 80}`;
  const ch = (channel || 1) - 1; // Dahua zero-indexes

  // Dahua expects the audio container as part of the URL params. PCMU = µ-law
  // 8 kHz; we send the same format from the browser.
  const url = `${base}/cgi-bin/audio.cgi?action=postAudio&channel=${ch}&httptype=singlepart&type=pcmu&samplerate=8000`;
  const writer = new stream.PassThrough();
  let closed = false;

  const reqPromise = axios.post(url, writer, {
    auth: { username, password },
    headers: {
      'Content-Type': 'audio/PCMU',
      'Transfer-Encoding': 'chunked',
    },
    timeout: 0,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
    responseType: 'stream',
  }).catch((err) => {
    if (!closed) logger.warn('dahua talkback POST stream errored', { error: err.message });
  });

  return {
    vendor: 'dahua',
    writer,
    close: async () => {
      if (closed) return;
      closed = true;
      try { writer.end(); } catch (_) { /* swallow */ }
      try { await reqPromise; } catch (_) { /* swallow */ }
    },
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async function open(monitorId, group, channel) {
  if (_sessions.has(monitorId)) {
    return { ok: false, reason: 'already-open' };
  }
  const args = {
    host:     group.host,
    httpPort: group.httpPort || 80,
    username: group.username,
    password: group.password,
    channel:  channel || 1,
  };
  let sess = null;
  try {
    switch ((group.deviceType || 'hikvision').toLowerCase()) {
      case 'hikvision': sess = await openHikvisionSession(args); break;
      case 'dahua':     sess = await openDahuaSession(args);     break;
      default:
        return { ok: false, reason: `talkback not yet implemented for ${group.deviceType}` };
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  _sessions.set(monitorId, sess);
  logger.info('[Talkback] session opened', { monitorId, vendor: sess.vendor });
  return { ok: true, vendor: sess.vendor };
}

/** Append a chunk (Buffer) to an open session. */
function write(monitorId, chunk) {
  const sess = _sessions.get(monitorId);
  if (!sess) return false;
  try { sess.writer.write(chunk); return true; }
  catch (_) { return false; }
}

/** Close a session and clean up. */
async function close(monitorId) {
  const sess = _sessions.get(monitorId);
  if (!sess) return { ok: false, reason: 'no-session' };
  _sessions.delete(monitorId);
  await sess.close().catch(() => {});
  logger.info('[Talkback] session closed', { monitorId, vendor: sess.vendor });
  return { ok: true };
}

function isOpen(monitorId) { return _sessions.has(monitorId); }

module.exports = { open, write, close, isOpen };
