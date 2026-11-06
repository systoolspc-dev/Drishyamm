/**
 * The visual language of the vehicle hub. Components only — the maths lives in
 * `vehicle-data.js`, so Fast Refresh stays happy and the derivations stay
 * testable without a DOM.
 *
 * Built from design tokens throughout. The brief named literal hues (slate
 * surfaces, amber accents, a rose watchlist badge); those are roles
 * `--surface`/`--line`, `--brand` and `--danger` already carry, and going
 * through the tokens is what makes the hub follow the theme in both modes.
 */
import { AlertTriangle, Car, Camera, ImageOff, ShieldAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { aiService } from '@/core/services/ai';
import { confidenceTone, fmtDateTime, prettyPlate } from '../vehicle-data';

/**
 * A number plate, set like a number plate.
 *
 * Monospace and grouped, because the whole job on these screens is comparing
 * two strings of characters that differ in one place. In a proportional face
 * `MH12AB1234` and `MH12A81234` are nearly the same shape.
 */
export function Plate({ value, size = 'md', muted = false }) {
  const cls = size === 'lg'
    ? 'text-[17px] px-2.5 py-1 tracking-[0.08em]'
    : size === 'sm'
      ? 'text-[10.5px] px-1.5 py-0.5 tracking-[0.06em]'
      : 'text-[12.5px] px-2 py-0.5 tracking-[0.07em]';
  if (!value) {
    return (
      <span className={`inline-flex items-center gap-1 rounded border border-dashed border-line font-mono font-bold text-fg-subtle ${cls}`}>
        no plate read
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded border font-mono font-bold ${cls} ${
        muted ? 'border-line bg-surface-sunken text-fg-secondary' : 'border-line-strong bg-surface-muted text-fg'
      }`}
    >
      {prettyPlate(value)}
    </span>
  );
}

const CONF_BAR = {
  good: 'var(--success)', ok: 'var(--brand)', warn: 'var(--danger)', idle: 'var(--line-strong)',
};

/**
 * Confidence as a number and a bar.
 *
 * The bar is not decoration: the review threshold is a position on it, so an
 * operator can see "just under" versus "nowhere near" without reading the
 * digits. Below the threshold it turns danger-coloured because that read is
 * going to a human.
 */
export function Confidence({ value, showBar = true }) {
  const tone = confidenceTone(value);
  return (
    <span className="inline-flex min-w-[64px] flex-col gap-1">
      <span className={`text-[11.5px] font-bold tabular-nums ${
        tone === 'warn' ? 'text-danger-ink' : tone === 'good' ? 'text-success-ink' : 'text-fg-secondary'
      }`}
      >
        {value == null ? '—' : `${value}%`}
      </span>
      {showBar && value != null ? (
        <span className="block h-1 w-full overflow-hidden rounded-full bg-surface-muted">
          <span className="block h-full rounded-full" style={{ width: `${Math.min(100, value)}%`, background: CONF_BAR[tone] }} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Watchlist badge.
 *
 * `animate-pulse` only while the hit is live on the stream tab — a table of
 * fifty pulsing badges is noise, and the point of the animation is to catch an
 * eye that is looking somewhere else.
 */
export function WatchBadge({ hit, flashing = false }) {
  if (!hit) return null;
  const critical = hit.riskLevel === 'critical';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ${
            critical
              ? 'bg-danger-soft text-danger-ink ring-danger-line'
              : 'bg-warning-soft text-warning-ink ring-warning-line'
          } ${flashing ? 'animate-pulse' : ''}`}
        >
          <ShieldAlert className="h-2.5 w-2.5" strokeWidth={2.5} />
          {critical ? 'Critical' : 'High'}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[18rem] text-[10.5px] leading-relaxed" side="top" variant="card">
        <p><span className="font-bold">Watchlist </span>{hit.reason || 'Flagged vehicle'}</p>
        {hit.category ? <p className="mt-1 text-fg-muted">{hit.category} · added {hit.addedDate}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The plate crop, when the event carried one.
 *
 * Snapshots come through the authenticated proxy — an `s3://` uri is not
 * something an <img> can load. When there is no crop the tile says so instead
 * of showing a broken image: "the camera did not send a picture" and "the
 * picture failed to load" look identical otherwise.
 */
export function PlateThumb({ uri, alt, className = 'h-12 w-20' }) {
  const src = uri ? aiService.snapshotSrc(uri) || uri : null;
  if (!src) {
    return (
      <span className={`grid shrink-0 place-items-center rounded border border-dashed border-line bg-surface-sunken text-fg-subtle ${className}`}>
        <ImageOff className="h-3.5 w-3.5" strokeWidth={2} />
      </span>
    );
  }
  return (
    <img
      alt={alt || 'Plate snapshot'}
      className={`shrink-0 rounded border border-line bg-black object-cover ${className}`}
      loading="lazy"
      src={src}
    />
  );
}

/** One read, as a row. Shared by the live stream and the records table. */
export function ReadRow({ read, hit, flashing = false, onSelect, dense = false }) {
  return (
    <button
      className={`flex w-full items-center gap-3 rounded-lg border px-2.5 text-left transition ${dense ? 'py-1.5' : 'py-2'} ${
        hit
          ? 'border-danger-line bg-danger-soft/40 hover:bg-danger-soft/60'
          : 'border-line bg-surface hover:border-brand/40 hover:bg-surface-sunken'
      }`}
      onClick={() => onSelect?.(read)}
      type="button"
    >
      <PlateThumb alt={`Plate read at ${read.cameraLabel}`} className="h-10 w-16" uri={read.snapshot} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Plate size="sm" value={read.plate} />
          <WatchBadge flashing={flashing} hit={hit} />
          {read.corrected ? (
            <span className="rounded-full bg-info-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-info-ink">
              corrected
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-fg-subtle">
          <Camera className="h-2.5 w-2.5 shrink-0" strokeWidth={2} />
          {read.cameraLabel} · {fmtDateTime(read.at)}
        </span>
      </span>
      <Confidence value={read.confidence} />
    </button>
  );
}

/** Shared empty state, so five tabs do not invent five of them. */
export function Empty({ icon: Icon = Car, title, body }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
      <Icon className="h-5 w-5 text-fg-subtle" strokeWidth={2} />
      <p className="text-small font-semibold text-fg-secondary">{title}</p>
      {body ? <p className="max-w-[52ch] text-[11px] leading-relaxed text-fg-subtle">{body}</p> : null}
    </div>
  );
}

/**
 * Says out loud that a tab is reading a feed that may carry no plates.
 *
 * The events service has no dedicated ANPR endpoint. When nothing in the feed
 * is a plate read, the honest message is "no reads yet", not an empty table
 * that reads as a broken page.
 */
export function FeedNote({ error }) {
  if (!error) return null;
  return (
    <p className="flex items-start gap-2 rounded-xl border border-warning-line bg-warning-soft px-3.5 py-2.5 text-[11.5px] leading-relaxed text-warning-ink">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
      <span>{error} Anything below is the last good reading.</span>
    </p>
  );
}
