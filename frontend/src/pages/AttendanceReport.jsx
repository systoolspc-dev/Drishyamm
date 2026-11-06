import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DoorOpen, LogIn, LogOut, UserRound, Search, Download, CalendarDays,
  Users, Clock, X,
  ShieldAlert, TriangleAlert, MoonStar, Check, Activity,
} from 'lucide-react';
import { aiService } from '@/services/ai';

// ── time helpers (always India time, whatever the browser is on) ──────────────
const IST_OFFSET = 19800; // +05:30 in seconds
const DAY = 86400;

function istDayStart(offsetDays = 0) {
  // Real epoch (seconds) of IST midnight, `offsetDays` days ago.
  const now = Date.now() / 1000;
  const istMidnight = Math.floor((now + IST_OFFSET) / DAY) * DAY;
  return istMidnight - IST_OFFSET - offsetDays * DAY;
}
function dateInputToEpoch(str) {
  // "YYYY-MM-DD" (an IST calendar day) → epoch seconds at IST midnight.
  const t = Date.parse(`${str}T00:00:00+05:30`);
  return Number.isNaN(t) ? null : t / 1000;
}
function fmtClock(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata',
    });
  } catch { return '—'; }
}
function fmtDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts * 1000).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch { return '—'; }
}
function istDateKey(ts) {
  // "YYYY-MM-DD" of the IST calendar day this ts falls in.
  return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// Minutes since midnight IST — used to flag late arrivals against a work-start time.
function istMinutes(ts) {
  if (!ts) return null;
  try {
    const s = new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  } catch { return null; }
}
function hhmmToMin(s) { const [h, m] = (s || '09:30').split(':').map(Number); return (h || 0) * 60 + (m || 0); }

const RANGES = [
  { key: 'today', label: 'Today', from: () => istDayStart(0) },
  { key: '7d',    label: 'Last 7 days',  from: () => istDayStart(6) },
  { key: '30d',   label: 'Last 30 days', from: () => istDayStart(29) },
  { key: 'all',   label: 'All time', from: () => 0 },
];

export default function AttendanceReport() {
  const [rangeKey, setRangeKey] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [dir, setDir] = useState('all');   // all | in | out
  const [sortKey, setSortKey] = useState('clockin'); // clockin | last | name | inside
  const [camFilter, setCamFilter] = useState('all'); // 'all' | monitorId
  const [workStart, setWorkStart] = useState('09:30'); // late = clock-in after this (IST)

  // The whole crossing history (name, direction, ts, duration) — we filter it
  // client-side. Poll so the report stays live while people move.
  const { data, isLoading } = useQuery({
    queryKey: ['attendance-report-crossings'],
    queryFn: () => aiService.activityCrossings({ limit: 1000 }),
    refetchInterval: 5000,
  });
  const { data: today } = useQuery({
    queryKey: ['attendance-report-today'],
    queryFn: () => aiService.activityAttendance(),
    refetchInterval: 5000,
  });
  // monitorId → friendly camera name, so in/out shows WHICH camera recognised them.
  const { data: camData } = useQuery({
    queryKey: ['attendance-report-cameras'],
    queryFn: () => aiService.listCameraAiSettings(),
    staleTime: 5 * 60_000,
  });
  const camMap = useMemo(() => {
    const list = camData?.data || camData?.cameras || (Array.isArray(camData) ? camData : []);
    const m = {};
    for (const c of list) { if (c?.monitorId) m[c.monitorId] = c.name || c.monitorId; }
    return m;
  }, [camData]);

  // Policy alerts (watchlist / stranger / after-hours) — the top of the funnel.
  const qc = useQueryClient();
  const { data: alertsData } = useQuery({
    queryKey: ['attendance-report-alerts'],
    queryFn: () => aiService.activityAlerts({ limit: 50 }),
    refetchInterval: 5000,
  });
  const ackAlert = (id) => aiService.activityAckAlert(id)
    .then(() => qc.invalidateQueries({ queryKey: ['attendance-report-alerts'] })).catch(() => {});

  // Detection-funnel health — is the noise→signal collapse actually happening?
  // Follows the report's single-day selection; multi-day ranges default to today.
  const metricsDate = rangeKey === 'custom' ? (customTo || customFrom || null) : null;
  const { data: metrics } = useQuery({
    queryKey: ['attendance-report-metrics', metricsDate],
    queryFn: () => aiService.activityMetrics(metricsDate),
    refetchInterval: 15000,
  });

  // Normalise every crossing once.
  const all = useMemo(() => (data?.crossings || []).map((c) => ({
    name: c.name || 'Unknown',
    known: !!c.name,
    direction: c.direction,
    ts: c.ts,
    duration_sec: c.duration_sec,
    dateKey: istDateKey(c.ts),
    cameraId: c.stream || '',
    camera: camMap[c.stream] || (c.stream === 'recognition' ? 'Recognised' : c.stream) || '—',
  })), [data, camMap]);

  // Distinct cameras present in the data (for the camera filter).
  const cameras = useMemo(() => {
    const seen = new Map();
    for (const r of all) { if (r.cameraId && !seen.has(r.cameraId)) seen.set(r.cameraId, r.camera); }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);

  // Distinct names for the picker (known people first, alphabetical).
  const names = useMemo(() => {
    const s = new Set(all.filter((r) => r.known).map((r) => r.name));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [all]);

  // Active date window (epoch seconds).
  const [fromTs, toTs] = useMemo(() => {
    if (rangeKey === 'custom') {
      const f = customFrom ? dateInputToEpoch(customFrom) : 0;
      const t = customTo ? dateInputToEpoch(customTo) + DAY : Number.MAX_SAFE_INTEGER;
      return [f ?? 0, t];
    }
    const r = RANGES.find((x) => x.key === rangeKey) || RANGES[0];
    return [r.from(), Number.MAX_SAFE_INTEGER];
  }, [rangeKey, customFrom, customTo]);

  // Apply all filters.
  const rows = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    return all.filter((r) =>
      r.ts >= fromTs && r.ts < toTs &&
      (dir === 'all' || r.direction === dir) &&
      (camFilter === 'all' || r.cameraId === camFilter) &&
      (!q || r.name.toLowerCase().includes(q)),
    );
  }, [all, fromTs, toTs, dir, nameQuery, camFilter]);

  // Per-person roll-up over the filtered window.
  const people = useMemo(() => {
    const map = new Map();
    // walk oldest→newest so clock-in / clock-out land correctly
    const ordered = [...rows].sort((a, b) => a.ts - b.ts);
    for (const r of ordered) {
      let p = map.get(r.name);
      if (!p) { p = { name: r.name, known: r.known, in: 0, out: 0, first: r.ts, last: r.ts, inside: 0, lastDir: null, clockIn: null, clockOut: null }; map.set(r.name, p); }
      if (r.direction === 'in') { p.in += 1; if (p.clockIn == null) p.clockIn = r.ts; }
      else { p.out += 1; p.clockOut = r.ts; if (r.duration_sec) p.inside += r.duration_sec; }
      p.first = Math.min(p.first, r.ts);
      p.last = Math.max(p.last, r.ts);
      p.lastDir = r.direction;
    }
    // authoritative "currently inside" for today, when the window includes today
    const todayPeople = new Map((today?.people || []).map((x) => [x.name, x]));
    const wsMin = hhmmToMin(workStart);
    const arr = Array.from(map.values()).map((p) => {
      const tp = todayPeople.get(p.name);
      const insideNow = tp ? !!tp.currently_inside : p.lastDir === 'in';
      const inside = tp && rangeKey === 'today' ? (tp.total_inside_sec || p.inside) : p.inside;
      // away = time between first arrival and last departure NOT spent on-site
      // (breaks + stepped-out gaps). on-site 'inside' already excludes breaks.
      const away = Math.max(0, (p.last - p.first) - inside);
      const clockIn = p.clockIn ?? p.first;
      const clockOut = insideNow ? null : (p.clockOut ?? p.last);
      const ci = istMinutes(clockIn);
      const late = ci != null && ci > wsMin;                 // arrived after the work-start time
      return { ...p, insideNow, inside, away, clockIn, clockOut, late };
    });
    const cmp = {
      clockin: (a, b) => (a.clockIn || 0) - (b.clockIn || 0),
      last: (a, b) => b.last - a.last,
      name: (a, b) => a.name.localeCompare(b.name),
      inside: (a, b) => b.inside - a.inside,
    }[sortKey] || ((a, b) => (a.clockIn || 0) - (b.clockIn || 0));
    return arr.sort(cmp);
  }, [rows, today, sortKey, rangeKey, workStart]);

  const totals = useMemo(() => ({
    in: rows.filter((r) => r.direction === 'in').length,
    out: rows.filter((r) => r.direction === 'out').length,
    people: people.length,
    inside: people.filter((p) => p.insideNow).length,
    late: people.filter((p) => p.late).length,
    hours: people.reduce((a, p) => a + (p.inside || 0), 0),
  }), [rows, people]);

  const feed = useMemo(() => [...rows].sort((a, b) => b.ts - a.ts), [rows]);

  function exportCsv() {
    // Export the per-person attendance summary (what HR/payroll needs), not the raw feed.
    const head = ['Name', 'Recognized', 'Date', 'Clock-in (IST)', 'Clock-out (IST)', 'Hours on-site', 'Away (h)', 'Late', 'Status'];
    const lines = people.map((p) => [
      p.name, p.known ? 'yes' : 'no', istDateKey(p.clockIn),
      fmtClock(p.clockIn), p.clockOut ? fmtClock(p.clockOut) : 'still in',
      (p.inside / 3600).toFixed(2), (p.away / 3600).toFixed(2),
      p.late ? 'yes' : 'no', p.insideNow ? 'IN' : 'LEFT',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [head.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${rangeKey}-${istDateKey(Date.now() / 1000)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filtersActive = nameQuery || dir !== 'all' || rangeKey !== 'today' || camFilter !== 'all';

  return (
    <div className="mx-auto max-w-7xl px-4 py-5">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <DoorOpen className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Attendance Report</h1>
          <p className="text-small text-fg-muted">
            Who was on-site, when, and for how long — recognized across all cameras. Clock-in = first sighting, clock-out = last. Times IST.
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={!feed.length}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary hover:bg-surface-sunken disabled:opacity-40"
        >
          <Download className="h-4 w-4" /> Export CSV
        </button>
      </div>

      <AlertsPanel data={alertsData} camMap={camMap} onAck={ackAlert} />

      {/* Filter bar */}
      <div className="mb-4 rounded-xl border border-line bg-surface p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          {/* date range presets */}
          <div className="inline-flex items-center gap-1 rounded-lg bg-surface-muted p-0.5">
            {RANGES.map((r) => (
              <button key={r.key} onClick={() => setRangeKey(r.key)}
                className={`rounded-md px-2.5 py-1.5 text-small font-semibold transition ${rangeKey === r.key ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>
                {r.label}
              </button>
            ))}
            <button onClick={() => setRangeKey('custom')}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-small font-semibold transition ${rangeKey === 'custom' ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>
              <CalendarDays className="h-3.5 w-3.5" /> Custom
            </button>
          </div>

          {rangeKey === 'custom' && (
            <div className="inline-flex items-center gap-1.5 text-small text-fg-muted">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-md border border-line px-2 py-1.5 text-small text-fg-secondary" />
              <span>to</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-md border border-line px-2 py-1.5 text-small text-fg-secondary" />
            </div>
          )}

          {/* name filter */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
            <input
              list="attendance-names"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="Filter by name…"
              className="w-52 rounded-lg border border-line py-2 pl-8 pr-7 text-small text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none"
            />
            <datalist id="attendance-names">
              {names.map((n) => <option key={n} value={n} />)}
            </datalist>
            {nameQuery && (
              <button onClick={() => setNameQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* direction */}
          <div className="inline-flex items-center gap-1 rounded-lg bg-surface-muted p-0.5">
            {[['all', 'All'], ['in', 'In'], ['out', 'Out']].map(([k, l]) => (
              <button key={k} onClick={() => setDir(k)}
                className={`rounded-md px-2.5 py-1.5 text-small font-semibold transition ${dir === k ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>
                {l}
              </button>
            ))}
          </div>

          {/* camera */}
          {cameras.length > 1 && (
            <select value={camFilter} onChange={(e) => setCamFilter(e.target.value)}
              className="rounded-lg border border-line bg-surface py-2 px-2.5 text-small font-semibold text-fg-secondary focus:border-brand focus:outline-none">
              <option value="all">All cameras</option>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}

          {/* work-start time → flags late arrivals */}
          <label className="inline-flex items-center gap-1.5 text-caption text-fg-muted" title="Arrivals after this are flagged late">
            <span className="hidden md:inline">Work starts</span>
            <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)}
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-small font-semibold text-fg-secondary focus:border-brand focus:outline-none" />
          </label>

          {filtersActive && (
            <button onClick={() => { setNameQuery(''); setDir('all'); setRangeKey('today'); setCamFilter('all'); }}
              className="ml-auto text-small font-semibold text-brand hover:underline">
              Reset filters
            </button>
          )}
        </div>
      </div>

      {/* Summary — attendance at a glance */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard icon={Users} tone="blue" label="Present" value={totals.people} />
        <SummaryCard icon={DoorOpen} tone="green" label="On-site now" value={totals.inside} />
        <SummaryCard icon={TriangleAlert} tone="amber" label="Late arrivals" value={totals.late} />
        <SummaryCard icon={Clock} tone="slate" label="Total on-site" value={`${(totals.hours / 3600).toFixed(1)}h`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Per-person */}
        <section className="rounded-xl border border-line bg-surface shadow-sm">
          <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
            <UserRound className="h-4 w-4 text-fg-subtle" />
            <h2 className="text-body font-bold text-fg">Attendance ({people.length})</h2>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}
              className="ml-auto rounded-md border border-line px-2 py-1 text-caption font-semibold text-fg-secondary">
              <option value="clockin">Sort: arrival</option>
              <option value="inside">Sort: hours</option>
              <option value="name">Sort: name</option>
              <option value="last">Sort: recent</option>
            </select>
          </div>
          <div className="max-h-[calc(var(--app-vh)*0.62)] overflow-y-auto">
            {isLoading ? <Empty text="Loading…" />
              : people.length === 0 ? <Empty text="No people match these filters." />
              : (
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-surface-sunken/90 text-micro uppercase tracking-wide text-fg-subtle backdrop-blur">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Name</th>
                      <th className="px-2 py-2 font-semibold">Clock-in</th>
                      <th className="px-2 py-2 font-semibold">Clock-out</th>
                      <th className="px-2 py-2 text-right font-semibold">Hours</th>
                      <th className="px-4 py-2 text-right font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.name} className="border-t border-line-subtle hover:bg-surface-sunken/60">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${p.insideNow ? 'bg-success' : 'bg-line-strong'}`} />
                            <span className={`text-small font-semibold ${p.known ? 'text-fg' : 'text-fg-subtle italic'}`}>{p.name}</span>
                          </div>
                          <div className="mt-0.5 pl-3.5 text-micro text-fg-subtle">{fmtDate(p.clockIn)} · {p.in}× in{p.out ? ` · ${p.out}× out` : ''}</div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="text-small font-semibold tabular-nums text-fg-secondary">{fmtClock(p.clockIn)}</div>
                          {p.late && <span className="mt-0.5 inline-block rounded bg-warning-soft px-1 py-px text-micro font-bold uppercase tracking-wide text-warning-ink">late</span>}
                        </td>
                        <td className="px-2 py-2.5 text-small tabular-nums text-fg-secondary">
                          {p.clockOut ? fmtClock(p.clockOut) : <span className="text-micro font-semibold text-success-ink">— still in —</span>}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <div className="text-small font-semibold tabular-nums text-fg-secondary">{fmtDur(p.inside)}</div>
                          {p.away > 300 && <div className="text-micro text-warning" title="stepped out / away">away {fmtDur(p.away)}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {p.insideNow
                            ? <span className="rounded-full bg-success-soft px-2 py-0.5 text-micro font-bold text-success-ink">IN</span>
                            : <span className="rounded-full bg-surface-muted px-2 py-0.5 text-micro font-bold text-fg-muted">LEFT</span>}
                        </td>

                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </section>

        {/* Entry / exit log */}
        <section className="rounded-xl border border-line bg-surface shadow-sm">
          <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
            <Clock className="h-4 w-4 text-fg-subtle" />
            <h2 className="text-body font-bold text-fg">Activity log</h2>
            <span className="text-caption text-fg-subtle">every in/out sighting ({feed.length})</span>
            <span className="ml-auto inline-flex items-center gap-1 rounded bg-success-soft px-1.5 py-0.5 text-micro font-bold text-success-ink">
              <span className="h-1 w-1 rounded-full bg-success" /> live
            </span>
          </div>
          <div className="max-h-[calc(var(--app-vh)*0.62)] overflow-y-auto">
            {feed.length === 0 ? <Empty text="No crossings match these filters." />
              : feed.map((c, i) => {
                const isIn = c.direction === 'in';
                return (
                  <div key={i} className="flex items-center gap-2.5 border-t border-line-subtle px-4 py-2.5">
                    {isIn ? <LogIn className="h-4 w-4 shrink-0 text-success" /> : <LogOut className="h-4 w-4 shrink-0 text-fg-subtle" />}
                    <span className={`w-7 shrink-0 text-micro font-bold ${isIn ? 'text-success-ink' : 'text-fg-subtle'}`}>{isIn ? 'IN' : 'OUT'}</span>
                    <span className={`min-w-0 flex-1 truncate text-small font-semibold ${c.known ? 'text-fg' : 'text-fg-subtle italic'}`}>{c.name}</span>
                    <span className="hidden shrink-0 max-w-[130px] truncate rounded bg-surface-muted px-1.5 py-0.5 text-micro font-medium text-fg-muted sm:inline" title={c.camera}>{c.camera}</span>
                    {!isIn && c.duration_sec != null && <span className="shrink-0 text-micro text-fg-subtle">{fmtDur(c.duration_sec)}</span>}
                    <span className="shrink-0 text-micro tabular-nums text-fg-subtle">{fmtDate(c.ts)}</span>
                    <span className="shrink-0 text-micro font-medium tabular-nums text-fg-muted">{fmtClock(c.ts)}</span>
                  </div>
                );
              })}
          </div>
        </section>
      </div>

      <HealthStrip data={metrics} camMap={camMap} />
    </div>
  );
}

function HealthStrip({ data, camMap }) {
  if (!data || data.error) return null;
  const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  const cams = (data.per_camera || []).filter((c) => c.detections > 20);
  return (
    <section className="mt-4 rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
        <Activity className="h-4 w-4 text-fg-subtle" />
        <h2 className="text-body font-bold text-fg">Funnel health</h2>
        <span className="text-caption text-fg-subtle">is the noise → signal collapse working?</span>
        {data.date && <span className="ml-auto text-caption tabular-nums text-fg-subtle">{data.date}</span>}
      </div>
      <div className="grid grid-cols-2 gap-px bg-surface-muted sm:grid-cols-4">
        <Health n={data.dedup_ratio != null ? `${data.dedup_ratio}:1` : '—'} l="Dedup ratio" hint={`${(data.detections_today || 0).toLocaleString()} detections → ${data.events_today || 0} events`} />
        <Health n={pct(data.recognition_rate)} l="Recognition rate" hint={`${(data.recognized_today || 0).toLocaleString()} of ${(data.detections_today || 0).toLocaleString()} named`} />
        <Health n={data.max_reentries} l="Max re-entries" hint={`avg ${data.avg_reentries} · ${data.people_today} people`} tone={data.max_reentries > 8 ? 'warn' : 'ok'} />
        <Health n={data.alerts_today} l="Alerts today" hint={`${data.alerts_critical || 0} critical`} tone={data.alerts_critical > 0 ? 'crit' : 'ok'} />
      </div>
      {cams.length > 0 && (
        <div className="border-t border-line-subtle px-4 py-2.5">
          <div className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-fg-subtle">Recognition by camera</div>
          <div className="flex flex-wrap gap-2">
            {cams.map((c) => {
              const name = camMap[c.camera] || c.camera;
              const rate = Math.round(c.recognition_rate * 100);
              const good = rate >= 15;
              return (
                <span key={c.camera} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-caption">
                  <span className={`h-1.5 w-1.5 rounded-full ${good ? 'bg-success' : 'bg-warning'}`} />
                  <span className="font-semibold text-fg-secondary">{name}</span>
                  <span className="tabular-nums text-fg-subtle">{rate}%</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function Health({ n, l, hint, tone = 'ok' }) {
  const c = { ok: 'text-fg', warn: 'text-warning-ink', crit: 'text-danger-ink' }[tone];
  return (
    <div className="bg-surface px-4 py-3">
      <div className={`text-section font-bold leading-none tabular-nums ${c}`}>{n}</div>
      <div className="mt-1 text-micro font-semibold uppercase tracking-wide text-fg-subtle">{l}</div>
      <div className="mt-1 text-micro text-fg-subtle">{hint}</div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, tone }) {
  const tones = {
    green: 'text-success-ink bg-success-soft',
    slate: 'text-fg-secondary bg-surface-muted',
    blue: 'text-info-ink bg-info-soft',
    amber: 'text-warning-ink bg-warning-soft',
  }[tone];
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${tones}`}><Icon className="h-4.5 w-4.5" /></div>
      <div>
        <div className="text-section font-bold leading-none tabular-nums text-fg">{value}</div>
        <div className="mt-1 text-micro font-semibold uppercase tracking-wide text-fg-subtle">{label}</div>
      </div>
    </div>
  );
}

function Empty({ text }) {
  return <div className="px-4 py-10 text-center text-small text-fg-subtle">{text}</div>;
}

const TIER = {
  critical: { icon: ShieldAlert, cls: 'text-danger-ink bg-danger-soft border-danger-line', label: 'Critical' },
  warning: { icon: TriangleAlert, cls: 'text-warning-ink bg-warning-soft border-warning-line', label: 'Warning' },
  info: { icon: MoonStar, cls: 'text-info-ink bg-info-soft border-info-line', label: 'Info' },
};
const TYPE_ICON = { watchlist: ShieldAlert, stranger: UserRound, after_hours: MoonStar };

// Policy alerts, newest first, with tier badge + camera + acknowledge. Renders
// nothing when there are no open alerts, so it stays out of the way until it matters.
function AlertsPanel({ data, camMap, onAck }) {
  const alerts = data?.alerts || [];
  const counts = data?.counts || {};
  const open = alerts.filter((a) => !a.acknowledged);
  if (!open.length) return null;
  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
        <ShieldAlert className="h-4 w-4 text-danger" />
        <h2 className="text-body font-bold text-fg">Alerts</h2>
        <div className="ml-auto flex items-center gap-2 text-micro font-semibold">
          {counts.critical > 0 && <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger-ink">{counts.critical} critical</span>}
          {counts.warning > 0 && <span className="rounded bg-warning-soft px-1.5 py-0.5 text-warning-ink">{counts.warning} warning</span>}
        </div>
      </div>
      <div className="max-h-56 divide-y divide-line-subtle overflow-y-auto">
        {open.slice(0, 20).map((a) => {
          const t = TIER[a.tier] || TIER.info;
          const Icon = TYPE_ICON[a.type] || t.icon;
          const cam = camMap[a.camera] || a.camera;
          return (
            <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${t.cls}`}><Icon className="h-3.5 w-3.5" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-small font-semibold text-fg">{a.subject || 'Unknown person'}</span>
                  <span className={`shrink-0 rounded px-1.5 py-px text-micro font-bold uppercase ${t.cls}`}>{t.label}</span>
                </div>
                <div className="truncate text-caption text-fg-muted">{a.detail}{cam ? ` · ${cam}` : ''}</div>
              </div>
              <span className="shrink-0 text-micro tabular-nums text-fg-subtle">{fmtClock(a.ts)}</span>
              <button onClick={() => onAck(a.id)} title="Acknowledge"
                className="shrink-0 rounded-md border border-line p-1 text-fg-subtle hover:bg-surface-sunken hover:text-success-ink">
                <Check className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
