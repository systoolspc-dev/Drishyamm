/**
 * Quick-edit drawer for one zone, opened from its card on the live wall.
 *
 * Only the two numbers people actually adjust while watching the wall: the
 * limit, and how early to be warned about it. Everything that needs the camera
 * picture in front of you -- the boundary, which streams feed the zone, access
 * rules -- stays in Zone Setup, and the footer says so rather than letting the
 * drawer grow into a second copy of that page.
 *
 * A drawer rather than a modal because the reason for opening it is usually on
 * the wall behind it: a card reading "No capacity set", or a count that looks
 * wrong. The overlay is kept light and the drawer narrow so that card stays in
 * view, and the live count inside the drawer keeps ticking while you type.
 */
import { useState } from 'react';
import {
  ArrowRight, Camera, CircleAlert, Gauge, Loader2, MapPin, ShieldCheck,
} from 'lucide-react';
import {
  Sheet, SheetContent, SheetDescription, SheetTitle,
} from '@/core/ui/sheet';
import { Field, StatusChip } from './bits';
import WarnThreshold from './WarnThreshold';
import { FULL_PCT, capacityBarClass, nfmt } from '../occupancy-data';
import { defaultRoom, saveRoom } from '../room-settings';

const INPUT = 'w-full rounded-lg border border-line bg-surface py-2 pl-3 pr-16 text-small font-bold tabular-nums text-fg placeholder:font-normal placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';

/**
 * `zone` is the LIVE zone (re-derived every poll) so the count in the header
 * moves while the drawer is open; the form inside is keyed on its id, so a
 * poll never resets what is being typed.
 */
