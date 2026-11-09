/**
 * liveRelay — the browser end of the backend live relay
 * (backend/src/services/liveRelay.service.js).
 *
 * One WebSocket per camera + variant per tab, shared by every player that
 * shows it (a tile and its fullscreen, say) and kept for GRACE_MS after the
 * last one leaves, so page flips and remounts reuse it.
 *
 * The socket carries the camera's own stream as fragmented MP4: an init
 * segment, the frames since the last keyframe (the server's GOP cache), then
 * live frames. A connection keeps the same cache, so a second player in this
 * tab also starts at once.
 *
 * H.265 the browser can't decode: the first init tells us the codec; if
 * MediaSource refuses it we reconnect asking the server for the H.264 sidecar
 * (transcode=1) and remember that per camera, so the next load goes straight
 * there.
 */
import api from '@/core/services/api';
import { API_BASE } from '@/core/config/endpoints';
import { canDecodeHevc } from '@/core/services/codecSupport';

const GRACE_MS = 10_000;
const conns = new Map(); // key → connection

const MSE = typeof window !== 'undefined' ? (window.ManagedMediaSource || window.MediaSource) : null;

export function relaySupported() {
  return !!(MSE && typeof WebSocket !== 'undefined');
}

export function mimeSupported(mime) {
  try { return !!(MSE && MSE.isTypeSupported(mime)); } catch { return false; }
}

// Per camera+variant: needs the H.264 sidecar on this device (learned once).
const memoKey = (id, variant) => `relay.transcode.${id}.${variant}`;
function needsTranscode(id, variant) {
  const forced = forcedDecoder();
  if (forced === 'transcode') return true;
  if (forced === 'native') return false;
  try { return localStorage.getItem(memoKey(id, variant)) === '1'; } catch { return false; }
}
function rememberTranscode(id, variant, yes) {
  try { if (yes) localStorage.setItem(memoKey(id, variant), '1'); else localStorage.removeItem(memoKey(id, variant)); } catch { /* storage off */ }
}

/** `?decoder=native|transcode|webrtc` in the page URL overrides the choice (testing). */
export function forcedDecoder() {
  try { return new URLSearchParams(window.location.search).get('decoder'); } catch { return null; }
}

// Keyframe test on a moof+mdat fragment (same rule as the server). Only the
// video track's data is read: audio frames (AAC) come as fragments of their
// own and are never keyframes.
function boxAt(u8, dv, type, start, end) {
  let off = start;
  while (off + 8 <= end) {
    const size = dv.getUint32(off);
    if (size < 8) return null;
    if (u8[off + 4] === type.charCodeAt(0) && u8[off + 5] === type.charCodeAt(1)
      && u8[off + 6] === type.charCodeAt(2) && u8[off + 7] === type.charCodeAt(3)) return { off, size };
    off += size;
  }
  return null;
}

function videoRange(u8, dv, vtrack) {
  const moof = boxAt(u8, dv, 'moof', 0, u8.length);
  const mdat = boxAt(u8, dv, 'mdat', 0, u8.length);
  if (!moof || !mdat) return null;
  const dataStart = mdat.off + 8;
  const dataEnd = mdat.off + mdat.size;
  const mEnd = moof.off + moof.size;
  for (let off = moof.off + 8, traf; (traf = boxAt(u8, dv, 'traf', off, mEnd)); off = traf.off + traf.size) {
    const tEnd = traf.off + traf.size;
    const tfhd = boxAt(u8, dv, 'tfhd', traf.off + 8, tEnd);
    if (!tfhd || dv.getUint32(tfhd.off + 12) !== vtrack) continue;
    const trun = boxAt(u8, dv, 'trun', traf.off + 8, tEnd);
    if (!trun) return { start: dataStart, end: dataEnd };
    const tf = dv.getUint32(tfhd.off + 8) & 0xffffff;
    let q = tfhd.off + 16;
    if (tf & 0x01) q += 8;
    if (tf & 0x02) q += 4;
    if (tf & 0x08) q += 4;
    const defSize = tf & 0x10 ? dv.getUint32(q) : 0;
    const fl = dv.getUint32(trun.off + 8) & 0xffffff;
    const count = dv.getUint32(trun.off + 12);
    let r = trun.off + 16;
    let start = dataStart;
    if (fl & 0x001) { start = moof.off + dv.getInt32(r); r += 4; }
    if (fl & 0x004) r += 4;
    let len = 0;
    for (let i = 0; i < count && r <= trun.off + trun.size; i++) {
      if (fl & 0x100) r += 4;
      if (fl & 0x200) { len += dv.getUint32(r); r += 4; } else len += defSize;
      if (fl & 0x400) r += 4;
      if (fl & 0x800) r += 4;
    }
    const end = len > 0 ? Math.min(dataEnd, start + len) : dataEnd;
    if (start < dataStart || start >= end) return { start: dataStart, end: dataEnd };
    return { start, end };
  }
  return null;
}

function isKeyframe(u8, hevc, vtrack = 1) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const range = videoRange(u8, dv, vtrack);
  if (!range) return false;
  let p = range.start;
  while (p + 5 <= range.end) {
    const len = dv.getUint32(p);
    const nal = u8[p + 4];
    if (hevc ? (((nal >> 1) & 0x3f) >= 16 && ((nal >> 1) & 0x3f) <= 21) : (nal & 0x1f) === 5) return true;
    if (len <= 0) break;
    p += 4 + len;
  }
  return false;
}

