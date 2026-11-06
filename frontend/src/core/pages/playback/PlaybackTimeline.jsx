import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Clock, Minus, Plus } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageCard } from '@/core/layout/OperationsPage';
import { toneClass } from '@/core/ui/tone';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import {
  DAY, LAYERS, atTime, bucketMarkers, clamp, dayKey, fmtClock, layerOf, tickLabel, timeTicks,
} from './model';

const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const MIN_VISIBLE_MS = 60_000;
const MARKER_SLOT_PX = 26;      // one marker per this many pixels, so neighbours never overlap
const CHIP_HALF_PX = 36;        // about half a time label's width
const NVR_EMPTY_NOTE = 'The NVR reports no recordings in this range.';
const VIEWS = [
  { id: 'range', label: 'Range view', hint: 'The selected time range' },
  { id: 'day', label: 'Day view', hint: 'The whole day, range highlighted' },
];

/**
 * The review timeline: where the NVR has footage, what happened when, the
 * playhead, and click-to-seek. Zoom narrows the visible range around the
 * playhead; while zoomed, the view pages along as the playhead reaches its
 * edge rather than scrolling under the pointer.
 *
 * `markers` are { t, category, title, count? } for every layer except
 * Recording, which comes from `recordings` ({ status, segments, message }).
 */
