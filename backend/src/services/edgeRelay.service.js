/**
 * edgeRelay.service.js — NVR replays for cameras that reach us through a site relay.
 *
 * A site relay (drishyam-site-relay.ps1 on a PC next to the NVR) pushes each
 * camera OUT to Stream Service as `edge_<site>_<token>_ch<N>`. The NVR sits on
 * the site's private network, so we can never open its playback ourselves.
 * Instead the relay's playback agent long-polls GET /api/edge/jobs (held open
 * until its job list changes, at most ~25 s), and for each job it replays that channel's range from the NVR
 * (stream-copied) and pushes it to the job's `pbsrc_*` path. Our ffmpeg then
 * reads that path exactly as if it were the NVR's playback URL.
 *
 * A job lives only while something here is consuming it: closing it (playback
 * stopped, export finished) drops it from the list, and the agent kills its
 * ffmpeg on the next poll. Jobs also expire on their own, so a crash here can
 * never leave a relay pulling the NVR indefinitely.
 *
 * Failures are 4xx on purpose: the error handler replaces every 5xx message
 * with "Internal Server Error", and these tell the user what to check.
 */
const crypto = require('node:crypto');
const AppError = require('../utils/AppError');
const streamingService = require('./drishyamStreaming.service');
const logger = require('../config/logger');

const MEDIAMTX_RTSP = process.env.MEDIAMTX_RTSP_BASE || 'rtsp://mediamtx:8554';
const AGENT_ALIVE_MS = 45 * 1000;     // a relay that polled this recently is listening
const MAX_WAIT_MS = 25 * 1000;        // long-poll hold (under every proxy's idle timeout)
const READY_TIMEOUT_MS = 30 * 1000;   // relay connects to the NVR + starts pushing
// A fast (download) job may try two NVR download forms before it pushes (relay v4).
const READY_TIMEOUT_FAST_MS = 60 * 1000;
const MAX_JOB_MS = 35 * 60 * 1000;    // just over the 30-minute playback session cap
// Each job is one more pull on the site's NVR; the relay script caps it too ($MaxReplays).
// 7 = 6 for cloud backfill + 1 kept for Playback / Clip Export.
const MAX_JOBS_PER_SITE = parseInt(process.env.EDGE_MAX_JOBS_PER_SITE || '', 10) || 7;

// `/edge_<site>_<token>_ch<N>` — the path the relay prints for each camera.
const EDGE_PATH_RE = /^\/?edge_([a-z0-9]+)_([a-z0-9]+)_ch(\d+)$/;

const jobs = new Map();       // id → { id, siteKey, ch, start, end, push, expiresAt }
const lastPoll = new Map();   // siteKey → epoch ms of the relay's last poll
const waiters = new Map();    // siteKey → Set of wake-up callbacks (held polls)

const siteKeyOf = (site, token) => `${site}_${token}`;

/** { site, token, ch } when the camera comes in through a site relay, else null. */
function parseEdgeCamera(camera) {
  const m = EDGE_PATH_RE.exec(String(camera?.path || ''));
  return m ? { site: m[1], token: m[2], ch: parseInt(m[3], 10) } : null;
}

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.expiresAt < now) jobs.delete(id);
}

function jobsFor(siteKey) {
  return [...jobs.values()]
    .filter((j) => j.siteKey === siteKey)
    .map(({ id, ch, start, end, push, fast }) => ({ id, ch, start, end, push, ...(fast ? { fast: true } : {}) }));
}

/** Wake the held polls of one relay: its job list just changed. */
function notify(siteKey) {
  const set = waiters.get(siteKey);
  if (!set) return;
  waiters.delete(siteKey);
  for (const wake of set) wake();
}

/**
 * Jobs for one relay; called by its agent, which also marks it alive. `have`
 * is the ids the agent is already running: while they still match, the call
 * is held (up to waitMs) until a job is added or closed.
 */
async function pollJobs(site, token, have = [], waitMs = MAX_WAIT_MS) {
  sweep();
  const siteKey = siteKeyOf(site, token);
  lastPoll.set(siteKey, Date.now());
  const same = () => {
    const ids = jobsFor(siteKey).map((j) => j.id).sort().join(',');
    return ids === [...have].sort().join(',');
  };
  if (same() && waitMs > 0) {
    await new Promise((resolve) => {
      const set = waiters.get(siteKey) || new Set();
      waiters.set(siteKey, set);
      const wake = () => { clearTimeout(timer); set.delete(wake); resolve(); };
      const timer = setTimeout(wake, Math.min(waitMs, MAX_WAIT_MS));
      set.add(wake);
    });
    lastPoll.set(siteKey, Date.now());
    sweep();
  }
  return jobsFor(siteKey);
}

/** The pushed path's video codec once the relay is publishing, else null. */
async function pathReady(name) {
  try {
    const { data } = await streamingService.api.get(`/v3/paths/get/${name}`);
    return data?.ready ? String((data.tracks || [])[0] || 'unknown') : null;
  } catch {
    return null;    // 404 until the relay starts publishing
  }
}

/**
 * Ask the camera's relay to replay [startMs, endMs] and wait until it is
 * pushing. `fast` (cloud backfill only, never someone watching): a relay that
 * can (v4, Hikvision) downloads the range from the NVR and sends it faster than
 * real time; older relays ignore the flag and replay as before. Resolves { id, sourceUrl, codec } — sourceUrl stands in for the NVR's
 * playback URL. Throws a user-facing AppError when the relay can't do it.
 */
async function openReplay(edge, startMs, endMs, { fast = false } = {}) {
  sweep();
  const siteKey = siteKeyOf(edge.site, edge.token);
  const listening = waiters.has(siteKey) || (lastPoll.get(siteKey) || 0) > Date.now() - AGENT_ALIVE_MS;
  if (!listening) {
    throw new AppError(
      "This camera's site relay isn't answering playback requests. Check the relay PC is on and online, and that it runs the latest relay script.",
      409,
    );
  }
  if ([...jobs.values()].filter((j) => j.siteKey === siteKey).length >= MAX_JOBS_PER_SITE) {
    throw new AppError('This site is already replaying the maximum number of clips. Stop one, then try again.', 429);
  }

  const id = crypto.randomBytes(6).toString('hex');
  const push = `pbsrc_${siteKey}_${id}`;
  jobs.set(id, {
    id, siteKey, ch: edge.ch, start: startMs, end: endMs, push, fast: !!fast,
    expiresAt: Date.now() + Math.min(endMs - startMs + 2 * 60 * 1000, MAX_JOB_MS),
  });
  notify(siteKey);
  logger.info('edge replay requested', { siteKey, ch: edge.ch, push, fast: !!fast });

  const deadline = Date.now() + (fast ? READY_TIMEOUT_FAST_MS : READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (!jobs.has(id)) break;                       // closed meanwhile
    const codec = await pathReady(push);
    if (codec) return { id, sourceUrl: `${MEDIAMTX_RTSP}/${push}`, codec };
    await new Promise((r) => setTimeout(r, 400));
  }
  closeReplay(id);
  throw new AppError('The site relay could not get this footage from the NVR. Check the time range has recordings, and try again.', 422);
}

function closeReplay(id) {
  const j = id && jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  notify(j.siteKey);
  logger.info('edge replay closed', { id });
}

module.exports = { parseEdgeCamera, pollJobs, openReplay, closeReplay };
