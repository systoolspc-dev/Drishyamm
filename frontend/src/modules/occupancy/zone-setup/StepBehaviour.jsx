/**
 * The zone's rules, one export per section of the Capacity & rules column:
 *
 *   Capacity & alerts     the limit and the warning line (open by default)
 *   Schedule & security   operating hours and the off-hours lock
 *   Staffing & dwell      minimum staffing and the loitering ceiling
 *   (Access & identity    privacy mode here; the whitelist is StepAccess)
 *
 * Floor and profile describe what the zone IS, so they sit beside its name
 * above the canvas (ZoneIdentityFields) rather than among its rules.
 *
 * Explanations live behind an info icon beside each label, not in paragraphs
 * under the fields: the column has to fit one screen.
 *
 * Same record the zone cards' quick-edit drawer writes, so a zone configured here
 * shows up on the occupancy page without a second save anywhere.
 */
import {
  Gauge, Lock, ShieldCheck, TriangleAlert, Users,
} from 'lucide-react';
import {
  Field, InfoTip, Segmented, Toggle,
} from '../components/bits';
import DwellLimit from '../components/DwellLimit';
import WarnThreshold from '../components/WarnThreshold';
import {
  FULL_PCT, PRIVACY_MODES, ROOM_PROFILES, withinHours,
} from '../occupancy-data';

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-body text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';

/** The limit in force right now: 0 under strict lockout or the off-hours lock. */
const capInForce = (draft, lockedOut) => (
  lockedOut || (draft.offHoursLock && !withinHours(draft)) ? 0 : Number(draft.maxCapacity) || 0
);

/**
 * Step 2's header badge: the people in the zone against the limit being
 * written, so "is this rule already breached" is answered at a glance instead
 * of in a sentence under the form. `count` is the live count off the camera
 * when there is one -- counted inside the boundary as it is drawn now, saved
 * or not -- and the last server reading otherwise.
 */
