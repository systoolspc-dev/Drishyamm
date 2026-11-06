/**
 * TimeScrubber — the one clock.
 *
 * It owns nothing. It reads `cursorMs` and writes `cursorMs`, and the canvas
 * and the history panel each derive their own highlight from that same value.
 *
 * That is the whole design. A scrubber with its own `activeIndex` alongside
 * the page's selection is exactly how a "synchronised" timeline drifts out of
 * sync — the scrubber says 10:22 while the panel highlights 10:29, and neither
 * is wrong on its own terms. One number, two readers.
 *
 * The range input is the real control, not the visual: it gives keyboard
 * stepping, arrow keys and screen-reader semantics for free, and the ticks,
 * node pips and progress fill are painted underneath it.
 */
import {
  ChevronFirst, ChevronLast, Pause, Play, RotateCcw, SkipBack, SkipForward,
} from 'lucide-react';
import { NODE, fmtClock, fmtClockSec, pctOfAxis } from './journey-model';

const PLAYBACK_SPEEDS = [1, 2, 4];

const PIP_TONE = {
  [NODE.START]: 'bg-success',
  [NODE.END]: 'bg-success',
  [NODE.ALERT]: 'bg-danger',
  [NODE.CLUSTER]: 'bg-brand',
  [NODE.SIGHTING]: 'bg-line-strong',
};

/**
 * `transport` (optional) puts the route player's controls at the right end of
 * this dock, so the page has one playback bar instead of two:
 * { playing, speed, canPrev, canNext, onPrev, onNext, onToggle, onSpeed }.
 *
 * `onFirst` / `onLast` jump to the journey's two ends. They live here, with
 * the other time controls, rather than in the history list — one home for
 * "move the clock" means there is still exactly one `cursorMs` writer per
 * gesture. Both are handed the node to jump to by the page, which resolves
 * the ends BY TIME, so they are correct no matter which way the list reads.
 */
