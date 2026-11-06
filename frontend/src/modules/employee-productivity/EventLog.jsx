import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  ScrollText, LogIn, LogOut, ShieldAlert, TriangleAlert, MoonStar,
  Search, Download, X, UserRound,
} from 'lucide-react';
import { aiService } from '@/core/services/ai';
import { useGroups } from '@/core/hooks/useQueries';
import {
  OperationsPage, PageHeader, PageContent, PageAction, PageTabs, PageCard,
} from '@/core/layout/OperationsPage';
import { StatusBadge } from '@/core/ui/status-badge';
import { useModuleData } from './useModuleData';

// Demo session = logged in via the dev-only demo account (auth.js), whose
// tokens are "demo."-prefixed. With no backend to serve events, the page
// falls back to dummy data so the module stays explorable.
function isDemoSession() {
  try { return (localStorage.getItem('auth_token') || '').startsWith('demo.'); } catch { return false; }
}

function istDateKey(ts) {
  return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function fmtClock(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata',
    });
  } catch { return '—'; }
}
function todayIst() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// icon + colour per event
function look(e) {
  if (e.kind === 'alert') {
    if (e.severity === 'critical') return { Icon: ShieldAlert, cls: 'text-danger-ink bg-danger-soft border-danger-line', tag: 'Critical' };
    if (e.type === 'after_hours') return { Icon: MoonStar, cls: 'text-warning-ink bg-warning-soft border-warning-line', tag: 'After-hours' };
    return { Icon: TriangleAlert, cls: 'text-warning-ink bg-warning-soft border-warning-line', tag: 'Warning' };
  }
  return e.type === 'in'
    ? { Icon: LogIn, cls: 'text-success-ink bg-success-soft border-success-line', tag: 'IN' }
    : { Icon: LogOut, cls: 'text-fg-muted bg-surface-muted border-line', tag: 'OUT' };
}

const TYPES = [
  { id: 'all', label: 'All' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'alert', label: 'Alerts' },
];

