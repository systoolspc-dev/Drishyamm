import { create } from 'zustand';

/**
 * Toast store — the one queue behind every transient notification in the
 * console. AIToastHost renders it; anything can write to it:
 *
 *   import { toast } from '@/core/store/toastStore';
 *   toast.error('Boost failed', 'Camera group not resolved yet');
 *   toast.success('Keyframe requested');
 *   toast.push({ kind: 'camera', tone: 'danger', title: 'Gate 2', ... });
 *
 * A toast is ephemeral and never the record: anything that should survive
 * the auto-dismiss is ALSO written to notificationStore (the bell) by the
 * caller. This store only decides what is on screen right now.
 *
 * Card shape (see AIToastHost for how each part is drawn):
 *   { id?, kind: 'ai'|'camera'|'system', tone: 'danger'|'warning'|'success'|'neutral',
 *     eyebrow, title, chips?: string[], foot?: { icon: 'alert'|'camera'|'info'|'check', text },
 *     detail?  (plain text — becomes the footer when no `foot` is given),
 *     to, action, ttl, groupKey?, merge?, live?: 'polite'|'assertive', data? }
 *
 * Two things make it more than an array:
 *
 *   groupKey  — a toast with a groupKey REPLACES a visible toast carrying the
 *               same key instead of stacking beside it ("Live updates paused"
 *               becomes "Live updates restored"; a camera that flaps updates
 *               its own card rather than growing a column).
 *   merge     — when a toast with a groupKey lands on an existing one, an
 *               optional merge(prev, next) can fold them into one card. Camera
 *               offline uses this: an NVR dropping 17 cameras at once shows as
 *               "17 cameras went offline", not 17 cards.
 */

/** Auto-dismiss windows. `0` means sticky until dismissed or replaced. */
export const TOAST_TTL = {
  critical: 10_000,   // a HIGH alert — long enough to glance back at
  warning:   7_000,
  offline:  15_000,   // an offline camera matters — let it linger
  online:    6_000,
  system:    8_000,
  error:    10_000,
  sticky:        0,
};

/** Cards are tall (chips + footer), so three is the most a laptop can stack. */
export const MAX_VISIBLE = 3;

/** How long after the first camera drop later drops fold into the same card. */
export const CAMERA_MERGE_WINDOW_MS = 12_000;

/** Human wording for the supervisor's offline reason codes — shown when the
 *  socket payload carries only the code. Mirrors offlineReason() in
 *  streamSupervisor.service.js. */
export const OFFLINE_REASON_TEXT = {
  flapping:        'Unstable connection — dropping repeatedly, backing off',
  nvr_unreachable: 'Recorder / NVR unreachable — site link or NVR appears down',
  stream_stopped:  'Stream not running — reconnecting',
  no_video:        'Reachable, but no video — check camera power and cabling',
};

export function offlineReasonText(reason, reasonCode) {
  if (reason && !/^[a-z_]+$/.test(String(reason))) return String(reason);
  return OFFLINE_REASON_TEXT[reasonCode || reason] || 'No video — check power, network or NVR';
}

/** The same reasons at footer length, for a card that lists several cameras. */
export const OFFLINE_REASON_SHORT = {
  flapping:        'Unstable connection',
  nvr_unreachable: 'NVR unreachable',
  stream_stopped:  'Stream not running',
  no_video:        'No video signal',
};

export function offlineReasonShort(reason, reasonCode) {
  const code = reasonCode || (/^[a-z_]+$/.test(String(reason || '')) ? reason : null);
  return OFFLINE_REASON_SHORT[code] || (reason ? String(reason) : 'No video');
}

