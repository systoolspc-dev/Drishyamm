import { useMemo, useState } from 'react';
import {
  History, Grid3x3, TrendingUp, TriangleAlert, Download, FileText, CalendarDays,
} from 'lucide-react';
import Panel from '../campus/components/Panel';
import { TH, TH_STICKY } from '../type';
import { useActivityParams } from '../useCaseStore';
import { exportScorecardCsv, exportScorecardPdf, istNow } from '../scorecard-export';
import { Heatmap, Chip } from './components/bits';
import {
  buildZones, buildBuckets, buildMatrix, buildHeatmap, buildPeak, buildZoneSummary,
  buildComplianceLog, historyDays, historyScope, formatDwell,
  HISTORY_RANGES, MAX_CUSTOM_DAYS, HEAT_RAMP, HEAT_EMPTY,
} from './headcount-data';

// ══════════════════════════════════════════════════════════════════════════
//  HISTORICAL HEADCOUNT & DENSITY ANALYTICS
//
//  The reporting half of Zone Headcount. The live half (who is where right
//  now) is the standalone /activity-monitoring/headcount page; this answers
//  "how full did each zone get, when, and did it stay within its limits" over
//  a chosen window, with exports.
//
//  Homes:
//    retail / corporate → the Zone Headcount tab of Retail Analytics
//      (/activity-monitoring/analytics/headcount). The store is the analytics
//      page's scope and arrives as `siteId`.
//    other verticals    → the Historical view of the standalone page.
//
//  Layout, top to bottom:
//    toolbar   title · window · Today | Yesterday | Last 7 Days | Custom ·
//              location · Export CSV / PDF
//    1         Hourly Occupancy Heatmap — zone × business hour, density %
//    2         Peak Traffic & Bottleneck Summary — per zone peak time, max
//              occupancy, dwell, bottleneck flag
//    3         Historical Capacity Compliance Log — every breach in the window
//
//  A multi-day window reads the heatmap and summary as the typical day across
//  it (the matrix stays hourly); the compliance log lists each day's breaches.
// ══════════════════════════════════════════════════════════════════════════

function todayIso() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function shiftIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(y, m - 1, d + days);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

const fmtDay = (iso) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  .format(new Date(`${iso}T00:00:00`));

function windowLabel(days) {
  if (days.length === 1) return fmtDay(days[0]);
  return `${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])} · ${days.length} days`;
}

// "21:00" → "22:00": the heatmap's last bucket covers the hour that ends there.
const hourAfter = (hhmm) => `${String((parseInt(hhmm, 10) + 1) % 24).padStart(2, '0')}:00`;

