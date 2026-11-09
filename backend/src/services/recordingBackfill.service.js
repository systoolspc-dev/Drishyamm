/**
 * recordingBackfill.service.js — fill cloud-recording gaps from the NVR's own HDD.
 *
 * Recording is live: Stream Service records whatever arrives from the camera.
 * When the site ↔ server link drops, nothing arrives, so the cloud timeline has
 * a hole even though the NVR kept recording to its own disk the whole time.
 *
 * Every BACKFILL_INTERVAL this loop, for every camera of every recording-enabled
 * account (RECORD_USER_IDS, or all cameras with RECORD_CONTINUOUS=1):
 *
 *   1. Builds the camera's coverage over the last BACKFILL_LOOKBACK_HOURS from
 *      the cloud clips (S3 key names carry start/end) plus the local segments
 *      not yet uploaded (start from the filename, end = mtime).
 *   2. Finds CLOSED gaps — a hole with footage on both sides, i.e. the
 *      connection came back — of at least BACKFILL_MIN_GAP_SEC. A gap must be
 *      seen on two consecutive passes before it is acted on, so a clip that is
 *      mid-upload (gone locally, not yet listed in S3) is never mistaken for one.
 *   3. Pulls each gap from the NVR in chunks of BACKFILL_CHUNK_SEC via the
 *      vendor RTSP playback URL (same builder NVR Playback uses), stream-copied
 *      (no re-encode), into the camera's normal recordings dir as an ordinary
 *      segment. recordingSync then stitches + uploads it like any other clip.
 *
 * Read-only towards the NVR: playback sessions only, nothing on the device is
 * changed or deleted. NVR load is bounded: at most BACKFILL_PER_HOST sessions per
 * NVR and BACKFILL_CONCURRENCY overall, and a host that fails (unreachable, auth
 * refused) is backed off — auth failures for an hour so we can never trip the
 * NVR's bad-login lockout. A chunk the NVR has no footage for is given up after
 * BACKFILL_MAX_TRIES attempts. Cameras whose vendor has no playback support
 * are skipped.
 *
 * Cameras that come in through a site relay (edge_<site>_<token>_chN) have no
 * NVR address we can reach, so their chunks are replayed by the relay's
 * playback agent (edgeRelay.openReplay, same as NVR Playback) and read from the
 * pbsrc_* path it pushes. At most BACKFILL_EDGE_PER_SITE at a time per site
 * (the site keeps one more replay slot for someone using Playback), outside the
 * BACKFILL_CONCURRENCY cap for direct NVRs: these are stream copies, light here.
 * Lookback is BACKFILL_EDGE_LOOKBACK_HOURS, and gaps that began before
 * BACKFILL_EDGE_SINCE (ISO time) are left alone: relay backfill applies from
 * when it was switched on, not to older holes.
 *
 * Live comes first: while a site is being backfilled, its live edge_* paths are
 * checked every LIVE_CHECK_MS. If fewer are up than when the pass started (NVR or
 * uplink struggling), that site's replays are stopped at once and it is paused
 * for EDGE_LIVE_PAUSE_MS. A stopped chunk keeps what it got; the rest stays a gap.
 */

const fs        = require('node:fs');
const path      = require('node:path');
const { spawn } = require('node:child_process');

const logger           = require('../config/logger');
const config           = require('../config/env');
const s3Service        = require('./s3.service');
const vendors          = require('./vendors');
const streamRouter     = require('./streamRouter.service');
const streamingService = require('./drishyamStreaming.service');
const edgeRelay        = require('./edgeRelay.service');

let Camera, CameraGroup;
const loadModels = () => {
  if (!Camera) ({ Camera, CameraGroup } = require('../models'));
};

// ── Settings ──────────────────────────────────────────────────────────────────

