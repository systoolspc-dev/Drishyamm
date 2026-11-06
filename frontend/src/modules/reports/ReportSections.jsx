/**
 * ReportSections.jsx — the blocks a report page is made of.
 *
 * A report page is the console's ordinary furniture: four summary tiles, then
 * cards with a header row, and inside them tables and one small chart. The
 * only pictures are 76 px thumbnails at the start of table rows — the still
 * stored when the incident was detected — so a row can be recognised without
 * opening it. Nothing on the page imitates the printed PDF; that format
 * belongs to "Download PDF".
 *
 * Counting rules are the server's (reports.service.js). This file only decides
 * how a number is shown. Comparisons with the previous period appear once, on
 * the headline tile, not on every row.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ChevronRight, Clock, ImageIcon, ShieldAlert, UserCheck, UserX, Video, VideoOff,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';
import { MetricCard } from '@/core/ui/metric-card';
import { aiService } from '@/core/services/ai';
import {
  DAYS, delta, fmtDay, fmtWhen, nf, SEVERITY_UI,
} from './report-vocabulary';

/* ─────────────────────────────── shell bits ───────────────────────────── */

/** A card with a header row (title · aside), a body, and an optional footer line. */
export function Card({ title, aside, foot, children, className, bodyClassName }) {
  return (
    <section className={cn('flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm', className)}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-heading text-fg">{title}</h2>
          {aside ? <span className="shrink-0 truncate text-small tabular-nums text-fg-subtle">{aside}</span> : null}
        </div>
      )}
      <div className={cn('min-w-0 flex-1', bodyClassName)}>{children}</div>
      {foot ? <div className="border-t border-line bg-surface-sunken px-4 py-2.5 text-small text-fg-muted">{foot}</div> : null}
    </section>
  );
}

function Empty({ children }) {
  return <p className="px-4 py-6 text-center text-body text-fg-muted">{children}</p>;
}

/**
 * columns: [{ key, title, align, width, nowrap }]; rows: objects of nodes
 * keyed by column. `rest` is the "13 other cameras" line — a sunken last row,
 * so a top-N table still adds up to the total printed beside its heading.
 */
export function DataTable({ columns, rows, rest, empty, minWidth = 560 }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  const cell = (c) => cn(
    'px-4 py-2.5 align-middle text-body',
    c.align === 'right' && 'text-right tabular-nums',
    c.nowrap && 'whitespace-nowrap',
    c.thumb && 'w-[92px] pr-0',
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line bg-surface-sunken">
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={cn(
                  'whitespace-nowrap px-4 py-2 text-left text-caption font-semibold uppercase tracking-wide text-fg-subtle',
                  c.align === 'right' && 'text-right',
                )}
              >
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key ?? i} className="border-b border-line-subtle last:border-0 hover:bg-surface-sunken">
              {columns.map((c) => <td key={c.key} className={cell(c)}>{r[c.key] ?? ''}</td>)}
            </tr>
          ))}
          {rest && (
            <tr className="bg-surface-sunken text-fg-muted">
              {columns.map((c) => <td key={c.key} className={cell(c)}>{rest[c.key] ?? ''}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A two-line cell: the thing, then where or what about it. */
export function Cell2({ one, two }) {
  return (
    <>
      <span className="block font-semibold text-fg">{one}</span>
      {two ? <span className="mt-px block text-small text-fg-muted">{two}</span> : null}
    </>
  );
}

export function SeverityChip({ severity }) {
  const sev = SEVERITY_UI[severity] || SEVERITY_UI.info;
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-caption font-semibold',
      toneClass(sev.tone, 'soft'),
    )}>
      <i className="h-1.5 w-1.5 rounded-full bg-current" />
      {sev.label}
    </span>
  );
}

/** "1,047 open" in the severity's colour, or a quiet "Reviewed". */
function StatusText({ open, severity }) {
  if (!(open > 0)) return <span className="whitespace-nowrap text-fg-muted">Reviewed</span>;
  return (
    <span className={cn('whitespace-nowrap font-semibold', severity === 'critical' ? 'text-danger-ink' : 'text-warning-ink')}>
      {nf(open)} open
    </span>
  );
}

function RowLink({ to, onClick, children }) {
  const cls = 'inline-flex items-center gap-0.5 whitespace-nowrap text-small font-semibold text-brand-ink hover:underline';
  if (to) return <Link to={to} className={cls}>{children} <ChevronRight className="h-3.5 w-3.5" /></Link>;
  return <button type="button" onClick={onClick} className={cls}>{children} <ChevronRight className="h-3.5 w-3.5" /></button>;
}

/* ─────────────────────────────── thumbnails ───────────────────────────── */

// One presigned URL per event id for the life of the page; a table re-render
// must not re-hit the snapshot endpoint for every row.
const snapshotCache = new Map();
function useSnapshot(eventId) {
  // The cache is the source of truth; state only exists to re-render once a
  // fetch lands. Reading the cache synchronously keeps cached rows from
  // flashing a placeholder.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!eventId || snapshotCache.has(eventId)) return undefined;
    let cancelled = false;
    aiService.getSnapshotUrl(eventId)
      .then((r) => { snapshotCache.set(eventId, r?.url || null); if (!cancelled) bump((n) => n + 1); })
      .catch(() => { snapshotCache.set(eventId, null); if (!cancelled) bump((n) => n + 1); });
    return () => { cancelled = true; };
  }, [eventId]);
  return eventId ? (snapshotCache.get(eventId) ?? null) : null;
}

