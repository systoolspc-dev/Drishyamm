import { useMemo } from 'react';
import {
  ArrowRight,
  Users, Clock, ShieldCheck, UserCheck,
} from 'lucide-react';
import { useActivityParams } from '../useCaseStore';
import { useModuleData } from '../useModuleData';
import PerformanceCharts from '../dashboard/PerformanceCharts';
import { T, TH } from '../type';
import { KpiCard, KpiRow } from '../kpi-card';

// ─────────────────────────────────────────────────────────────────────────────
// /activity-monitoring/analytics/trends — the DEFAULT view. Today, hour by hour.
//
// Reads the same hourly TRENDS buckets the dashboard charts always used, and
// adds the two things a chart alone does not answer: what the peak was, and
// whether today is beating its benchmark. The charts themselves are the
// existing PerformanceCharts component — the dashboard no longer mounts it,
// this page does, so there is still exactly one chart definition.
// ─────────────────────────────────────────────────────────────────────────────

// Hand-set benchmarks stand in for the 30-day rolling averages the API will
// return alongside today's buckets (GET /activity/trends?…&withBenchmark=1).
const BENCHMARK = {
  peakOccupancy: 128,
  peakWait: 4.1,
  avgCoverage: 94,
  presentAtPeak: 11,
};

function pct(now, base) {
  if (!base) return null;
  return Math.round(((now - base) / base) * 100);
}

// A benchmark tile: today's number, and how it sits against the 30-day norm.
// `lowerIsBetter` flips the colour, because a shorter queue is a good miss.
// `icon` sits in a brand-orange badge top-right — decorative, the label names it.
// One benchmark, on the module-wide KPI card (../kpi-card.jsx). The move
// against the 30-day norm is the badge; its tone says whether that move is
// good or bad for this metric, and the icon tile follows it.
function Benchmark({ label, icon, value, unit, base, baseUnit = unit, lowerIsBetter = false, hint }) {
  const delta = pct(value, base);
  const flat = delta === null || delta === 0;
  const worse = lowerIsBetter ? delta > 0 : delta < 0;
  const tone = flat ? 'neutral' : worse ? 'bad' : 'good';

  return (
    <KpiCard
      icon={icon}
      kpi={{
        label,
        value,
        unit: unit?.trim(),
        tone,
        badge: flat ? null : { text: `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}%`, tone },
        sub: hint || `30-day norm ${base}${baseUnit}`,
      }}
    />
  );
}

export default function TrendsTab() {
  const { useCase } = useActivityParams();
  const { TRENDS } = useModuleData();
  const isRetail = useCase === 'retail';

  // Peaks are derived, never stored — one source (TRENDS) for the tiles and
  // the charts below them, so the two cannot disagree.
  const peak = useMemo(() => {
    const empty = { traffic: 0, trafficAt: '—', wait: 0, waitAt: '—', coverage: 0, present: 0 };
    if (!TRENDS?.length) return empty;

    return TRENDS.reduce((acc, b) => {
      const traffic = b.traffic ?? 0;
      const wait = b.wait ?? 0;
      return {
        traffic: traffic > acc.traffic ? traffic : acc.traffic,
        trafficAt: traffic > acc.traffic ? b.h : acc.trafficAt,
        wait: wait > acc.wait ? wait : acc.wait,
        waitAt: wait > acc.wait ? b.h : acc.waitAt,
        coverage: Math.round(TRENDS.reduce((s, x) => s + (x.coverage ?? 0), 0) / TRENDS.length),
        present: Math.max(acc.present, b.present ?? 0),
      };
    }, empty);
  }, [TRENDS]);

  return (
    <div className="space-y-5 pb-5">
      {/* Daily operational benchmarks — today against the 30-day norm.
          Retail gets four tiles; an office has no footfall gate and no billing
          queue, so it gets the two that mean anything there. */}
      <section>
        <h2 className="mb-2 text-lg font-semibold text-fg">Today against benchmark</h2>
        <KpiRow count={isRetail ? 4 : 2}>
          {isRetail && (
            <Benchmark
              label="Peak occupancy"
              icon={Users}
              value={peak.traffic}
              unit=" in/hr"
              base={BENCHMARK.peakOccupancy}
              hint={`Peaked at ${peak.trafficAt} · norm ${BENCHMARK.peakOccupancy}/hr`}
            />
          )}

          {isRetail && (
            <Benchmark
              label="Queue peak"
              icon={Clock}
              value={peak.wait}
              unit=" min"
              base={BENCHMARK.peakWait}
              lowerIsBetter
              hint={`Worst at ${peak.waitAt} · norm ${BENCHMARK.peakWait} min`}
            />
          )}

          <Benchmark
            label={isRetail ? 'Avg counter coverage' : 'Avg desk coverage'}
            icon={ShieldCheck}
            value={peak.coverage}
            unit="%"
            base={BENCHMARK.avgCoverage}
            hint={`Across ${TRENDS.length} hourly buckets · norm ${BENCHMARK.avgCoverage}%`}
          />

          <Benchmark
            label="Peak staff on site"
            icon={UserCheck}
            value={peak.present}
            unit=""
            base={BENCHMARK.presentAtPeak}
            hint={`Norm ${BENCHMARK.presentAtPeak} at peak`}
          />
        </KpiRow>
      </section>

      {/* The hourly charts themselves — the dashboard's old bottom band */}
      <section>
        <h2 className="mb-2 text-lg font-semibold text-fg">Hourly trends</h2>
        <PerformanceCharts loading={false} />
      </section>

      {/* Counter flow (retail): what arrived, and what it cost in wait. Moved
          here from the old Traffic & Zones tab — it is today-only data. */}
      {isRetail && (
        <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <ArrowRight className="h-4 w-4 text-brand" />
            <h2 className="text-lg font-semibold text-fg">Counter flow, hour by hour</h2>
            <span className={T.itemMeta}>entries vs average wait</span>
          </div>
          {/* Bleeds to the card edges so the header band spans it; px-4
              cells put the text back on the card's content line. */}
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH.left}>Hour</th>
                  <th className={TH.right}>Entries</th>
                  <th className={TH.right}>Avg wait</th>
                  <th className={TH.right}>Coverage</th>
                  <th className={TH.right}>Staff on floor</th>
                </tr>
              </thead>
              <tbody>
                {TRENDS.map((b) => (
                  <tr key={b.h} className="border-b border-line-subtle last:border-0 hover:bg-surface-sunken">
                    <td className={`px-4 py-2 tabular-nums ${T.tdPrimary}`}>{b.h}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-fg-secondary">{b.traffic ?? '—'}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-semibold ${
                      (b.wait ?? 0) >= 5 ? 'text-danger-ink' : 'text-fg-secondary'
                    }`}>
                      {b.wait != null ? `${b.wait} min` : '—'}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums font-semibold ${
                      (b.coverage ?? 100) < 90 ? 'text-warning-ink' : 'text-fg-secondary'
                    }`}>
                      {b.coverage}%
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-fg-secondary">{b.present} / {b.expected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
