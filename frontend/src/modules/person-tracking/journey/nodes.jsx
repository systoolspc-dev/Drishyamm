/**
 * The cards and connectors the chain is made of.
 *
 * Five node kinds, one row. Colour does semantic work only — brand accent
 * marks aggregation, success marks the anchors, danger marks a violation, info
 * marks an unmonitored gap. Selection is a RING, never a colour change, so a
 * selected alert still reads as an alert.
 *
 * Every card is the same width. That is not cosmetic: the windowing in
 * `NodeChain` computes which slice to render from a fixed pitch, and a
 * content-sized card would make that arithmetic guesswork.
 */
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ChevronDown, ChevronRight, Clock3, Flag, ImageOff,
  LogIn, MapPin, Play, ShieldAlert,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { aiService } from '@/core/services/ai';
import { NODE, fmtClockSec, fmtDateTime, fmtDuration } from './journey-model';

/** Card pitch, in px, at zoom 1. NodeChain windows against this. */
export const CARD_W = 172;
export const CARD_GAP = 0;
export const CONNECTOR_W = 92;
export const PITCH = CARD_W + CONNECTOR_W;

// Only the future dims, and only when it is not the card you picked --
// dimming a selected node washes out the ring that says it is selected,
// which is exactly what an operator is looking at after clicking a row in
// the history panel. 55% rather than 40%: enough to recede, not so much
// that a violation ahead of the cursor stops being legible.
const STATE_DIM = { past: '', active: '', future: 'opacity-[0.55]' };

// ── Connector ───────────────────────────────────────────────────────────────

/**
 * The line between two nodes.
 *
 * Solid for a normal transition. Dashed plus a pill when the feed had a hole
 * wider than the threshold — and the pill carries the duration, because the
 * gap is the finding: four minutes between two gates is someone walking,
 * forty is someone somewhere nobody was watching.
 */
export function Connector({ gapBeforeMs, dimmed }) {
  const gap = gapBeforeMs != null;
  return (
    <span
      aria-hidden
      className={`flex shrink-0 flex-col items-center justify-center gap-1 ${dimmed ? 'opacity-[0.55]' : ''}`}
      style={{ width: CONNECTOR_W }}
    >
      {gap ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-info-line bg-info-soft px-1.5 py-0.5 text-[9px] font-bold text-info-ink">
          {fmtDuration(gapBeforeMs)} unmonitored
        </span>
      ) : null}
      <span className="flex w-full items-center">
        <span
          className={`h-0 flex-1 border-t-2 ${gap ? 'border-dashed border-info' : 'border-solid border-line-strong'}`}
        />
        <ChevronRight
          className={`-ml-1 h-3 w-3 shrink-0 ${gap ? 'text-info' : 'text-fg-subtle'}`}
          strokeWidth={2.5}
        />
      </span>
    </span>
  );
}

// ── Media popover ───────────────────────────────────────────────────────────

/**
 * The app's own portaled tooltip, not a new primitive.
 *
 * Hover gives the snapshot, the exact timestamps and the dwell. Video is a
 * CLICK, and it opens Playback at that moment rather than streaming inline:
 * the AI service exposes no clip endpoint, so an inline 5-second player would
 * have to invent a URL. The deep link is real, already used by this page's
 * header, and lands the operator on frame-accurate video — so the affordance
 * is honest about what it does instead of promising a preview it cannot serve.
 */