const env = (k, d) => {
  const v = parseInt(process.env[k] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const ENABLED          = process.env.BACKFILL_ENABLED !== '0';
const INTERVAL_MS      = env('BACKFILL_INTERVAL_MIN', 10) * 60 * 1000;
const LOOKBACK_MS      = env('BACKFILL_LOOKBACK_HOURS', 24) * 3600 * 1000;
const MIN_GAP_MS       = env('BACKFILL_MIN_GAP_SEC', 60) * 1000;
const CHUNK_MS         = env('BACKFILL_CHUNK_SEC', 600) * 1000;
const CONCURRENCY      = env('BACKFILL_CONCURRENCY', 4);
const PER_HOST         = env('BACKFILL_PER_HOST', 2);
const EDGE_PER_SITE    = env('BACKFILL_EDGE_PER_SITE', 6);
const EDGE_LOOKBACK_MS = env('BACKFILL_EDGE_LOOKBACK_HOURS', 72) * 3600 * 1000;
const EDGE_SINCE_MS    = Date.parse(process.env.BACKFILL_EDGE_SINCE || '') || 0;
const MAX_TRIES        = env('BACKFILL_MAX_TRIES', 3);
const HOST_BACKOFF_MS  = 15 * 60 * 1000;   // NVR unreachable / timed out
const AUTH_BACKOFF_MS  = 60 * 60 * 1000;   // NVR refused credentials
const EDGE_BACKOFF_MS  = 5 * 60 * 1000;    // relay not polling (PC off / restarting)
const PASS_BUDGET_MS   = 60 * 60 * 1000;   // stop starting chunks after this, so the next pass re-plans
const LIVE_CHECK_MS    = 20 * 1000;        // how often a backfilling site's live streams are checked
const EDGE_LIVE_PAUSE_MS = env('BACKFILL_EDGE_LIVE_PAUSE_MIN', 15) * 60 * 1000; // pause after live streams dropped during a backfill
// A relay can't tell "no footage" from "NVR switched off", so "empty" only counts
// towards giving up while this site has filled a chunk this recently.
const EDGE_EMPTY_TRUST_MS = 30 * 60 * 1000;
const SETTLE_MS        = 5 * 60 * 1000;    // never touch the last few minutes
const JOIN_SLACK_MS    = 5 * 1000;         // clips this close count as continuous
const MIN_USEFUL_SEC   = 5;                // less than this = NVR gave us nothing
// A pulled chunk is stored as clips of this length, like live recordings: a
// 10-minute ~250 MB clip opened slowly in the browser. Pulls stay CHUNK_SEC long
// (each relay replay costs ~20 s to start).
const CLIP_SEC         = env('BACKFILL_CLIP_SEC', 180);

const RECORDINGS_DIR = config.streamService.recordingsDir || '/recordings';
const STATE_FILE     = path.join(RECORDINGS_DIR, '.backfill-state.json');

const RECORD_USER_IDS = new Set(
  (process.env.RECORD_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const recordsEverything = () => process.env.RECORD_CONTINUOUS === '1';

// ── State ─────────────────────────────────────────────────────────────────────

let _timer = null;
let _bootTimer = null;
let _running = false;
const _gapSeen   = new Map();   // `${monitorId}|${gapStartMs}` → first pass that saw it
const _hostUntil = new Map();   // NVR host → epoch ms it may be tried again
const _lastFill = new Map();    // relay site host → epoch ms of its last filled chunk
const _skipLogged = new Set();  // monitorIds already logged as unsupported
let _state = { chunks: {} };    // `${monitorId}|${chunkStartMs}` → { tries, last, status }

function loadState() {
  try { _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { _state = { chunks: {} }; }
  if (!_state.chunks) _state.chunks = {};
}

function saveState() {
  // Forget chunks that have slid out of the lookback window.
  const floor = Date.now() - Math.max(LOOKBACK_MS, EDGE_LOOKBACK_MS) - 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(_state.chunks)) {
    if (Number(k.split('|')[1]) < floor) delete _state.chunks[k];
    else if (!v) delete _state.chunks[k];
  }
  try {
    fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(_state));
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (err) {
    logger.warn('backfill: could not save state', { error: err.message });
  }
}

// ── Time helpers (recording names are server-local wall clock) ──────────────

const z = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const hms = (ms) => { const d = new Date(ms); return `${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`; };
const atLocal = (day, h, m, s) => { const [Y, M, D] = day.split('-').map(Number); return new Date(Y, M - 1, D, h, m, s).getTime(); };
const nextMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };

function daysBetween(fromMs, toMs) {
  const out = [];
  for (let t = fromMs; t <= toMs; t = nextMidnight(t)) out.push(dayKey(t));
  if (!out.includes(dayKey(toMs))) out.push(dayKey(toMs));
  return out;
}

/** Cloud clip `HH-MM-SS_to_HH-MM-SS_Nm.mp4` → [startMs, endMs] or null. */
function cloudSpan(day, filename) {
  const m = /^(\d{2})-(\d{2})-(\d{2})_to_(\d{2})-(\d{2})-(\d{2})/.exec(filename);
  if (!m) return null;
  const s = atLocal(day, +m[1], +m[2], +m[3]);
  let e = atLocal(day, +m[4], +m[5], +m[6]);
  // Ran past midnight only if it ends well before it starts (23:5x -> 00:0x). A
  // few seconds backwards is clock jitter: +24 h there made a phantom day of footage.
  if (e < s - 3600 * 1000) e += 24 * 3600 * 1000;
  else if (e < s) e = s;
  return [s, e];
}

// ── Coverage + gaps ─────────────────────────────────────────────────────────

// End of a local segment. Its mtime is the end only while it is the segment
// being written (live). A file finished long ago (a backfilled chunk waiting
// to upload, or one written later than the footage it holds) has an mtime far
// past its footage: taking that as the end made a span that hid every gap
// behind it (2026-11-04: chunks of 28/10 written on 3/11 hid six days). Such
// files are measured instead; the result is cached by size + mtime.
const LIVE_SEGMENT_MAX_MS = 15 * 60 * 1000;
const _durCache = new Map();   // file → { key, sec }
async function localEnd(file, startMs, st) {
  if (st.mtimeMs - startMs <= LIVE_SEGMENT_MAX_MS) return st.mtimeMs;
  const key = `${st.size}|${st.mtimeMs}`;
  let hit = _durCache.get(file);
  if (!hit || hit.key !== key) {
    hit = { key, sec: await probeDurationSec(file) };
    _durCache.set(file, hit);
  }
  return hit.sec > 0 ? Math.min(st.mtimeMs, startMs + hit.sec * 1000) : startMs; // unreadable: covers nothing
}

async function coverage(camera, group, days) {
  const spans = [];
  for (const day of days) {
    // A failed listing must not look like an empty day (that would be one big
    // phantom gap), so let it throw and skip the camera this pass.
    const clips = await s3Service.listRecordings(camera.userId, group.name, camera.name, day);
    for (const c of clips) {
      const sp = cloudSpan(day, c.filename);
      if (sp) spans.push(sp);
    }
    const dir = path.join(RECORDINGS_DIR, streamingService.pathName(camera.monitorId), day);
    let files = [];
    try { files = await fs.promises.readdir(dir); } catch { /* nothing local that day */ }
    if (_durCache.size > 20000) _durCache.clear();
    for (const f of files) {
      const m = /^(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.mp4$/.exec(f);
      if (!m) continue;
      try {
        const file = path.join(dir, f);
        const st = await fs.promises.stat(file);
        const s = atLocal(day, +m[1], +m[2], +m[3]);
        const e = await localEnd(file, s, st);
        if (e > s) spans.push([s, e]);
      } catch { /* uploaded + removed meanwhile */ }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1] + JOIN_SLACK_MS) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  return merged;
}

/**
 * Holes between consecutive covered spans that reach into [fromMs, toMs].
 * The start is NOT clipped to the window: it is the end of the footage before
 * the hole, so it stays the same pass after pass (gap + chunk keys rely on it).
 */
function closedGaps(spans, fromMs, toMs) {
  const gaps = [];
  for (let i = 1; i < spans.length; i++) {
    const s = Math.round(spans[i - 1][1]);
    const e = Math.round(Math.min(spans[i][0], toMs));
    if (e > fromMs && e - Math.max(s, fromMs) >= MIN_GAP_MS) gaps.push([s, e]);
  }
  return gaps;
}

/**
 * Split a gap into chunks that never cross local midnight (one date dir each).
 * Boundaries are laid from the gap's fixed start, so a chunk keeps its key
 * across passes; chunks ending before `floorMs` (out of lookback) are dropped.
 */
function chunksOf([s, e], floorMs = -Infinity) {
  const out = [];
  for (let t = s; t < e;) {
    const end = Math.min(t + CHUNK_MS, e, nextMidnight(t));
    if (end > floorMs && end - t >= MIN_USEFUL_SEC * 1000) out.push([t, end]);
    t = end;
  }
  return out;
}

// ── Pulling one chunk from the NVR ──────────────────────────────────────────

function probeDurationSec(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(parseFloat(out) || 0));
  });
}

/** Classify an ffmpeg failure tail: 'auth' | 'host' | 'empty'. */
function failureKind(tail) {
  if (/401|unauthori[sz]ed|403|forbidden/i.test(tail)) return 'auth';
  if (/timed? ?out|connection refused|no route|unreachable|network is|resolve|reset by peer/i.test(tail)) return 'host';
  return 'empty';
}

function nvrSource({ camera, group, deviceType, start, end }) {
  return streamRouter.buildRtspUrl({
    host:     group.host     ?? camera.host,
    port:     group.port     ?? camera.port ?? 554,
    path:     vendors.buildPlaybackPath(deviceType, camera.channel || 1, start, end),
    username: group.username ?? camera.username,
    password: group.password ?? camera.password, // model getter decrypts
  });
}

/** openReplay's AppError → failure kind: relay offline | site busy | no footage. */
const edgeFailureKind = (err) => (err.statusCode === 409 ? 'host' : err.statusCode === 429 ? 'busy' : 'empty');

async function pullChunk(job) {
  if (!job.edge) return pullFrom(job, nvrSource(job));
  let replay;
  try {
    // fast: a v4 relay downloads the range and sends it faster than real time.
    replay = await edgeRelay.openReplay(job.edge, job.start, job.end, { fast: true });
  } catch (err) {
    return { ok: false, gotSec: 0, kind: edgeFailureKind(err), tail: err.message };
  }
  try {
    return await pullFrom(job, replay.sourceUrl);
  } finally {
    edgeRelay.closeReplay(replay.id);
  }
}

function pullFrom(job, sourceUrl) {
  const { camera, start, end } = job;
  const day = dayKey(start);
  const dir = path.join(RECORDINGS_DIR, streamingService.pathName(camera.monitorId), day);
  const tmp = path.join(dir, `.backfill-${start}.part`);
  const durSec = Math.round((end - start) / 1000);

  return new Promise((resolve) => {
    fs.mkdirSync(dir, { recursive: true });
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp', '-timeout', '15000000',   // 15 s socket I/O timeout
      '-fflags', '+genpts',
      '-i', sourceUrl,
      '-t', String(durSec),
      '-map', '0:v:0', '-c:v', 'copy', '-an',             // as recorded; NVR audio is G.711
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', '-y', tmp,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    job.proc = proc;
    let tail = '';
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-800); });
    // NVR playback is real time; allow the chunk's length plus generous slack.
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, (durSec + 120) * 1000);
    proc.on('error', (e) => { tail += ` spawn: ${e.message}`; });
    proc.on('close', async () => {
      clearTimeout(killer);
      const got = fs.existsSync(tmp) ? await probeDurationSec(tmp) : 0;
      if (got >= MIN_USEFUL_SEC) {
        // Ordinary segment names, so recordingSync uploads them as usual.
        try {
          const files = got > CLIP_SEC * 1.2 ? await splitClips(tmp, dir, start) : null;
          if (files && files.length) {
            fs.promises.unlink(tmp).catch(() => {});
            return resolve({ ok: true, gotSec: got, file: files.join(', ') });
          }
          const final = path.join(dir, `${hms(start)}-000001.mp4`);
          fs.renameSync(tmp, final);
          return resolve({ ok: true, gotSec: got, file: final });
        } catch (err) {
          tail += ` rename: ${err.message}`;
        }
      }
      fs.promises.unlink(tmp).catch(() => {});
      resolve({ ok: false, gotSec: got, kind: failureKind(tail), tail: tail.trim().slice(-200) });
    });
  });
}

