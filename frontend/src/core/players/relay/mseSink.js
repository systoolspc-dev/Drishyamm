/**
 * MSE sink: plays a liveRelay stream (fragmented MP4, one fragment per frame)
 * in a <video> element through Media Source Extensions — the browser's own,
 * usually hardware, decoder. H.265 included wherever the device has one.
 *
 * Live edge: the first append is init + the server's GOP cache (keyframe and
 * every frame since); we then seek to the newest frame, so the picture is
 * current as soon as it appears instead of replaying up to 3 s of GOP. After
 * that, a lag over LAG_SPEEDUP plays slightly fast, over LAG_JUMP jumps.
 */
const MSE = typeof window !== 'undefined' ? (window.ManagedMediaSource || window.MediaSource) : null;

const LAG_TARGET  = 0.15;   // s behind the newest frame we aim for
const LAG_SPEEDUP = 0.6;
const LAG_JUMP    = 2.0;
const KEEP_BEHIND = 8;      // s of played video kept in the buffer
// Frames keep arriving but the playable range stops growing: one track (the
// audio, say) has stopped while the other goes on, and MediaSource only plays
// where both are buffered. Reported as an error so the player can fall back.
const STALL_MS    = 6000;

// play(), and if the browser refuses sound without a click, play muted
// instead of not at all.
export function playSafe(video) {
  const p = video.play();
  if (!p || !p.catch) return;
  p.catch((err) => {
    if (err?.name === 'NotAllowedError' && !video.muted) {
      video.muted = true;
      video.dispatchEvent(new Event('autoplay-muted'));
      video.play().catch(() => {});
    }
  });
}

export function createMseSink(video, { onFirstFrame, onError } = {}) {
  let ms = null;
  let sb = null;
  let url = null;
  let queue = [];
  let mime = null;
  let destroyed = false;
  let started = false;
  let tick = null;
  let lastTrim = 0;
  let waitKey = false;
  let lastEnd = 0;
  let lastGrowAt = 0;
  let appended = 0;
  let stallReported = false;

  function teardown() {
    if (tick) { clearInterval(tick); tick = null; }
    queue = [];
    sb = null;
    if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } url = null; }
    if (ms && ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* ignore */ } }
    ms = null;
    started = false;
  }

  function pump() {
    if (!sb || sb.updating || !queue.length || destroyed) return;
    const next = queue.length > 1 && !started ? concat(queue.splice(0)) : queue.shift();
    try {
      sb.appendBuffer(next);
    } catch (err) {
      if (err?.name === 'QuotaExceededError') {
        queue.unshift(next);
        trim(true);
      } else {
        onError?.(err?.message || 'append failed');
      }
    }
  }

  function trim(force) {
    if (!sb || sb.updating || !video.buffered.length) return;
    const now = performance.now();
    if (!force && now - lastTrim < 5000) return;
    lastTrim = now;
    const start = video.buffered.start(0);
    const cut = video.currentTime - KEEP_BEHIND;
    if (cut > start + 1) { try { sb.remove(start, cut); } catch { /* ignore */ } }
  }

  function edge() {
    const b = video.buffered;
    return b.length ? b.end(b.length - 1) : null;
  }

  function keepLive() {
    if (video.dataset.userPaused === '1') return; // the user paused this tile
    const end = edge();
    if (end == null) return;
    const now = performance.now();
    if (end > lastEnd + 0.01) { lastEnd = end; lastGrowAt = now; stallReported = false; }
    else if (lastGrowAt && now - lastGrowAt > STALL_MS && appended > 0 && !stallReported) {
      stallReported = true;
      onError?.('stalled');
    }
    appended = 0;
    const lag = end - video.currentTime;
    if (lag > LAG_JUMP || video.currentTime < video.buffered.start(video.buffered.length - 1)) {
      video.currentTime = Math.max(end - LAG_TARGET, 0);
      video.playbackRate = 1;
    } else if (lag > LAG_SPEEDUP) {
      video.playbackRate = 1.15;
    } else if (lag < LAG_TARGET * 2) {
      video.playbackRate = 1;
    }
    if (video.paused) playSafe(video);
    trim(false);
  }

  function onUpdateEnd() {
    if (!started && edge() != null) {
      started = true;
      video.currentTime = Math.max(edge() - LAG_TARGET, 0);
      lastEnd = edge(); lastGrowAt = performance.now();
      playSafe(video);
      const done = () => { if (!destroyed) onFirstFrame?.(); };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(done);
      else video.addEventListener('playing', done, { once: true });
      tick = setInterval(keepLive, 500);
    }
    pump();
  }

  const sink = {
    init(meta, initU8, gop) {
      if (destroyed) return;
      teardown();
      mime = meta.mime;
      ms = new MSE();
      if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) video.disableRemotePlayback = true;
      url = URL.createObjectURL(ms);
      video.removeAttribute('src');
      video.srcObject = null;
      video.src = url;
      queue = [initU8, ...gop];
      ms.addEventListener('sourceopen', () => {
        if (destroyed || !ms) return;
        try {
          sb = ms.addSourceBuffer(mime);
          sb.mode = 'segments';
          sb.addEventListener('updateend', onUpdateEnd);
          sb.addEventListener('error', () => onError?.('decode error'));
          pump();
        } catch (err) {
          onError?.(err?.message || 'unsupported codec');
        }
      }, { once: true });
    },
    frame(u8, key) {
      if (destroyed || !ms) return;
      // Backlog (tab in the background, slow decoder): drop whole GOPs, never
      // single frames — a decoder fed a frame without its references shows
      // garbage. keepLive() then jumps over the gap.
      if (waitKey && !key) return;
      waitKey = false;
      appended++;
      if (queue.length > 400) { queue = []; waitKey = !key; if (waitKey) return; }
      queue.push(u8);
      pump();
    },
    reset() { teardown(); },
    error(msg, attempt) { if (attempt > 2) onError?.(msg); },
    destroy() {
      destroyed = true;
      teardown();
      try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    },
  };
  return sink;
}

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