export function CapacityBadge({ draft, lockedOut, count = 0, live = false }) {
  const cap = capInForce(draft, lockedOut);
  const locked = lockedOut || (draft.offHoursLock && !withinHours(draft));
  const pct = Number(draft.warnPct) || FULL_PCT;
  const warnAt = draft.warnEnabled !== false && cap > 0 ? Math.ceil((cap * pct) / 100) : null;

  let tone = 'neutral';
  let text = `${count} now · no limit`;
  if (locked) {
    tone = count > 0 ? 'danger' : 'neutral';
    text = count > 0 ? `Locked · ${count} inside` : 'Locked';
  } else if (cap > 0) {
    tone = count >= cap ? 'danger' : warnAt != null && count >= warnAt ? 'warning' : 'success';
    text = `${count} / ${cap}${count >= cap ? ' · Breached' : ''}`;
  }
  const look = {
    danger: 'bg-danger-soft text-danger-ink ring-danger-line',
    warning: 'bg-warning-soft text-warning-ink ring-warning-line',
    success: 'bg-success-soft text-success-ink ring-success-line',
    neutral: 'bg-surface-muted text-fg-muted ring-line',
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-small font-bold tabular-nums ring-1 ${look}`}
      title={live ? 'Live: people inside the boundary on this camera now, against the limit being set' : 'People in this zone at last reading, against the limit being set'}
    >
      {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {tone === 'danger' ? <TriangleAlert className="h-3 w-3" strokeWidth={2.5} /> : <Users className="h-3 w-3" strokeWidth={2.5} />}
      {text}
    </span>
  );
}


/**
 * Capacity & alerts: the limit and the warning line. Strict lockout (under
 * Access) still governs the limit -- a lockout IS a capacity of zero. How the
 * room stands against it is the header badge.
 */
export function CapacityStep({ draft, set, lockedOut }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-body font-semibold text-fg-secondary" htmlFor="z-max">
            <Gauge className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
            Max capacity
          </label>
          <InfoTip label="About max capacity">
            {lockedOut
              ? 'Held at 0 by strict lockout, set under Access & identity.'
              : 'Above this count the zone is in breach. Pushed to the camera. 0 means no limit.'}
          </InfoTip>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <input
            className={`w-20 rounded-lg border border-line bg-surface px-2 py-1 text-right text-body font-bold tabular-nums text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 ${lockedOut ? 'opacity-50' : ''}`}
            disabled={lockedOut}
            id="z-max"
            min="0"
            onChange={(e) => set({ maxCapacity: Math.max(0, Number(e.target.value) || 0) })}
            type="number"
            value={lockedOut ? 0 : draft.maxCapacity}
          />
          <span className="text-body text-fg-subtle">people</span>
        </span>
      </div>

      <WarnThreshold
        capacity={capInForce(draft, lockedOut)}
        compact
        enabled={draft.warnEnabled !== false}
        idPrefix="z-warn"
        onChange={set}
        pct={draft.warnPct}
      />
    </div>
  );
}

/** Operating hours & the off-hours lock. */
export function ScheduleRules({ draft, set }) {
  const lockedNow = draft.offHoursLock && !withinHours(draft);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Field htmlFor="z-start" label="Opens at">
          <input className={INPUT} id="z-start" onChange={(e) => set({ hours: [e.target.value, draft.hours?.[1] || '18:00'] })} type="time" value={draft.hours?.[0] || '09:00'} />
        </Field>
        <Field htmlFor="z-end" label="Closes at">
          <input className={INPUT} id="z-end" onChange={(e) => set({ hours: [draft.hours?.[0] || '09:00', e.target.value] })} type="time" value={draft.hours?.[1] || '18:00'} />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2">
        <p className="flex min-w-0 items-center gap-1.5 text-body font-semibold text-fg-secondary">
          <Lock className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
          Off-hours security lock
          <InfoTip label="About the off-hours lock">
            Outside the hours above, the allowed occupancy becomes 0, so anyone inside is a breach, with no
            schedule to maintain by hand.
          </InfoTip>
          {draft.offHoursLock ? (
            <span className={`rounded-md px-1.5 py-0.5 text-small font-bold ${lockedNow ? 'bg-danger-soft text-danger-ink' : 'bg-success-soft text-success-ink'}`}>
              {lockedNow ? 'Locked now' : 'Open now'}
            </span>
          ) : null}
        </p>
        <Toggle checked={Boolean(draft.offHoursLock)} label="Off-hours security lock" onChange={(v) => set({ offHoursLock: v })} />
      </div>
    </div>
  );
}

/** Minimum staffing & the dwell ceiling. */
export function StaffingRules({ draft, set }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-body font-semibold text-fg-secondary" htmlFor="z-min">
            <Users className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
            Min staffing
          </label>
          <InfoTip label="About min staffing">
            Under this count during operating hours the zone is under-staffed. 0 turns it off.
          </InfoTip>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <input
            className="w-20 rounded-lg border border-line bg-surface px-2 py-1 text-right text-body font-bold tabular-nums text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            id="z-min"
            min="0"
            onChange={(e) => set({ minCapacity: Math.max(0, Number(e.target.value) || 0) })}
            type="number"
            value={draft.minCapacity}
          />
          <span className="text-body text-fg-subtle">people</span>
        </span>
      </div>

      <DwellLimit
        compact
        enabled={draft.dwellEnabled !== false}
        idPrefix="z-dwell"
        minutes={Number(draft.maxDwellMin) || 0}
        onChange={set}
      />
    </div>
  );
}

/**
 * Floor and profile: what the zone IS, so they sit with its name above the
 * canvas rather than among its rules. Floors come from the camera groups the
 * site is organised by, plus whatever this zone was saved with.
 */
export function ZoneIdentityFields({ draft, set, floors }) {
  const blurb = ROOM_PROFILES.find((p) => p.id === draft.profile)?.blurb;
  const SELECT = 'min-w-0 rounded-lg border border-line bg-surface px-2 py-2 text-body text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';
  return (
    <>
      <select aria-label="Floor level" className={SELECT} id="z-floor" onChange={(e) => set({ floor: e.target.value })} title="Floor level" value={draft.floor || ''}>
        <option value="">No floor</option>
        {floors.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
      <span className="flex min-w-0 items-center gap-1">
        <select aria-label="Zone profile" className={`${SELECT} w-full`} id="z-profile" onChange={(e) => set({ profile: e.target.value })} title="Zone profile" value={draft.profile}>
          {ROOM_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {blurb ? <InfoTip label="About this profile">{blurb}</InfoTip> : null}
      </span>
    </>
  );
}

/** Identity tracking (privacy mode), shown under Access & identity. */
export function IdentityTracking({ draft, set }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-body font-semibold text-fg-secondary">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
        Identity tracking
      </p>
      <Segmented compact name="Identity tracking" onChange={(v) => set({ privacy: v })} options={PRIVACY_MODES} value={draft.privacy} />
    </div>
  );
}