/**
 * The still stored at detection, 76 px wide. Face events carry an s3:// uri
 * (streamed through the byte relay, no fetch); zone events carry a snapshot
 * key resolved through /ai/events/:id/snapshot. A grey placeholder otherwise.
 */
export function EventThumb({ eventId, uri, dim = false }) {
  const direct = aiService.snapshotSrc(uri);
  const fetched = useSnapshot(direct ? null : eventId);
  const url = direct || fetched;
  const [broken, setBroken] = useState(false);
  return (
    <span className={cn('block aspect-video w-[76px] overflow-hidden rounded-md bg-surface-muted', dim && 'opacity-60 grayscale')}>
      {url && !broken
        ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setBroken(true)} />
        : <span className="grid h-full w-full place-items-center text-fg-subtle"><ImageIcon className="h-4 w-4" /></span>}
    </span>
  );
}

/* ─────────────────────────────── summary ──────────────────────────────── */

/**
 * The four numbers, chosen per report type so a Face Detection Report leads
 * with people and a Camera Health Report leads with cameras. Coverage is
 * always the last tile: "nothing happened" and "nobody was looking" produce
 * the same event data, and this is the only number that tells them apart.
 * Values stay in ink; the icon carries the tone.
 */
function tilesFor(report) {
  const s = report.summary || {};
  const c = report.coverage || {};
  const partial = c.cameras > 0 && c.reporting < c.cameras;
  const silentCount = Math.max(0, (c.cameras || 0) - (c.reporting || 0));

  const coverage = {
    icon: partial ? VideoOff : Video,
    label: 'Camera coverage',
    value: `${Math.round(c.percent || 0)}%`,
    tone: partial ? 'warning' : 'success',
    sub: partial ? `${nf(silentCount)} of ${nf(c.cameras)} sent no data` : `All ${nf(c.cameras)} cameras sent data`,
  };

  const change = delta(s.actionable, s.actionablePrevious);
  const attention = (label = 'Needs attention') => ({
    icon: ShieldAlert,
    label,
    value: nf(s.actionable),
    tone: s.actionable > 0 ? 'danger' : 'success',
    sub: change ? `${change.label} vs previous period` : (s.actionable > 0 ? 'First period on record' : 'All clear'),
  });

  const review = {
    icon: Clock,
    label: 'Awaiting review',
    value: nf(s.actionableOpen),
    tone: s.openOver24h > 0 ? 'warning' : 'info',
    sub: s.openOver24h > 0
      ? `${nf(s.openOver24h)} open over 24h`
      : (s.actionableOpen > 0 ? 'All raised within 24h' : 'Nothing waiting'),
  };

  const withEvents = (report.byCamera || []).filter((x) => x.count > 0).length;
  const detections = {
    icon: Activity,
    label: 'Detections',
    value: nf(s.detections),
    tone: 'info',
    sub: `${nf(withEvents)} of ${nf(c.cameras)} cameras`,
  };

  switch (report.type) {
    case 'face':
      return [
        attention('Watchlist matches'),
        { icon: UserCheck, label: 'People recognised', value: nf(s.knownPeople), tone: 'success', sub: 'Enrolled faces seen' },
        { icon: UserX, label: 'Unrecognised sightings', value: nf(s.unknownSightings), tone: 'neutral', sub: 'Faces not on file' },
        coverage,
      ];
    case 'restricted_area':
      return [attention('Zone entries'), review, detections, coverage];
    case 'occupancy': {
      const occ = report.occupancy;
      const cams = (occ?.perCamera || []).filter((x) => x.peak != null || x.avg != null);
      const peakCam = cams.reduce((best, x) => (x.peak != null && (best == null || x.peak > best.peak) ? x : best), null);
      return [
        attention('Capacity incidents'),
        {
          icon: Activity, label: 'Peak occupancy', tone: 'info',
          value: peakCam ? nf(peakCam.peak) : '—',
          sub: peakCam ? `${peakCam.name || peakCam.monitorId}${peakCam.peakAt ? ` · ${fmtWhen(peakCam.peakAt)}` : ''}` : 'No camera counted heads',
        },
        review,
        coverage,
      ];
    }
    case 'camera_health':
    case 'recording':
      return [
        { icon: Video, label: 'Cameras', value: nf(c.cameras), tone: 'info', sub: 'In scope' },
        {
          icon: VideoOff, label: 'Offline now', value: nf(c.offlineNow),
          tone: c.offlineNow > 0 ? 'danger' : 'success',
          sub: c.offlineNow > 0 ? 'Not streaming when generated' : 'All online',
        },
        { icon: Activity, label: 'Sent data', value: nf(c.reporting), tone: 'info', sub: `of ${nf(c.cameras)} cameras in the period` },
        coverage,
      ];
    case 'incident':
      return [
        attention('Incidents'),
        { icon: Clock, label: 'Still open', value: nf(s.actionableOpen), tone: s.actionableOpen > 0 ? 'warning' : 'success', sub: s.actionableOpen > 0 ? 'Not yet acknowledged' : 'All acknowledged' },
        { icon: Clock, label: 'Open over 24h', value: nf(s.openOver24h), tone: s.openOver24h > 0 ? 'warning' : 'info', sub: s.openOver24h > 0 ? 'Waiting more than a day' : 'None overdue' },
        coverage,
      ];
    default:
      return [attention(), review, detections, coverage];
  }
}