export default function TimeScrubber({
  axis, nodes, cursorMs, onCursor, onSelect, transport,
  onFirst, onLast, canFirst = false, canLast = false,
}) {
  if (!axis?.spanMs) return null;

  const value = cursorMs ?? axis.endMs;
  const pct = pctOfAxis(axis, value);

  return (
    // One fixed-height row: where you are on the left, the track taking the
    // width, the transport on the right. Below `sm` the track drops to its own
    // full-width second row so it keeps usable length.
    <div className="flex w-full shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2 shadow-sm sm:h-16 sm:flex-nowrap sm:py-0">
      <div className="flex w-[92px] shrink-0 flex-col items-start gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-fg-subtle">Timeline</span>
        <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-brand-ink">
          {cursorMs == null ? 'whole journey' : fmtClockSec(value)}
        </span>
      </div>

      <div className="relative order-last h-9 min-w-0 flex-1 basis-full sm:order-none sm:basis-0">
        {/* Track */}
        <span aria-hidden className="absolute left-0 right-0 top-[15px] h-1 rounded-full bg-surface-muted" />
        {/* Progress — only while scrubbing; a full bar on load would imply a
            cursor nobody has placed. */}
        {cursorMs != null ? (
          <span
            aria-hidden
            className="absolute left-0 top-[15px] h-1 rounded-full bg-brand"
            style={{ width: `${pct}%` }}
          />
        ) : null}

        {/* One pip per node, coloured by kind, clickable — the scrubber
            doubles as a minimap of where the interesting stops are. */}
        {nodes.map((node) => {
          const left = pctOfAxis(axis, node.firstSeenMs);
          return (
            <button
              className={`absolute top-[9px] h-[13px] w-[3px] -translate-x-1/2 rounded-full transition hover:scale-y-125 ${PIP_TONE[node.kind] || 'bg-line-strong'}`}
              key={node.id}
              onClick={() => { onSelect(node.id); onCursor(node.firstSeenMs); }}
              style={{ left: `${left}%` }}
              title={`${node.label} · ${fmtClockSec(node.firstSeenMs)}`}
              type="button"
            />
          );
        })}

        {/* Handle */}
        {cursorMs != null ? (
          <span
            aria-hidden
            className="absolute top-[10px] h-[11px] w-[11px] -translate-x-1/2 rounded-full border-2 border-surface bg-brand shadow"
            style={{ left: `${pct}%` }}
          />
        ) : null}

        <input
          aria-label="Scrub the journey timeline"
          aria-valuetext={cursorMs == null ? 'Whole journey' : fmtClockSec(value)}
          className="absolute inset-x-0 top-[9px] h-[13px] w-full cursor-ew-resize appearance-none bg-transparent focus-visible:outline-none [&::-moz-range-thumb]:h-[13px] [&::-moz-range-thumb]:w-[13px] [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-webkit-slider-thumb]:h-[13px] [&::-webkit-slider-thumb]:w-[13px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-transparent"
          max={axis.endMs}
          min={axis.startMs}
          onChange={(e) => onCursor(Number(e.target.value))}
          step={1000}
          type="range"
          value={value}
        />

        {/* Ticks, on round clock times so two visits can be compared. */}
        {axis.ticks.map((t) => (
          <span
            aria-hidden
            className="absolute top-[24px] -translate-x-1/2 whitespace-nowrap text-[9px] tabular-nums text-fg-subtle"
            key={t.ms}
            style={{ left: `${t.pct}%` }}
          >
            {fmtClock(t.ms)}
          </span>
        ))}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
        {transport ? (
          <>
            {/* One transport: the journey's two ends on the outside, the
                footage controls in the middle — the order a media bar reads.
                Chevron icons rather than a second Skip pair, because Skip
                already means "one step" in this very row. */}
            <div className="inline-flex overflow-hidden rounded-md border border-line">
              {onFirst ? (
                <DockButton disabled={!canFirst} label="Jump to first seen" onClick={onFirst}>
                  <ChevronFirst className="h-3 w-3" strokeWidth={2.5} />
                </DockButton>
              ) : null}
              <DockButton
                className={onFirst ? 'border-l border-line' : ''}
                disabled={!transport.canPrev}
                label="Previous step"
                onClick={transport.onPrev}
              >
                <SkipBack className="h-3 w-3" strokeWidth={2.5} />
              </DockButton>
              <DockButton
                active
                className="border-x border-line"
                label={transport.playing ? 'Pause' : 'Play'}
                onClick={transport.onToggle}
              >
                {transport.playing
                  ? <Pause className="h-3 w-3" strokeWidth={2.5} />
                  : <Play className="h-3 w-3" strokeWidth={2.5} />}
              </DockButton>
              <DockButton disabled={!transport.canNext} label="Next step" onClick={transport.onNext}>
                <SkipForward className="h-3 w-3" strokeWidth={2.5} />
              </DockButton>
              {onLast ? (
                <DockButton className="border-l border-line" disabled={!canLast} label="Jump to last seen" onClick={onLast}>
                  <ChevronLast className="h-3 w-3" strokeWidth={2.5} />
                </DockButton>
              ) : null}
            </div>

            <div aria-label="Playback speed" className="inline-flex overflow-hidden rounded-md border border-line" role="group">
              {PLAYBACK_SPEEDS.map((s, i) => (
                <button
                  aria-pressed={transport.speed === s}
                  className={`px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-all duration-200 ${i ? 'border-l border-line' : ''} ${
                    transport.speed === s
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : 'text-fg-muted hover:bg-surface-sunken hover:text-fg'
                  }`}
                  key={s}
                  onClick={() => transport.onSpeed(s)}
                  type="button"
                >
                  {s}×
                </button>
              ))}
            </div>
          </>
        ) : null}

        <button
          className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] font-semibold text-fg-muted transition hover:bg-surface-sunken disabled:opacity-40"
          disabled={cursorMs == null}
          onClick={() => onCursor(null)}
          type="button"
        >
          <RotateCcw className="h-2.5 w-2.5" strokeWidth={2.5} />
          Clear
        </button>
      </div>
    </div>
  );
}

function DockButton({ label, onClick, disabled, active = false, className = '', children }) {
  return (
    <button
      aria-label={label}
      className={`px-2 py-1 transition-all duration-200 disabled:opacity-40 disabled:hover:bg-transparent ${
        active
          ? 'text-amber-600 hover:bg-amber-500/10 dark:text-amber-400'
          : 'text-fg-muted hover:bg-surface-sunken hover:text-fg'
      } ${className}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