export default function PlaybackTimeline({
  span, range, viewMode, onViewMode, now, playhead, recordings, markers, exportRange,
  hidden, onToggleLayer, onSeek, emptyNote = NVR_EMPTY_NOTE,
}) {
  const trackRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [trackWidth, setTrackWidth] = useState(800);

  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setTrackWidth(entry.contentRect.width || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zoom state belongs to one span; a new span (another range, day view)
  // starts fitted. Adjusted during render rather than in an effect, so the
  // first paint of the new span is already right.
  const spanKey = `${span.start}|${span.end}`;
  const [view, setView] = useState({ key: spanKey, zoom: 0, start: span.start });
  const current = view.key === spanKey ? view : { key: spanKey, zoom: 0, start: span.start };

  const baseSpan = Math.max(1, span.end - span.start);
  let maxZoom = 0;
  ZOOMS.forEach((z, i) => { if (baseSpan / z >= MIN_VISIBLE_MS) maxZoom = i; });
  const zoom = Math.min(current.zoom, maxZoom);
  const visible = baseSpan / ZOOMS[zoom];
  let vStart = clamp(current.start, span.start, span.end - visible);
  const pageAlong = zoom > 0 && playhead != null && playhead >= span.start && playhead <= span.end
    && (playhead < vStart || playhead > vStart + visible);
  if (pageAlong) {
    // Page along with the playhead: put it 10% in from the left. Once stored,
    // the playhead is inside the page, so this settles on the next render.
    vStart = clamp(playhead - visible * 0.1, span.start, span.end - visible);
    if (vStart !== current.start || view.key !== spanKey) setView({ key: spanKey, zoom, start: vStart });
  }
  const vEnd = vStart + visible;

  const zoomTo = (next) => {
    const z = clamp(next, 0, maxZoom);
    const vis = baseSpan / ZOOMS[z];
    const center = playhead ?? vStart + visible / 2;
    setView({ key: spanKey, zoom: z, start: clamp(center - vis / 2, span.start, span.end - vis) });
  };

  const pct = (ms) => ((ms - vStart) / visible) * 100;
  const msAt = (clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r?.width) return null;
    return vStart + clamp((clientX - r.left) / r.width, 0, 1) * visible;
  };
  // A time label centred on its line, except near an edge where it would be
  // cut off: there it hangs inward from the line instead.
  const chipAlign = (ms) => {
    const px = (pct(ms) / 100) * trackWidth;
    if (px < CHIP_HALF_PX) return 'translate-x-0';
    if (trackWidth - px < CHIP_HALF_PX) return '-translate-x-full';
    return '-translate-x-1/2';
  };

  const { step, ticks } = timeTicks(vStart, vEnd);
  const segments = recordings.status === 'ok'
    ? recordings.segments.filter((s) => s.end > vStart && s.start < vEnd)
    : [];
  const slots = Math.max(8, Math.floor(trackWidth / MARKER_SLOT_PX));
  const buckets = bucketMarkers(markers.filter((m) => !hidden.has(m.category)), vStart, vEnd, slots);
  const futureFrom = now < vEnd ? Math.max(0, pct(now)) : null;

  let note = null;
  if (recordings.status === 'unsupported') note = recordings.message;
  else if (recordings.status === 'error') note = `Recording track unavailable: ${recordings.message}`;
  else if (recordings.status === 'ok' && !recordings.segments.some((s) => s.end > span.start && s.start < span.end)) {
    note = emptyNote;
  }

  const bandOf = (r) => {
    if (!r || r.end <= vStart || r.start >= vEnd) return null;
    const l = Math.max(0, pct(r.start));
    return { left: `${l}%`, width: `${Math.max(0.3, Math.min(100, pct(r.end)) - l)}%` };
  };
  const windowBand = viewMode === 'day' ? bandOf(range) : null;
  const exportBand = bandOf(exportRange);

  const inactive = recordings.status === 'idle';
  // Bands, shading and lines cover the two tracks: below the tick row, above the playhead label row.
  const overTracks = 'top-6 bottom-7';

  return (
    <PageCard className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-heading font-bold text-fg">Timeline</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken"
            >
              {VIEWS.find((v) => v.id === viewMode)?.label}
              <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 border-line bg-surface">
            <DropdownMenuRadioGroup value={viewMode} onValueChange={onViewMode}>
              {VIEWS.map((v) => (
                <DropdownMenuRadioItem key={v.id} value={v.id}>
                  <span className="flex flex-col">
                    <span className="text-small font-semibold text-fg">{v.label}</span>
                    <span className="text-caption text-fg-muted">{v.hint}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="-ml-1.5 mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
        {LAYERS.map((l) => {
          const off = hidden.has(l.id);
          return (
            <button
              key={l.id}
              type="button"
              aria-pressed={!off}
              title={off ? `Show ${l.label.toLowerCase()}` : `Hide ${l.label.toLowerCase()}`}
              onClick={() => onToggleLayer(l.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-caption font-medium transition hover:bg-surface-sunken',
                off ? 'text-fg-disabled line-through' : 'text-fg-secondary',
              )}
            >
              <LayerGlyph layer={l} className={off ? 'opacity-40' : ''} />
              {l.label}
            </button>
          );
        })}
      </div>

      {/* Track: ticks · recording rail · event lane · playhead label row */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={-1}
        aria-label="Timeline — click to play from a moment"
        aria-valuemin={span.start}
        aria-valuemax={span.end}
        aria-valuenow={playhead ?? range.start}
        aria-valuetext={fmtClock(playhead ?? range.start)}
        onPointerMove={(e) => setHover(msAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const ms = msAt(e.clientX);
          if (ms != null && ms <= now) onSeek(ms);
        }}
        className={cn(
          'relative mt-2 select-none',
          inactive && 'opacity-60',
          hover != null && hover > now ? 'cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <div className="relative h-6">
          {ticks.map((t) => {
            const p = pct(t);
            const edge = p < 3 ? 'start' : p > 97 ? 'end' : 'mid';
            return (
              <span
                key={t}
                className={cn(
                  'pointer-events-none absolute bottom-0 flex flex-col',
                  edge === 'start' ? 'items-start' : edge === 'end' ? 'items-end -translate-x-full' : 'items-center -translate-x-1/2',
                )}
                style={{ left: `${p}%` }}
              >
                <span className="text-caption tabular-nums text-fg-muted">{tickLabel(t, step)}</span>
                <span className="mt-0.5 h-1.5 w-px bg-line-strong" />
              </span>
            );
          })}
        </div>

        <div className={cn('relative h-3.5 overflow-hidden rounded-md bg-surface-muted', recordings.status === 'loading' && 'animate-pulse')}>
          {!hidden.has('recording') && segments.map((s) => {
            const l = Math.max(0, pct(s.start));
            return (
              <span
                key={`${s.start}-${s.kind}`}
                title={`Recorded ${fmtClock(s.start)}–${fmtClock(s.end)}`}
                className="absolute inset-y-0 bg-brand"
                style={{ left: `${l}%`, width: `${Math.max(0.4, Math.min(100, pct(s.end)) - l)}%` }}
              />
            );
          })}
        </div>

        <div className="relative mt-1 h-8 rounded-md bg-surface-sunken">
          {buckets.map((b) => (
            <Marker key={b.key} bucket={b} left={pct(b.t)} onJump={(t) => onSeek(t, { preroll: true })} />
          ))}
        </div>

        <div className="relative h-7" />

        {windowBand ? <div className={cn('pointer-events-none absolute rounded-sm bg-brand/10', overTracks)} style={windowBand} /> : null}
        {exportBand ? (
          <div className={cn('pointer-events-none absolute border-x-2 border-brand/60 bg-brand/10', overTracks)} style={exportBand} title="Clip export range" />
        ) : null}
        {futureFrom != null ? (
          <div
            className={cn('pointer-events-none absolute right-0 bg-[repeating-linear-gradient(135deg,transparent_0,transparent_4px,var(--line)_4px,var(--line)_5px)]', overTracks)}
            style={{ left: `${futureFrom}%` }}
          />
        ) : null}

        {hover != null && hover <= now ? (
          <div className="pointer-events-none absolute bottom-7 top-0 z-10" style={{ left: `${pct(hover)}%` }}>
            <span className={cn('absolute left-0 top-0 whitespace-nowrap rounded-md border border-line bg-surface px-1.5 py-0.5 text-caption font-semibold tabular-nums text-fg shadow-sm', chipAlign(hover))}>
              {fmtClock(hover)}
            </span>
            <span className="absolute bottom-0 left-0 top-6 w-px -translate-x-1/2 bg-fg-subtle" />
          </div>
        ) : null}

        {playhead != null && playhead >= vStart && playhead <= vEnd ? (
          <div className="pointer-events-none absolute bottom-0 top-5 z-20" style={{ left: `${pct(playhead)}%` }}>
            <span className="absolute left-0 top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-brand ring-2 ring-surface" />
            <span className="absolute bottom-6 left-0 top-1 w-0.5 -translate-x-1/2 rounded-full bg-brand" />
            <span className={cn('absolute bottom-0 left-0 whitespace-nowrap rounded-md bg-brand px-1.5 py-0.5 text-caption font-semibold tabular-nums text-white shadow', chipAlign(playhead))}>
              {fmtClock(playhead)}
            </span>
          </div>
        ) : null}
      </div>

      {note ? <p className="mt-1 text-caption text-fg-subtle">{note}</p> : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle pt-2.5">
        <div className="flex items-center gap-2">
          <span className="text-small font-medium text-fg-muted">Zoom</span>
          <SmallButton label="Zoom out" disabled={zoom === 0} onClick={() => zoomTo(zoom - 1)}><Minus className="h-3.5 w-3.5" /></SmallButton>
          {/* Drawn by hand: with a light accent colour Chrome paints the
              unfilled track near-black, which read as a heavy bar. */}
          <input
            type="range"
            min={0}
            max={maxZoom}
            step={1}
            value={zoom}
            disabled={maxZoom === 0}
            onChange={(e) => zoomTo(Number(e.target.value))}
            aria-label="Zoom"
            style={{
              background: `linear-gradient(to right, var(--brand) ${maxZoom ? (zoom / maxZoom) * 100 : 0}%, var(--surface-muted) ${maxZoom ? (zoom / maxZoom) * 100 : 0}%)`,
            }}
            className="h-1.5 w-24 cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50 sm:w-32 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface [&::-moz-range-thumb]:bg-brand [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:shadow"
          />
          <SmallButton label="Zoom in" disabled={zoom >= maxZoom} onClick={() => zoomTo(zoom + 1)}><Plus className="h-3.5 w-3.5" /></SmallButton>
          <button
            type="button"
            onClick={() => zoomTo(0)}
            disabled={zoom === 0}
            className="h-8 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-50"
          >
            Fit
          </button>
        </div>

        <GoToTime span={span} now={now} disabled={inactive} onGo={(ms) => onSeek(ms)} />
      </div>
    </PageCard>
  );
}

/**
 * Jump the player to a typed time inside the span. The time is read on the
 * span's first day, or the next one for a range that runs past midnight.
 */
function GoToTime({ span, now, disabled, onGo }) {
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState(null);

  const go = () => {
    if (!value) return;
    let ms = atTime(dayKey(span.start), value);
    if (ms < span.start) ms = atTime(dayKey(span.start + DAY), value);
    if (ms < span.start || ms > span.end) { setProblem('Outside the timeline'); return; }
    if (ms > now) { setProblem('Not recorded yet'); return; }
    setProblem(null);
    onGo(ms);
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); go(); }} className="flex items-center gap-2">
      {problem ? <span role="status" className="text-caption font-medium text-danger-ink">{problem}</span> : null}
      <span className="flex h-8 items-center rounded-lg border border-line bg-surface pl-2.5 pr-1 transition focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
        <Clock className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <input
          type="time"
          step="1"
          value={value}
          disabled={disabled}
          onChange={(e) => { setValue(e.target.value); setProblem(null); }}
          aria-label="Time to go to"
          className="ml-1.5 w-24 bg-transparent text-small font-medium tabular-nums text-fg outline-none disabled:cursor-not-allowed [&::-webkit-calendar-picker-indicator]:hidden"
        />
      </span>
      <button
        type="submit"
        disabled={disabled || !value}
        className="h-8 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-50"
      >
        Go to time
      </button>
    </form>
  );
}

/**
 * A marker's colour: the recording rail keeps its own, bookmarks are blue and
 * every event type is red. Event types stay apart by their icon, not by hue.
 */
function markTone(layer) {
  if (layer.id === 'recording') return layer.tone;
  if (layer.id === 'bookmark') return 'info';
  return 'danger';
}

/** A layer's mark: a dot for Recording and Motion, the layer icon otherwise. */
export function LayerGlyph({ layer, className }) {
  const tone = markTone(layer);
  if (layer.id === 'recording' || layer.id === 'motion') {
    return <span className={cn('h-2 w-2 shrink-0 rounded-full', toneClass(tone, 'dot'), className)} />;
  }
  const Icon = layer.Icon;
  return (
    <Icon
      className={cn('h-3.5 w-3.5 shrink-0', toneClass(tone, 'icon'), className)}
      strokeWidth={2.25}
      fill={layer.id === 'bookmark' ? 'currentColor' : 'none'}
    />
  );
}

function Marker({ bucket, left, onJump }) {
  const layer = layerOf(bucket.category);
  const many = bucket.count > 1;
  const label = `${many ? `${bucket.count} × ` : ''}${bucket.title} · ${fmtClock(bucket.t)}${many && bucket.last > bucket.t ? `–${fmtClock(bucket.last)}` : ''}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onJump(bucket.t); }}
      className="absolute top-1/2 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full transition hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      style={{ left: `${left}%` }}
    >
      <LayerGlyph layer={layer} />
      {many ? (
        <span className="absolute -right-1 -top-0.5 min-w-3.5 rounded-full bg-fg px-0.5 text-center text-[9px] font-bold leading-3.5 text-fg-inverse">
          {bucket.count > 99 ? '99+' : bucket.count}
        </span>
      ) : null}
    </button>
  );
}

function SmallButton({ label, disabled, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-50"
    >
      {children}
    </button>
  );
}
