import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { useActivityParams } from '../useCaseStore';
import { useModuleData } from '../useModuleData';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';

// The hourly chart grid. Four charts sharing one dummy TRENDS array
// (10:00 → now). Backend: GET /activity/trends — one row per hour with
// present_staff / expected_staff / customer_entries / coverage_pct /
// avg_queue_wait_min.
//
// Lives on /activity-monitoring/analytics/trends, not on the dashboard — the Analytics page owns
// the heading and the page chrome, so keep this component headless of both.
// It stays in the dashboard/ folder because it reads the dashboard's data
// module; move it only if that stops being true.

function ChartCard({ title, sub, to, children }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-small font-bold text-fg">{title}</p>
        {/* every chart clicks through to the subpage holding its full story */}
        {to && (
          <Link to={to} className="shrink-0 text-micro font-semibold text-brand-ink hover:underline">
            Details →
          </Link>
        )}
      </div>
      <p className="mb-2 text-micro text-fg-subtle">{sub}</p>
      <div className="h-36">{children}</div>
    </div>
  );
}

export default function PerformanceCharts({ loading }) {
  const { useCase } = useActivityParams();
  const { TRENDS } = useModuleData();
  const isRetail = useCase === 'retail';
  // Retail shows 4 charts; corporate keeps the 2 that make sense in an office
  // (attendance + workspace coverage) and drops footfall + billing queue.
  const skeletons = isRetail ? [0, 1, 2, 3] : [0, 1];
  const gridCls = isRetail
    ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4'
    : 'grid grid-cols-1 gap-3 sm:grid-cols-2';

  if (loading) {
    return (
      <div className={gridCls}>
        {skeletons.map((i) => (
          <div key={i} className="animate-pulse rounded-xl border border-line bg-surface p-3.5 shadow-sm">
            <div className="mb-2 h-3 w-28 rounded bg-surface-muted" />
            <div className="h-36 rounded bg-surface-muted" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-2 text-caption text-fg-subtle">
        hourly · {isRetail ? 'store open 10:00–22:00 IST' : 'office hours 09:00–18:00 IST'}
      </p>

      <div className={gridCls}>
        <ChartCard title="Attendance Trend" sub="present vs expected staff" to="/attendance-report">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={TRENDS} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 14]} />
              <Tooltip {...TIP} />
              <Area type="monotone" dataKey="expected" name="Expected" stroke="var(--line-strong)" fill="var(--surface-muted)" strokeWidth={1.5} strokeDasharray="4 3" />
              <Area type="monotone" dataKey="present" name="Present" stroke="#F7983A" fill="#F7983A22" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {isRetail && (
          <ChartCard title="Customer Traffic" sub="entries per hour (footfall)" to="/ai-event/headcount">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={TRENDS} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="traffic" name="Entries" fill="var(--text-primary)" radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        <ChartCard
          title={isRetail ? 'Coverage Trend' : 'Workspace Coverage'}
          sub={isRetail ? '% of counters staffed' : '% of desks covered'}
          to={isRetail ? '/activity-monitoring/zones' : undefined}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={TRENDS} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[60, 100]} unit="%" />
              <Tooltip {...TIP} />
              <Line type="monotone" dataKey="coverage" name={isRetail ? 'Coverage %' : 'Desk coverage %'} stroke="#10b981" strokeWidth={2} dot={{ r: 2.5 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {isRetail && (
          <ChartCard title="Queue Wait Time" sub="avg minutes at billing" to="/activity-monitoring/zones">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={TRENDS} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} />
                <Line type="monotone" dataKey="wait" name="Wait (min)" stroke="#f43f5e" strokeWidth={2} dot={{ r: 2.5 }} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>
    </div>
  );
}