/**
 * Cut a pulled chunk into ~CLIP_SEC clips (at key frames, stream copy) named by
 * their own start time. Returns the final paths, or null if it could not
 * (the caller then keeps the chunk as one file).
 */
function splitClips(src, dir, startMs) {
  const tag = `.backfill-seg-${startMs}`;
  const list = path.join(dir, `${tag}.csv`);
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-map', '0:v:0', '-c', 'copy',
      '-f', 'segment', '-segment_time', String(CLIP_SEC), '-reset_timestamps', '1',
      '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart',
      '-segment_list', list, '-segment_list_type', 'csv',
      path.join(dir, `${tag}-%03d.mp4`),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const cleanup = () => {
      try { for (const f of fs.readdirSync(dir)) if (f.startsWith(tag)) fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
    };
    proc.on('error', () => { cleanup(); resolve(null); });
    proc.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
        const rows = fs.readFileSync(list, 'utf8').trim().split('\n').map((l) => l.split(','));
        const out = [];
        for (const [name, s] of rows) {
          const at = startMs + Math.round(parseFloat(s) * 1000);
          const final = path.join(dir, `${hms(at)}-000001.mp4`);
          fs.renameSync(path.join(dir, name), final);
          out.push(final);
        }
        fs.promises.unlink(list).catch(() => {});
        resolve(out);
      } catch (e) {
        logger.warn('backfill: could not split chunk into clips, keeping it whole', { error: e.message });
        cleanup();
        resolve(null);
      }
    });
  });
}