export function MediaPopover({ node, children }) {
  const stop = node.stops[0] || {};
  const monitorId = stop.monitor_id || stop.camera_code || null;
  const snapshot = stop.snapshot_uri || stop.snapshot || null;
  const src = snapshot ? aiService.snapshotSrc(snapshot) || snapshot : null;
  const at = stop.first_seen_at || '';

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="w-[248px] text-[10.5px] leading-relaxed" side="top" variant="card">
        <div className="mb-2 aspect-video w-full overflow-hidden rounded border border-line bg-black">
          {src ? (
            <img alt={node.label} className="h-full w-full object-contain" src={src} />
          ) : (
            <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-white/45">
              <ImageOff className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="text-[9.5px]">No snapshot on this sighting</span>
            </span>
          )}
        </div>

        <p className="font-bold text-fg">{node.label}</p>
        <p className="mt-0.5 text-fg-muted">
          {fmtDateTime(node.firstSeenMs)}
          {node.count > 1 ? ` — ${fmtClockSec(node.lastSeenMs)}` : ''}
        </p>
        <p className="text-fg-muted">
          {node.count > 1 ? `${node.count} sightings · ` : ''}dwell {fmtDuration(node.dwellMs)}
        </p>

        {monitorId ? (
          <Link
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1 text-[10px] font-bold text-fg-secondary transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink"
            to={`/playback?monitor=${encodeURIComponent(monitorId)}${at ? `&t=${encodeURIComponent(at)}` : ''}`}
          >
            <Play className="h-2.5 w-2.5" strokeWidth={2.5} />
            Open in Playback
          </Link>
        ) : (
          <p className="mt-2 rounded-md border border-line bg-surface-sunken px-2 py-1 text-[9.5px] text-fg-subtle">
            This sighting carries no camera id, so there is nothing to open.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// ── Card shell ──────────────────────────────────────────────────────────────

function Card({ node, state, selected, onSelect, accent, children }) {
  return (
    <MediaPopover node={node}>
      <button
        aria-current={selected ? 'true' : undefined}
        className={`relative flex shrink-0 flex-col overflow-hidden rounded-xl border bg-surface p-2.5 text-left shadow-sm transition ${accent} ${
          selected ? 'ring-2 ring-brand ring-offset-1 ring-offset-surface-app' : ''
        } ${selected ? '' : STATE_DIM[state] || ''} ${state === 'active' ? 'shadow-md' : ''}`}
        onClick={() => onSelect(node.id)}
        style={{ width: CARD_W }}
        type="button"
      >
        {children}
      </button>
    </MediaPopover>
  );
}

const Eyebrow = ({ Icon, children, className }) => (
  <span className={`flex items-center gap-1 text-[8.5px] font-bold uppercase tracking-[0.08em] ${className}`}>
    <Icon className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
    {children}
  </span>
);

const Meta = ({ children }) => (
  <span className="mt-1 block truncate text-[9.5px] tabular-nums text-fg-subtle">{children}</span>
);

// ── Anchors ─────────────────────────────────────────────────────────────────

/**
 * Where the journey starts and where it ends.
 *
 * Never clustered, and badged in words rather than by position, because a
 * scrolled canvas can hide which end you are looking at.
 */
export function AnchorNode({ node, state, selected, onSelect }) {
  const isStart = node.kind === NODE.START;
  return (
    <Card
      accent="border-success-line shadow-[inset_3px_0_0_var(--success)]"
      node={node}
      onSelect={onSelect}
      selected={selected}
      state={state}
    >
      <Eyebrow className="text-success-ink" Icon={isStart ? LogIn : Flag}>
        {isStart ? 'Start / Entry' : 'Last seen / Exit'}
      </Eyebrow>
      <span className="mt-1.5 truncate text-[11.5px] font-bold text-fg">{node.label}</span>
      <Meta>{fmtClockSec(node.firstSeenMs)}</Meta>
      <Meta>dwell {fmtDuration(node.dwellMs)}</Meta>
    </Card>
  );
}

// ── Alert ───────────────────────────────────────────────────────────────────

/** A policy violation. Its own card, at every zoom, always. */
export function AlertNode({ node, state, selected, onSelect }) {
  return (
    <Card
      accent="border-danger-line bg-danger-soft shadow-[inset_3px_0_0_var(--danger)]"
      node={node}
      onSelect={onSelect}
      selected={selected}
      state={state}
    >
      <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-danger">
        <ShieldAlert className="h-2.5 w-2.5 text-white" strokeWidth={2.75} />
      </span>
      <Eyebrow className="text-danger-ink" Icon={AlertTriangle}>Violation</Eyebrow>
      <span className="mt-1.5 truncate pr-4 text-[11.5px] font-bold text-fg">{node.label}</span>
      <span className="mt-1 line-clamp-2 text-[9.5px] font-semibold leading-snug text-danger-ink">
        {node.alert?.message}
      </span>
      <Meta>{fmtClockSec(node.firstSeenMs)}</Meta>
    </Card>
  );
}

// ── Single sighting ─────────────────────────────────────────────────────────

export function SightingNode({ node, state, selected, onSelect }) {
  return (
    <Card
      accent="border-line hover:border-brand/40"
      node={node}
      onSelect={onSelect}
      selected={selected}
      state={state}
    >
      <Eyebrow className="text-fg-subtle" Icon={MapPin}>{node.zone || 'Sighting'}</Eyebrow>
      <span className="mt-1.5 truncate text-[11.5px] font-bold text-fg">{node.label}</span>
      <Meta>{fmtClockSec(node.firstSeenMs)}</Meta>
      <Meta>dwell {fmtDuration(node.dwellMs)}</Meta>
    </Card>
  );
}

// ── Cluster ─────────────────────────────────────────────────────────────────

/**
 * A contiguous run through one zone, collapsed.
 *
 * The count and the time range are the whole value of the card — twelve
 * sightings along one corridder between 10:15 and 10:28 is one fact, not
 * twelve. Expanding is local and per-card: there is no expand-all, because
 * expanding everything recreates the problem clustering solves.
 */
export function ClusterNode({ node, state, selected, expanded, onSelect, onToggle }) {
  return (
    <span className="flex shrink-0 flex-col" style={{ width: CARD_W }}>
      <Card
        accent="border-brand/50 shadow-[inset_3px_0_0_var(--brand)]"
        node={node}
        onSelect={onSelect}
        selected={selected}
        state={state}
      >
        <Eyebrow className="text-brand-ink" Icon={MapPin}>Zone run</Eyebrow>
        <span className="mt-1.5 truncate text-[11.5px] font-bold text-fg">{node.label}</span>
        <span className="mt-1 block text-[10px] font-semibold text-fg-secondary">
          {node.count} sightings
        </span>
        <Meta>
          {fmtClockSec(node.firstSeenMs)} – {fmtClockSec(node.lastSeenMs)}
        </Meta>
        <Meta>{fmtDuration(node.dwellMs)} in zone</Meta>
      </Card>

      <button
        aria-expanded={expanded}
        className="mt-1 inline-flex items-center justify-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-[9.5px] font-bold text-brand-ink transition hover:bg-brand-soft"
        onClick={() => onToggle(node.id)}
        type="button"
      >
        {expanded
          ? <ChevronDown className="h-2.5 w-2.5" strokeWidth={3} />
          : <ChevronRight className="h-2.5 w-2.5" strokeWidth={3} />}
        {expanded ? 'Collapse' : `Expand ${node.count} steps`}
      </button>

      {expanded ? <MicroStepList node={node} /> : null}
    </span>
  );
}

/** The individual sightings inside a cluster, once someone asks. */
export function MicroStepList({ node }) {
  return (
    <ol className="mt-1 max-h-[188px] overflow-y-auto rounded-lg border border-line bg-surface-sunken p-1">
      {node.stops.map((stop, i) => (
        <li
          className="flex items-baseline gap-1.5 rounded px-1.5 py-1 text-[9.5px] leading-snug hover:bg-surface"
          key={`${stop.first_seen_at}-${i}`}
        >
          <span className="w-4 shrink-0 text-right font-bold tabular-nums text-fg-subtle">{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-fg-secondary">{stop.label}</span>
            <span className="flex items-center gap-1 tabular-nums text-fg-subtle">
              <Clock3 className="h-2 w-2 shrink-0" strokeWidth={2.5} />
              {fmtClockSec(new Date(stop.first_seen_at).getTime())}
              {stop.duration_sec ? ` · ${fmtDuration(stop.duration_sec * 1000)}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Dispatch by kind, so the chain stays a map over nodes. */
export function JourneyNode({ node, state, selected, expanded, onSelect, onToggle }) {
  const common = { node, state, selected, onSelect };
  if (node.kind === NODE.START || node.kind === NODE.END) return <AnchorNode {...common} />;
  if (node.kind === NODE.ALERT) return <AlertNode {...common} />;
  if (node.kind === NODE.CLUSTER) return <ClusterNode {...common} expanded={expanded} onToggle={onToggle} />;
  return <SightingNode {...common} />;
}
