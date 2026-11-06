import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X, ArrowRight, Check, Cctv, Info, VideoOff, Video, ShieldAlert, UserX, UserCheck, Users, UsersRound,
  LogIn, LogOut, Clock, PackageX, GitBranch, Car, CarFront, Activity, WifiOff, Wifi,
  OctagonAlert, TriangleAlert, CircleCheck,
} from 'lucide-react';
import { on as onSocket, connectSocket, getSocket } from '@/core/services/socket';
import { describe, aiService } from '@/core/services/ai';
import { useAuthStore } from '@/core/store/authStore';
import { useNotificationStore } from '@/core/store/notificationStore';
import {
  useToastStore, toast, TOAST_TTL, MAX_VISIBLE, mergeCameraStatus, offlineReasonText,
} from '@/core/store/toastStore';

/**
 * The console's one toast layer. Three kinds of card, one visual family, drawn
 * to Anil's mockup (2026-09-19):
 *
 *   ┃ (icon)  CAMERA OFFLINE                          12:17 PM  ×
 *   ┃         3 cameras went offline
 *   ┃         [Workstation 2] [Support] [Cafeteria] [+1]
 *   ┃         (!) NVR unreachable                 [ Camera health → ]
 *
 *   ai       a HIGH / MEDIUM AI event (routine info never toasts):
 *            chips are the facts (zone, count, who), the footer is the camera
 *   camera   a camera going offline — and coming back
 *   system   something the console itself needs to say: live updates lost,
 *            an action that failed (pages raise these through `toast.error`)
 *
 * Severity is one CSS variable on the card (`data-tone`): the glowing edge
 * bar, the tinted icon disc, the eyebrow and the footer badge all derive from
 * it — red for HIGH / offline, amber for MEDIUM, green for back online, grey
 * for informational. The orange pill is the only action.
 *
 * Behaviour that is not decoration: the timer strip along the bottom shows
 * how long the card has left and stops while it is hovered or focused; every
 * timer pauses when the tab is hidden; Escape dismisses the newest; an NVR
 * dropping many cameras at once folds into ONE card instead of a column.
 *
 * Anti-flood for AI events (mirrors the backend email throttle): the pipeline
 * emits on EVERY frame a face is seen, so the same identity on the same camera
 * is one toast per PER_SUBJECT_COOLDOWN_MS, and a rolling cap stops many
 * different people flooding the corner. A toast is never the record — every
 * card also lands in the notification bell.
 */
const PER_SUBJECT_COOLDOWN_MS = 120_000;  // same person + camera + type = 1 alert / 2 min
const BURST_WINDOW_MS = 60_000;
const BURST_MAX = 6;                       // at most 6 fresh AI alerts per rolling minute
const SOCKET_GRACE_MS = 4_000;             // a reconnect faster than this is not worth a toast
const MAX_CHIPS = 3;                       // then a "+N" chip

// AI event timestamps arrive in seconds or milliseconds — normalise to ms.
const toMs = (t) => {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n > 1e12 ? n : n * 1000;
};

// Stable dedup subject — keyed on IDENTITY, never the volatile trackId. Known
// people key on their name/id; every unknown collapses to one token per camera.
const subjectOf = (evt) => {
  const p = evt?.payload || {};
  const named = p.personId || p.matchedName || p.name;
  if (named && String(named).toLowerCase() !== 'unknown') return `id:${named}`;
  return 'unknown';
};

const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;

/** The chips under an AI title: zone, count, who, capacity. */
function eventChips(evt, d) {
  const p = evt?.payload || {};
  const key = String(evt?.eventType || evt?.kind || '').toLowerCase();
  const count = p.count != null && Number.isFinite(Number(p.count)) ? Number(p.count) : null;
  const chips = [];
  if (p.zoneName) chips.push(p.zoneName);
  if (key.startsWith('occupancy')) {
    if (count != null) chips.push(plural(count, 'person', 'people'));
    if (p.capacity) chips.push(`limit ${p.capacity}`);
  } else if (key === 'zone.intrusion') {
    if (count != null) chips.push(plural(count, 'person', 'people'));
  } else if (/person|match|unknown|alert|face/.test(key)) {
    chips.push(d.isUnknown ? 'Unrecognised person' : d.subject);
    if (!d.isUnknown && d.confidencePct) chips.push(`${d.confidencePct}% match`);
  } else if (!d.isUnknown && d.subject) {
    chips.push(d.subject);
  }
  return chips;
}