// ── Live-first guard for relay sites ────────────────────────────────────────

/** host key `edge:<site>_<token>` → number of that site's live edge_* paths up, or null. */
async function liveUp(hosts) {
  try {
    const { data } = await streamingService.api.get('/v3/paths/list?itemsPerPage=1000');
    const out = new Map();
    for (const h of hosts) {
      const prefix = `edge_${h.slice('edge:'.length)}_ch`;
      out.set(h, (data.items || []).filter((p) => p.name.startsWith(prefix) && p.ready).length);
    }
    return out;
  } catch {
    return null;     // Stream Service API unavailable: no verdict this round
  }
}

/**
 * Watch the live streams of every relay site in this pass. Baseline = what is up
 * before any of our replays start; a drop below it pauses the site and kills its
 * running replays. Returns a stop() for the end of the pass.
 */
async function guardLive(jobs, running) {
  const hosts = [...new Set(jobs.filter((j) => j.edge).map((j) => j.host))];
  if (!hosts.length) return () => {};
  const baseline = (await liveUp(hosts)) || new Map();
  const timer = setInterval(async () => {
    const now = await liveUp(hosts);
    if (!now) return;
    for (const h of hosts) {
      const base = baseline.get(h) || 0;
      if ((now.get(h) || 0) >= base || (_hostUntil.get(h) || 0) > Date.now()) continue;
      _hostUntil.set(h, Date.now() + EDGE_LIVE_PAUSE_MS);
      const victims = [...running].filter((j) => j.host === h);
      for (const j of victims) { j.stopped = true; try { j.proc?.kill('SIGTERM'); } catch { /* gone */ } }
      logger.warn('backfill: live streams dropped while backfilling a relay site, pausing it', {
        site: h, liveBefore: base, liveNow: now.get(h) || 0, stoppedReplays: victims.length, pauseMin: EDGE_LIVE_PAUSE_MS / 60_000,
      });
    }
  }, LIVE_CHECK_MS);
  return () => clearInterval(timer);
}

