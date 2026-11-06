/**
 * Breach Trends — the aggregate behind the table, over the same filtered rows:
 * when breaches happen (per IST hour of the day, the peak hour emphasised) and
 * where (the cameras with the most). One series each, one brand hue; the peak
 * is picked out by weight, not a second colour.
 */
import { BarChart3 } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import Panel from '@/core/ui/panel';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';
import { breachTrends } from './breach-model';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export default function BreachTrends({ rows }) {
  const { hours, peak, topCameras, total } = breachTrends(rows);
  const hourLabel = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;

  return (
    <Panel
      bodyClass="p-4"
      icon={BarChart3}
      right={<span className="text-micro text-fg-subtle">{plural(total, 'breach')} in view · IST</span>}
      title="Breach trends"
    >
      {total === 0 ? (
        <p className="py-8 text-center text-small text-fg-muted">No breaches in this range to chart.</p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
          <figure className="min-w-0">
            <figcaption className="mb-2">
              <span className="block text-small font-semibold text-fg">Peak breach hours</span>
              <span className="text-micro text-fg-muted">
                {peak ? <>Busiest: <b className="text-fg-secondary">{hourLabel(peak.hour)}</b> · {plural(peak.count, 'breach')}</> : null}
              </span>
            </figcaption>
            <div className="h-48">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart barCategoryGap={2} data={hours} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis axisLine={false} dataKey="label" interval={2} tick={AXIS} tickLine={false} />
                  <YAxis allowDecimals={false} axisLine={false} tick={AXIS} tickLine={false} />
                  <Tooltip
                    {...TIP}
                    cursor={{ fill: 'var(--surface-muted)' }}
                    formatter={(v) => [plural(v, 'breach'), null]}
                    labelFormatter={(_, p) => (p?.[0] ? hourLabel(p[0].payload.hour) : '')}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {hours.map((h) => (
                      <Cell fill="var(--brand)" fillOpacity={peak && h.hour === peak.hour ? 1 : 0.45} key={h.hour} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>

          <figure className="min-w-0">
            <figcaption className="mb-2">
              <span className="block text-small font-semibold text-fg">Top violated cameras</span>
              <span className="text-micro text-fg-muted">Breaches per camera in this range</span>
            </figcaption>
            <div style={{ height: Math.max(96, topCameras.length * 30 + 8) }}>
              <ResponsiveContainer height="100%" width="100%">
                <BarChart barCategoryGap={6} data={topCameras} layout="vertical" margin={{ top: 0, right: 28, left: 0, bottom: 0 }}>
                  <XAxis allowDecimals={false} hide type="number" />
                  <YAxis axisLine={false} dataKey="name" tick={AXIS} tickLine={false} type="category" width={120} />
                  <Tooltip {...TIP} cursor={{ fill: 'var(--surface-muted)' }} formatter={(v) => [plural(v, 'breach'), null]} />
                  <Bar dataKey="count" fill="var(--brand)" radius={[0, 4, 4, 0]}>
                    <LabelList dataKey="count" fill="var(--text-secondary)" fontSize={10} position="right" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>
        </div>
      )}
    </Panel>
  );
}