const ICONS = {
  ShieldAlert, UserX, UserCheck, Users, UsersRound, LogIn, LogOut, Clock, PackageX,
  GitBranch, Car, CarFront, Activity, WifiOff, Wifi, VideoOff, Video,
  OctagonAlert, TriangleAlert, CircleCheck, Info,
};
const SYSTEM_ICON = { danger: 'OctagonAlert', warning: 'TriangleAlert', success: 'CircleCheck', neutral: 'Info' };

// Footer badge: a filled tone disc for a reason / result, a neutral disc for a place.
const FOOT_BY_TONE = { danger: 'alert', warning: 'alert', success: 'check', neutral: 'info' };

export default function AIToastHost() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const toasts = useToastStore((s) => s.toasts);
  const camNamesRef = useRef({});          // monitorId -> friendly name
  const offlineRef = useRef(new Set());    // monitorIds currently offline (transition dedup)
  const seenRef = useRef(new Map());       // dedup key -> last-alerted ts
  const burstRef = useRef([]);             // recent alert timestamps (rolling cap)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);

  // Every timer pauses while the tab is hidden — see the header comment.
  useEffect(() => {
    const h = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, []);

  // Escape dismisses the newest card. Ignored while typing in a field.
  useEffect(() => {
    const h = (e) => {
      if (e.key !== 'Escape') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      useToastStore.getState().dismissNewest();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    connectSocket();

    // Resolve monitorId -> camera name so a card reads "Gate 2", not a hash.
    aiService.listCameraAiSettings?.().then((d) => {
      const list = d?.data || d?.cameras || (Array.isArray(d) ? d : []);
      const m = {};
      for (const c of list) if (c?.monitorId) m[c.monitorId] = c.name || c.monitorId;
      camNamesRef.current = m;
    }).catch(() => {});
    // No fabricated "Camera 28c7a6…" — operators go looking for that camera.
    const nameOf = (monitorId) => camNamesRef.current[monitorId] || 'Unnamed camera';

    // ── AI events ─────────────────────────────────────────────────────────
    const offEvent = onSocket('ai.event', (evt) => {
      if (evt.severity !== 'warning' && evt.severity !== 'critical') return;

      const now = Date.now();
      const key = `${evt.eventType || evt.type || 'evt'}:${subjectOf(evt)}:${evt.monitorId}`;
      const last = seenRef.current.get(key) || 0;
      if (now - last < PER_SUBJECT_COOLDOWN_MS) return;   // same identity, still cooling down
      burstRef.current = burstRef.current.filter((t) => now - t < BURST_WINDOW_MS);
      if (burstRef.current.length >= BURST_MAX) return;   // too many at once — drop the rest
      seenRef.current.set(key, now);
      burstRef.current.push(now);
      if (seenRef.current.size > 500) {
        for (const [k, ts] of seenRef.current) {
          if (now - ts > PER_SUBJECT_COOLDOWN_MS) seenRef.current.delete(k);
        }
      }

      const d = describe(evt);
      const isCrit = evt.severity === 'critical';
      const camName = nameOf(evt.monitorId);
      const tsMs = toMs(evt.ts);
      const chips = eventChips(evt, d);

      toast.push({
        id: evt.id || `${evt.ts}-${evt.trackId}-${Math.random()}`,
        kind: 'ai',
        tone: isCrit ? 'danger' : 'warning',
        eyebrow: isCrit ? 'High' : 'Medium',
        icon: d.iconName,
        title: d.nounWhen,
        chips,
        foot: { icon: 'camera', text: camName },
        at: tsMs,
        to: '/alerts',
        action: 'View alert',
        ttl: isCrit ? TOAST_TTL.critical : TOAST_TTL.warning,
        live: isCrit ? 'assertive' : 'polite',
      });
      const clock = new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      useNotificationStore.getState().add({
        kind: 'ai', severity: evt.severity, title: d.nounWhen,
        detail: `${chips.length ? `${chips.join(' · ')} · ` : ''}${camName} · ${clock}`,
        ts: tsMs, to: '/alerts',
      });
    });

    // ── Camera offline / back online ──────────────────────────────────────
    // Only on a genuine transition, so a reconnecting camera cannot fire dozens.
    const offStatus = onSocket('stream.status', ({ monitorId, status, reason, reasonCode }) => {
      if (!monitorId) return;
      const name = nameOf(monitorId);
      const wasOffline = offlineRef.current.has(monitorId);
      const store = useToastStore.getState();

      if (status === 'offline' && !wasOffline) {
        offlineRef.current.add(monitorId);
        const why = offlineReasonText(reason, reasonCode);
        store.push({
          kind: 'camera', tone: 'danger', eyebrow: 'Camera offline', icon: 'VideoOff',
          title: name, foot: { icon: 'alert', text: why }, to: '/health', action: 'Camera health',
          ttl: TOAST_TTL.offline, live: 'assertive',
          groupKey: 'camera-offline', merge: mergeCameraStatus,
          data: { cameras: [{ monitorId, name, reason, reasonCode }] },
        });
        useNotificationStore.getState().add({ kind: 'camera-offline', title: `${name} went offline`, detail: why, ts: Date.now(), to: '/health' });
      } else if (status === 'online' && wasOffline) {
        offlineRef.current.delete(monitorId);
        // A card that only announced THIS camera as offline is now stale.
        const stale = store.toasts.find((t) => t.groupKey === 'camera-offline' && !t.leaving
          && t.data?.cameras?.length === 1 && t.data.cameras[0].monitorId === monitorId);
        if (stale) store.dismiss(stale.id);
        store.push({
          kind: 'camera', tone: 'success', eyebrow: 'Back online', icon: 'Video',
          title: name, foot: { icon: 'check', text: 'Streaming again' }, to: '/health', action: 'Camera health',
          ttl: TOAST_TTL.online,
          groupKey: 'camera-online', merge: mergeCameraStatus,
          data: { cameras: [{ monitorId, name }] },
        });
        useNotificationStore.getState().add({ kind: 'camera-online', title: `${name} back online`, detail: 'Streaming again', ts: Date.now(), to: '/health' });
      }
    });

    // ── The console's own link to the server ──────────────────────────────
    // socket.io reconnects by itself; the operator only needs to know when the
    // live feed has actually been gone for a while, and when it is back.
    const sock = getSocket();
    let graceTimer = null;
    let announced = false;
    const onDisconnect = (why) => {
      if (why === 'io client disconnect') return;        // logout — not a fault
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        announced = true;
        toast.warn('Live updates paused', 'Reconnecting to the server — alerts and camera status are not updating',
          { groupKey: 'socket', ttl: TOAST_TTL.sticky, live: 'assertive' });
        useNotificationStore.getState().add({ kind: 'system-error', title: 'Live updates paused', detail: 'Lost the connection to the server', ts: Date.now() });
      }, SOCKET_GRACE_MS);
    };
    const onConnect = () => {
      clearTimeout(graceTimer);
      if (!announced) return;
      announced = false;
      toast.success('Live updates restored', 'Alerts and camera status are live again', { groupKey: 'socket' });
    };
    sock?.on('disconnect', onDisconnect);
    sock?.on('connect', onConnect);

    return () => {
      offEvent();
      offStatus();
      clearTimeout(graceTimer);
      sock?.off('disconnect', onDisconnect);
      sock?.off('connect', onConnect);
    };
  }, [isAuthenticated]);

  if (!isAuthenticated || toasts.length === 0) return null;

  // Chronological: the newest card sits nearest the corner and pushes older
  // ones up. The store caps the queue at MAX_VISIBLE, so nothing is ever
  // mounted off-screen with a timer that cannot be seen.
  const visible = toasts.slice(-MAX_VISIBLE);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[430px] max-w-[calc(var(--app-vw)-2rem)] flex-col items-stretch gap-2 print:hidden"
      aria-live="polite"
      aria-relevant="additions"
    >
      {visible.map((t) => <ToastCard key={t.id} toast={t} pausedAll={hidden} />)}
    </div>
  );
}