// ── Planning + running a pass ───────────────────────────────────────────────

async function recordedCameras() {
  loadModels();
  const where = recordsEverything() ? {} : { userId: [...RECORD_USER_IDS] };
  if (!recordsEverything() && !RECORD_USER_IDS.size) return [];
  return Camera.findAll({ where, include: [{ model: CameraGroup, as: 'group' }] });
}

async function planJobs(passAt) {
  const now = Date.now();
  const toMs = now - SETTLE_MS;
  const jobs = [];
  const seenNow = new Set();

  for (const camera of await recordedCameras()) {
    const group = camera.group;
    if (!group) continue;
    const edge = edgeRelay.parseEdgeCamera(camera);
    const fromMs = now - (edge ? EDGE_LOOKBACK_MS : LOOKBACK_MS);
    // One extra day back, so a gap that began before the window still has the
    // footage that precedes it (otherwise it would not count as a closed gap).
    const days = daysBetween(fromMs - 24 * 3600 * 1000, toMs);
    const deviceType = camera.deviceType || group.deviceType || 'hikvision';
    if (!edge && !vendors.supportsPlayback(deviceType)) {
      if (!_skipLogged.has(camera.monitorId)) {
        _skipLogged.add(camera.monitorId);
        logger.info('backfill: camera has no NVR playback support, skipping', { camera: camera.name, deviceType });
      }
      continue;
    }

    let spans;
    try {
      spans = await coverage(camera, group, days);
    } catch (err) {
      logger.warn('backfill: could not read coverage, skipping camera this pass', { camera: camera.name, error: err.message });
      continue;
    }

    for (const gap of closedGaps(spans, fromMs, toMs)) {
      if (edge && gap[0] < EDGE_SINCE_MS) continue;
      const gapKey = `${camera.monitorId}|${gap[0]}`;
      seenNow.add(gapKey);
      if (!_gapSeen.has(gapKey)) { _gapSeen.set(gapKey, passAt); continue; }  // confirm next pass

      for (const [s, e] of chunksOf(gap, fromMs)) {
        const st = _state.chunks[`${camera.monitorId}|${s}`];
        if (st && (st.status === 'gave-up' || st.tries >= MAX_TRIES)) continue;
        jobs.push({
          camera, group, deviceType, edge, start: s, end: e,
          host: edge ? `edge:${edge.site}_${edge.token}` : String(group.host ?? camera.host),
          key: `${camera.monitorId}|${s}`,
        });
      }
    }
  }
  for (const k of [..._gapSeen.keys()]) if (!seenNow.has(k)) _gapSeen.delete(k);
  jobs.sort((a, b) => a.start - b.start);   // oldest footage first
  return jobs;
}