export default function HeadcountHistory({ siteId, siteLabel }) {
  const { params, label: verticalLabel } = useActivityParams();
  const cfg = params.headcount;
  const words = cfg?.label || { site: 'Site', area: 'Area' };

  const today = useMemo(() => todayIso(), []);
  const [range, setRange] = useState('today');
  const [custom, setCustom] = useState(() => ({ from: shiftIso(today, -13), to: today }));
  const [area, setArea] = useState('');

  const days = useMemo(
    () => historyDays(range, today, custom),
    [range, today, custom],
  );
  const scope = useMemo(() => historyScope(siteId, days), [siteId, days]);
  const buckets = useMemo(() => buildBuckets(params.businessHours, scope), [params.businessHours, scope]);

  const model = useMemo(() => {
    if (!cfg) return null;
    const inArea = (z) => !area || z.area === area;
    const zones = buildZones(cfg, scope).filter(inArea);
    const matrix = buildMatrix(zones, buckets, scope);
    return {
      zones,
      heat: buildHeatmap(matrix),
      peak: buildPeak(matrix, cfg),
      summary: buildZoneSummary(matrix, zones, cfg.breachPct),
      log: buildComplianceLog(cfg, siteId, days, inArea),
    };
  }, [cfg, scope, buckets, area, siteId, days]);

  if (!cfg || !model) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center">
        <p className="text-[13px] font-bold text-fg-secondary">Headcount is not licensed for {verticalLabel}</p>
      </div>
    );
  }

  const { heat, peak, summary, log } = model;
  const areaLabel = area || cfg.areas?.[0] || `All ${words.area.toLowerCase()}s`;
  const hoursLabel = buckets.length ? `${buckets[0]}–${hourAfter(buckets[buckets.length - 1])}` : '';
  const multiDay = days.length > 1;
  const bottlenecks = summary.filter((z) => z.bottleneck);
  const activeBreaches = log.filter((b) => b.state === 'Active').length;

  // ── Export — the scorecard writer, with this report's own section titles ──
  const exportPayload = () => {
    const now = istNow();
    const code = siteId || 'site';
    const period = windowLabel(days);
    return {
      title: 'Historical Headcount & Density Analytics',
      reportId: `RPT-HC-${code}-${now.stamp}`,
      header: [
        ['Report Type', 'Historical Headcount & Density'],
        [`${words.site}`, siteLabel || code],
        ['Period', `${period} (${hoursLabel} IST)`],
        ['Location', areaLabel],
        ['Generated At', now.label],
      ],
      labels: {
        subtitle: `Drishyam Activity Monitoring  -  Zone headcount history for ${verticalLabel}`,
        policy: 'Capacity thresholds',
        summary: 'Window summary',
        footer: 'Generated from anonymous person counts. No identity data.',
        rowNoun: 'zones',
      },
      policy: [
        ['Breach limit', `${cfg.breachPct}% of zone capacity`],
        ['Dwell alert', `${Math.round((cfg.dwellAlertSec || 0) / 60)} min`],
        ...(cfg.densityPerM2 ? [['Density limit', `${cfg.densityPerM2} people / m2`]] : []),
        ['Heatmap basis', multiDay ? `Typical day across ${days.length} days` : 'Single day'],
      ],
      kpis: [
        { label: 'Peak time', value: peak?.site.at || '-', note: peak ? `${peak.site.value} people · ${peak.site.utilization}% of capacity` : '' },
        { label: 'Busiest zone', value: peak?.zone.label || '-', note: peak ? `${peak.zone.utilization}% at ${peak.zone.at}` : '' },
        { label: 'Bottleneck zones', value: String(bottlenecks.length), note: `at or above ${cfg.breachPct}%` },
        { label: 'Threshold breaches', value: String(log.length), note: `${activeBreaches} still active` },
      ],
      tables: [
        {
          title: 'Peak traffic & bottleneck summary',
          columns: ['Zone', 'Area', 'Peak time', 'Max occupancy', 'Capacity', 'Peak util %', 'Avg occupancy', 'Dwell (typical)', 'Longest stay', 'Bottleneck'],
          rows: summary.map((z) => [
            z.label, z.area, z.peakAt, z.max, z.capacity, z.utilization, z.avg,
            z.avgDwellSec == null ? '' : formatDwell(z.avgDwellSec),
            z.maxDwellSec == null ? '' : formatDwell(z.maxDwellSec),
            z.bottleneck ? 'Yes' : 'No',
          ]),
        },
        {
          title: 'Historical capacity compliance log',
          columns: ['Date', 'Time', 'Zone', 'Rule', 'Peak', 'Limit', 'For', 'State'],
          rows: log.length
            ? log.map((b) => [b.date, b.time, b.zone, b.rule, b.peak, b.limit, b.duration, b.state])
            : [['-', '-', 'No breaches in this window', '', '', '', '', '']],
        },
      ],
      filename: `headcount-history_${code}_${days[0]}_${days[days.length - 1]}`,
    };
  };

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {/* ── Toolbar · title, window, range, location, exports ─────────────── */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-3 py-3 shadow-sm sm:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            <History className="h-4 w-4" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-fg sm:text-base">Historical Headcount &amp; Density Analytics</h2>
            <p className="truncate text-caption text-fg-subtle">
              {windowLabel(days)} · {hoursLabel} IST · {summary.length} zones · {areaLabel}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => exportScorecardCsv(exportPayload())} className={btnSecondary}>
              <Download className="h-3.5 w-3.5" /> Export CSV
            </button>
            <button type="button" onClick={() => exportScorecardPdf(exportPayload())} className={btnSecondary}>
              <FileText className="h-3.5 w-3.5" /> Export PDF
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Time range" className="inline-flex flex-wrap items-center rounded-lg border border-line bg-surface-muted p-0.5">
            {HISTORY_RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={range === r.id}
                onClick={() => setRange(r.id)}
                className={`min-h-10 rounded-md px-3 py-1.5 text-[12.5px] transition lg:min-h-0 ${range === r.id ? 'bg-surface font-semibold text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {range === 'custom' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <DateInput label="From" value={custom.from} max={custom.to} onChange={(v) => setCustom((c) => ({ ...c, from: v || c.from }))} />
              <span className="text-caption text-fg-subtle">to</span>
              <DateInput label="To" value={custom.to} min={custom.from} max={today} onChange={(v) => setCustom((c) => ({ ...c, to: v || c.to }))} />
              <span className="text-caption text-fg-subtle">max {MAX_CUSTOM_DAYS} days</span>
            </div>
          )}

          <span className="hidden flex-1 sm:block" />
          <select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            aria-label="Location"
            title="Location"
            className={`${selectCls} ${area ? 'border-brand/40 text-brand-ink' : ''}`}
          >
            <option value="">{cfg.areas?.[0] || `All ${words.area.toLowerCase()}s`}</option>
            {(cfg.areas || []).slice(1).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {/* ── 1 · Hourly Occupancy Heatmap ─────────────────────────────────── */}
      <Panel
        icon={Grid3x3}
        title="Hourly Occupancy Heatmap"
        right={
          <span className="flex items-center gap-1.5 text-[10px] text-fg-subtle">
            0%
            {[HEAT_EMPTY, ...HEAT_RAMP].map((c) => (
              <i key={c} className="block h-2.5 w-4 rounded-[2px] sm:w-5" style={{ background: c }} />
            ))}
            100%+
          </span>
        }
        bodyClass="p-4"
      >
        <p className="mb-3 text-caption text-fg-subtle">
          Density as % of each zone&apos;s capacity, {hoursLabel} IST
          {multiDay ? ` — the typical day across ${days.length} days.` : '.'} Hover a cell for the count.
        </p>
        {heat.length === 0
          ? <p className="py-6 text-center text-[12px] text-fg-subtle">No counted zones in this location.</p>
          : <Heatmap rows={heat} buckets={buckets} />}
      </Panel>

      {/* ── 2 · Peak Traffic & Bottleneck Summary ────────────────────────── */}
      <Panel icon={TrendingUp} title="Peak Traffic & Bottleneck Summary" count={summary.length} bodyClass="p-0">
        {peak && (
          <div className="grid grid-cols-1 gap-px border-b border-line-subtle bg-line-subtle sm:grid-cols-3">
            <Highlight label={multiDay ? 'Typical peak time' : 'Peak time'} value={peak.site.at} sub={`${peak.site.value.toLocaleString('en-IN')} people · ${peak.site.utilization}% of total capacity`} />
            <Highlight label="Fullest zone" value={peak.zone.label} sub={`${peak.zone.count} / ${peak.zone.capacity} (${peak.zone.utilization}%) at ${peak.zone.at}`} tone={peak.zone.utilization >= cfg.breachPct ? 'crit' : ''} />
            <Highlight label="Bottleneck zones" value={String(bottlenecks.length)} sub={`peaked at or above ${cfg.breachPct}% of capacity`} tone={bottlenecks.length ? 'crit' : ''} />
          </div>
        )}
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="text-left">
                <th className={thCls.left}>Zone</th>
                <th className={thCls.left}>Peak time</th>
                <th className={thCls.left}>Max occupancy</th>
                <th className={thCls.right}>Avg</th>
                <th className={thCls.left}>Dwell time</th>
                <th className={thCls.right}>Bottleneck</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {summary.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-fg-subtle">No counted zones in this location.</td></tr>
              ) : summary.map((z) => (
                <tr key={z.id} className="hover:bg-surface-sunken">
                  <td className="px-4 py-2">
                    <p className="text-heading font-semibold text-fg">{z.label}</p>
                    <p className="text-caption text-fg-subtle">{z.typeLabel} · {z.area}</p>
                  </td>
                  <td className="px-4 py-2 font-mono tabular-nums text-fg-secondary">{z.peakAt}</td>
                  <td className="px-4 py-2">
                    <div className="w-36">
                      <span className={`font-semibold tabular-nums ${z.bottleneck ? 'text-danger-ink' : 'text-fg'}`}>
                        {z.max}<span className="font-normal text-fg-subtle"> / {z.capacity} · {z.utilization}%</span>
                      </span>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
                        <div className={`h-full rounded-full ${z.bottleneck ? 'bg-danger' : 'bg-brand/70'}`} style={{ width: `${Math.min(100, z.utilization)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-fg-secondary">{z.avg}</td>
                  <td className="px-4 py-2">
                    {z.avgDwellSec == null ? <span className="text-fg-disabled">—</span> : (
                      <span className="font-mono text-sm tabular-nums text-fg-secondary">
                        {formatDwell(z.avgDwellSec)}
                        {z.maxDwellSec != null && <span className="ml-1 font-sans text-small text-fg-subtle">· longest {formatDwell(z.maxDwellSec)}</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {z.bottleneck ? <Chip status="over" label="Bottleneck" /> : <Chip status="ok" label="Within limit" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ── 3 · Historical Capacity Compliance Log ───────────────────────── */}
      <Panel
        icon={TriangleAlert}
        title="Historical Capacity Compliance Log"
        count={log.length}
        right={<span className="text-caption text-fg-subtle">{activeBreaches} active</span>}
        bodyClass="p-0"
      >
        <div className="scrollbar-thin max-h-[28rem] overflow-auto">
          <table className="w-full min-w-[46rem] border-collapse text-[12px]">
            <thead>
              <tr className="text-left">
                <th className={thCls.left}>Date</th>
                <th className={thCls.left}>Time</th>
                <th className={thCls.left}>Zone</th>
                <th className={thCls.left}>Rule</th>
                <th className={thCls.right}>Peak</th>
                <th className={thCls.right}>Limit</th>
                <th className={thCls.left}>For</th>
                <th className={thCls.right}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {log.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-fg-subtle">Every zone stayed within its thresholds in this window.</td></tr>
              ) : log.map((b) => (
                <tr key={b.id} className="hover:bg-surface-sunken">
                  <td className="whitespace-nowrap px-4 py-2 text-fg-muted">{fmtDay(b.date)}</td>
                  <td className="px-4 py-2 font-mono text-[11px] text-fg-muted">{b.time}</td>
                  <td className="px-4 py-2 text-heading font-semibold text-fg">{b.zone}</td>
                  <td className="px-4 py-2 font-mono text-[11px] text-fg-muted">{b.rule}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums text-fg">{b.peak}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-fg-subtle">{b.limit}</td>
                  <td className="px-4 py-2 font-mono text-[11px] text-fg-muted">{b.duration}</td>
                  <td className="px-4 py-2 text-right">
                    {/* Only an open breach keeps its colour; closed ones go quiet. */}
                    <Chip status={b.state === 'Active' ? b.status : 'empty'} label={b.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Highlight({ label, value, sub, tone = '' }) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-caption font-medium text-fg-muted">{label}</p>
      <p className={`mt-0.5 truncate text-xl font-bold leading-tight tracking-tight ${tone === 'crit' ? 'text-danger-ink' : 'text-fg'}`}>{value}</p>
      <p className="truncate text-xs text-fg-subtle">{sub}</p>
    </div>
  );
}

function DateInput({ label, value, min, max, onChange }) {
  return (
    <div className="relative">
      <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-lg border border-line bg-surface pl-8 pr-2.5 text-[12px] text-fg-secondary outline-none focus:border-brand lg:h-8"
      />
    </div>
  );
}

// The module's sticky header band (type.js TH), over px-4 cells.
const thCls = { left: `${TH_STICKY} ${TH.left}`, right: `${TH_STICKY} ${TH.right}` };
const selectCls = 'h-11 min-w-0 rounded-lg border border-line bg-surface px-2.5 text-[12px] font-semibold text-fg-secondary outline-none focus:border-brand lg:h-8';
const btnSecondary = 'inline-flex h-11 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink lg:h-8';
