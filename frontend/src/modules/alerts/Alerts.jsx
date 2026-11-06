import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, CheckCircle2, RefreshCw, Image as ImageIcon, X, ChevronRight,
  AlertTriangle, ShieldAlert, UserX, UserCheck, LogIn, LogOut, WifiOff,
  Activity, Clock, Camera, Search, Eye, PlayCircle, Filter, ArrowDownUp,
  UsersRound, PackageX, GitBranch, Car, CarFront, Wifi, Sparkles, Mail,
} from 'lucide-react';
import { aiService, describe } from '@/core/services/ai';
import { on as onSocket, connectSocket } from '@/core/services/socket';
import { useGroups } from '@/core/hooks/useQueries';
import EnhanceFaceDialog from '@/core/components/EnhanceFaceDialog';
import {
  OperationsPage, PageHeader, PageContent, PageAction, PageTabs, PageCard,
} from '@/core/layout/OperationsPage';
import { MetricCard, MetricGrid } from '@/core/ui/metric-card';
import { StatusBadge } from '@/core/ui/status-badge';
import AlertRecipients from './AlertRecipients';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';

// Map from icon NAME (returned by describe()) to the actual lucide component.
// Done once at module scope so describe() doesn't need to import lucide.
const ICONS = {
  LogIn, LogOut, UserCheck, UserX, ShieldAlert, UsersRound, PackageX, GitBranch,
  Clock, Activity, Car, CarFront, WifiOff, Wifi,
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Alerts() {
  const navigate = useNavigate();
  const [events, setEvents]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [filter, setFilter]       = useState('all');     // all | needsReview | recognised | unknown | watchlist
  const [search, setSearch]       = useState('');
  const [sortDesc, setSortDesc]   = useState(true);
  const [selected, setSelected]   = useState(null);
  const [liveOk, setLiveOk]       = useState(false);
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  // Email alerts is its own account switch; off = no recipients editor here.
  const user = useAuthStore((s) => s.user);
  const emailOn = makeEntitlement(user).has('email_alerts');

  // Map monitorId → { name, groupName } so events show real camera labels
  const { data: groups = [] } = useGroups();
  const cameras = useMemo(() => {
    const out = {};
    for (const g of groups) for (const c of g.cameras || []) {
      out[c.monitorId] = { name: c.name || 'Camera', groupName: g.name || '' };
    }
    return out;
  }, [groups]);

  // ── Data load ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await aiService.listEvents({ limit: 200 });
      const list = Array.isArray(res) ? res
                 : Array.isArray(res?.data)   ? res.data
                 : Array.isArray(res?.events) ? res.events
                 : Array.isArray(res?.items)  ? res.items : [];
      setEvents(list);
    } catch (err) {
      setError(err?.response?.status === 401 ? 'Session expired — log in again.'
             : err?.message || 'Could not reach the server.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // ── Live socket ────────────────────────────────────────────────────────────
  useEffect(() => {
    const s = connectSocket(); if (!s) return;
    const onOk = () => setLiveOk(true); const onOff = () => setLiveOk(false);
    s.on('connect', onOk); s.on('disconnect', onOff); setLiveOk(s.connected);
    return () => { s.off('connect', onOk); s.off('disconnect', onOff); };
  }, []);
  useEffect(() => {
    return onSocket('ai.event', (evt) => {
      setEvents((prev) => [evt, ...prev].slice(0, 300));
    });
  }, []);

  // ── Derived: per-event view-models, filters, grouping ─────────────────────
  const enriched = useMemo(
    () => events.map((e) => ({ raw: e, vm: describe(e, cameras) })),
    [events, cameras],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = enriched;
    if (filter === 'needsReview') list = list.filter((it) => !it.raw.acknowledgedAt && (it.vm.tone === 'warn' || it.vm.tone === 'critical'));
    if (filter === 'recognised')  list = list.filter((it) => it.vm.tone === 'good' && !it.vm.isUnknown);
    if (filter === 'unknown')     list = list.filter((it) => it.vm.isUnknown);
    if (filter === 'watchlist')   list = list.filter((it) => it.vm.tone === 'critical');
    if (q) list = list.filter((it) =>
      (it.vm.subject || '').toLowerCase().includes(q) ||
      (it.vm.cameraLabel || '').toLowerCase().includes(q) ||
      (it.vm.title || '').toLowerCase().includes(q));
    list = [...list].sort((a, b) => sortDesc
      ? b.vm.when.getTime() - a.vm.when.getTime()
      : a.vm.when.getTime() - b.vm.when.getTime());
    return list;
  }, [enriched, filter, search, sortDesc]);

  // Grouping by date (Today / Yesterday / Earlier · <date>)
  const groupedSections = useMemo(() => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfDay); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const buckets = new Map();
    for (const it of visible) {
      const t = it.vm.when;
      let key;
      if (t >= startOfDay)            key = 'Today';
      else if (t >= startOfYesterday) key = 'Yesterday';
      else                             key = t.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(it);
    }
    return Array.from(buckets.entries());
  }, [visible]);

  // ── Stat cards (real counts) ──────────────────────────────────────────────
  const stats = useMemo(() => {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    let today = 0, watchlist = 0, unknown = 0, recognised = 0;
    for (const it of enriched) {
      if (it.vm.when >= startOfDay) today++;
      if (it.vm.tone === 'critical') watchlist++;
      if (it.vm.isUnknown)            unknown++;
      else if (it.vm.tone === 'good') recognised++;
    }
    return { today, watchlist, unknown, recognised, total: enriched.length };
  }, [enriched]);

  return (
    <OperationsPage>
      <PageHeader
        icon={Bell}
        title="Alerts"
        description="Everything the AI saw across your camera network — recognised faces, strangers, and watchlist alerts."
        actions={
          <>
            {liveOk ? <StatusBadge status="live" pulse /> : <StatusBadge status="offline" />}
            {emailOn ? (
              <PageAction onClick={() => setRecipientsOpen(true)} type="button" title="Get alerts by email">
                <Mail className="h-3.5 w-3.5" strokeWidth={2} />
                Email alerts
              </PageAction>
            ) : null}
            <PageAction onClick={load} type="button">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={2} />
              Refresh
            </PageAction>
          </>
        }
      />

      {emailOn ? <AlertRecipients open={recipientsOpen} onClose={() => setRecipientsOpen(false)} /> : null}

      <PageContent scroll className="gap-5">
      {/* Stat cards — operator-thinking labels, not technical fields */}
      <MetricGrid cols={4}>
        <MetricCard label="Watchlist alerts" value={stats.watchlist.toLocaleString()} icon={ShieldAlert} tone="danger"
                    alert={stats.watchlist > 0}
                    sub={stats.watchlist ? 'requires attention' : 'all clear'}
                    onClick={() => setFilter('watchlist')} active={filter === 'watchlist'} />
        <MetricCard label="Strangers today"  value={stats.unknown.toLocaleString()}   icon={UserX}       tone="warning"
                    sub="unrecognised faces"
                    onClick={() => setFilter('unknown')} active={filter === 'unknown'} />
        <MetricCard label="Recognised"       value={stats.recognised.toLocaleString()} icon={UserCheck}  tone="success"
                    sub="known people seen"
                    onClick={() => setFilter('recognised')} active={filter === 'recognised'} />
        <MetricCard label="Today"            value={stats.today.toLocaleString()}     icon={Clock}       tone="neutral"
                    sub={`${stats.total} total in window`}
                    onClick={() => setFilter('all')} active={filter === 'all'} />
      </MetricGrid>

      {/* Filter + search bar */}
      <PageCard className="flex shrink-0 flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-2 px-1 text-caption font-bold uppercase tracking-wider text-fg-muted">
          <Filter className="h-3.5 w-3.5" strokeWidth={2} /> Show
        </div>
        <PageTabs tabs={FILTERS} active={filter} onChange={setFilter} />

        <div className="ml-auto flex items-center gap-2 min-w-[220px] w-full md:w-[300px]">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" strokeWidth={2} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a name or camera…"
              className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-small focus:border-brand/50 focus:outline-none focus:ring-2 focus:ring-brand/15"
            />
          </div>
          <PageAction onClick={() => setSortDesc((s) => !s)} type="button" title="Toggle sort direction">
            <ArrowDownUp className="h-3.5 w-3.5" strokeWidth={2} />
            {sortDesc ? 'Newest' : 'Oldest'}
          </PageAction>
        </div>
      </PageCard>

      {/* Body */}
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading && enriched.length === 0 ? (
        <SkeletonGrid />
      ) : visible.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <div className="space-y-6">
          {groupedSections.map(([heading, items]) => (
            <section key={heading}>
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-body font-bold text-fg-secondary uppercase tracking-wider">{heading}</h2>
                <span className="text-small text-fg-subtle font-mono tabular-nums">{items.length}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                {items.map(({ raw, vm }) => (
                  <EventCard key={raw.id} event={raw} vm={vm} onClick={() => setSelected({ raw, vm })} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      </PageContent>

      {selected && (
        <EventDetailModal
          event={selected.raw}
          vm={selected.vm}
          onClose={() => setSelected(null)}
          onAcknowledged={(updated) => {
            setEvents((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
            setSelected({ raw: updated, vm: describe(updated, cameras) });
          }}
          onViewLive={(monitorId) => navigate(`/live?monitor=${encodeURIComponent(monitorId)}`)}
          onOpenRecording={(monitorId) => navigate(`/playback?camera=${monitorId}`)}
        />
      )}
    </OperationsPage>
  );
}

// ── Atoms ────────────────────────────────────────────────────────────────────

// The filter row uses the shared segmented control, so its icons and selected
// state match the tab bars on Playback, Occupancy and Event Log.
const FILTERS = [
  { id: 'all',         label: 'All',              Icon: Activity },
  { id: 'needsReview', label: 'Needs review',     Icon: AlertTriangle },
  { id: 'watchlist',   label: 'Watchlist alerts', Icon: ShieldAlert },
  { id: 'unknown',     label: 'Strangers',        Icon: UserX },
  { id: 'recognised',  label: 'Recognised',       Icon: UserCheck },
];

const TONE_BG = {
  good:     'bg-success-soft',
  warn:     'bg-warning-soft',
  critical: 'bg-danger-soft',
  neutral:  'bg-surface-sunken',
};
const TONE_TEXT = {
  good:     'text-success-ink',
  warn:     'text-warning-ink',
  critical: 'text-danger-ink',
  neutral:  'text-fg-secondary',
};
const TONE_BORDER = {
  good:     'border-success-line',
  warn:     'border-warning-line',
  critical: 'border-danger-line',
  neutral:  'border-line',
};

// ── Event card ───────────────────────────────────────────────────────────────

function EventCard({ event, vm, onClick }) {
  const Icon = ICONS[vm.iconName] || Activity;
  return (
    <button
      onClick={onClick}
      className="text-left bg-surface border border-line rounded-xl overflow-hidden hover:border-brand/40 hover:shadow-md transition-all group flex flex-col"
    >
      <div className="relative">
        {/* Tone strip on the left */}
        <div className="absolute top-0 left-0 bottom-0 w-1" style={{ backgroundColor: vm.theme.hex }} />
        <ThumbnailLoader event={event} />

        {/* Top-left tone chip */}
        <div className="absolute top-2 left-3 flex items-center gap-1">
          <span className={`text-micro uppercase tracking-wider font-bold px-2 py-0.5 rounded-md border ${TONE_BG[vm.tone]} ${TONE_BORDER[vm.tone]} ${TONE_TEXT[vm.tone]}`}>
            {vm.nounWhen}
          </span>
        </div>

        {/* Top-right ack */}
        {event.acknowledgedAt && (
          <div className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-success-soft border border-success-line px-1.5 py-0.5">
            <CheckCircle2 size={11} className="text-success-ink" />
            <span className="text-micro font-bold text-success-ink">Reviewed</span>
          </div>
        )}

        {/* Bottom-left timestamp + camera */}
        <div className="absolute bottom-2 left-3 right-2 flex items-end justify-between gap-2 pointer-events-none">
          <span className="text-micro font-mono font-bold text-white px-2 py-0.5 rounded-md bg-black/65 backdrop-blur-sm truncate max-w-[60%]">
            <Camera size={10} className="inline -mt-0.5 mr-1" />
            {vm.cameraLabel}
          </span>
          <span className="text-micro font-mono font-bold text-white px-2 py-0.5 rounded-md bg-black/65 backdrop-blur-sm">
            {vm.when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}
          </span>
        </div>
      </div>

      <div className="p-3 flex items-start gap-3">
        <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${TONE_BG[vm.tone]} ${TONE_TEXT[vm.tone]}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-body font-bold truncate ${vm.tone === 'critical' ? 'text-danger-ink' : 'text-fg'}`}>
            {vm.title}
          </p>
          <p className="text-caption font-medium text-fg-muted mt-0.5">
            {vm.confidencePct != null ? `${vm.confidencePct}% match · ` : ''}
            {fmtRel(vm.when)}
          </p>
        </div>
        <ChevronRight size={14} className="text-fg-disabled group-hover:text-brand transition mt-1" />
      </div>
    </button>
  );
}

function ThumbnailLoader({ event }) {
  // vms_face detections carry the crop as an s3:// uri → stream it straight from
  // MinIO through the byte-relay (synchronous, no fetch). Only fall back to the
  // presigned /events/:id/snapshot path for local ai_events that have no uri.
  const directSrc = aiService.snapshotSrc(event?.snapshot_uri || event?.snapshotUri);
  const [url, setUrl] = useState(directSrc || undefined);
  const [errored, setErr] = useState(false);
  useEffect(() => {
    if (directSrc) { setErr(false); setUrl(directSrc); return; }
    let cancel = false;
    setUrl(undefined);
    aiService.getSnapshotUrl(event.id)
      .then(({ url: u }) => { if (!cancel) setUrl(u || null); })
      .catch(() => { if (!cancel) setErr(true); });
    return () => { cancel = true; };
  }, [event?.id, directSrc]);
  if (errored || url === null) {
    return (
      <div className="aspect-video bg-slate-900 flex items-center justify-center">
        <ImageIcon size={28} className="text-white/25" />
      </div>
    );
  }
  if (url === undefined) return <div className="aspect-video bg-line animate-pulse" />;
  return (
    <div className="aspect-video bg-black overflow-hidden">
      <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" onError={() => setErr(true)} />
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

function EventDetailModal({ event, vm, onClose, onAcknowledged, onViewLive, onOpenRecording }) {
  const [snapUrl, setSnap] = useState(() => aiService.snapshotSrc(event?.snapshot_uri || event?.snapshotUri));
  const [acking, setAcking] = useState(false);
  useEffect(() => {
    const direct = aiService.snapshotSrc(event?.snapshot_uri || event?.snapshotUri);
    if (direct) { setSnap(direct); return; }
    aiService.getSnapshotUrl(event.id).then(({ url }) => setSnap(url)).catch(() => {});
  }, [event.id]);

  const handleAck = async () => {
    if (event.acknowledgedAt) return;
    setAcking(true);
    try {
      await aiService.acknowledge(event.id);
      onAcknowledged?.({ ...event, acknowledgedAt: new Date().toISOString() });
    } finally { setAcking(false); }
  };

  const Icon = ICONS[vm.iconName] || Activity;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl max-w-5xl w-full overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header — strong tone strip + clear title */}
        <div className={`flex items-center justify-between px-5 py-3.5 border-b border-line ${TONE_BG[vm.tone]}`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-surface ${TONE_TEXT[vm.tone]} shadow-sm`}>
              <Icon size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="text-heading font-bold text-fg truncate">{vm.title}</h3>
              <p className="text-small text-fg-secondary mt-0.5">{vm.nounWhen} · {vm.when.toLocaleString()}</p>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 p-1.5 rounded-md hover:bg-surface/60 text-fg-secondary">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr]">
          {/* Snapshot + Enhance button overlay. The Enhance affordance
              sits directly on the image (bottom-right corner) so the
              operator's eye finds it the moment they look at a blurry
              face. Only renders when there's actually a snapshot to
              enhance — no point showing "Enhance this" over a "No
              snapshot" placeholder. */}
          <div className="bg-black flex items-center justify-center min-h-[300px] relative">
            {snapUrl ? (
              <>
                <img src={snapUrl} alt="" className="w-full max-h-[calc(var(--app-vh)*0.6)] object-contain" />
                <div className="absolute bottom-3 right-3">
                  <EnhanceFaceDialog imageUrl={snapUrl}>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand hover:bg-brand-hover px-3 py-2 text-small font-bold text-white shadow-lg"
                      title="Clean up this face with CodeFormer + Real-ESRGAN"
                    >
                      <Sparkles size={13} />
                      Enhance face
                    </button>
                  </EnhanceFaceDialog>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 text-fg-disabled">
                <ImageIcon size={36} className="text-white/30" />
                <span className="text-small">No snapshot</span>
              </div>
            )}
          </div>

          {/* Side panel */}
          <div className="p-5 space-y-3 border-t md:border-t-0 md:border-l border-line">
            <Detail icon={UserCheck} label="Person"     value={vm.subject} />
            <Detail icon={Camera}    label="Camera"     value={vm.cameraLabel} />
            <Detail icon={Clock}     label="When"       value={vm.when.toLocaleString()} />
            {vm.confidencePct != null && (
              <Detail icon={Activity} label="Confidence" value={`${vm.confidencePct}%`} />
            )}
            {event.bbox && (
              <Detail icon={Activity} label="Bounding box" value={event.bbox.map((v) => Math.round(v)).join(', ')} mono />
            )}
            {event.acknowledgedAt && (
              <div className="flex items-center gap-2 text-small text-success-ink bg-success-soft px-3 py-2 rounded-lg border border-success-line">
                <CheckCircle2 size={14} />
                Reviewed at {new Date(event.acknowledgedAt).toLocaleString()}
              </div>
            )}

            <div className="pt-3 border-t border-line grid grid-cols-2 gap-2">
              <button
                onClick={() => onViewLive?.(event.monitorId)}
                disabled={!event.monitorId}
                className="flex items-center justify-center gap-1.5 h-9 rounded-lg bg-surface border border-line hover:bg-surface-sunken text-small font-bold text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Eye size={14} /> View Live
              </button>
              <button
                onClick={() => onOpenRecording?.(event.monitorId)}
                disabled={!event.monitorId}
                className="flex items-center justify-center gap-1.5 h-9 rounded-lg bg-surface border border-line hover:bg-surface-sunken text-small font-bold text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <PlayCircle size={14} /> Open Clip
              </button>
              <button
                onClick={handleAck}
                disabled={!!event.acknowledgedAt || acking}
                className="col-span-2 flex items-center justify-center gap-1.5 h-9 rounded-lg bg-brand hover:bg-brand-hover text-white text-small font-bold disabled:bg-line disabled:text-fg-muted"
              >
                <CheckCircle2 size={14} />
                {event.acknowledgedAt ? 'Already reviewed' : acking ? 'Saving…' : 'Mark as reviewed'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Detail({ icon: Icon, label, value, mono }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="shrink-0 w-7 h-7 rounded-md bg-surface-muted flex items-center justify-center text-fg-muted mt-0.5">
        <Icon size={13} />
      </div>
      <div className="min-w-0">
        <p className="text-micro font-bold uppercase tracking-wider text-fg-muted">{label}</p>
        <p className={`text-body font-semibold text-fg truncate ${mono ? 'font-mono' : ''}`}>{value}</p>
      </div>
    </div>
  );
}

// ── States ──────────────────────────────────────────────────────────────────

function ErrorState({ message, onRetry }) {
  return (
    <div className="bg-surface rounded-xl border border-danger-line p-8 text-center">
      <div className="w-12 h-12 mx-auto rounded-full bg-danger-soft flex items-center justify-center text-danger-ink mb-3">
        <AlertTriangle size={20} />
      </div>
      <p className="text-body font-bold text-fg">Couldn't load activity</p>
      <p className="text-small text-fg-muted mt-1">{message}</p>
      <button onClick={onRetry} className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-small font-bold text-white">
        <RefreshCw size={13} /> Try again
      </button>
    </div>
  );
}

function EmptyState({ filter }) {
  const msg = filter === 'watchlist'  ? 'No watchlist alerts. All clear.'
            : filter === 'unknown'    ? 'No strangers detected.'
            : filter === 'recognised' ? 'Nobody from the gallery seen yet.'
            : filter === 'needsReview'? 'Nothing needs your attention right now.'
            : 'No activity in the visible window.';
  return (
    <div className="bg-surface rounded-xl border border-line p-12 text-center">
      <div className="w-14 h-14 mx-auto rounded-full bg-success-soft flex items-center justify-center text-success-ink mb-3">
        <CheckCircle2 size={24} />
      </div>
      <p className="text-heading font-bold text-fg">{msg}</p>
      <p className="text-body text-fg-muted mt-1">Events appear here automatically as the AI sees activity.</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="bg-surface border border-line rounded-xl overflow-hidden animate-pulse">
          <div className="aspect-video bg-line" />
          <div className="p-3 flex gap-3">
            <div className="w-9 h-9 rounded-lg bg-line" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-line rounded w-3/4" />
              <div className="h-2.5 bg-line rounded w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtRel(d) {
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60)    return 'just now';
  if (sec < 3600)  return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