export default function QuickZoneDrawer({ zone, room, registry, onClose, onSaved, onOpenZoneSetup }) {
  return (
    <Sheet onOpenChange={(o) => !o && onClose()} open={Boolean(zone)}>
      <SheetContent
        className="w-[400px] max-w-full gap-0 bg-surface p-0"
        overlayClassName="bg-black/20"
        side="right"
      >
        {zone ? (
          <DrawerBody
            key={zone.id}
            onClose={onClose}
            onOpenZoneSetup={onOpenZoneSetup}
            onSaved={onSaved}
            registry={registry}
            room={room}
            zone={zone}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ zone, room, registry, onClose, onSaved, onOpenZoneSetup }) {
  // Seeded once. A zone nobody has configured opens with an EMPTY limit rather
  // than the default profile's guess: a number the operator did not type would
  // be saved as if they had.
  const [initial] = useState(() => {
    const base = { ...defaultRoom(zone), ...(room || {}) };
    return {
      base,
      maxCapacity: room || zone.capacity > 0 ? String(Number(base.maxCapacity) || '') : '',
      warnEnabled: base.warnEnabled !== false,
      warnPct: Number(base.warnPct) || FULL_PCT,
    };
  });
  const [maxCapacity, setMaxCapacity] = useState(initial.maxCapacity);
  const [warn, setWarn] = useState({ warnEnabled: initial.warnEnabled, warnPct: initial.warnPct });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const cap = Number(maxCapacity) || 0;
  const dirty = maxCapacity !== initial.maxCapacity
    || warn.warnEnabled !== initial.warnEnabled
    || warn.warnPct !== initial.warnPct;
  const count = zone.count;
  const pct = cap > 0 ? Math.round((count / cap) * 100) : 0;

  const preview = cap <= 0
    ? { tone: 'muted', text: 'No limit — this zone will never alert on capacity.' }
    : count >= cap
      ? { tone: 'crit', text: `${nfmt(count)} present now — this limit is already breached.` }
      : warn.warnEnabled && pct >= warn.warnPct
        ? { tone: 'warn', text: `${nfmt(count)} present now (${pct}%) — this would raise a warning straight away.` }
        : { tone: 'ok', text: `${nfmt(count)} present now — ${pct}% of this limit.` };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    // Only the limit and the warning change here; the zone's cameras and
    // shapes ride along untouched, and every camera it spans is rewritten.
    const res = await saveRoom({ ...initial.base, ...warn, maxCapacity: cap }, { registry });
    setSaving(false);
    onSaved(res.rooms);
    // A partial save stays open: the operator needs to read which half did not
    // land, and a drawer that closed on them would hide exactly that.
    if (res.error) setError(res.error);
    else onClose();
  };

  const goToSetup = () => {
    if (dirty && !window.confirm('Leave without saving the changes in this drawer?')) return;
    onOpenZoneSetup(zone.id);
  };

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={submit}>
      {/* ── Header: which zone, is it live, what feeds it ─────────────────── */}
      <header className="border-b border-line px-5 pb-4 pt-5 pr-12">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <MapPin className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <div className="min-w-0">
            <SheetTitle className="break-words text-[15px] font-bold leading-snug text-fg">{zone.label}</SheetTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
              <LivePill offline={zone.offline} />
              <span className="inline-flex min-w-0 items-start gap-1">
                <Camera className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                <span className="break-words">{zone.cameras.join(', ') || 'No camera linked'}</span>
              </span>
              {zone.floor ? <span className="break-words">· {zone.floor}</span> : null}
            </div>
          </div>
        </div>
        <SheetDescription className="sr-only">
          Quick edit of the capacity limit and near-capacity warning for {zone.label}.
        </SheetDescription>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {/* ── Live now: the number the operator is reacting to ─────────────── */}
        <section className="rounded-xl border border-line bg-surface-sunken p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-bold uppercase tracking-wide text-fg-subtle">Live now</span>
            <StatusChip status={zone.status} />
          </div>
          <p className="mt-2 text-[24px] font-extrabold leading-none tracking-tight tabular-nums text-fg">
            {nfmt(count)}
            <span className="ml-1 text-[13px] font-semibold tracking-normal text-fg-subtle">
              / {zone.capacity > 0 ? nfmt(zone.capacity) : '—'}
            </span>
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
            {zone.capacity > 0 ? (
              <div
                className={`h-full rounded-full transition-[width] ${capacityBarClass(zone.utilization)}`}
                style={{ width: `${Math.min(100, zone.utilization)}%` }}
              />
            ) : null}
          </div>
          {zone.locked ? (
            <p className="mt-2 text-[10.5px] font-semibold text-danger-ink">
              Off-hours lock is active, so the limit in force is 0 until opening.
            </p>
          ) : null}
        </section>

        {/* ── The two quick settings ──────────────────────────────────────── */}
        <section>
          <p className="flex items-center gap-1.5 border-b border-line-subtle pb-1.5 text-[11px] font-bold uppercase tracking-wide text-fg-muted">
            <Gauge className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
            Capacity
          </p>

          <Field
            className="pt-3"
            hint="Over this count the zone is a breach. Pushed to the camera. Leave empty for no limit."
            htmlFor="qz-max"
            label="Max capacity limit"
          >
            <div className="relative mt-1.5">
              <input
                autoFocus={!zone.capacity}
                className={INPUT}
                id="qz-max"
                inputMode="numeric"
                min="0"
                onChange={(e) => setMaxCapacity(e.target.value === '' ? '' : String(Math.max(0, Math.floor(Number(e.target.value) || 0))))}
                placeholder="e.g. 40"
                type="number"
                value={maxCapacity}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-semibold text-fg-subtle">
                people
              </span>
            </div>
          </Field>

          <WarnThreshold
            capacity={cap}
            enabled={warn.warnEnabled}
            idPrefix="qz-warn"
            onChange={(patch) => setWarn((w) => ({ ...w, ...patch }))}
            pct={warn.warnPct}
          />

          <p className={`mt-3 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[10.5px] leading-relaxed ${
            preview.tone === 'crit' ? 'border-danger-line bg-danger-soft text-danger-ink'
              : preview.tone === 'warn' ? 'border-warning-line bg-warning-soft text-warning-ink'
                : 'border-line bg-surface-sunken text-fg-muted'
          }`}
          >
            <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
            <span>{preview.text}</span>
          </p>
        </section>

        {error ? (
          <p className="flex items-start gap-1.5 rounded-lg border border-warning-line bg-warning-soft px-2.5 py-2 text-[11px] leading-relaxed text-warning-ink" role="alert">
            <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
            <span>{error}</span>
          </p>
        ) : null}
      </div>

      {/* ── Footer: commit, and the way out to the full editor ─────────────── */}
      <footer className="border-t border-line bg-surface px-5 py-4">
        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!dirty || saving}
            type="submit"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2.25} />}
            {zone.capacity > 0 || room ? 'Save changes' : 'Set capacity'}
          </button>
          <button
            className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3.5 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>

        <div className="mt-4 rounded-lg border border-dashed border-line-strong bg-surface-sunken px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-fg-muted">
            Need to re-map camera streams or draw boundaries?
          </p>
          <button
            className="mt-1 inline-flex items-center gap-1 rounded text-[11.5px] font-semibold text-brand-ink transition hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            onClick={goToSetup}
            type="button"
          >
            Go to full Zone Setup
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
          </button>
        </div>
      </footer>
    </form>
  );
}

function LivePill({ offline }) {
  return offline ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-fg-muted ring-1 ring-line">
      <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" />
      Offline
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-success-ink ring-1 ring-success-line">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
      Live
    </span>
  );
}