async function runJobs(jobs) {
  const perHost = new Map();
  let active = 0;        // direct NVR pulls (relay pulls are capped per site instead)
  let running = 0;
  let filled = 0;
  let failed = 0;
  const budgetEnd = Date.now() + PASS_BUDGET_MS;
  const inFlight = new Set();
  const stopGuard = await guardLive(jobs, inFlight);

  await new Promise((done) => {
    const queue = [...jobs];
    const cameraBusy = (job) => [...inFlight].some((j) => j.camera.monitorId === job.camera.monitorId);
    const pump = () => {
      if (Date.now() > budgetEnd) queue.length = 0;   // the rest waits for the next pass
      if (!queue.length && !running) return done();
      // Relay sites: one replay per camera first, so every camera moves forward
      // together; a second round gives any slots left to cameras with more to do.
      for (const fair of [true, false]) {
        for (let i = 0; i < queue.length;) {
          const job = queue[i];
          if ((_hostUntil.get(job.host) || 0) > Date.now()) { queue.splice(i, 1); continue; }
          if (fair && job.edge && cameraBusy(job)) { i++; continue; }
          if (!job.edge && active >= CONCURRENCY) { i++; continue; }
          if ((perHost.get(job.host) || 0) >= (job.edge ? EDGE_PER_SITE : PER_HOST)) { i++; continue; }
          queue.splice(i, 1);
          if (!job.edge) active++;
          running++;
          perHost.set(job.host, (perHost.get(job.host) || 0) + 1);
          logger.info('backfill: pulling gap from NVR', {
            camera: job.camera.name, via: job.edge ? 'site relay' : 'direct',
            from: new Date(job.start).toString(), sec: Math.round((job.end - job.start) / 1000),
          });
          inFlight.add(job);
          pullChunk(job).then((r) => {
            if (!r.ok && job.stopped) r.kind = 'busy';   // we stopped it for live: not the NVR's fault
            const st = _state.chunks[job.key] || { tries: 0 };
            st.tries += 1;
            st.last = Date.now();
            if (r.ok) {
              filled++;
              if (job.edge) _lastFill.set(job.host, Date.now());
              st.status = 'filled';
              logger.info('backfill: gap filled', { camera: job.camera.name, gotSec: Math.round(r.gotSec), file: r.file });
            } else {
              failed++;
              if (r.kind === 'auth') _hostUntil.set(job.host, Date.now() + AUTH_BACKOFF_MS);
              if (r.kind === 'host') _hostUntil.set(job.host, Date.now() + (job.edge ? EDGE_BACKOFF_MS : HOST_BACKOFF_MS));
              // An unreachable NVR (or a busy relay) says nothing about whether footage
              // exists, so only "NVR answered but had nothing" counts towards giving up.
              const siteAnswering = !job.edge || Date.now() - (_lastFill.get(job.host) || 0) < EDGE_EMPTY_TRUST_MS;
              if (r.kind !== 'empty' || !siteAnswering) st.tries -= 1;
              st.status = st.tries >= MAX_TRIES ? 'gave-up' : r.kind;
              if (r.kind === 'busy') { _state.chunks[job.key] = st; return; }   // Playback has the slots; retry next pass
              logger.warn('backfill: could not pull gap', { camera: job.camera.name, kind: r.kind, tries: st.tries, tail: r.tail });
            }
            _state.chunks[job.key] = st;
            saveState();
          }).finally(() => {
            inFlight.delete(job);
            if (!job.edge) active--;
            running--;
            perHost.set(job.host, perHost.get(job.host) - 1);
            pump();
          });
        }
      }
      if (!queue.length && !running) done();
    };
    pump();
  });
  stopGuard();
  return { filled, failed };
}