export function SummaryTiles({ report }) {
  // Four tiles stay on one row from `lg` up. The product-wide MetricGrid
  // only goes four-across at `xl`, which left the coverage tile orphaned on
  // a second row at laptop widths.
  return (
    <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
      {tilesFor(report).map((t) => <MetricCard key={t.label} {...t} />)}
    </div>
  );
}

/** What this report cannot tell you — only when the server has something to say. */
export function Notes({ report }) {
  if (!report.notes?.length) return null;
  return (
    <ul className="space-y-1 border-l-2 border-brand-line pl-3">
      {report.notes.map((n) => <li key={n} className="text-small text-fg-muted">{n}</li>)}
    </ul>
  );
}

/* ─────────────────────────────── incidents ────────────────────────────── */

function bucketTitle(i) {
  switch (i.bucket) {
    case 'watchlist': return 'Watchlist match';
    case 'zone': return 'Restricted-zone entry';
    case 'crowd': return 'Crowding / capacity';
    case 'weapon': return 'Possible weapon';
    case 'fire': return 'Possible fire or smoke';
    case 'camera': return 'Camera stopped sending video';
    case 'unknown': return 'Unrecognised person';
    case 'known': return 'Recognised person';
    default: return String(i.eventType || 'Activity').replace(/[._]/g, ' ');
  }
}

