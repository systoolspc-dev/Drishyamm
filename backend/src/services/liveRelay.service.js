// Live relay: the camera's own stream to the browser over a WebSocket, no
// transcode, with a keyframe (GOP) cache for instant start.
//
// Why
//   Browsers that can decode H.265 (most Windows/macOS/iOS/Android devices,
//   in hardware) don't need our ffmpeg H.265→H.264 transcode — it cost seconds
//   of start-up, a CPU core per few tiles and a second encode generation.
//   But a new viewer of a running stream must start on a keyframe, and these
//   cameras send one every 3.3 s (sub, measured 2026-10-20 on all 18 lab
//   channels; 2.5 s on two). So each relay keeps the last keyframe and every
//   frame since: a viewer gets that at once and the browser shows the newest
//   frame within a few hundred ms, then plays live.
//
// How
//   One relay per Stream Service path (cam_<id>_sub, cam_<id>, or a
//   transcoded *_h264 path for browsers that can't decode H.265). Stream
//   Service stays the only NVR puller, so per-NVR session limits and pacing
//   still apply. The relay is `ffmpeg -c copy` into fragmented MP4, one
//   fragment per frame (~1 % CPU, no decode). Node splits the output into the
//   init segment (ftyp+moov) and per-frame fragments (moof+mdat), marks
//   keyframes, and fans each fragment out to that path's WebSocket viewers.
//
//   Wire format (per viewer): one text message {type:'init', codec, mime},
//   then binary messages: the init segment, the cached GOP, then live frames.
//   A text {type:'reset'} precedes a new init after a relay restart.
//
//   A slow viewer (bufferedAmount over the limit) skips frames until the next
//   keyframe instead of growing a queue, so one bad Wi-Fi client never holds
//   up the server or other viewers.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const transcoder = require('./transcoder.service');

const IDLE_MS        = parseInt(process.env.RELAY_IDLE_MS || '30000', 10);
const MAX_GOP_FRAMES = parseInt(process.env.RELAY_MAX_GOP_FRAMES || '800', 10);
const SLOW_BYTES     = parseInt(process.env.RELAY_SLOW_BYTES || String(2 * 1024 * 1024), 10);
// Stall watchdog. An NVR can keep the RTSP/TCP session open while it stops
// sending video (keep-alives / RTCP / audio still flow), so ffmpeg's socket
// timeout never fires and the relay sits frozen for good: viewers get the
// cached GOP — one still picture — then nothing. Measured 2026-11-09 on an
// 18-tile wall (office12): 3 of 18 relays delivered 50 frames (the GOP cache)
// and then zero for 60 s, and stayed that way until the page was reloaded.
// A running relay with no video fragment for RELAY_STALL_MS is restarted
// through the normal path (same per-NVR pacing and backoff). Sub-streams run
// at 6-25 fps, so 10 s of silence is never a quiet camera.
const STALL_MS       = parseInt(process.env.RELAY_STALL_MS || '10000', 10);
// No init segment at all this long after ffmpeg started: connect/probe hung.
const NO_INIT_MS     = parseInt(process.env.RELAY_NO_INIT_MS || '20000', 10);
const TICKET_MS      = 30_000;

const _relays = new Map();   // path → relay
const _tickets = new Map();  // ticket → { userId, monitorId, path, expires }
// Several accounts can hold the same NVR channel, each under its own path. They
// share one relay, so one channel costs the NVR one session however many
// accounts watch it.
const _bySource = new Map(); // NVR URL → path of the relay reading it
const _aliasOf = new Map();  // path → path of the relay it shares

// ── fMP4 helpers ─────────────────────────────────────────────────────────────

function findBox(buf, type, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const t = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
    if (size < hdr) return null;
    if (t === type) return { off, size, hdr };
    off += size;
  }
  return null;
}

