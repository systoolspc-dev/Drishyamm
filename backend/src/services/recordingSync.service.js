/**
 * recordingSync.service.js — v2.0 (Stream Service)
 *
 * Two independent background loops:
 *
 * 1. S3 Sync  — every 5 minutes
 *    Scans the Stream Service recording directory for completed 15-min MP4 segments.
 *    Uploads each file to 10PB S3 then deletes the local copy.
 *    Node.js reads directly from the bind-mounted volume — zero HTTP overhead
 *    (the old Shinobi approach downloaded via HTTP; this reads from disk).
 *
 * 2. Watchdog — every 2 minutes
 *    Compares cameras in the DB against paths configured in Stream Service.
 *    Re-adds any missing paths (Stream Service loses its config on restart because
 *    it has no persistent DB — the Express DB is the source of truth).
 *    Also syncs camera online/offline status from Stream Service live path state.
 *
 * Stream Service auto-reconnects to cameras when RTSP drops — no manual restart needed.
 */

const fs            = require('node:fs');
const path          = require('node:path');
const os            = require('node:os');
const { spawn }     = require('node:child_process');
const axios         = require('axios');

const logger          = require('../config/logger');
const config          = require('../config/env');
const s3Service       = require('./s3.service');
const streamingService = require('./drishyamStreaming.service');

// Lazy-loaded to avoid circular dependency with models/index.js
let Camera, CameraGroup, User;
const loadModels = () => {
  if (!Camera) ({ Camera, CameraGroup, User } = require('../models'));
};

// ── Constants ──────────────────────────────────────────────────────────────────

const RECORDINGS_DIR      = config.streamService.recordingsDir;
const SYNC_INTERVAL_MS    = 5  * 60 * 1000;  // S3 sync: every 5 min
const WATCHDOG_MS         = 2  * 60 * 1000;  // Watchdog: every 2 min
const MIN_AGE_MS          = 2  * 60 * 1000;  // Skip files < 2 min old (still writing)
const MIN_SIZE_BYTES      = 10 * 1024;       // Skip files < 10 KB (corrupt/stub)
const HLS_PROBE_TIMEOUT   = 4_000;           // Max wait for HLS health probe (ms)

// Stitching: if a file's duration is below this, we try to merge it with
// adjacent short fragments before uploading. RTSP reconnects produce many
// tiny clips; stitching restores proper 5-/10-minute records.
const STITCH_BELOW_SEC    = config.streamService.stitchBelowSeconds ?? 120;
// Hard ceiling for a stitched batch (seconds). Roughly matches 1.5× the
// configured segment duration so we don't accidentally produce huge files
// when many fragments queue up after a long outage.
const STITCH_MAX_BATCH_SEC = parseInt(process.env.RECORDING_STITCH_MAX_BATCH_SEC || String(15 * 60), 10);
// Max gap between fragment end and next fragment start, in seconds, that
// still counts as "consecutive" for stitching purposes.
const STITCH_MAX_GAP_SEC   = 5;

// ── Per-process state ──────────────────────────────────────────────────────────

let _syncTimer     = null;
let _watchdogTimer = null;
let _syncBootTimer = null;
let _watchdogBootTimer = null;
let _syncRunning   = false;
let _watchdogRunning = false;