const INCIDENT_COLUMNS = [
  { key: 'thumb', title: '', thumb: true },
  { key: 'what', title: 'Incident' },
  { key: 'camera', title: 'Camera' },
  { key: 'times', title: 'Times', align: 'right', width: 80 },
  { key: 'last', title: 'Last seen', width: 130, nowrap: true },
  { key: 'sev', title: 'Severity', width: 100 },
  { key: 'status', title: 'Status', width: 100 },
  { key: 'go', title: '', width: 90, align: 'right' },
];

/**
 * One row per recurring thing, not per occurrence: "Restricted-zone entry ·
 * Loading Bay · 1,189 times". The log already exists; this is the summary.
 * Reports saved before incidents were grouped carry `count`, not `occurrences`.
 */
export function Incidents({ report, title = 'Needs attention', onOpenClip, empty = 'Nothing needed attention in this period.' }) {
  const list = report.incidents || [];
  const total = report.summary?.actionable || 0;
  const rows = list.map((i) => {
    const times = i.occurrences ?? i.count ?? 1;
    const open = i.openOccurrences ?? (i.acknowledgedAt ? 0 : times);
    return {
      key: i.id,
      thumb: <EventThumb eventId={i.snapshotEventId} uri={i.snapshotUri} />,
      what: <Cell2 one={bucketTitle(i)} two={i.zone ? `Zone: ${i.zone}` : i.subject} />,
      camera: <Cell2 one={i.cameraName} two={i.siteName || null} />,
      times: nf(times),
      last: <span className="tabular-nums text-fg-secondary">{fmtWhen(i.lastSeen)}</span>,
      sev: <SeverityChip severity={i.severity} />,
      status: <StatusText open={open} severity={i.severity} />,
      go: <RowLink onClick={() => onOpenClip?.(i)}>Footage</RowLink>,
    };
  });
  return (
    <Card
      title={title}
      aside={list.length ? `${nf(list.length)} incident${list.length === 1 ? '' : 's'} · grouped by what, where and who` : null}
      foot={total > list.length ? `The ${nf(list.length)} most significant of ${nf(total)} incidents. The CSV export carries the full list.` : null}
    >
      <DataTable columns={INCIDENT_COLUMNS} rows={rows} empty={empty} minWidth={760} />
    </Card>
  );
}

/* ─────────────────────────────── breakdown ────────────────────────────── */