export default function EventLog() {
  const { events: demoEvents } = useModuleData();
  // Seeded from the URL so the dashboard omnibox ("Investigate an Event") lands
  // here already scoped to the query, day and camera the operator picked.
  const [searchParams] = useSearchParams();
  const [type, setType] = useState('all');
  const [date, setDate] = useState(() => searchParams.get('date') || todayIst());
  const [nameQuery, setNameQuery] = useState(() => searchParams.get('q') || '');
  const [camFilter, setCamFilter] = useState(() => searchParams.get('camera') || 'all');

  // ?site=<groupId> scopes the log to one site's cameras — the dashboard's
  // quick-action search passes it, and the group list says which cameras that
  // is. `null` means "no site filter", which is not the same as "no cameras".
  const siteParam = searchParams.get('site') || '';
  const { data: groups = [] } = useGroups({ enabled: !!siteParam });
  const siteCodes = useMemo(() => {
    if (!siteParam) return null;
    const g = groups.find((grp) => String(grp.id) === siteParam);
    if (!g) return null;
    return new Set((g.cameras || []).map((c) => c.monitorId).filter(Boolean));
  }, [siteParam, groups]);

  const { data: camData } = useQuery({
    queryKey: ['eventlog-cameras'],
    queryFn: () => aiService.listCameraAiSettings(),
    staleTime: 5 * 60_000,
  });
  const camMap = useMemo(() => {
    const list = camData?.data || camData?.cameras || (Array.isArray(camData) ? camData : []);
    const m = {};
    for (const c of list) if (c?.monitorId) m[c.monitorId] = c.name || c.monitorId;
    return m;
  }, [camData]);

  const { data, isLoading } = useQuery({
    queryKey: ['eventlog', type, date],
    queryFn: () => aiService.activityEvents({
      types: type === 'all' ? undefined : type,
      date: date || undefined,
      limit: 500,
    }),
    refetchInterval: 5000,
  });

  // Real events when the backend answers; demo fallback otherwise. The API
  // already filtered by type/date — the demo rows filter client-side.
  const { events, usingDemo } = useMemo(() => {
    let rows = data?.events || [];
    let demo = false;
    if (!rows.length && isDemoSession()) {
      rows = demoEvents(date).filter((e) => type === 'all' || e.kind === type);
      demo = true;
    }
    const q = nameQuery.trim().toLowerCase();
    return {
      usingDemo: demo,
      events: rows.filter((e) =>
        (camFilter === 'all' || e.camera === camFilter) &&
        (!siteCodes || siteCodes.has(e.camera) || siteCodes.has(e.stream)) &&
        (!q || (e.subject || '').toLowerCase().includes(q)),
      ),
    };
  }, [data, date, type, nameQuery, camFilter, siteCodes, demoEvents]);

  const cameras = useMemo(() => {
    const seen = new Map();
    for (const e of events) {
      if (e.camera && !seen.has(e.camera)) seen.set(e.camera, camMap[e.camera] || e.camera);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [events, camMap]);

  function exportCsv() {
    const head = ['Date', 'Time (IST)', 'Kind', 'Type', 'Subject', 'Camera', 'Detail'];
    const lines = events.map((e) => [
      istDateKey(e.ts), fmtClock(e.ts), e.kind, e.type, e.subject || 'Unknown',
      camMap[e.camera] || e.camera || '', e.detail || '',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [head.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `event-log-${date || 'recent'}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    // Frame, inset and header come from OperationsPage so this page lines up
    // with every other Live & Records page instead of centring itself at 896px.
    <OperationsPage>
      <PageHeader
        icon={ScrollText}
        title="Event Log"
        description="Every meaningful event — attendance and alerts — in one searchable timeline. Times in IST."
        actions={
          <>
            {usingDemo ? (
              <StatusBadge tone="warning" title="No backend connected — showing realistic dummy events">Demo data</StatusBadge>
            ) : (
              <StatusBadge status="live" pulse />
            )}
            <PageAction onClick={exportCsv} disabled={!events.length} type="button" className="disabled:opacity-40">
              <Download className="h-3.5 w-3.5" strokeWidth={2} /> Export CSV
            </PageAction>
          </>
        }
      />

      <PageContent className="gap-4">
        {/* filters */}
        <PageCard className="shrink-0 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <PageTabs tabs={TYPES} active={type} onChange={setType} />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="h-9 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary focus:border-brand focus:outline-none" />
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" strokeWidth={2} />
              <input value={nameQuery} onChange={(e) => setNameQuery(e.target.value)} placeholder="Filter by name…"
                className="h-9 w-48 rounded-lg border border-line bg-surface pl-8 pr-7 text-small text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none" />
              {nameQuery && <button onClick={() => setNameQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>}
            </div>
            {cameras.length > 1 && (
              <select value={camFilter} onChange={(e) => setCamFilter(e.target.value)}
                className="h-9 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary focus:border-brand focus:outline-none">
                <option value="all">All cameras</option>
                {cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </div>
        </PageCard>

        {/* timeline — fills the rest of the frame and scrolls inside itself */}
        <PageCard className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-4 py-3">
            <ScrollText className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
            <h2 className="text-sm font-semibold text-fg sm:text-base">Events</h2>
            <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-caption font-bold tabular-nums text-fg-muted">{events.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading && !events.length ? <Empty text="Loading…" />
              : events.length === 0 ? <Empty text="No events match these filters." />
              : events.map((e, i) => {
                const l = look(e);
                const cam = camMap[e.camera] || e.camera;
                return (
                  <div key={i} className="flex items-center gap-3 border-t border-line-subtle px-4 py-2.5 first:border-t-0">
                    <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${l.cls}`}><l.Icon className="h-3.5 w-3.5" strokeWidth={2} /></span>
                    <span className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-micro font-bold uppercase ${l.cls}`}>{l.tag}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <UserRound className="h-3 w-3 shrink-0 text-fg-disabled" strokeWidth={2} />
                        <span className={`truncate text-small font-semibold ${e.subject ? 'text-fg' : 'text-fg-subtle italic'}`}>{e.subject || 'Unknown person'}</span>
                      </div>
                      <div className="truncate text-caption text-fg-muted">{e.detail}{cam ? ` · ${cam}` : ''}</div>
                    </div>
                    <span className="shrink-0 text-micro font-medium tabular-nums text-fg-subtle">{fmtClock(e.ts)}</span>
                  </div>
                );
              })}
          </div>
        </PageCard>
      </PageContent>
    </OperationsPage>
  );
}

function Empty({ text }) {
  return <div className="px-4 py-12 text-center text-small text-fg-subtle">{text}</div>;
}