async function runBackfill() {
  if (_running) return;
  _running = true;
  const passAt = Date.now();
  try {
    const jobs = await planJobs(passAt);
    if (!jobs.length) return;
    logger.info('backfill: pass starting', { chunks: jobs.length });
    const { filled, failed } = await runJobs(jobs);
    logger.info('backfill: pass complete', { filled, failed, tookSec: Math.round((Date.now() - passAt) / 1000) });
  } catch (err) {
    logger.error('backfill: unexpected error', { error: err.message });
  } finally {
    _running = false;
  }
}

// ── Start / stop ────────────────────────────────────────────────────────────

function start() {
  if (!ENABLED || _timer || _bootTimer) return;
  loadState();
  logger.info('backfill: service starting', {
    intervalMin: INTERVAL_MS / 60_000, lookbackHours: LOOKBACK_MS / 3_600_000,
    edgeLookbackHours: EDGE_LOOKBACK_MS / 3_600_000, edgePerSite: EDGE_PER_SITE,
    edgeSince: EDGE_SINCE_MS ? new Date(EDGE_SINCE_MS).toISOString() : null, chunkSec: CHUNK_MS / 1000,
  });
  _bootTimer = setTimeout(() => {
    _bootTimer = null;
    runBackfill();
    _timer = setInterval(runBackfill, INTERVAL_MS);
  }, 90_000);
}

function stop() {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  if (_timer)     { clearInterval(_timer);    _timer = null; }
}

module.exports = { start, stop, runBackfill };
module.exports._internals = { cloudSpan, closedGaps, chunksOf, failureKind, planJobs, coverage, localEnd, splitClips };