// Watchdog state — keep flapping under control so we don't churn
// the NVR with constant remove+re-add cycles (which makes things WORSE,
// not better — the NVR has a connection cap and re-adds reuse RTSP slots).
//
//   _muxer404Count: monitorId → consecutive 404 count from probeHlsMuxer.
//                   We only cycle a path after 3 consecutive 404s, not 1.
//   _lastResetAt:   monitorId → epoch ms of last cycle.
//                   We never cycle the same camera within 5 minutes —
//                   gives Stream Service (and the NVR) breathing room.
const _muxer404Count = new Map();
const _muxer500Count = new Map();        // consecutive 500s per monitor (mirror of 404)
const _lastResetAt   = new Map();
const _nvrResetAt    = new Map();        // host → epoch ms of last path-cycle on that NVR
const _orphanSeen    = new Map();        // orphan path name → consecutive watchdog sightings
const RESET_COOLDOWN_MS  = 5 * 60 * 1000;
const COLD_START_MS      = 120 * 1000;   // grace period after ready=true
const RESET_AFTER_404S   = 3;            // consecutive failed probes
const RESET_AFTER_500S   = 2;            // consecutive 500s before a (definitive) reset
// Many cameras share one NVR; serialise path-cycles per host so a tickful of
// 500s on one NVR can't fire 26 simultaneous RTSP re-opens into a box that is
// already at its session cap (the cross-camera flap amplifier).
const NVR_RESET_MIN_MS   = parseInt(process.env.WATCHDOG_NVR_RESET_MIN_MS || '30000', 10);
// Orphan reconciliation: a configured cam_* path whose camera is gone from the
// DB is deleted, but only after it has been seen orphaned on this many
// CONSECUTIVE passes — guards against deleting a path during the brief window
// between addCamera() and the DB row committing.
const ORPHAN_CLEANUP     = process.env.WATCHDOG_ORPHAN_CLEANUP !== '0'; // on by default
const ORPHAN_CONFIRM_PASSES = parseInt(process.env.WATCHDOG_ORPHAN_PASSES || '2', 10);
// Never reconcile these path names away even if no DB camera matches (demo /
// externally-published paths). Comma-separated monitorId bases.
const ORPHAN_SKIP = new Set(
  (process.env.WATCHDOG_ORPHAN_SKIP || 'demo-entrance')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

// S3 key cache — prevents re-uploading in the same process lifetime.
// Guards against S3 eventual-consistency returning "not found" for fresh objects.
const _uploaded = new Set();
// Bound the cache so a long-lived process can't leak memory (one entry per clip,
// forever, reaches millions over weeks). s3Service.exists() is the REAL
// idempotency guard, so eviction costs at most one extra HEAD. FIFO eviction —
// a Set preserves insertion order, so values().next() is the oldest.
const UPLOADED_CACHE_MAX = parseInt(process.env.RECORDING_UPLOADED_CACHE_MAX || '50000', 10);
function rememberUploaded(key) {
  if (_uploaded.size >= UPLOADED_CACHE_MAX) _uploaded.delete(_uploaded.values().next().value);
  _uploaded.add(key);
}

// Above this size, skip the in-memory buffered-upload FALLBACK and let the file
// survive to retry next cycle — reading a multi-GB clip whole would OOM the heap.
// (The primary path streams from disk, so this only bounds the fallback.)
const MAX_BUFFER_FALLBACK_BYTES = parseInt(process.env.RECORDING_MAX_BUFFER_MB || '256', 10) * 1024 * 1024;

// RECORDING_KEEP_LOCAL=1 keeps a local copy of every clip that reaches S3.
// The copy is MOVED into an `archived/` subdir of its date dir rather than left
// in place: findSegments() only picks up *.mp4 sitting directly inside a date
// dir and never recurses, so an archived clip is invisible to the next sync
// pass. Leaving it in place would re-probe (ffprobe) and re-stitch every kept
// file on every 5-minute cycle, unbounded, forever.
const KEEP_LOCAL  = process.env.RECORDING_KEEP_LOCAL === '1';
const ARCHIVE_DIR = 'archived';

/** Retire a clip that is safely in S3: archive it when KEEP_LOCAL, else delete. */
async function retireLocalClip(filePath) {
  if (!KEEP_LOCAL) {
    await fs.promises.unlink(filePath).catch(() => {});
    return;
  }
  const dest = path.join(path.dirname(filePath), ARCHIVE_DIR, path.basename(filePath));
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(filePath, dest);   // same filesystem: atomic, instant
  } catch (err) {
    logger.warn('recordingSync: could not archive local clip', { filePath, error: err.message });
  }
}
// STALE_TEMP_MS is derived from CONCAT_TIMEOUT_MS, which is declared further down
// (near the ffmpeg helpers) — see below, defined after it to avoid a TDZ error.

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Recursively collect MP4 files under a camera recording directory. */
async function findSegments(cameraDir) {
  const results = [];
  let dateDirs;
  try {
    dateDirs = await fs.promises.readdir(cameraDir);
  } catch {
    return results; // directory doesn't exist yet — camera never recorded
  }

  for (const dateDir of dateDirs) {
    const datePath = path.join(cameraDir, dateDir);
    let files;
    try {
      files = await fs.promises.readdir(datePath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.mp4')) continue;
      if (file.startsWith('.stitch-')) continue;   // never treat a stitch temp as a segment
      const filePath = path.join(datePath, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) results.push({ filePath, stat, date: dateDir, filename: file });
      } catch {
        // File removed between readdir and stat — skip silently
      }
    }
  }
  return results;
}

/** Delete a directory's matching temp files older than STALE_TEMP_MS. A crash or
 *  SIGKILL between spawning ffmpeg and its cleanup leaves these behind; without a
 *  sweep they fill the disk / os.tmpdir over weeks. Best-effort, never throws. */