function makeConn(monitorId, variant) {
  const c = {
    key: `${monitorId}|${variant}`,
    monitorId, variant,
    transcode: needsTranscode(monitorId, variant),
    ws: null, meta: null, init: null, gop: [], hevc: false,
    sinks: new Set(), refCount: 0, closeTimer: null, retry: 0, closed: false,
    error: null,
  };
  open(c);
  return c;
}

async function open(c) {
  if (c.closed) return;
  let ticket;
  try {
    const { data } = await api.post(`/stream/live/${encodeURIComponent(c.monitorId)}/ticket`, {}, {
      params: { variant: c.variant, transcode: c.transcode ? '1' : '0', hevc: canDecodeHevc() ? '1' : '0' },
    });
    ticket = data.ticket;
    if (data.transcode && !c.transcode) { c.transcode = true; rememberTranscode(c.monitorId, c.variant, true); }
  } catch (err) {
    return retryLater(c, err?.response?.data?.message || err.message);
  }
  if (c.closed) return;
  const wsBase = /^https?:/.test(API_BASE)
    ? API_BASE.replace(/^http/, 'ws')
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${API_BASE}`;
  // `cam` is for routing only (the backend reads just `ticket`): with several
  // backend replicas, nginx hashes on it so the socket reaches the replica that
  // issued the ticket and runs this camera's relay (deploy/nginx/nginx.conf).
  const ws = new WebSocket(`${wsBase}/api/stream/live?ticket=${encodeURIComponent(ticket)}&cam=${encodeURIComponent(c.monitorId)}`);
  ws.binaryType = 'arraybuffer';
  c.ws = ws;
  let expectInit = false;
  ws.onmessage = (e) => {
    if (c.ws !== ws) return;
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'reset') { c.init = null; c.gop = []; for (const s of c.sinks) s.reset?.(); }
      if (msg.type === 'init') {
        // Can this device decode what the camera sends? If not, ask for the
        // H.264 sidecar instead and remember it for this camera.
        if (!c.transcode && !mimeSupported(msg.mime)) {
          rememberTranscode(c.monitorId, c.variant, true);
          c.transcode = true;
          ws.close();
          return;
        }
        c.meta = msg;
        c.hevc = /^(hvc1|hev1)/.test(msg.codec || '');
        expectInit = true;
      }
      return;
    }
    const u8 = new Uint8Array(e.data);
    if (expectInit) {
      expectInit = false;
      c.init = u8;
      c.gop = [];
      c.retry = 0;
      c.error = null;
      for (const s of c.sinks) s.init(c.meta, u8, []);
      return;
    }
    if (!c.init) return;
    const key = isKeyframe(u8, c.hevc, c.meta?.vtrack || 1);
    if (key) c.gop = [u8];
    else if (c.gop.length && c.gop.length < 1200) c.gop.push(u8); // video + audio fragments
    for (const s of c.sinks) s.frame(u8, key);
  };
  ws.onclose = () => {
    if (c.ws !== ws) return;
    c.ws = null;
    if (!c.closed) retryLater(c, null);
  };
}

function retryLater(c, error) {
  if (c.closed) return;
  c.error = error;
  c.retry++;
  if (error) for (const s of c.sinks) s.error?.(error, c.retry);
  const delay = Math.min(8000, 250 * 2 ** Math.min(c.retry, 5));
  setTimeout(() => open(c), c.transcode && c.retry === 1 ? 0 : delay);
}

function destroy(c) {
  c.closed = true;
  conns.delete(c.key);
  try { c.ws?.close(); } catch { /* closed */ }
}

/**
 * Attach a sink {init(meta, initU8, gopU8[]), frame(u8, isKey), reset(), error(msg, n)}
 * to a camera's stream. Returns an unsubscribe function.
 */
export function subscribe(monitorId, variant, sink) {
  const key = `${monitorId}|${variant}`;
  let c = conns.get(key);
  if (!c) { c = makeConn(monitorId, variant); conns.set(key, c); }
  if (c.closeTimer) { clearTimeout(c.closeTimer); c.closeTimer = null; }
  c.refCount++;
  c.sinks.add(sink);
  if (c.init) sink.init(c.meta, c.init, c.gop.slice());
  return () => {
    c.sinks.delete(sink);
    c.refCount = Math.max(0, c.refCount - 1);
    if (c.refCount === 0) {
      c.closeTimer = setTimeout(() => { if (c.refCount === 0) destroy(c); }, GRACE_MS);
    }
  };
}

/** monitorIds with a player on screen right now (sub or main). */
export function viewedIds() {
  const ids = [];
  for (const c of conns.values()) if (c.refCount > 0 && !ids.includes(c.monitorId)) ids.push(c.monitorId);
  return ids;
}

/** For diagnostics / the bench: which decode path each open stream uses. */
export function inspect() {
  return [...conns.values()].map((c) => ({
    monitorId: c.monitorId, variant: c.variant, transcode: c.transcode,
    codec: c.meta?.codec || null, viewers: c.refCount, open: !!c.ws, gop: c.gop.length,
  }));
}

if (typeof window !== 'undefined') window.__liveRelay = { inspect };