function FootBadge({ icon }) {
  if (icon === 'alert') {
    return <span className="toast-badge -mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-black leading-none">!</span>;
  }
  const Glyph = icon === 'check' ? Check : icon === 'camera' ? Cctv : Info;
  const cls = icon === 'check' ? 'toast-badge' : 'toast-badge-neutral';
  return <span className={`${cls} -mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full`}><Glyph size={10} strokeWidth={2.5} /></span>;
}

function ToastCard({ toast: t, pausedAll }) {
  const navigate = useNavigate();
  const dismiss = useToastStore((s) => s.dismiss);
  const remove = useToastStore((s) => s.remove);
  const [held, setHeld] = useState(false);           // hovered or focused
  const timerRef = useRef(null);
  const startedRef = useRef(0);
  const remainingRef = useRef(t.ttl);

  const tone = t.tone || 'neutral';
  const Icon = ICONS[t.icon] || ICONS[SYSTEM_ICON[tone]] || Info;
  const paused = held || pausedAll;
  const time = new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const chips = Array.isArray(t.chips) ? t.chips : [];
  const shownChips = chips.slice(0, MAX_CHIPS);
  const moreChips = chips.length - shownChips.length;
  // A plain `detail` (the imperative API) is drawn as the footer.
  const foot = t.foot || (t.detail ? { icon: FOOT_BY_TONE[tone], text: t.detail } : null);

  // Auto-dismiss with a real remaining-time budget, so a pause never resets
  // the clock and never lets a hovered card vanish the moment the mouse leaves.
  useEffect(() => {
    remainingRef.current = t.ttl;
    return () => clearTimeout(timerRef.current);
  }, [t.id, t.at, t.ttl]);
  useEffect(() => {
    if (!t.ttl || t.leaving) return undefined;
    if (paused) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
      }
      return undefined;
    }
    startedRef.current = Date.now();
    timerRef.current = setTimeout(() => dismiss(t.id), remainingRef.current);
    return () => clearTimeout(timerRef.current);
  }, [paused, t.id, t.at, t.ttl, t.leaving, dismiss]);

  // The leave animation ends → unmount. A fallback covers environments with
  // animations disabled, where animationend never fires.
  useEffect(() => {
    if (!t.leaving) return undefined;
    const f = setTimeout(() => remove(t.id), 400);
    return () => clearTimeout(f);
  }, [t.leaving, t.id, remove]);

  const go = () => {
    if (!t.to) return;
    navigate(t.to);
    dismiss(t.id);
  };

  return (
    <div
      data-toast
      data-tone={tone}
      data-leaving={t.leaving ? 'true' : undefined}
      data-paused={pausedAll ? 'true' : undefined}
      role={t.live === 'assertive' ? 'alert' : 'status'}
      onAnimationEnd={(e) => { if (t.leaving && e.animationName === 'toast-out') remove(t.id); }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false); }}
      onClick={t.to ? go : undefined}
      className={`pointer-events-auto relative overflow-hidden rounded-2xl border border-toast-line bg-toast text-toast-ink shadow-[var(--toast-shadow)] ${t.to ? 'cursor-pointer' : ''}`}
    >
      {/* Severity, said by colour: the glowing edge. */}
      <span aria-hidden className="toast-bar absolute inset-y-0 left-0 w-1" />

      <div className="flex items-start gap-3 py-3 pl-4 pr-2.5">
        {/* WHAT KIND of thing — the icon is the type; the disc carries the tone. */}
        <span className="toast-icon mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full">
          <Icon size={16} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {t.eyebrow && <span className="toast-eyebrow text-micro font-bold uppercase tracking-[0.12em]">{t.eyebrow}</span>}
            <span className="ml-auto text-caption tabular-nums text-toast-ink-muted">{time}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}
              className="-mr-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-toast-ink-muted transition hover:bg-toast-raised hover:text-toast-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>

          <div className="truncate text-heading font-bold text-toast-ink" title={t.title}>{t.title}</div>

          {shownChips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {shownChips.map((c, i) => (
                <span key={`${c}-${i}`} className="toast-chip max-w-full truncate rounded-full px-2.5 py-0.5 text-caption font-medium" title={c}>{c}</span>
              ))}
              {moreChips > 0 && (
                <span className="toast-chip rounded-full px-2 py-0.5 text-caption font-medium text-toast-ink-muted" title={chips.slice(MAX_CHIPS).join(', ')}>+{moreChips}</span>
              )}
            </div>
          )}

          {(foot || t.to) && (
            <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-1.5">
              {foot && (
                <span className="flex min-w-0 flex-1 items-start gap-1.5 text-caption text-toast-ink-muted">
                  <FootBadge icon={foot.icon} />
                  <span className="line-clamp-2" title={foot.text}>{foot.text}</span>
                </span>
              )}
              {t.to && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); go(); }}
                  className="toast-action -my-0.5 ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-caption font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {t.action || 'View'} <ArrowRight size={12} strokeWidth={2.2} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Time left. Drains over the ttl; stops while the card is held. */}
      {t.ttl > 0 && (
        <div className="h-0.5 w-full bg-toast-line" aria-hidden>
          <div key={t.at} data-toast-timer className="h-full w-full bg-white/20" style={{ '--toast-ttl': `${t.ttl}ms` }} />
        </div>
      )}
    </div>
  );
}