// RFC 6381 codec string from the sample entry in the init segment, so the
// browser can ask MediaSource.isTypeSupported / addSourceBuffer precisely.
function codecFromInit(init) {
  const hv = init.indexOf(Buffer.from('hvcC'));
  if (hv > 0) {
    const entry = init.includes(Buffer.from('hvc1')) ? 'hvc1' : 'hev1';
    const p = hv + 4; // HEVCDecoderConfigurationRecord
    const b1 = init[p + 1];
    const space = ['', 'A', 'B', 'C'][b1 >> 6];
    const tier = (b1 >> 5) & 1 ? 'H' : 'L';
    const idc = b1 & 0x1f;
    let compat = init.readUInt32BE(p + 2);
    // general_profile_compatibility_flags, bit-reversed, hex, no leading zeros
    let rev = 0;
    for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    const cons = [];
    for (let i = 0; i < 6; i++) cons.push(init[p + 6 + i]);
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    const level = init[p + 12];
    return [`${entry}.${space}${idc}`, (rev >>> 0).toString(16).toUpperCase(), `${tier}${level}`,
      ...cons.map((c) => c.toString(16).toUpperCase())].join('.');
  }
  const av = init.indexOf(Buffer.from('avcC'));
  if (av > 0) {
    const p = av + 4;
    return 'avc1.' + [init[p + 1], init[p + 2], init[p + 3]].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

// Audio: the cameras send G.711, which MediaSource can't play, so the relay
// re-encodes it to AAC (the video stays a stream copy). G.711 at 8 kHz mono
// costs next to nothing to encode. RELAY_AUDIO=0 turns it off.
const AUDIO_ON = process.env.RELAY_AUDIO !== '0';
const AUDIO_CODEC = 'mp4a.40.2'; // AAC-LC

// The track ID of the video track in an init segment (the trak whose handler
// is 'vide'); 1 when it can't be read, which is what ffmpeg gives it here
// (video is mapped first).
function videoTrackId(init) {
  const moov = findBox(init, 'moov');
  if (!moov) return 1;
  let off = moov.off + moov.hdr;
  const end = moov.off + moov.size;
  for (let trak; (trak = findBox(init, 'trak', off, end)); off = trak.off + trak.size) {
    const tEnd = trak.off + trak.size;
    const tkhd = findBox(init, 'tkhd', trak.off + trak.hdr, tEnd);
    const h = init.indexOf(Buffer.from('hdlr'), trak.off);
    if (!tkhd || h < 0 || h + 16 > tEnd) continue;
    if (init.toString('latin1', h + 12, h + 16) !== 'vide') continue;
    const v = init[tkhd.off + tkhd.hdr];
    return init.readUInt32BE(tkhd.off + tkhd.hdr + (v === 1 ? 20 : 12));
  }
  return 1;
}

// Where the video sample data of a moof+mdat fragment lies, or null when the
// fragment carries no video (an audio frame). Reads tfhd/trun so audio data in
// the same mdat is never mistaken for NAL units.
function videoRange(frag, vtrack) {
  const moof = findBox(frag, 'moof');
  const mdat = findBox(frag, 'mdat');
  if (!moof || !mdat) return null;
  const mEnd = moof.off + moof.size;
  let off = moof.off + moof.hdr;
  for (let traf; (traf = findBox(frag, 'traf', off, mEnd)); off = traf.off + traf.size) {
    const tEnd = traf.off + traf.size;
    const tfhd = findBox(frag, 'tfhd', traf.off + traf.hdr, tEnd);
    if (!tfhd) continue;
    const p0 = tfhd.off + tfhd.hdr;
    if (frag.readUInt32BE(p0 + 4) !== vtrack) continue;
    const dataStart = mdat.off + mdat.hdr;
    const dataEnd = mdat.off + mdat.size;
    const trun = findBox(frag, 'trun', traf.off + traf.hdr, tEnd);
    if (!trun) return { start: dataStart, end: dataEnd };
    // tfhd: flags, track_ID, then optional fields in this order.
    const tf = frag.readUInt32BE(p0) & 0xffffff;
    let q = p0 + 8;
    if (tf & 0x01) q += 8; // base_data_offset
    if (tf & 0x02) q += 4; // sample_description_index
    if (tf & 0x08) q += 4; // default_sample_duration
    const defSize = tf & 0x10 ? frag.readUInt32BE(q) : 0;
    const p = trun.off + trun.hdr;
    const fl = frag.readUInt32BE(p) & 0xffffff;
    const count = frag.readUInt32BE(p + 4);
    let r = p + 8;
    // default-base-is-moof: data_offset counts from the start of the moof.
    let start = dataStart;
    if (fl & 0x001) { start = moof.off + frag.readInt32BE(r); r += 4; }
    if (fl & 0x004) r += 4;
    let len = 0;
    for (let i = 0; i < count && r <= trun.off + trun.size; i++) {
      if (fl & 0x100) r += 4;
      if (fl & 0x200) { len += frag.readUInt32BE(r); r += 4; } else len += defSize;
      if (fl & 0x400) r += 4;
      if (fl & 0x800) r += 4;
    }
    const end = len > 0 ? Math.min(dataEnd, start + len) : dataEnd;
    if (start < dataStart || start >= end) return { start: dataStart, end: dataEnd };
    return { start, end };
  }
  return null;
}

// Keyframe = the sample's NAL units include an IRAP (HEVC types 16–21) or an
// IDR (H.264 type 5). Read from the data itself rather than trusting flags.
function isKeyframe(frag, hevc, vtrack = 1) {
  const range = videoRange(frag, vtrack);
  if (!range) return false;
  let off = range.start;
  const end = range.end;
  while (off + 5 <= end) {
    const len = frag.readUInt32BE(off);
    const nal = frag[off + 4];
    if (hevc) {
      const t = (nal >> 1) & 0x3f;
      if (t >= 16 && t <= 21) return true;
    } else if ((nal & 0x1f) === 5) {
      return true;
    }
    if (len <= 0) break;
    off += 4 + len;
  }
  return false;
}

// ── Relay ────────────────────────────────────────────────────────────────────

function sourceUrl(path) {
  const host = config.streamService.rtspHost || 'localhost';
  const port = config.streamService.rtspPort || 8554;
  return `rtsp://${host}:${port}/${path}`;
}

async function sourceReady(path) {
  try {
    const streaming = require('./drishyamStreaming.service');
    const r = await streaming.api.get(`/v3/paths/get/${path}`, { timeout: 1500 });
    return r.data?.ready === true;
  } catch (_) {
    return false;
  }
}

function send(ws, data) {
  try { ws.send(data); } catch (_) { /* closed */ }
}

function sendInit(relay, ws) {
  const codecs = relay.audio ? `${relay.codec},${AUDIO_CODEC}` : relay.codec;
  send(ws, JSON.stringify({ type: 'init', codec: relay.codec, audio: !!relay.audio, vtrack: relay.vtrack || 1, mime: `video/mp4; codecs="${codecs}"`, path: relay.path }));
  send(ws, relay.init);
  for (const f of relay.gop) send(ws, f);
}

// Paths whose NVR rejected our login: no new attempt until this time. NVRs
// lock an IP out after a handful of failed logins (CLAUDE.md rule 2), and a
// lockout takes every camera of that customer offline.
const AUTH_BLOCK_MS = 10 * 60_000;
const _authBlocked = new Map(); // path → ms
function blockedUntil(path) { return _authBlocked.get(path) || 0; }

async function spawnRelay(relay) {
  if (relay.stopped) return;
  // Where to read from:
  //   • Stream Service already pulling this stream → read it there (no
  //     second NVR session).
  //   • Otherwise straight from the NVR (one session either way): the NVR
  //     starts each session on a keyframe, so the first frame is here in
  //     ~1.5–2 s. Read behind Stream Service, that keyframe is gone before
  //     we attach and we'd wait a full camera GOP (3.3 s) for the next.
  //   • *_h264 sidecars are always read from Stream Service.
  let input = sourceUrl(relay.path);
  relay.direct = false;
  if (!relay.path.endsWith('_h264') && !(await sourceReady(relay.path))) {
    // A new NVR session: same per-NVR pacing as the transcoders (bursts trip
    // the customer's network block).
    relay.paceTicket = {};
    await transcoder.paceNvrOpen(relay.monitorId, {
      priority: relay.variant === 'main' ? transcoder.OPEN_PRIORITY.main
        : (relay.viewers.size || relay.wanted) ? transcoder.OPEN_PRIORITY.view : transcoder.OPEN_PRIORITY.warm,
      ticket: relay.paceTicket,
    });
    relay.paceTicket = null;
    if (relay.nvrUrl) { input = relay.nvrUrl; relay.direct = true; }
  }
  if (relay.stopped) return;
  // Live view carries the camera's audio as AAC. NVR playback (once) stays
  // video only: its player has no sound control and is always muted.
  const audio = AUDIO_ON && !relay.once;
  const args = [
    '-hide_banner', '-loglevel', process.env.RELAY_TRACE ? 'debug' : 'error', '-nostdin',
    '-rtsp_transport', 'tcp',
    // Ride out network pauses (seen up to ~12 s on remote NVR links) rather
    // than tearing the session down; same reasoning as Stream Service's
    // readTimeout.
    '-timeout', '30000000',
    // NOT +nobuffer: it throws away the packets read while probing — which
    // hold the NVR's opening keyframe — so a stream copy then waits a whole
    // camera GOP (3.3 s) for the next one. Traced 2026-10-20: header ready
    // at 0.26 s, first frame out at 5.4 s.
    '-fflags', '+genpts', '-flags', 'low_delay',
    // Probe only until the codec parameters are known (no frame-rate
    // analysis), but allow up to a camera GOP for them: read mid-GOP from
    // Stream Service they only come with the next keyframe.
    '-probesize', process.env.RELAY_PROBESIZE || '2000000', '-analyzeduration', relay.direct ? (process.env.RELAY_ANALYZE_DIRECT_US || '1000000') : '4000000', '-fpsprobesize', '0',
    '-i', input,
    '-map', '0:v:0', '-c:v', 'copy',
    // `?`: a camera without audio just has none.
    ...(audio ? [
      '-map', '0:a:0?', '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-b:a', '64k',
      // Don't hold video back more than 1 s waiting for audio.
      '-max_interleave_delta', '1000000',
    ] : []),
    '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_every_frame',
    '-flush_packets', '1',
    'pipe:1',
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  relay.proc = proc;
  relay.startedAt = Date.now();
  relay.init = null;
  relay.gop = [];
  let buf = Buffer.alloc(0);
  let initParts = [];
  let pendingMoof = null;
  let err = '';

  proc.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    while (buf.length - off >= 8) {
      let size = buf.readUInt32BE(off);
      if (size === 1) {
        if (buf.length - off < 16) break;
        size = Number(buf.readBigUInt64BE(off + 8));
      }
      if (size < 8 || buf.length - off < size) break;
      const box = buf.subarray(off, off + size);
      const type = box.toString('latin1', 4, 8);
      off += size;
      if (!relay.init) {
        if (type === 'moof') {
          relay.init = Buffer.concat(initParts);
          initParts = [];
          relay.codec = codecFromInit(relay.init);
          if (relay.codec) _codecSeen.set(relay.path, relay.codec);
          relay.hevc = !!relay.codec && /^(hvc1|hev1)/.test(relay.codec);
          relay.audio = relay.init.includes(Buffer.from('mp4a'));
          relay.vtrack = videoTrackId(relay.init);
          relay.firstInitAt = relay.firstInitAt || Date.now();
          logger.info('liveRelay: init', { path: relay.path, codec: relay.codec, direct: relay.direct, ms: Date.now() - relay.startedAt });
          for (const ws of relay.viewers) {
            if (relay.restarts > 0) send(ws, JSON.stringify({ type: 'reset' }));
            sendInit(relay, ws);
          }
          pendingMoof = Buffer.from(box);
        } else {
          initParts.push(Buffer.from(box));
        }
        continue;
      }
      if (type === 'moof') { pendingMoof = Buffer.from(box); continue; }
      if (type === 'mdat' && pendingMoof) {
        const frag = Buffer.concat([pendingMoof, box]);
        pendingMoof = null;
        onFragment(relay, frag);
      }
    }
    buf = off ? buf.subarray(off) : buf;
  });
  proc.stderr.on('data', (c) => {
    err = (err + c.toString()).slice(-2000);
    if (process.env.RELAY_TRACE) {
      for (const line of c.toString().split('\n')) {
        if (/DESCRIBE|SETUP|PLAY|Input #0|Output #0|SDP|HTTP\/|RTSP\/1.0 \d/.test(line)) {
          logger.info('liveRelay trace', { path: relay.path, t: Date.now() - relay.startedAt, line: line.replace(/rtsp:\/\/[^@\s/]*@/g, 'rtsp://***@').slice(0, 140) });
        }
      }
    }
  });
  proc.on('exit', (code) => {
    if (relay.proc !== proc) return;
    relay.proc = null;
    if (relay.stopped) return;
    if (relay.direct && /401|Unauthorized|403|Forbidden/i.test(err)) {
      // Login rejected: stop, and don't try this camera again for a while.
      _authBlocked.set(relay.path, Date.now() + AUTH_BLOCK_MS);
      logger.error('liveRelay: NVR rejected login — not retrying', { path: relay.path, monitorId: relay.monitorId, retryAfterMs: AUTH_BLOCK_MS });
      stopRelay(relay.path);
      return;
    }
    const ran = Date.now() - relay.startedAt;
    relay.restarts = (relay.restarts || 0) + 1;
    // A transcoded sidecar that hasn't published yet 404s at once: retry fast
    // while ffmpeg starts (no NVR session is opened by retrying it).
    // Only while that sidecar's ffmpeg is actually running/starting: rejected at
    // capacity it will not appear, and 0.5 s retries would just spin.
    const sidecarWait = relay.path.endsWith('_h264') && !relay.firstInitAt && relay.restarts < 60
      && transcoder.isRunning(relay.monitorId, relay.path.endsWith('_sub_h264') ? 'sub' : 'main');
    // Codec parameters not seen within the probe (connected mid-stream): the
    // session itself is fine, try again at once.
    const headerOnly = ran < 3000 && /Could not write header/.test(err) && relay.restarts < 5;
    // The NVR closed the connection at once (a lockout looks like this): back
    // off further, up to a minute. Several sessions failing together would
    // otherwise knock on it every second for as long as it lasts.
    const refused = relay.direct && ran < 3000 && /Invalid data|Connection reset|Connection refused/.test(err);
    if (ran > 30_000) relay.restarts = 1;
    const delay = sidecarWait ? 500 : headerOnly ? 300
      : ran > 30_000 ? 1000
        : refused ? Math.min(60_000, 1000 * 2 ** Math.min(relay.restarts, 6))
          : Math.min(15_000, 1000 * 2 ** Math.min(relay.restarts, 4));
    const msg = relay.killReason
      || err.trim().split('\n').slice(-2).join(' | ').replace(/rtsp:\/\/[^@\s/]*@/g, 'rtsp://***@');
    relay.killReason = null;
    // A one-shot replay (NVR playback) is over when its source ends: the range
    // is done, or the NVR had nothing. Never restart it from the beginning.
    if (relay.once) {
      logger.info('liveRelay: replay ended', { path: relay.path, ranMs: ran, error: code ? msg : undefined });
      stopRelay(relay.path);
      return;
    }
    logger.warn('liveRelay: source ended, restarting', { path: relay.path, direct: relay.direct, code, ranMs: ran, delay, error: msg });
    setTimeout(() => { if (!relay.stopped) spawnRelay(relay).catch(() => {}); }, delay);
  });
}

function onFragment(relay, frag) {
  const key = isKeyframe(frag, relay.hevc, relay.vtrack || 1);
  if (key) relay.gop = [frag];
  else if (relay.gop.length && relay.gop.length < MAX_GOP_FRAMES) relay.gop.push(frag);
  relay.lastFrameAt = Date.now();
  for (const ws of relay.viewers) {
    if (ws.bufferedAmount > SLOW_BYTES) { ws._relaySkip = true; continue; }
    if (ws._relaySkip) {
      if (!key) continue;
      ws._relaySkip = false;
    }
    send(ws, frag);
  }
}

function sharedPath(path, nvrUrl) {
  if (!nvrUrl) return path;
  const owner = _bySource.get(nvrUrl);
  if (owner && owner !== path && _relays.has(owner)) {
    _aliasOf.set(path, owner);
    return owner;
  }
  _bySource.set(nvrUrl, path);
  _aliasOf.delete(path);
  return path;
}

function getRelay(requestedPath, { monitorId, variant, nvrUrl = null, wanted = false, once = false }) {
  const path = once ? requestedPath : sharedPath(requestedPath, nvrUrl);
  let relay = _relays.get(path);
  if (relay && nvrUrl && !relay.nvrUrl) relay.nvrUrl = nvrUrl;
  if (relay && wanted) {
    // A viewer is on its way: promote an open still queued as warm-up.
    relay.wanted = true;
    relay.paceTicket?.bump?.(variant === 'main' ? transcoder.OPEN_PRIORITY.main : transcoder.OPEN_PRIORITY.view);
  }
  if (!relay) {
    if (blockedUntil(path) > Date.now()) {
      relay = { path, monitorId, variant, nvrUrl, wanted, viewers: new Set(), gop: [], init: null, codec: null, proc: null, pinnedUntil: 0, idleTimer: null, stopped: true, restarts: 0 };
      return relay; // login rejected recently: don't knock again (see spawnRelay)
    }
    relay = { path, monitorId, variant, nvrUrl, wanted, once, viewers: new Set(), gop: [], init: null, codec: null, proc: null, pinnedUntil: 0, idleTimer: null, stopped: false, restarts: 0 };
    _relays.set(path, relay);
    spawnRelay(relay).catch((err) => logger.error('liveRelay: spawn failed', { path, error: err.message }));
  }
  touchIdle(relay);
  return relay;
}

function touchIdle(relay) {
  if (relay.idleTimer) { clearTimeout(relay.idleTimer); relay.idleTimer = null; }
  if (relay.viewers.size) return;
  const wait = Math.max(IDLE_MS, relay.pinnedUntil - Date.now());
  relay.idleTimer = setTimeout(() => {
    if (relay.viewers.size || relay.pinnedUntil > Date.now()) return touchIdle(relay);
    stopRelay(relay.path);
  }, wait);
  if (relay.idleTimer.unref) relay.idleTimer.unref();
}

function stopRelay(path) {
  const relay = _relays.get(path);
  if (!relay) return false;
  relay.stopped = true;
  if (relay.idleTimer) clearTimeout(relay.idleTimer);
  _relays.delete(path);
  if (relay.nvrUrl && _bySource.get(relay.nvrUrl) === path) _bySource.delete(relay.nvrUrl);
  try { relay.proc?.kill('SIGKILL'); } catch (_) {}
  for (const ws of relay.viewers) { try { ws.close(1001, 'relay stopped'); } catch (_) {} }
  logger.info('liveRelay: stopped', { path });
  return true;
}

/** Keep a relay running with no viewers until `untilMs` (warm-keeper). */
function pin(path, opts, untilMs) {
  const relay = getRelay(path, opts);
  relay.pinnedUntil = Math.max(relay.pinnedUntil, untilMs);
  touchIdle(relay);
}

// Codec seen on each path, kept across relay restarts (warm-keeper uses it to
// skip the H.264 sidecar for cameras that are H.264 already).
const _codecSeen = new Map();
function codecOf(requested) {
  const path = _aliasOf.get(requested) || requested;
  return _relays.get(path)?.codec || _codecSeen.get(path) || _codecSeen.get(requested) || null;
}

function nvrHost(url) {
  try { return new URL(url).hostname; } catch (_) { return null; }
}

/** Relays reading directly from this NVR, across all accounts. */
function sessionsOnHost(host) {
  let n = 0;
  for (const r of _relays.values()) if (r.nvrUrl && nvrHost(r.nvrUrl) === host) n++;
  return n;
}

function hasSource(nvrUrl) {
  const owner = _bySource.get(nvrUrl);
  return !!owner && _relays.has(owner);
}

function viewerCount(path) {
  return _relays.get(path)?.viewers.size || 0;
}

/** Stop a relay nobody is watching (pins dropped). False if it has viewers. */
function releaseIfIdle(path) {
  const r = _relays.get(path);
  if (!r) return false;
  if (r.viewers.size) return false;
  return stopRelay(path);
}

function isRunning(path) {
  const r = _relays.get(path);
  return !!(r && !r.stopped);
}

// ── Viewers / tickets ────────────────────────────────────────────────────────

function issueTicket({ userId, monitorId, path, variant, nvrUrl = null, once = false }) {
  const ticket = crypto.randomBytes(18).toString('base64url');
  // Start (or keep) the relay now, so it warms up while the socket connects.
  const relay = getRelay(path, { monitorId, variant, nvrUrl, wanted: true, once });
  _tickets.set(ticket, { userId, monitorId, path: relay.path, variant, nvrUrl, expires: Date.now() + TICKET_MS });
  return ticket;
}

function redeemTicket(ticket) {
  const t = _tickets.get(ticket);
  _tickets.delete(ticket);
  if (!t || t.expires < Date.now()) return null;
  return t;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of _tickets) if (t.expires < now) _tickets.delete(k);
}, 60_000).unref?.();

