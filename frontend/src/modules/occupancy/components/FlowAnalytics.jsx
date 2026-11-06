/**
 * The charts of the Past Headcount Data page (/occupancy/usage-trends).
 *
 * It was tab 2 of /occupancy. Nothing about the charts changed when it moved
 * to a route of its own -- the page shell is the only thing that did -- so
 * this stays one component that takes a series and a heatmap.
 *
 * Three views of the same day, each answering a different question:
 *
 *   Timeline   how full was the building, hour by hour   (a level)
 *   Net flow   was it filling or emptying                (a rate)
 *   Heatmap    which space was full, and when            (a distribution)
 *
 * Level and rate are separated on purpose. A flat occupancy curve with 300 in
 * and 300 out an hour is a busy transit hall; the same flat curve with 4 in and
 * 4 out is an empty one. One chart cannot say both without hiding one of them.
 */
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ArrowLeftRight, Grid3x3, TrendingUp } from 'lucide-react';
import Panel from '@/core/ui/panel';
import { CameraEmptyState } from '@/core/components/CameraEmptyState';
// Recharts exports a `Tooltip` of its own; the app's hover card is aliased
// so both can live in this file, matching how Zone Headcount handles it.
import { Tooltip as UiTooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';
import { HEAT_EMPTY, HEAT_RAMP, heatColor, nfmt } from '../occupancy-data';

export default function FlowAnalytics({ timeline, heatmap, peak }) {
  return (
    <div className="flex flex-col gap-4 xl:min-h-0 xl:flex-1">
      <div className="grid gap-4 xl:min-h-0 xl:flex-[1.1] xl:grid-cols-2">
        <Panel
          icon={TrendingUp}
          title="Building occupancy timeline"
          right={peak ? (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-micro font-bold text-brand-ink">
              Peak {nfmt(peak.inside)} at {peak.hour}
            </span>
          ) : null}
          bodyClass="p-3 xl:flex xl:flex-col"
        >
          {timeline.length ? (
            <div className="h-[260px] xl:h-auto xl:min-h-0 xl:flex-1">
              <ResponsiveContainer height="100%" width="100%">
                <AreaChart data={timeline} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="occ-inside" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...GRID} strokeDasharray="3 3" />
                  <XAxis dataKey="hour" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                  <Tooltip {...TIP} />
                  <Area dataKey="inside" name="Inside" type="monotone" stroke="var(--brand)" strokeWidth={2} fill="url(#occ-inside)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <NoSeries />}
        </Panel>

        <Panel icon={ArrowLeftRight} title="Entry / exit net movement" bodyClass="p-3 xl:flex xl:flex-col">
          {timeline.length ? (
            <div className="h-[260px] xl:h-auto xl:min-h-0 xl:flex-1">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart data={timeline} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid {...GRID} strokeDasharray="3 3" />
                  <XAxis dataKey="hour" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                  <Tooltip {...TIP} />
                  <Legend wrapperStyle={{ fontSize: 10, color: 'var(--text-muted)' }} />
                  {/* Zero is the line that matters here: bars above it filled the
                      building, bars below it emptied it. */}
                  <ReferenceLine y={0} stroke="var(--line-strong)" />
                  <Bar dataKey="in" name="In" fill="var(--brand)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="out" name="Out" fill="var(--info)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <NoSeries />}
        </Panel>
      </div>

      <Panel
        icon={Grid3x3}
        title="Utilisation by zone and hour"
        right={<HeatLegend />}
        bodyClass="p-3 xl:overflow-y-auto"
        className="xl:min-h-0 xl:flex-1"
        fill={false}
      >
        {heatmap.rows.length ? <Heatmap heatmap={heatmap} /> : (
          <CameraEmptyState
            description="This grid is built from the counted spaces. Add a camera and draw a zone on it, and its hours fill in from the next reading on."
            framed={false}
            showSetup={false}
            size="sm"
            title="No spaces are reporting yet"
          />
        )}
      </Panel>
    </div>
  );
}

/**
 * No hourly buckets to plot.
 *
 * The cause is almost always a camera that is not counting yet, not a gap in
 * the data, so this is the product's standard camera empty state rather than
 * an ⓘ over two lines of grey -- same illustration, same words. No Camera
 * Setup button: every empty card on the page carried one, so it read as a
 * wall of identical buttons; setup is reached from the sidebar.
 */
function NoSeries() {
  return (
    <CameraEmptyState
      className="h-[260px] justify-center"
      description="Hourly totals come from the footfall service. Once a camera is counting at a gate, today's buckets appear here."
      framed={false}
      showSetup={false}
      size="sm"
      title="No hourly history yet"
    />
  );
}

/**
 * The colour scale, labelled with the numbers it means.
 *
 * A bare Low -> High strip says the squares differ but not by how much, which
 * on a planning view is most of the question. The ends carry 0% and 100%+ and
 * the steps sit between them, so a cell's colour can be read as a value
 * without hovering it.
 *
 * "100%+" rather than "100%": the top step is everything at or over capacity,
 * and a room CAN be over — that is what a breach is.
 */
function HeatLegend() {
  return (
    <span className="flex items-center gap-1.5 text-micro font-semibold text-fg-subtle">
      <span className="hidden lg:inline">Utilisation</span>
      <span className="tabular-nums">0%</span>
      <span className="flex items-center gap-px">
        {HEAT_RAMP.map((c, i) => (
          <span
            className={`h-2.5 w-4 ${i === 0 ? 'rounded-l-sm' : ''} ${i === HEAT_RAMP.length - 1 ? 'rounded-r-sm' : ''}`}
            key={c}
            style={{ background: c }}
          />
        ))}
      </span>
      <span className="tabular-nums">100%+</span>

      {/* The unobserved swatch is deliberately OUTSIDE the ramp and labelled in
          words. Sitting at the low end it would read as the zero step, which is
          the one thing the outline exists to deny. */}
      <span className="ml-1.5 hidden items-center gap-1 border-l border-line pl-1.5 sm:flex">
        <span className="h-2.5 w-4 rounded-sm border border-dashed border-line" style={{ background: HEAT_EMPTY }} />
        not observed
      </span>
    </span>
  );
}

/**
 * Zone x hour grid.
 *
 * Columns are the operational hours the rooms are actually configured for, not
 * a rolling window off the clock — a planning view should show the working day
 * in the same slots every time it is opened, or two visits cannot be compared.
 *
 * A cell with no observation is drawn as an outline rather than the lightest
 * step of the ramp. The empty colour and "0% full" would otherwise be the same
 * square, and "we did not watch this hour" is not the same claim as "this room
 * was empty" — the second one an operator would act on.
 */
function Heatmap({ heatmap }) {
  const { labels, rows } = heatmap;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[620px]">
        <div
          className="grid items-center gap-[3px]"
          style={{ gridTemplateColumns: `minmax(110px,190px) repeat(${labels.length}, minmax(0,1fr))` }}
        >
          {rows.map((r) => (
            <HeatRow cells={r.cells} key={r.id} labels={labels} row={r} />
          ))}
          <div />
          {labels.map((h) => (
            <div className="text-center font-mono text-[9.5px] text-fg-subtle" key={h}>{h.slice(0, 2)}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeatRow({ row, cells, labels }) {
  return (
    <>
      <div className="truncate pr-2 text-right text-[10.5px] text-fg-muted" title={row.label}>{row.label}</div>
      {cells.map((c, i) => (
        <HeatCell capacity={row.capacity} cell={c} key={labels[i]} label={row.label} time={labels[i]} />
      ))}
    </>
  );
}

/**
 * One cell.
 *
 * The app's own tooltip rather than a native `title`: a native tooltip waits a
 * second, renders in the OS chrome with no theme, and cannot be styled to match
 * the rest of the page. Every other hover explanation in the app goes through
 * this component, so this one does too.
 */
function HeatCell({ cell, label, time, capacity }) {
  const observed = cell.pct != null;
  return (
    <UiTooltip>
      <TooltipTrigger asChild>
        <div
          className={`h-[22px] rounded transition-transform hover:scale-110 ${
            observed ? '' : 'border border-dashed border-line'
          }`}
          style={{ background: observed ? heatColor(cell.pct) : HEAT_EMPTY }}
        />
      </TooltipTrigger>
      <TooltipContent className="text-[10.5px]" side="top" variant="card">
        {observed ? (
          <p>
            <span className="font-bold">{label}</span> at {time} —{' '}
            <span className="tabular-nums">
              {nfmt(cell.count)}{capacity > 0 ? `/${nfmt(capacity)}` : ''}
            </span>{' '}
            occupied
            {cell.exact != null ? (
              <span className="tabular-nums"> ({cell.exact}% utilisation)</span>
            ) : ' (no capacity set)'}
          </p>
        ) : (
          <p>
            <span className="font-bold">{label}</span> at {time} — not observed
          </p>
        )}
        {observed ? (
          <p className="mt-1 text-fg-muted">Peak headcount in this hour, since the page was opened.</p>
        ) : (
          <p className="mt-1 text-fg-muted">This page had not been opened during that hour, so there is no reading to show.</p>
        )}
      </TooltipContent>
    </UiTooltip>
  );
}
