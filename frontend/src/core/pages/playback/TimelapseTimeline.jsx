import { useEffect, useRef, useState } from 'react';
import { cn } from '@/core/lib/utils';
import { PageCard } from '@/core/layout/OperationsPage';
import { LayerGlyph } from './PlaybackTimeline';
import { LAYERS, bucketMarkers, clamp, fmtClock, layerOf, tickLabel, timeTicks } from './model';

const TICK_PX = 84;          // about one tick label per this many pixels
const MARKER_SLOT_PX = 26;   // one marker per this many pixels, so neighbours never overlap
const CHIP_HALF_PX = 32;

/**
 * The timelapse's range as one strip: where there is recorded footage, what
 * happened when, and an orange playhead. Click anywhere to jump the
 * timelapse there. No zoom — the whole range is always in view, because a
 * timelapse is for seeing the whole range at once.
 *
 * `clips` are { start, end }; `markers` are { t, category, title, count? }.
 */
export default function TimelapseTimeline({
  range, clips, markers, hidden, onToggleLayer, playhead, onSeek, disabled, note,
}) {
  const trackRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(1, range.end - range.start);
  const pct = (ms) => clamp(((ms - range.start) / span) * 100, 0, 100);
  const msAt = (clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r?.width) return null;
    return range.start + clamp((clientX - r.left) / r.width, 0, 1) * span;
  };
  const chipAlign = (ms) => {
    const px = (pct(ms) / 100) * width;
    if (px < CHIP_HALF_PX) return 'translate-x-0';
    if (width - px < CHIP_HALF_PX) return '-translate-x-full';
    return '-translate-x-1/2';
  };

  const { step, ticks } = timeTicks(range.start, range.end, Math.max(3, Math.floor(width / TICK_PX)));
  const visibleClips = hidden.has('recording') ? [] : clips.filter((c) => c.end > range.start && c.start < range.end);
  const buckets = bucketMarkers(
    markers.filter((m) => !hidden.has(m.category)),
    range.start, range.end, Math.max(8, Math.floor(width / MARKER_SLOT_PX)),
  );
  const showPlayhead = !disabled && playhead != null && playhead >= range.start && playhead <= range.end;

  return (
    <PageCard className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <h2 className="text-small font-semibold text-fg">
          Timeline <span className="font-medium text-fg-muted">(Timelapse View)</span>
        </h2>
        <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1">
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
      </div>

      {/* Ticks · footage rail · event markers */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={-1}
        aria-label="Timelapse timeline — click to jump to a moment"
        aria-valuemin={range.start}
        aria-valuemax={range.end}
        aria-valuenow={playhead ?? range.start}
        aria-valuetext={fmtClock(playhead ?? range.start)}
        aria-disabled={disabled || undefined}
        onPointerMove={(e) => { if (!disabled) setHover(msAt(e.clientX)); }}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          if (disabled) return;
          const ms = msAt(e.clientX);
          if (ms != null) onSeek(ms);
        }}
        className={cn('relative mt-2 select-none', disabled ? 'cursor-default opacity-60' : 'cursor-pointer')}
      >
        <div className="relative h-5">
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
                <span className="mt-0.5 h-1 w-px bg-line-strong" />
              </span>
            );
          })}
        </div>

        <div className="relative mt-0.5 h-2.5 overflow-hidden rounded-full bg-surface-muted">
          {visibleClips.map((c) => {
            const l = pct(c.start);
            return (
              <span
                key={c.key}
                title={`Recorded ${fmtClock(c.start)}–${fmtClock(c.end)}`}
                className="absolute inset-y-0 bg-brand/35"
                style={{ left: `${l}%`, width: `${Math.max(0.3, pct(c.end) - l)}%` }}
              />
            );
          })}
        </div>

        <div className="relative mt-1 h-5">
          {buckets.map((b) => (
            <MarkerDot key={b.key} bucket={b} left={pct(b.t)} disabled={disabled} onJump={onSeek} />
          ))}
        </div>

        {hover != null ? (
          <div className="pointer-events-none absolute bottom-0 top-0 z-10" style={{ left: `${pct(hover)}%` }}>
            <span className={cn('absolute left-0 top-0 whitespace-nowrap rounded-md border border-line bg-surface px-1.5 text-caption font-semibold tabular-nums text-fg shadow-sm', chipAlign(hover))}>
              {fmtClock(hover)}
            </span>
            <span className="absolute bottom-0 left-0 top-5 w-px -translate-x-1/2 bg-fg-subtle" />
          </div>
        ) : null}

        {showPlayhead ? (
          <div className="pointer-events-none absolute bottom-0 top-5 z-20" style={{ left: `${pct(playhead)}%` }}>
            <span className="absolute bottom-0 left-0 top-0 w-0.5 -translate-x-1/2 rounded-full bg-brand" />
            <span className="absolute left-0 top-1.75 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-brand shadow" />
          </div>
        ) : null}
      </div>

      {note ? <p className="mt-1 text-caption text-fg-subtle">{note}</p> : null}
    </PageCard>
  );
}

function MarkerDot({ bucket, left, disabled, onJump }) {
  const layer = layerOf(bucket.category);
  const many = bucket.count > 1;
  const label = `${many ? `${bucket.count} × ` : ''}${bucket.title} · ${fmtClock(bucket.t)}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onJump(bucket.t); }}
      className="absolute top-1/2 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full transition hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      style={{ left: `${left}%` }}
    >
      <LayerGlyph layer={layer} />
    </button>
  );
}