/** Kill relays whose source went silent; the exit handler restarts them. */
function sweepStalled(now = Date.now()) {
  for (const relay of _relays.values()) {
    const proc = relay.proc;
    if (!proc || relay.stopped || relay.once || relay.killReason) continue;
    let reason = null;
    if (!relay.init) {
      if (now - relay.startedAt > NO_INIT_MS) reason = `no video ${Math.round((now - relay.startedAt) / 1000)} s after start (watchdog)`;
    } else {
      const since = Math.max(relay.lastFrameAt || 0, relay.startedAt);
      if (now - since > STALL_MS) reason = `no video for ${Math.round((now - since) / 1000)} s while connected (watchdog)`;
    }
    if (!reason) continue;
    relay.killReason = reason;
    try { proc.kill('SIGKILL'); } catch (_) { relay.killReason = null; }
  }
}
setInterval(() => sweepStalled(), 2000).unref?.();

function addViewer(ws, { path, monitorId, variant }) {
  const relay = getRelay(path, { monitorId, variant, wanted: true });
  relay.viewers.add(ws);
  touchIdle(relay);
  if (relay.init) sendInit(relay, ws);
  ws.on('close', () => {
    relay.viewers.delete(ws);
    touchIdle(relay);
  });
}

/**
 * Attach the WebSocket endpoint to the HTTP server:
 *   ws(s)://<api>/api/stream/live?ticket=<one-time ticket>
 * Tickets come from POST /api/stream/live/:monitorId/ticket (authenticated).
 */
function attach(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { return; }
    if (url.pathname !== '/api/stream/live') return; // socket.io handles its own path
    const t = redeemTicket(url.searchParams.get('ticket') || '');
    if (!t) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => addViewer(ws, t));
  });
  logger.info('liveRelay: WebSocket endpoint at /api/stream/live');
}

function stats() {
  return [..._relays.values()].map((r) => ({
    path: r.path, codec: r.codec, viewers: r.viewers.size, gopFrames: r.gop.length,
    running: !!r.proc, restarts: r.restarts, pinned: r.pinnedUntil > Date.now(),
    lastFrameAgoMs: r.lastFrameAt ? Date.now() - r.lastFrameAt : null,
  }));
}

module.exports = { attach, issueTicket, pin, isRunning, stopRelay, stats, viewerCount, releaseIfIdle, codecOf, sessionsOnHost, hasSource, _internals: { codecFromInit, isKeyframe, findBox, sweepStalled, relays: _relays } };
