import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Radar, MapPin, Footprints, Clock, ChevronRight, RotateCcw,
  UserRound, Video, Activity, Route as RouteIcon, Loader2,
} from 'lucide-react';
import { aiService } from '@/core/services/ai';
import { PageIcon } from '@/core/layout/OperationsPage';
import { Link } from 'react-router-dom';

/**
 * Live Tracker — real-time "who is where" across every camera.
 *
 * Powered by the LiveTracker service (activity-monitor): K-of-N-confirmed
 * sightings, hop-by-hop trail, transit prediction from the learned movement
 * graph. This page is a 1.5s-poll live board — pick a person to follow their
 * journey as it happens.
 */

const STATUS = {
  active:  { label: 'Live now',   cls: 'bg-success-soft text-success-ink border-success-line', dot: 'bg-success animate-pulse' },
  transit: { label: 'In transit', cls: 'bg-warning-soft text-warning-ink border-warning-line',       dot: 'bg-warning' },
  lost:    { label: 'Lost',       cls: 'bg-surface-muted text-fg-muted border-line',      dot: 'bg-neutral' },
};

function fmtClock(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' });
  } catch { return '—'; }
}
function fmtDur(sec) {
  if (sec == null) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function LiveTracker() {
  const [selected, setSelected] = useState(null);

  const { data: camData } = useQuery({
    queryKey: ['track-cameras'],
    queryFn: () => aiService.listCameraAiSettings(),
    staleTime: 5 * 60_000,
  });
  const camName = useMemo(() => {
    const list = camData?.data || camData?.cameras || (Array.isArray(camData) ? camData : []);
    const m = {};
    for (const c of list) if (c?.monitorId) m[c.monitorId] = c.name || c.monitorId;
    return (id) => (id ? (m[id] || `Camera ${String(id).slice(0, 8)}…`) : '—');
  }, [camData]);

  const { data, isLoading } = useQuery({
    queryKey: ['track-live'],
    queryFn: () => aiService.trackLive(),
    refetchInterval: 1500,
  });
  const { data: detail } = useQuery({
    queryKey: ['track-live', selected],
    queryFn: () => aiService.trackLive(selected),
    enabled: !!selected,
    refetchInterval: 1500,
  });

  const tracks = data?.tracks || [];
  const occupancy = data?.occupancy || {};
  const liveCount = tracks.filter((t) => t.status === 'active').length;

  return (
    <div className="w-full page-inset">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <PageIcon icon={Radar} />
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Live tracking</h1>
          <p className="mt-0.5 text-xs font-normal leading-normal text-fg-muted">Real-time person location across every camera — confirmed sightings only, with the journey trail. Times in IST.</p>
          <Link to="/person-tracker" className="mt-1 inline-flex items-center gap-1 text-small font-semibold text-brand hover:text-brand-hover">
            ← Track one person from a photo
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-success-line bg-success-soft px-2.5 py-1 text-xs font-medium leading-normal text-success-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" /> {liveCount} live on camera
          </span>
          <button onClick={() => aiService.trackReset()} title="Clear all tracks"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium leading-normal text-fg-secondary hover:bg-surface-sunken">
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
        </div>
      </div>

      {/* camera occupancy strip */}
      {Object.keys(occupancy).length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(occupancy).map(([cam, names]) => (
            <div key={cam} className="inline-flex items-center gap-2 rounded-xl border border-success-line bg-success-soft/60 px-3 py-1.5">
              <Video className="h-3.5 w-3.5 text-success-ink" />
              <span className="text-small font-bold text-fg">{camName(cam)}</span>
              <span className="text-caption font-medium text-success-ink">{names.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        {/* people board */}
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
            <UserRound className="h-4 w-4 text-fg-subtle" />
            <h2 className="flex items-center gap-2 text-sm font-semibold leading-tight text-fg sm:text-base">People being tracked</h2>
            <span className="ml-auto text-caption text-fg-subtle">{tracks.length}</span>
          </div>
          <div className="max-h-[calc(var(--app-vh)*0.62)] overflow-y-auto">
            {isLoading ? (
              <div className="px-4 py-10 text-center text-fg-subtle"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
            ) : tracks.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <Radar className="mx-auto mb-2 h-8 w-8 text-fg-disabled" />
                <p className="text-body font-semibold text-fg-muted">No one tracked yet</p>
                <p className="mt-1 text-caption text-fg-subtle">As soon as a recognised person appears on any AI camera, they show up here — automatically.</p>
              </div>
            ) : tracks.map((t) => {
              const s = STATUS[t.status] || STATUS.lost;
              const isSel = selected === t.name;
              return (
                <button key={t.name} onClick={() => setSelected(t.name)}
                  className={`flex w-full items-center gap-3 border-t border-line-subtle px-4 py-3 text-left transition first:border-t-0 ${isSel ? 'bg-brand-soft/60' : 'hover:bg-surface-sunken/70'}`}>
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-muted text-small font-bold text-fg-secondary">
                    {t.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-body font-bold text-fg">{t.name}</span>
                      <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-micro font-bold uppercase ${s.cls}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />{s.label}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-caption text-fg-muted">
                      <MapPin className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {t.status === 'active' ? camName(t.camera)
                          : t.status === 'transit' ? `Last at ${camName(t.camera)} · ${fmtDur(t.seconds_since_seen)} ago`
                          : `Lost · last at ${camName(t.camera)}`}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-micro text-fg-subtle">{t.hops} hop{t.hops === 1 ? '' : 's'}</div>
                    <div className="mt-0.5 h-1 w-14 overflow-hidden rounded-full bg-surface-muted">
                      <div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, (t.confidence || 0) * 100)}%` }} />
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-fg-disabled" />
                </button>
              );
            })}
          </div>
        </div>

        {/* journey detail */}
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
          <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
            <RouteIcon className="h-4 w-4 text-fg-subtle" />
            <h2 className="flex items-center gap-2 text-sm font-semibold leading-tight text-fg sm:text-base">{selected ? `Journey — ${selected}` : 'Journey'}</h2>
          </div>
          {!selected || !detail?.found ? (
            <div className="px-6 py-16 text-center">
              <Footprints className="mx-auto mb-2 h-8 w-8 text-fg-disabled" />
              <p className="text-sm font-normal leading-normal text-fg-muted">Select a person to follow their journey live.</p>
            </div>
          ) : (
            <div className="p-4">
              {/* status card */}
              <div className="mb-4 grid grid-cols-3 gap-2">
                <StatCard icon={Activity} label="Status" value={(STATUS[detail.status] || STATUS.lost).label} />
                <StatCard icon={MapPin} label={detail.status === 'active' ? 'Current camera' : 'Last camera'} value={camName(detail.camera)} />
                <StatCard icon={Clock} label="Last seen" value={detail.seconds_since_seen != null ? `${fmtDur(detail.seconds_since_seen)} ago` : '—'} />
              </div>

              {/* transit prediction */}
              {detail.status === 'transit' && (detail.predicted_next || []).length > 0 && (
                <div className="mb-4 rounded-xl border border-warning-line bg-warning-soft/70 p-3">
                  <div className="mb-1.5 text-micro font-bold uppercase tracking-wide text-warning-ink">Likely heading to</div>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.predicted_next.map((p) => (
                      <span key={p.camera} className="inline-flex items-center gap-1.5 rounded-full border border-warning-line bg-surface px-2.5 py-1 text-caption font-semibold text-fg">
                        {camName(p.camera)}
                        <span className="text-micro font-bold text-warning-ink">{Math.round(p.probability * 100)}%</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* trail timeline (newest first) */}
              <div className="mb-1.5 text-micro font-bold uppercase tracking-wide text-fg-subtle">Trail — {detail.trail?.length || 0} stops</div>
              <div className="max-h-[calc(var(--app-vh)*0.4)] overflow-y-auto pr-1">
                {[...(detail.trail || [])].reverse().map((h, i, arr) => {
                  const isCurrent = i === 0 && detail.status === 'active';
                  return (
                    <div key={`${h.camera}-${h.enter}`} className="relative flex gap-3 pb-4">
                      {i < arr.length - 1 && <span className="absolute left-[9px] top-6 bottom-0 w-px bg-line" aria-hidden />}
                      <span className={`relative z-10 mt-1 grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full border-2 ${isCurrent ? 'border-success bg-success-soft' : 'border-line-strong bg-surface'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${isCurrent ? 'bg-success animate-pulse' : 'bg-line-strong'}`} />
                      </span>
                      <div className="min-w-0 flex-1 rounded-lg border border-line-subtle bg-surface-sunken/50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-small font-bold text-fg">{camName(h.camera)}</span>
                          <span className="shrink-0 text-micro tabular-nums text-fg-subtle">{fmtClock(h.enter)}{h.exit ? ` – ${fmtClock(h.exit)}` : ' – now'}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 text-micro text-fg-muted">
                          <span>stayed {h.dwell_sec != null ? fmtDur(h.dwell_sec) : fmtDur((detail.last_seen || 0) - h.enter)}</span>
                          {h.transit_sec != null && <span>· walked {fmtDur(h.transit_sec)} from {camName(h.from)}</span>}
                          <span className="ml-auto">match {Math.round((h.best_conf || 0) * 100)}%</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {(detail.trail || []).length === 0 && <p className="py-6 text-center text-small text-fg-subtle">No confirmed stops yet.</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-line bg-surface-sunken/60 px-3 py-2.5">
      <div className="flex items-center gap-1 text-micro font-bold uppercase tracking-wide text-fg-subtle"><Icon className="h-3 w-3" />{label}</div>
      <div className="mt-1 truncate text-body font-bold text-fg">{value}</div>
    </div>
  );
}