let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(++seq).toString(36)}`;

export const useToastStore = create((set, get) => ({
  toasts: [],

  /** Add a toast. Returns its id. */
  push: (input) => {
    const now = Date.now();
    const item = { id: input.id || nextId(), at: now, ttl: TOAST_TTL.system, tone: 'neutral', ...input };
    set((s) => {
      const list = s.toasts.slice();
      if (item.groupKey) {
        const i = list.findIndex((t) => t.groupKey === item.groupKey && !t.leaving);
        if (i >= 0) {
          const prev = list[i];
          const merged = typeof item.merge === 'function' ? item.merge(prev, item) : null;
          // Replacement keeps the slot so the card updates in place rather than
          // jumping to the end of the stack; `at` resets so the timer restarts.
          list[i] = { ...(merged || item), id: prev.id, at: now, leaving: false };
          return { toasts: list };
        }
      }
      list.push(item);
      // Cap the queue: the oldest card leaves to make room. It is in the bell
      // already, and a card nobody can see must not sit off-screen on a timer.
      const live = list.filter((t) => !t.leaving);
      for (let n = live.length - MAX_VISIBLE, k = 0; n > 0; n--, k++) {
        const idx = list.indexOf(live[k]);
        list[idx] = { ...list[idx], leaving: true };
      }
      return { toasts: list };
    });
    return item.id;
  },

  /** Begin the leave animation; the host removes the node when it ends. */
  dismiss: (id) => set((s) => ({
    toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
  })),

  /** Drop immediately (after the leave animation, or on unmount). */
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  /** Dismiss the newest visible toast — bound to Escape. */
  dismissNewest: () => {
    const live = get().toasts.filter((t) => !t.leaving);
    const last = live[live.length - 1];
    if (last) get().dismiss(last.id);
  },

  clear: () => set({ toasts: [] }),
}));

// ── Camera name chips ─────────────────────────────────────────────────────────

/**
 * Names for the chips on a multi-camera card. When every camera shares the
 * same leading word ("Camera WorkStation 2", "Camera Support", …) that word is
 * dropped — it is the site's naming habit, not information — but never so far
 * that a name becomes a bare number ("Camera 1" stays "Camera 1").
 */
export function chipNames(cameras) {
  const names = cameras.map((c) => String(c.name || 'Unnamed camera').trim());
  if (names.length < 2) return names;
  const first = names[0].split(/\s+/)[0];
  const shared = first.length >= 3 && names.every((n) => n.split(/\s+/)[0].toLowerCase() === first.toLowerCase() && n.split(/\s+/).length > 1);
  if (!shared) return names;
  const stripped = names.map((n) => n.split(/\s+/).slice(1).join(' '));
  return stripped.every((n) => /[a-z]/i.test(n)) ? stripped : names;
}

/** Plain-text list for places without chips (the bell, an email). */
export function cameraListText(cameras, max = 3) {
  const names = cameras.map((c) => c.name);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

/**
 * Fold a second camera-status toast into the first when it lands inside the
 * merge window — used for both "went offline" and "back online" cards.
 * `data.cameras` accumulates; the title becomes a count, the names become
 * chips, and an offline reason is kept only while every camera shares it.
 * Returns null once the window has passed, which tells the store to replace
 * the card instead.
 */
export function mergeCameraStatus(prev, next) {
  if (Date.now() - prev.at > CAMERA_MERGE_WINDOW_MS) return null;
  const all = [...(prev.data?.cameras || []), ...(next.data?.cameras || [])];
  const seen = new Set();
  const cameras = all.filter((c) => (seen.has(c.monitorId) ? false : (seen.add(c.monitorId), true)));
  if (cameras.length === 1) return { ...next, data: { cameras } };

  const back = next.tone === 'success';
  const codes = new Set(cameras.map((c) => c.reasonCode || c.reason || ''));
  const shared = codes.size === 1 ? cameras[0] : null;
  return {
    ...next,
    title: `${cameras.length} cameras ${back ? 'back online' : 'went offline'}`,
    chips: chipNames(cameras),
    foot: back
      ? { icon: 'check', text: 'Streaming again' }
      : { icon: 'alert', text: shared ? offlineReasonShort(shared.reason, shared.reasonCode) : 'Different reasons — see Camera status' },
    data: { cameras },
  };
}

/** @deprecated use mergeCameraStatus */
export const mergeCameraOffline = mergeCameraStatus;

// ── Imperative API for pages ──────────────────────────────────────────────────

const SYSTEM_EYEBROW = { danger: 'Error', warning: 'Attention', success: 'Done', neutral: 'Info' };
const SYSTEM_FOOT = { danger: 'alert', warning: 'alert', success: 'check', neutral: 'info' };

const system = (tone, title, detail, opts = {}) => useToastStore.getState().push({
  kind: 'system', tone, title,
  eyebrow: SYSTEM_EYEBROW[tone],
  foot: detail ? { icon: SYSTEM_FOOT[tone], text: detail } : undefined,
  ttl: opts.ttl ?? (tone === 'danger' ? TOAST_TTL.error : TOAST_TTL.system),
  ...opts,
});

export const toast = {
  push:    (item) => useToastStore.getState().push(item),
  dismiss: (id) => useToastStore.getState().dismiss(id),
  error:   (title, detail, opts) => system('danger',  title, detail, opts),
  warn:    (title, detail, opts) => system('warning', title, detail, opts),
  success: (title, detail, opts) => system('success', title, detail, { ttl: 4_000, ...opts }),
  info:    (title, detail, opts) => system('neutral', title, detail, opts),
};

export default toast;

// Dev only: lets a browser session (or a screenshot script) raise cards
// without waiting for a real camera to drop — `__drishyamToast.toast.error(…)`.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  window.__drishyamToast = { toast, store: useToastStore, mergeCameraStatus, offlineReasonText, offlineReasonShort, chipNames };
}