async function sweepStaleTempFiles(dir, matcher) {
  const now = Date.now();
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return; }
  for (const name of names) {
    if (!matcher(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.promises.stat(p);
      if (st.isFile() && (now - st.mtimeMs) > STALE_TEMP_MS) {
        await fs.promises.unlink(p).catch(() => {});
        logger.debug('recordingSync: swept stale temp file', { file: p });
      }
    } catch { /* gone already */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FFPROBE / FFMPEG HELPERS — used by the stitcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe a media file for its duration in seconds.
 * Returns null on probe failure (corrupt header etc.) so callers can skip the file.
 */
// A hung ffprobe/ffmpeg (corrupt file, stalled disk/NFS) would otherwise never
// fire close/error, leaving the Promise pending forever and the child as a
// zombie holding a file descriptor. These caps kill the process so the pool of
// FDs can't be exhausted over days of operation.
const PROBE_TIMEOUT_MS  = 15_000;         // a probe that takes >15s is stuck
const CONCAT_TIMEOUT_MS = 10 * 60_000;    // -c copy is fast; only kills true hangs
// A stitch/concat temp file older than this is definitely orphaned (no live
// stitch runs longer than CONCAT_TIMEOUT_MS). Swept each sync pass.
const STALE_TEMP_MS = 2 * CONCAT_TIMEOUT_MS;

/** Kill a spawned child (TERM then KILL) and swallow errors. */
function killChild(child) {
  try { child.kill('SIGTERM'); } catch (_) {}
  // Escalate if it ignores TERM.
  setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000).unref?.();
}

function probeDurationSec(filePath) {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    let err = '';
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
    const timer = setTimeout(() => {
      logger.warn('ffprobe timed out; killing', { filePath, ms: PROBE_TIMEOUT_MS });
      killChild(ff);
      done(null);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    ff.stdout.on('data', (d) => { out += d; });
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', () => done(null));
    ff.on('close', (code) => {
      if (code !== 0) {
        logger.debug('ffprobe non-zero exit', { filePath, code, err: err.slice(-200) });
        return done(null);
      }
      const sec = parseFloat(out.trim());
      done(Number.isFinite(sec) ? sec : null);
    });
  });
}

/**
 * Concatenate multiple .mp4 files into a single output without re-encoding.
 * Uses ffmpeg's concat demuxer (`-f concat -c copy`) — fast and lossless,
 * works as long as all inputs share the same codec params (they do — same camera).
 *
 * @param {string[]} inputPaths — absolute file paths in chronological order
 * @param {string}   outputPath — absolute file path for the merged output
 * @returns {Promise<boolean>} true on success, false on ffmpeg error
 */
async function ffmpegConcat(inputPaths, outputPath) {
  // ffmpeg concat demuxer needs an instruction file with one `file '...'` per line
  const listPath = path.join(os.tmpdir(), `concat-${Date.now()}-${process.pid}.txt`);
  const listBody = inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.promises.writeFile(listPath, listBody, 'utf8');

  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      // Video stays lossless (stream copy). Audio is re-encoded to AAC because
      // MP4 can't hold PCM (pcm_s16be) — some cameras emit it, and `-c copy`
      // then failed the whole stitch ("codec pcm_s16be not supported in mp4"),
      // losing the recording. AAC is a no-op cost when there's no/already-AAC audio.
      '-c:v', 'copy',
      '-c:a', 'aac',
      // Put the moov atom at the front so the stored MP4 is instantly seekable
      // in the browser (progressive playback) instead of needing a full download.
      '-movflags', '+faststart',
      // Avoid negative timestamps after concat (some cameras emit them at boundaries)
      '-fflags', '+genpts',
      outputPath,
    ]);
    let err = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.promises.unlink(listPath).catch(() => {});
      resolve(val);
    };
    const timer = setTimeout(() => {
      logger.warn('ffmpeg concat timed out; killing', { outputPath, ms: CONCAT_TIMEOUT_MS });
      killChild(ff);
      finish(false);
    }, CONCAT_TIMEOUT_MS);
    timer.unref?.();
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', () => finish(false));
    ff.on('close', (code) => {
      if (code !== 0) {
        logger.warn('ffmpeg concat failed', { code, err: err.slice(-300) });
        return finish(false);
      }
      finish(true);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FILENAME PARSING / GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the start timestamp from a Stream Service recording filename.
 * Stream Service writes files like `14-23-45-123456.mp4` (HH-MM-SS-microseconds).
 *
 * Returns a Date in the local timezone (since Stream Service uses local time strftime),
 * or null if the filename doesn't match.
 */
function parseStartTime(dateDir, filename) {
  // dateDir = "YYYY-MM-DD", filename = "HH-MM-SS-ffffff.mp4"
  const m = filename.match(/^(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?\.mp4$/);
  if (!m) return null;
  const [, hh, mm, ss, frac] = m;
  const [Y, M, D] = dateDir.split('-').map((s) => parseInt(s, 10));
  const ms = frac ? Math.floor(parseInt(frac, 10) / 1000) % 1000 : 0;
  const dt = new Date(Y, M - 1, D, parseInt(hh), parseInt(mm), parseInt(ss), ms);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Format a Date as HH-MM-SS for use in S3 key. */
function formatHMS(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

/**
 * Build a human-friendly S3 filename for a recording covering [start, end].
 * Example: `14-23-45_to_14-33-45_10m.mp4`
 */
function buildClipFilename(start, end, durationSec) {
  const minutes = Math.max(1, Math.round(durationSec / 60));
  return `${formatHMS(start)}_to_${formatHMS(end)}_${minutes}m.mp4`;
}

/** Safe slugify matching the S3 key format used by s3.service.js */
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');

// ─────────────────────────────────────────────────────────────────────────────
// S3 SYNC — upload completed segments, then delete local copies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upload a single, ready-to-store clip to S3 with the given filename and
 * delete the local copy on success. The caller has already decided this
 * file represents the final form of a recording (post-stitch if needed).
 */
async function uploadClip({ filePath, s3Filename, date, camera, group, user }) {
  const s3Key = `recordings/${user.id}/${slug(group.name)}/${slug(camera.name)}/${date}/${s3Filename}`;

  if (_uploaded.has(s3Key)) {
    await retireLocalClip(filePath);
    return s3Key;
  }
  if (await s3Service.exists(s3Key)) {
    rememberUploaded(s3Key);
    await retireLocalClip(filePath);
    return s3Key;
  }

  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || stat.size < MIN_SIZE_BYTES) {
    logger.warn('recordingSync: skipping tiny/corrupt clip', { s3Filename, bytes: stat?.size ?? 0 });
    await fs.promises.unlink(filePath).catch(() => {});
    return null;
  }

  // Primary: stream the clip from disk (bounded memory). Fallback: the proven
  // buffered upload if streaming throws. If BOTH fail this throws — the local
  // file is NOT deleted (unlink is below), so it survives and retries next cycle.
  try {
    await s3Service.uploadRecordingFromFile(user.id, group.name, camera.name, s3Filename, filePath, 'video/mp4', date);
  } catch (streamErr) {
    // Only buffer-fall-back for files small enough to hold in the heap safely;
    // a multi-GB clip is left to retry next cycle rather than risk an OOM crash.
    if (stat.size > MAX_BUFFER_FALLBACK_BYTES) {
      logger.error('recordingSync: streamed upload failed; too large to buffer, will retry', { s3Key, bytes: stat.size, error: streamErr.message });
      throw streamErr;   // file NOT deleted (unlink is below) → survives, retried
    }
    logger.warn('recordingSync: streamed upload failed, falling back to buffered', { s3Key, error: streamErr.message });
    const buffer = await fs.promises.readFile(filePath);
    await s3Service.uploadRecording(user.id, group.name, camera.name, s3Filename, buffer, 'video/mp4', date);
  }
  rememberUploaded(s3Key);
  logger.info('recordingSync: uploaded', { s3Key, bytes: stat.size });

  await retireLocalClip(filePath);
  return s3Key;
}

/**
 * Group consecutive segments into upload batches.
 *
 *   - A "long" segment (duration >= STITCH_BELOW_SEC) becomes a batch of one.
 *   - "Short" segments are joined with adjacent short segments while:
 *         (a) the gap between end-of-prev and start-of-next is <= STITCH_MAX_GAP_SEC, AND
 *         (b) the cumulative batch duration stays under STITCH_MAX_BATCH_SEC.
 *
 * Returns an array of batches. Each batch is an array of segments to ffmpeg-concat.
 */
function planBatches(segmentsWithMeta) {
  const batches = [];
  let cur = null;

  for (const seg of segmentsWithMeta) {
    if (!cur) {
      cur = [seg];
      continue;
    }

    const last           = cur[cur.length - 1];
    const lastEnd        = last.start.getTime() + last.durationSec * 1000;
    const gapSec         = (seg.start.getTime() - lastEnd) / 1000;
    const cumulativeSec  = cur.reduce((s, x) => s + x.durationSec, 0);
    const lastIsShort    = last.durationSec  < STITCH_BELOW_SEC;
    const segIsShort     = seg.durationSec   < STITCH_BELOW_SEC;
    const canMerge       = lastIsShort && segIsShort
                           && gapSec >= 0 && gapSec <= STITCH_MAX_GAP_SEC
                           && (cumulativeSec + seg.durationSec) <= STITCH_MAX_BATCH_SEC;

    if (canMerge) {
      cur.push(seg);
    } else {
      batches.push(cur);
      cur = [seg];
    }
  }
  if (cur) batches.push(cur);

  return batches;
}

/**
 * Resolve a batch into a single uploadable file:
 *   - 1 segment → use it as-is.
 *   - N segments → ffmpeg-concat into a temp file; that becomes the upload.
 *
 * Returns { filePath, durationSec, start, end, sources } or null on failure.
 * `sources` is the list of original files that should be deleted on success.
 */
// Stream Service and backfill write fragmented MP4 (moof boxes, no index). A
// browser can't seek in that without downloading everything before the point,
// and the length isn't known up front, so a 10-minute clip opened slowly and
// showed a wrong duration. Every clip is uploaded as a normal MP4 with its moov
// at the front instead. Stream copy: no quality change, little CPU.
async function isFragmented(filePath) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    return head.includes('moof') || head.includes('mvex');
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Rewrite a fragmented segment in place as a faststart MP4 (keeps its mtime). */
async function makeFaststart(filePath, cameraDir) {
  if (!(await isFragmented(filePath))) return true;
  const st = await fs.promises.stat(filePath);
  const tmp = path.join(cameraDir, `.stitch-fs-${Date.now()}-${process.pid}.mp4`);
  const ok = await ffmpegConcat([filePath], tmp);
  if (!ok) { await fs.promises.unlink(tmp).catch(() => {}); return false; }
  await fs.promises.utimes(tmp, st.atime, st.mtime).catch(() => {});
  await fs.promises.rename(tmp, filePath);
  return true;
}

async function materializeBatch(batch, cameraDir) {
  if (batch.length === 1) {
    const s = batch[0];
    // Unreadable as a normal MP4: upload it as recorded rather than lose it.
    if (!(await makeFaststart(s.filePath, cameraDir))) {
      logger.warn('recordingSync: could not make segment faststart, uploading as recorded', { file: s.filePath });
    }
    return {
      filePath:    s.filePath,
      durationSec: s.durationSec,
      start:       s.start,
      end:         new Date(s.start.getTime() + s.durationSec * 1000),
      sources:     [s.filePath],
      isStitched:  false,
    };
  }

  const start = batch[0].start;
  const end   = new Date(batch[batch.length - 1].start.getTime() + batch[batch.length - 1].durationSec * 1000);
  const totalSec = batch.reduce((s, x) => s + x.durationSec, 0);

  const stitchedPath = path.join(cameraDir, `.stitch-${Date.now()}-${process.pid}.mp4`);
  const ok = await ffmpegConcat(batch.map((b) => b.filePath), stitchedPath);
  if (!ok) {
    await fs.promises.unlink(stitchedPath).catch(() => {});
    return null;
  }

  return {
    filePath:    stitchedPath,
    durationSec: totalSec,
    start,
    end,
    sources:     batch.map((b) => b.filePath),
    isStitched:  true,
  };
}

async function syncCamera(camera, group, user) {
  const cameraDir = path.join(RECORDINGS_DIR, streamingService.pathName(camera.monitorId));
  // Reap any orphaned stitch temp from a prior crash before scanning segments.
  await sweepStaleTempFiles(cameraDir, (n) => n.startsWith('.stitch-') && n.endsWith('.mp4'));
  const segments  = await findSegments(cameraDir);
  if (!segments.length) return;

  const now = Date.now();

  // Filter to segments old enough to be considered finalized, and probe them
  // for actual duration. Drop any that fail to probe (corrupt header).
  const candidates = [];
  for (const seg of segments) {
    if ((now - seg.stat.mtimeMs) < MIN_AGE_MS) continue;
    const start = parseStartTime(seg.date, seg.filename);
    if (!start) continue;
    const durationSec = await probeDurationSec(seg.filePath);
    if (durationSec == null || durationSec <= 0) {
      logger.warn('recordingSync: dropping unreadable segment', { file: seg.filePath });
      await fs.promises.unlink(seg.filePath).catch(() => {});
      continue;
    }
    candidates.push({ ...seg, start, durationSec });
  }

  if (!candidates.length) return;

  // Order by start time so the planner can detect adjacency
  candidates.sort((a, b) => a.start - b.start);

  const batches = planBatches(candidates);

  for (const batch of batches) {
    let materialized = null;
    try {
      materialized = await materializeBatch(batch, cameraDir);
      if (!materialized) continue;

      const { filePath, durationSec, start, end, sources, isStitched } = materialized;
      const s3Filename = buildClipFilename(start, end, durationSec);

      // Upload the materialized clip
      const dateDir = batch[0].date;
      const s3Key = await uploadClip({ filePath, s3Filename, date: dateDir, camera, group, user });

      if (s3Key) {
        // If we stitched, delete the original fragments now that the merged
        // clip is safely in S3. uploadClip already removed `filePath` itself.
        if (isStitched) {
          await Promise.all(sources.map((p) => fs.promises.unlink(p).catch(() => {})));
          logger.info('recordingSync: stitched + uploaded', {
            camera: camera.name, sources: sources.length, durationSec, s3Key,
          });
        }
      }
    } catch (err) {
      // A throw AFTER a successful stitch (e.g. uploadClip fails both paths)
      // would otherwise orphan the .stitch-*.mp4 temp on disk forever.
      if (materialized?.isStitched && materialized.filePath) {
        await fs.promises.unlink(materialized.filePath).catch(() => {});
      }
      logger.warn('recordingSync: failed to process batch', {
        camera: camera.name, error: err.message,
      });
    }
  }
}

async function runSync() {
  if (_syncRunning) {
    logger.debug('recordingSync: previous sync still running — skipping');
    return;
  }
  _syncRunning = true;
  logger.info('recordingSync: starting S3 sync pass');

  try {
    // Reap orphaned concat list files (os.tmpdir) left by a prior crash/SIGKILL.
    await sweepStaleTempFiles(os.tmpdir(), (n) => n.startsWith('concat-') && n.endsWith('.txt'));
    loadModels();
    const cameras = await Camera.findAll({});

    // Build lookup maps to avoid N+1 queries
    const groupIds = [...new Set(cameras.map((c) => c.groupId).filter(Boolean))];
    const userIds  = [...new Set(cameras.map((c) => c.userId).filter(Boolean))];

    const [groups, users] = await Promise.all([
      CameraGroup.findAll({ where: { id: groupIds } }),
      User.findAll({ where: { id: userIds }, attributes: ['id'] }),
    ]);

    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const userMap  = new Map(users.map((u) => [u.id, u]));

    for (const camera of cameras) {
      const group = groupMap.get(camera.groupId);
      const user  = userMap.get(camera.userId);
      if (!group || !user) continue;
      await syncCamera(camera, group, user);
    }

    logger.info('recordingSync: S3 sync pass complete');
  } catch (err) {
    logger.error('recordingSync: unexpected sync error', { error: err.message });
  } finally {
    _syncRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WATCHDOG — self-healing camera doctor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe the HLS muxer for a camera that Stream Service reports as ready.
 * Returns the HTTP status code, or null on network error.
 *
 * Why: Stream Service may report a path as ready (RTSP OK, tracks present) but
 * its HLS muxer can end up in a corrupted state after an RTSP reconnect —
 * the muxer hash prefix changes, leaving stale segment references that
 * return HTTP 500.  Removing and re-adding the path forces muxer recreation.
 */
async function probeHlsMuxer(monitorId) {
  // Use the INTERNAL HLS origin (http://stream-service:8888), not the browser-facing
  // hlsUrl (e.g. http://localhost:8898 — a host port-map that is unreachable
  // from inside the backend container, so every probe silently network-errored
  // and the muxer-reset path below was effectively dead). Falls back to hlsUrl
  // when MEDIAMTX_INTERNAL_HLS_URL is unset (single-origin deployments).
  const base = config.streamService.internalHlsUrl || config.streamService.hlsUrl;
  const url  = `${base}/${streamingService.pathName(monitorId)}/index.m3u8`;
  try {
    const resp = await axios.get(url, {
      timeout: HLS_PROBE_TIMEOUT,
      validateStatus: () => true,  // never throw on HTTP error status
    });
    return resp.status;
  } catch (_) {
    return null;  // network-level error — Stream Service HLS port unreachable
  }
}

/**
 * Build the connection config for a camera, preferring group-level credentials
 * (group owns the IP device) and falling back to camera-level fields.
 */
function buildCamConfig(camera) {
  const group = camera.group;
  return {
    // Owner: StreamServiceEngine.addCamera() uses this to decide whether this
    // account's cameras record continuously (RECORD_USER_IDS).
    userId:   camera.userId,
    host:     group?.host     ?? camera.host,
    port:     group?.port     ?? camera.port,
    path:     camera.path,
    username: group?.username ?? camera.username,
    password: group?.password ?? camera.password,
  };
}

/**
 * Stream Service stores path config in memory only — it is lost on restart.
 * The Express DB is the source of truth for which cameras should exist.
 *
 * This watchdog is the "doctor" for all camera paths:
 *   1. Re-adds paths that went missing after a Stream Service restart
 *      (skips cameras under an active quarantine so it can't undo the backoff)
 *   2. Also re-registers sub-streams (on-demand low-res streams for grid)
 *   1b. Reconciles the other direction — deletes orphan cam_* paths whose
 *      camera no longer exists in the DB (so deleted cameras stop streaming)
 *   3. Probes HLS muxer for ready cameras; resets those returning HTTP 500/404
 *      (corrupted muxer after RTSP reconnect — only fix is cycling the path),
 *      with consecutive-failure + per-NVR rate limits so it can't flap-storm
 *   4. Syncs camera online/offline status in DB from live Stream Service state
 */
async function runWatchdog() {
  if (_watchdogRunning) return;
  _watchdogRunning = true;

  try {
    loadModels();
    const cameras = await Camera.findAll({
      include: [{ model: CameraGroup, as: 'group' }],
    });

    if (!cameras.length) return;

    // Single call to Stream Service to get all configured path names
    const configuredPaths = await streamingService.listConfiguredPaths();
    const configuredNames = new Set(configuredPaths.map((p) => p.name));

    // Single call to get which paths are currently receiving RTSP
    const activePaths = await streamingService.listPaths();
    const readyMap    = new Map(activePaths.filter((p) => p.ready).map((p) => [p.name, p]));
    const readyNames  = new Set(readyMap.keys());

    const now = Date.now();
    // A camera the supervisor has quarantined (flapping NVR/dead channel) must
    // NOT be re-added or cycled here, or the watchdog instantly undoes the
    // backoff and the camera keeps hammering the NVR. quarantine_until is
    // persisted by streamSupervisor on transition into QUARANTINED.
    const isQuarantined = (camera) =>
      camera.supervisorState === 'quarantined' ||
      (camera.quarantineUntil && new Date(camera.quarantineUntil).getTime() > now);

    let added   = 0;
    let resets  = 0;
    let orphans = 0;
    const statusUpdates = [];

    // ── Phase 1: re-add missing paths + sub-streams ──────────────────────────
    for (const camera of cameras) {
      const pathName    = streamingService.pathName(camera.monitorId);
      const subPathName = streamingService.subPathName(camera.monitorId);
      const camConfig   = buildCamConfig(camera);
      const subPath     = streamingService.deriveSubPath(camera.path);

      // Honour an active quarantine: leave the path missing so the NVR pull
      // stays stopped until the supervisor lifts the backoff.
      if (isQuarantined(camera)) continue;

      // Don't re-create paths for an unreachable NVR — they'd only fail to
      // connect and churn the logs/CPU. The path stays removed until the
      // reachability prober sees the host come back, at which point it's
      // re-added automatically on a later cycle. (null/unknown → don't skip,
      // preserving legacy behavior before the prober has a reading.)
      if (require('./cameraReachability.service').isReachable(camera.host) === false) continue;

      if (!configuredNames.has(pathName)) {
        logger.warn('watchdog: path missing from Stream Service — re-adding', {
          camera: camera.name, pathName,
        });
        try {
          await streamingService.addCamera(camera.monitorId, camConfig);
          // Re-register sub-stream alongside the main path
          if (subPath) {
            await streamingService.addCameraSubStream(camera.monitorId, { ...camConfig, path: subPath });
          }
          // Re-apply recording retention: a freshly (re-)added path defaults to
          // recordDeleteAfter '0s'. This restores the camera's effective
          // retention after a Stream Service restart / path recreation, without a
          // periodic patch storm (only runs when a path was actually missing).
          await require('./recordingRetention.service').applyRetention(camera).catch(() => {});
          added++;
        } catch (err) {
          logger.error('watchdog: failed to re-add camera path', {
            camera: camera.name, error: err.message,
          });
        }
      } else if (subPath && !configuredNames.has(subPathName)) {
        // Main path exists but sub-stream is missing (e.g. first watchdog run after upgrade)
        try {
          await streamingService.addCameraSubStream(camera.monitorId, { ...camConfig, path: subPath });
        } catch (_) {}
      }
    }

    // ── Phase 1b: reconcile Stream Service → DB (delete orphan paths) ───────────────
    //
    // The DB is the source of truth. Phase 1 adds DB cameras missing from
    // Stream Service; this does the reverse — purges cam_* paths still configured in
    // Stream Service whose camera was deleted from the DB (deleted via a route that
    // didn't call removeCamera, deleted directly in SQL, or whose delete-time
    // removeCamera() failed because Stream Service was momentarily down). Without
    // this, deleted cameras keep pulling RTSP and showing up forever.
    //
    // Safety: only act on the cam_ namespace, never touch allowlisted/published
    // paths, and require the orphan to persist for ORPHAN_CONFIRM_PASSES
    // consecutive watchdog passes so a path isn't deleted in the small window
    // between addCamera() and its DB row committing.
    if (ORPHAN_CLEANUP) {
      const liveBaseIds = new Set(cameras.map((c) => c.monitorId));
      const seenThisPass = new Set();

      for (const name of configuredNames) {
        if (!name.startsWith('cam_')) continue;            // skip all_others etc.
        const base = name.slice(4).replace(/_(sub|clean)$/, '');
        if (!base || base.length === 0) continue;
        if (liveBaseIds.has(base)) continue;               // camera still exists
        if (ORPHAN_SKIP.has(base)) continue;               // demo / external publisher

        seenThisPass.add(name);
        const seen = (_orphanSeen.get(name) || 0) + 1;
        if (seen < ORPHAN_CONFIRM_PASSES) {
          _orphanSeen.set(name, seen);
          logger.debug('watchdog: orphan path observed (awaiting confirmation)', { name, seen });
          continue;
        }

        // Confirmed orphan — delete it.
        const ok = await streamingService.deletePathByName(name);
        if (ok) {
          orphans++;
          _orphanSeen.delete(name);
          logger.warn('watchdog: deleted orphan path (no DB camera)', { name });
        }
      }

      // Forget orphan counters for paths that are no longer orphaned (camera
      // re-created, or path already gone) so the counter can't go stale.
      for (const name of _orphanSeen.keys()) {
        if (!seenThisPass.has(name)) _orphanSeen.delete(name);
      }
    }

    // ── Phase 2: probe HLS muxers for ready cameras, reset corrupted ones ────
    //
    // Camera flapping is the #1 cause of 404s in the live view. Three rules
    // make this loop-safe:
    //
    //   1. Only consider cameras that have been ready > COLD_START_MS (120s)
    //      so we don't cycle muxers that are simply still warming up.
    //   2. Require RESET_AFTER_404S (3) consecutive failed probes before a
    //      single 404 is treated as "muxer corrupted." 500 still resets
    //      immediately because that's a definitive error.
    //   3. RESET_COOLDOWN_MS (5 min) per camera — never recycle the same
    //      path twice in quick succession. Cycling re-opens RTSP, and on
    //      a maxed-out NVR that just makes things worse.
    const readyCameras = cameras.filter(
      (c) => readyNames.has(streamingService.pathName(c.monitorId)) && !isQuarantined(c),
    );
    const nowMs = now;

    const probeResults = await Promise.all(
      readyCameras.map(async (camera) => {
        const pathName     = streamingService.pathName(camera.monitorId);
        const pathData     = readyMap.get(pathName);
        const readyTimeStr = pathData?.readyTime;
        const readySinceMs = readyTimeStr ? nowMs - new Date(readyTimeStr).getTime() : null;
        const readers      = pathData?.readers?.length ?? 0;
        return {
          camera,
          status: await probeHlsMuxer(camera.monitorId),
          readySinceMs, readers,
        };
      })
    );

    for (const { camera, status, readySinceMs, readers } of probeResults) {
      const monitor = camera.monitorId;

      // Track consecutive 404s and 500s; clear each on any other response.
      if (status === 404) {
        _muxer404Count.set(monitor, (_muxer404Count.get(monitor) || 0) + 1);
      } else {
        _muxer404Count.delete(monitor);
      }
      if (status === 500) {
        _muxer500Count.set(monitor, (_muxer500Count.get(monitor) || 0) + 1);
      } else {
        _muxer500Count.delete(monitor);
      }

      // Cooldown: did we cycle this camera recently?
      const lastReset = _lastResetAt.get(monitor) || 0;
      const inCooldown = (nowMs - lastReset) < RESET_COOLDOWN_MS;
      if (inCooldown) continue;

      // Decide whether to cycle. A cycle re-opens RTSP, so we never do it for an
      // unwatched path (readers === 0 — nothing to fix, pure NVR noise) and we
      // require the muxer to have been ready past the warm-up window. Both 404
      // and 500 now need consecutive failures, so a single transient muxer-hash
      // race during a normal reconnect no longer hair-triggers a destructive
      // remove+add into a possibly-saturated NVR.
      const f404 = _muxer404Count.get(monitor) || 0;
      const f500 = _muxer500Count.get(monitor) || 0;
      const warmedAndWatched =
        readers > 0 && readySinceMs !== null && readySinceMs > COLD_START_MS;
      const shouldReset =
        warmedAndWatched &&
        ((status === 500 && f500 >= RESET_AFTER_500S) ||
         (status === 404 && f404 >= RESET_AFTER_404S));

      if (!shouldReset) continue;

      // Per-NVR rate limit: serialise cycles across cameras sharing one host so
      // a tickful of 500s on one NVR can't fire many simultaneous RTSP re-opens
      // into a box already at its session cap (the cross-camera flap amplifier).
      const nvrKey = camera.group?.host || camera.host || `cam:${monitor}`;
      if (nowMs - (_nvrResetAt.get(nvrKey) || 0) < NVR_RESET_MIN_MS) {
        logger.debug('watchdog: reset deferred (per-NVR rate limit)', { camera: camera.name, nvrKey });
        continue;
      }

      logger.warn('watchdog: cycling path (likely corrupted muxer)', {
        camera: camera.name, monitor,
        wasStatus: status, failures: status === 500 ? f500 : f404,
        readers, readySinceSec: Math.round((readySinceMs || 0) / 1000),
      });

      const camConfig = buildCamConfig(camera);
      const subPath   = streamingService.deriveSubPath(camera.path);
      try {
        await streamingService.removeCamera(monitor);
        await streamingService.removeCameraSubStream(monitor);
        await streamingService.addCamera(monitor, camConfig);
        if (subPath) {
          await streamingService.addCameraSubStream(monitor, { ...camConfig, path: subPath });
        }
        _lastResetAt.set(monitor, nowMs);
        _nvrResetAt.set(nvrKey, nowMs);
        _muxer404Count.delete(monitor);
        _muxer500Count.delete(monitor);
        resets++;
        logger.info('watchdog: path reset — HLS muxer recreated', { camera: camera.name });
      } catch (err) {
        logger.error('watchdog: failed to reset corrupted path', {
          camera: camera.name, error: err.message,
        });
      }
    }

    // ── Phase 3: sync online/offline status in DB ─────────────────────────────
    // Must agree with streamSupervisor, which is the primary status authority.
    // A camera that isn't `ready` is NOT necessarily offline: sourceOnDemand
    // paths are only ready while being viewed. If the cameraReachability prober
    // says the host answers, the camera is online (standby). Only mark offline
    // when the path is not ready AND the host is genuinely unreachable —
    // otherwise this watchdog would flip every idle camera back to offline and
    // fight the supervisor on every cycle.
    const reachability = require('./cameraReachability.service');
    for (const camera of cameras) {
      const pathName = streamingService.pathName(camera.monitorId);
      const ready    = readyNames.has(pathName);
      const newStatus = (ready || reachability.isReachable(camera.host) === true)
        ? 'online'
        : 'offline';
      if (camera.status !== newStatus) {
        statusUpdates.push(camera.update({ status: newStatus }));
      }
    }

    if (statusUpdates.length) await Promise.all(statusUpdates);

    // Paths were (re-)added or reset — likely a Stream Service restart or recovery.
    // Trigger an immediate (debounced) retention reconcile so recordDeleteAfter
    // re-converges in seconds rather than waiting for the next reconcile tick.
    if (added > 0 || resets > 0) {
      try { require('./streamReconcile.service').requestReconcile('watchdog-readd'); } catch (_) { /* noop */ }
    }

    if (added > 0 || resets > 0 || orphans > 0 || statusUpdates.length > 0) {
      logger.info('watchdog: cycle complete', {
        pathsAdded:    added,
        orphansPurged: orphans,
        muxerResets:   resets,
        statusUpdates: statusUpdates.length,
      });
    }
  } catch (err) {
    logger.error('watchdog: unexpected error', { error: err.message });
  } finally {
    _watchdogRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// START / STOP
// ─────────────────────────────────────────────────────────────────────────────

function start() {
  if (_syncTimer || _watchdogTimer) return; // already running

  logger.info('recordingSync: service starting', {
    recordingsDir:    RECORDINGS_DIR,
    syncIntervalMin:  SYNC_INTERVAL_MS / 60_000,
    watchdogIntervalMin: WATCHDOG_MS / 60_000,
  });

  // Staggered boot — give Stream Service time to be ready before the watchdog fires.
  // Handles stored so stop() during the boot window cancels them (otherwise they
  // fire runSync/runWatchdog + re-arm intervals on an already-stopped service).
  _syncBootTimer = setTimeout(() => {
    _syncBootTimer = null;
    runSync();
    _syncTimer = setInterval(runSync, SYNC_INTERVAL_MS);
  }, 30_000);

  _watchdogBootTimer = setTimeout(() => {
    _watchdogBootTimer = null;
    runWatchdog();
    _watchdogTimer = setInterval(runWatchdog, WATCHDOG_MS);
  }, 60_000);
}

function stop() {
  if (_syncBootTimer)     { clearTimeout(_syncBootTimer);     _syncBootTimer     = null; }
  if (_watchdogBootTimer) { clearTimeout(_watchdogBootTimer); _watchdogBootTimer = null; }
  if (_syncTimer)         { clearInterval(_syncTimer);        _syncTimer         = null; }
  if (_watchdogTimer)     { clearInterval(_watchdogTimer);    _watchdogTimer     = null; }
  logger.info('recordingSync: service stopped');
}

module.exports = { start, stop, runSync, runWatchdog };
// Exposed for unit tests only.
module.exports._internals = { rememberUploaded, sweepStaleTempFiles, _uploaded, UPLOADED_CACHE_MAX, STALE_TEMP_MS, isFragmented, makeFaststart };
