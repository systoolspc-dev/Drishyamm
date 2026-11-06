/**
 * localRecordings.service.js
 *
 * Serve recordings straight from the local Stream Service recordings volume
 * (RECORDINGS_DIR/cam_<monitorId>/<YYYY-MM-DD>/<HH-MM-SS-micros>.mp4), bypassing
 * S3 entirely. Used for on-prem / demo playback where the cloud bucket is slow
 * or unreachable — playback streams off local disk with HTTP Range support.
 *
 * Local recording "key" = path relative to the recordings root, e.g.
 *   "cam_5ff9f2d653674a8f88969c13/2026-06-12/19-00-00-000000.mp4"
 * The "cam_" prefix lets the controller distinguish a local key from an S3 key
 * ("recordings/<userId>/...") and route each to the right backend.
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config/env');
const logger = require('../config/logger');

const ROOT    = config.streamService.recordingsDir || '/recordings';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve a local key to an absolute path, blocking path-traversal escapes. */
function safeResolve(key) {
  const rel  = path.normalize(String(key || '')).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
  const full = path.resolve(ROOT, rel);
  const root = path.resolve(ROOT);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('invalid recording key');
  }
  return full;
}

/** Extract the 24-hex monitorId from a local key (cam_<id>/...), or null. */
function monitorIdFromKey(key) {
  const m = /^cam_([0-9a-fA-F]{24})\//.exec(String(key || ''));
  return m ? m[1] : null;
}

/**
 * List recordings on local disk for a set of cameras (a group). Each camera
 * needs { monitorId, name }. Optional `date` filter (YYYY-MM-DD).
 *
 * Returns [{ key, cameraName, monitorId, date, filename, size, lastModified }] —
 * the same shape s3Service.listGroupRecordings returns, so the controller and
 * frontend treat local and cloud recordings identically.
 */
async function listGroupRecordings(cameras, date = null) {
  const out = [];
  for (const cam of cameras || []) {
    if (!cam || !cam.monitorId) continue;
    const camDir = path.join(ROOT, `cam_${cam.monitorId}`);
    let days;
    try { days = await fs.promises.readdir(camDir); } catch { continue; }
    for (const d of days) {
      if (!DATE_RE.test(d) || (date && d !== date)) continue;
      const dayDir = path.join(camDir, d);
      let files;
      try { files = await fs.promises.readdir(dayDir); } catch { continue; }
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.mp4')) continue;
        let st;
        try { st = await fs.promises.stat(path.join(dayDir, f)); } catch { continue; }
        if (!st.size) continue; // skip 0-byte / in-progress segments
        // Stream Service names segments HH-MM-SS-micros.mp4 in local time.
        const tm   = /^(\d{2})-(\d{2})-(\d{2})/.exec(f);
        const time = tm ? `${tm[1]}:${tm[2]}:${tm[3]}` : '';
        out.push({
          key:          `cam_${cam.monitorId}/${d}/${f}`,
          cameraName:   cam.name,
          monitorId:    cam.monitorId,
          date:         d,
          time,                                   // HH:MM:SS (local)
          startedAt:    time ? `${d}T${time}` : null,
          filename:     f,
          size:         st.size,
          lastModified: st.mtime,
        });
      }
    }
  }
  // newest first
  out.sort((a, b) => (b.date + b.filename).localeCompare(a.date + a.filename));
  return out;
}

/**
 * Group a group's clips into fixed time windows (default 5 min) per camera, so
 * the UI shows tidy "19:40–19:45 · Camera Gate · 18 clips" rows instead of a
 * flood of seconds-long segments. Each window lists its ordered clips so the
 * player can play them back-to-back.
 */
async function listWindows(cameras, date = null, windowMinutes = 5) {
  const clips = await listGroupRecordings(cameras, date);
  const wm    = Math.max(1, Math.min(60, parseInt(windowMinutes, 10) || 5));
  const map   = new Map();

  for (const c of clips) {
    if (!c.time) continue;
    const [hh, mm] = c.time.split(':');
    const minOfDay = parseInt(hh, 10) * 60 + parseInt(mm, 10);
    const wStart   = Math.floor(minOfDay / wm) * wm;
    const windowStart = `${String(Math.floor(wStart / 60)).padStart(2, '0')}:${String(wStart % 60).padStart(2, '0')}`;
    const key = `${c.monitorId}|${c.date}|${windowStart}`;
    let w = map.get(key);
    if (!w) {
      w = {
        windowKey:     key,
        cameraName:    c.cameraName,
        monitorId:     c.monitorId,
        date:          c.date,
        windowStart,                                   // HH:MM (local)
        startedAt:     `${c.date}T${windowStart}:00`,
        windowMinutes: wm,
        clipCount:     0,
        bytes:         0,
        firstKey:      c.key,                          // for the thumbnail
        clips:         [],
      };
      map.set(key, w);
    }
    w.clipCount += 1;
    w.bytes     += c.size;
    w.clips.push({ key: c.key, time: c.time, size: c.size });
  }

  const windows = [...map.values()];
  windows.forEach((w) => w.clips.sort((a, b) => a.time.localeCompare(b.time)));
  windows.sort((a, b) => (b.date + b.windowStart).localeCompare(a.date + a.windowStart)); // newest first
  return windows;
}

/**
 * Open a read stream for a local recording with HTTP Range support. Returns the
 * same shape as s3Service.getReadStream so streamRecording() is source-agnostic.
 */
function getReadStream(key, range = null) {
  const full  = safeResolve(key);
  const total = fs.statSync(full).size;

  if (range) {
    const m   = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end   = m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) start = 0;
    return {
      stream:        fs.createReadStream(full, { start, end }),
      contentLength: end - start + 1,
      contentType:   'video/mp4',
      contentRange:  `bytes ${start}-${end}/${total}`,
      statusCode:    206,
    };
  }
  return {
    stream:        fs.createReadStream(full),
    contentLength: total,
    contentType:   'video/mp4',
    contentRange:  null,
    statusCode:    200,
  };
}

module.exports = { listGroupRecordings, listWindows, getReadStream, safeResolve, monitorIdFromKey, ROOT };