/** Everything the cameras saw, routine traffic included. Name, count and a bar. */
export function Breakdown({ report, title = 'What was detected', excludeRoutine = false }) {
  const rows = (report.breakdown || []).filter((b) => !excludeRoutine || !b.routine);
  const total = excludeRoutine ? rows.reduce((n, b) => n + (b.primary || 0), 0) : (report.summary?.detections || 0);
  const max = Math.max(1, ...rows.map((b) => b.primary || 0));
  return (
    <Card
      title={title}
      aside={total ? `${nf(total)} ${excludeRoutine ? 'incidents' : 'detections'}` : null}
      bodyClassName="flex flex-col justify-evenly gap-3 px-4 py-3"
    >
      {rows.length === 0
        ? <Empty>Nothing was detected in this period.</Empty>
        : rows.map((b) => (
          <div key={b.bucket} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
            <span className="truncate text-body font-medium text-fg">{b.name}</span>
            <span className="whitespace-nowrap text-body font-semibold tabular-nums text-fg">
              {nf(b.primary)}<span className="ml-1 text-small font-normal text-fg-muted">{b.primaryUnit}</span>
            </span>
            <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
              <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(1.5, ((b.primary || 0) / max) * 100)}%` }} />
            </span>
          </div>
        ))}
    </Card>
  );
}

/* ──────────────────────────── when and where ──────────────────────────── */

const niceStep = (m) => {
  if (!(m > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(m));
  const f = m / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const tick = (v) => (v >= 1000 ? `${v / 1000}k` : String(v));

/**
 * One series on one scale: a column a day, the busiest day solid, round
 * numbers on the axis. `days`: [{ day, count }].
 */
export function DayChart({ days, unit = 'detections' }) {
  const data = (days || []).filter((d) => d.count != null);
  if (!data.length) return <Empty>No activity in this period.</Empty>;

  const W = 560; const H = 140; const padL = 40; const padR = 6; const top = 14; const bottom = 24;
  const max = Math.max(...data.map((d) => d.count));
  const step = niceStep(max / 3);
  const yMax = Math.max(step, Math.ceil(max / step) * step);
  const ih = H - top - bottom; const iw = W - padL - padR;
  const y = (v) => top + ih - (v / yMax) * ih;
  const n = data.length; const slot = iw / n; const bw = Math.min(36, slot * 0.55);
  const peak = data.reduce((a, d) => (d.count > a.count ? d : a), data[0]);
  // Label every column up to a fortnight, then thin the labels out.
  const every = n > 16 ? Math.ceil(n / 8) : 1;
  const ticks = []; for (let v = 0; v <= yMax; v += step) ticks.push(v);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${unit} per day`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="stroke-line" strokeWidth="1" />
          <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="fill-fg-subtle text-[11px] tabular-nums">{tick(v)}</text>
        </g>
      ))}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="stroke-line-strong" strokeWidth="1" />
      {data.map((d, i) => {
        const x = padL + slot * i + (slot - bw) / 2;
        const h = Math.max(1.5, (d.count / yMax) * ih);
        const isPeak = d === peak;
        return (
          <g key={d.day}>
            <rect x={x} y={y(d.count)} width={bw} height={h} rx="3" className={isPeak ? 'fill-brand' : 'fill-brand/40'}>
              <title>{`${fmtDay(d.day)} — ${nf(d.count)} ${unit}`}</title>
            </rect>
            {isPeak && <text x={x + bw / 2} y={y(d.count) - 6} textAnchor="middle" className="fill-fg text-[11px] font-semibold tabular-nums">{nf(d.count)}</text>}
            {i % every === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="fill-fg-subtle text-[11px]">{fmtDay(d.day)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** Detections per local day, with the one line of facts that matters. */
export function ActivityByDay({ report, title = 'Activity by day', unit = 'detections' }) {
  const days = report.when?.daily || [];
  const peak = days.reduce((a, d) => (d.count > (a?.count ?? -1) ? d : a), null);
  const busiest = report.when?.busiestHour;
  const share = report.when?.afterHoursShare ?? 0;
  const facts = [
    peak ? `Peak ${nf(peak.count)} on ${fmtDay(peak.day)}` : null,
    busiest ? `busiest hour ${DAYS[busiest.dow]} ${String(busiest.hour).padStart(2, '0')}:00` : null,
    share ? `${share}% outside 07:00–19:00` : null,
  ].filter(Boolean).join(' · ');

  return (
    <Card title={title} aside={`${unit} · local days`} bodyClassName="flex flex-col justify-center px-4 py-3">
      <DayChart days={days} unit={unit} />
      {facts && <p className="mt-2 text-small text-fg-muted">{facts}</p>}
    </Card>
  );
}

/** Cameras with the most activity, and a footer naming the ones that sent nothing. */
export function Cameras({ report, title = 'Cameras with most activity', countTitle = 'Events', limit = 6 }) {
  const all = (report.byCamera || []).filter((c) => c.count > 0);
  const shown = all.slice(0, limit);
  const tail = all.slice(limit);
  const cov = report.coverage || {};
  const silentCount = Math.max(0, (cov.cameras || 0) - (cov.reporting || 0));
  const silent = cov.silent || [];

  const columns = [
    { key: 'camera', title: 'Camera' },
    { key: 'events', title: countTitle, align: 'right', width: 100 },
    { key: 'alerts', title: 'Alerts', align: 'right', width: 90 },
    { key: 'last', title: 'Last event', width: 140, nowrap: true },
  ];
  const rows = shown.map((c) => ({
    key: c.monitorId,
    camera: <Cell2 one={c.name} two={c.siteName || null} />,
    events: nf(c.count),
    alerts: nf(c.alerts || 0),
    last: <span className="tabular-nums text-fg-secondary">{c.lastEvent ? fmtWhen(c.lastEvent) : '—'}</span>,
  }));
  const rest = tail.length ? {
    camera: `${nf(tail.length)} other camera${tail.length === 1 ? '' : 's'}`,
    events: nf(tail.reduce((n, c) => n + c.count, 0)),
    alerts: nf(tail.reduce((n, c) => n + (c.alerts || 0), 0)),
  } : null;

  const foot = silentCount > 0 ? (
    <>
      <span className={cn('font-semibold', toneClass('warning', 'text'))}>{nf(silentCount)} cameras sent no data</span>
      {silent.length ? ` · ${silent.slice(0, 4).map((x) => x.name).join(', ')}${silentCount > 4 ? ` +${nf(silentCount - 4)} more` : ''}` : ''}
    </>
  ) : null;

  return (
    <Card title={title} aside={all.length ? `Top ${nf(shown.length)} of ${nf(cov.cameras || 0)}` : null} foot={foot}>
      <DataTable columns={columns} rows={rows} rest={rest} empty="No camera recorded anything." minWidth={520} />
    </Card>
  );
}

/* ─────────────────────────────── people ───────────────────────────────── */

/** People the face gallery recognised, most seen first. */
export function PeopleTable({ report }) {
  const people = [...(report.people || [])].sort((a, b) => (b.sightings || 0) - (a.sightings || 0));
  const shown = people.slice(0, 8);
  const tail = people.slice(8);
  const columns = [
    { key: 'thumb', title: '', thumb: true },
    { key: 'person', title: 'Person' },
    { key: 'wl', title: 'Watchlist', width: 110 },
    { key: 'sightings', title: 'Sightings', align: 'right', width: 100 },
    { key: 'cams', title: 'Cameras', align: 'right', width: 90 },
    { key: 'last', title: 'Last seen', width: 140, nowrap: true },
    { key: 'go', title: '', width: 90, align: 'right' },
  ];
  const rows = shown.map((p) => ({
    key: p.name,
    thumb: <EventThumb eventId={p.snapshotEventId} uri={p.snapshotUri} />,
    person: <span className="font-semibold text-fg">{p.name}</span>,
    wl: p.watchlisted ? <SeverityChip severity="critical" /> : <span className="text-fg-muted">No</span>,
    sightings: nf(p.sightings),
    cams: nf((p.cameras || []).length),
    last: <span className="tabular-nums text-fg-secondary">{fmtWhen(p.lastSeen)}</span>,
    go: <RowLink to={`/person-tracker?name=${encodeURIComponent(p.name)}`}>Journey</RowLink>,
  }));
  return (
    <Card
      title="People seen"
      aside={people.length ? `${nf(people.length)} recognised ${people.length === 1 ? 'person' : 'people'} · by sightings` : null}
      foot={tail.length ? `+${nf(tail.length)} more ${tail.length === 1 ? 'person' : 'people'} · ${nf(tail.reduce((n, p) => n + (p.sightings || 0), 0))} sightings` : null}
    >
      <DataTable columns={columns} rows={rows} empty="No enrolled person was recognised in this period." minWidth={640} />
    </Card>
  );
}

/* ─────────────────────────────── zones ────────────────────────────────── */

export function ZonesTable({ report }) {
  const zones = [...(report.zones || [])].sort((a, b) => (b.entries || 0) - (a.entries || 0));
  const columns = [
    { key: 'thumb', title: '', thumb: true },
    { key: 'zone', title: 'Zone' },
    { key: 'camera', title: 'Camera' },
    { key: 'entries', title: 'Entries', align: 'right', width: 100 },
    { key: 'detections', title: 'Detections', align: 'right', width: 110 },
  ];
  const rows = zones.map((z) => ({
    key: `${z.zone}·${z.cameraName}`,
    thumb: <EventThumb eventId={z.snapshotEventId} uri={z.snapshotUri} />,
    zone: <span className="font-semibold text-fg">{z.zone}</span>,
    camera: <span className="text-fg-secondary">{z.cameraName}</span>,
    entries: nf(z.entries),
    detections: nf(z.detections),
  }));
  return (
    <Card title="Zones with entries" aside={zones.length ? `${nf(zones.length)} zone${zones.length === 1 ? '' : 's'} · by entries` : null}>
      <DataTable columns={columns} rows={rows} empty="No restricted zone recorded an entry in this period." minWidth={520} />
    </Card>
  );
}

/* ─────────────────────────────── occupancy ────────────────────────────── */

/** Head counts per camera; `count NULL ⟺ unknown`, so averages use measured minutes only. */
export function OccupancyTable({ report }) {
  const occ = report.occupancy;
  const cams = [...(occ?.perCamera || [])].filter((c) => c.peak != null || c.avg != null).sort((a, b) => (b.peak || 0) - (a.peak || 0));
  const pct = (c) => {
    const p = (c.measuredMinutes / Math.max(1, occ?.periodMinutes || 1)) * 100;
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
  };
  const columns = [
    { key: 'camera', title: 'Camera' },
    { key: 'avg', title: 'Average', align: 'right', width: 90 },
    { key: 'peak', title: 'Peak', align: 'right', width: 80 },
    { key: 'peakAt', title: 'Peak time', width: 140, nowrap: true },
    { key: 'measured', title: 'Measured', align: 'right', width: 100 },
  ];
  const rows = cams.slice(0, 8).map((c) => ({
    key: c.monitorId,
    camera: <Cell2 one={c.name || c.monitorId} two={c.siteName || null} />,
    avg: c.avg == null ? '—' : String(Math.round(c.avg * 10) / 10),
    peak: c.peak == null ? '—' : nf(c.peak),
    peakAt: <span className="tabular-nums text-fg-secondary">{c.peakAt ? fmtWhen(c.peakAt) : '—'}</span>,
    measured: pct(c),
  }));
  const empty = occ
    ? 'No occupancy was measured in this period. Enable head-count on a camera to start the history.'
    : 'This report was saved before per-camera occupancy was kept. Re-run it to include the measurements.';
  return (
    <Card
      title="Occupancy by camera"
      aside={cams.length ? `${nf(cams.length)} camera${cams.length === 1 ? '' : 's'} with measurements · by peak` : null}
      foot={cams.length > 8 ? `+${nf(cams.length - 8)} more cameras` : null}
    >
      <DataTable columns={columns} rows={rows} empty={empty} minWidth={560} />
    </Card>
  );
}

/** Highest camera count each day. */
export function DailyPeak({ report }) {
  const days = (report.occupancy?.daily || []).filter((d) => d.peak != null).map((d) => ({ day: d.day, count: d.peak }));
  return (
    <Card title="Daily peak occupancy" aside="highest camera count each day" bodyClassName="flex flex-col justify-center px-4 py-3">
      <DayChart days={days} unit="people" />
    </Card>
  );
}

/* ─────────────────────────────── camera status ────────────────────────── */

const Dot = ({ status }) => (
  <i className={cn('mr-1.5 inline-block h-2 w-2 rounded-full align-[0px]', status === 'online' ? 'bg-success' : status === 'offline' ? 'bg-danger' : 'bg-fg-subtle')} />
);
const statusLabel = (s) => (s === 'online' ? 'Online' : s === 'offline' ? 'Offline' : 'Unknown');

/** Every camera in scope, offline first, as it was when the report was generated. */
export function CameraStatusTable({ report }) {
  const cams = report.cameras;               // present on reports generated after this page shipped
  const isRecording = report.type === 'recording';
  const order = (a, b) => (a.status === 'online') - (b.status === 'online') || (b.events || 0) - (a.events || 0) || String(a.name).localeCompare(String(b.name));
  const columns = [
    { key: 'thumb', title: '', thumb: true },
    { key: 'camera', title: 'Camera' },
    { key: 'status', title: 'Status', width: 110, nowrap: true },
    { key: 'events', title: 'Events', align: 'right', width: 90 },
    { key: 'extra', title: isRecording ? 'Retention' : 'Alerts', align: 'right', width: 90 },
    { key: 'lastEvent', title: 'Last event', width: 140, nowrap: true },
    { key: 'lastSeen', title: 'Last seen', width: 140, nowrap: true },
    { key: 'go', title: '', width: 120, align: 'right' },
  ];
  const rows = (cams ? [...cams].sort(order) : []).map((c) => ({
    key: c.monitorId,
    thumb: <EventThumb eventId={c.snapshotEventId} uri={c.snapshotUri} dim={c.status !== 'online'} />,
    camera: <Cell2 one={c.name} two={c.siteName || null} />,
    status: <span className="text-fg"><Dot status={c.status} />{statusLabel(c.status)}</span>,
    events: nf(c.events || 0),
    extra: isRecording ? (c.retentionDays != null ? `${nf(c.retentionDays)} days` : 'Default') : nf(c.alerts || 0),
    lastEvent: c.lastEvent ? <span className="tabular-nums text-fg-secondary">{fmtWhen(c.lastEvent)}</span> : <span className="text-fg-subtle">No data</span>,
    lastSeen: <span className="tabular-nums text-fg-secondary">{c.lastSeenAt ? fmtWhen(c.lastSeenAt) : '—'}</span>,
    go: <RowLink to="/health">Camera Health</RowLink>,
  }));
  const offline = rows.length ? (cams.filter((c) => c.status !== 'online').length) : 0;
  return (
    <Card
      title={isRecording ? 'Camera recording status' : 'Camera status'}
      aside={cams ? `${nf(cams.length)} camera${cams.length === 1 ? '' : 's'} · offline first` : null}
      foot={offline ? `${nf(offline)} offline when the report was generated · anything that happened on a silent camera is missing from every report for this period` : null}
    >
      <DataTable
        columns={columns}
        rows={rows}
        empty={cams ? 'No camera is in the selected scope.' : 'This report was saved before the per-camera status table was kept. Re-run it to include every camera.'}
        minWidth={820}
      />
    </Card>
  );
}

/* ──────────────────────────────── footer ──────────────────────────────── */

const FOOTNOTE = {
  face: 'Recognised people are enrolled faces matched by the gallery; unrecognised sightings are faces not on file, counted per appearance',
  restricted_area: 'Zone entries count incidents: one person crossing a zone repeatedly within 10 minutes is one entry',
  incident: 'An incident is one thing happening in one place: repeated detections of the same event, camera and subject within 10 minutes are grouped',
  occupancy: 'Occupancy is the head count a camera measured, rolled up per minute; overlapping cameras are never summed',
  camera_health: 'Status is the stream supervisor’s view when the report was generated',
  recording: 'Status is the stream supervisor’s view when the report was generated',
};

export function ReportFootnote({ report }) {
  const line = FOOTNOTE[report.type] || 'Counted per incident and per person, not per video frame';
  return (
    <p className="text-caption text-fg-subtle">
      {line} · Times are local ({report.timezone})
    </p>
  );
}
