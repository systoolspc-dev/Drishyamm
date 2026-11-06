/**
 * Room Behavior Settings.
 *
 * Four groups, in the order an operator actually fills them in:
 *
 *   1. Context   — which room is this, and what kind of room
 *   2. Capacity  — the numbers the alerts fire on
 *   3. Schedule  — when those numbers apply, and what happens outside that
 *   4. Privacy   — how much identity this room is allowed to resolve
 *
 * Profile is placed in group 1 rather than beside the thresholds on purpose:
 * choosing it seeds every field in groups 2-4, so it has to come before them or
 * it would silently overwrite work the operator had already done. The panel
 * warns before it does that.
 */
import { useMemo, useState } from 'react';
import {
  Building2, CalendarClock, CircleAlert, Gauge, Loader2, Lock,
  ShieldCheck, Timer, Trash2,
} from 'lucide-react';
import Panel from '@/core/ui/panel';
import { HeaderInfo } from '@/core/ui/header-info';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import { Field, Segmented, Toggle } from './bits';
import DwellLimit from './DwellLimit';
import {
  PRIVACY_MODES, PROFILE_BY_ID, ROOM_PROFILES, withinHours,
} from '../occupancy-data';
import { applyProfile, defaultRoom, deleteRoom, saveRoom } from '../room-settings';

const INPUT = 'mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-small text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';


export default function RoomBehaviorPanel({ zone, room, onSaved, onClose, embedded = false }) {
  const [draft, setDraft] = useState(() => ({ ...defaultRoom(zone), ...(room || {}) }));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  // NOTE: the draft is seeded once, on mount. Switching rooms inside the same
  // panel is a REMOUNT, not a resync -- every caller passes `key={zone.id}`.
  // Copying the new room into state from an effect instead would render one
  // frame of room A's numbers under room B's title, and would quietly discard
  // unsaved edits; remounting makes both impossible by construction.

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const profile = PROFILE_BY_ID[draft.profile];
  const open = withinHours(draft);
  const lockedNow = draft.offHoursLock && !open;

  // A live preview of the rule the operator is writing, against the count the
  // room has right now. Reading "12 of 8 - over" while still in the form is
  // what stops a capacity typo from being discovered by an alert storm.
  const preview = useMemo(() => {
    const count = zone?.count ?? 0;
    const cap = lockedNow ? 0 : Number(draft.maxCapacity) || 0;
    if (cap > 0 && count >= cap) return { tone: 'crit', text: `${count} present now — this rule is already breached` };
    if (Number(draft.minCapacity) > 0 && count < Number(draft.minCapacity)) {
      return { tone: 'warn', text: `${count} present now — below the ${draft.minCapacity} minimum` };
    }
    if (cap > 0) return { tone: 'ok', text: `${count} present now — ${Math.round((count / cap) * 100)}% of this limit` };
    return { tone: 'ok', text: `${count} present now — no limit set, so nothing will alert` };
  }, [zone?.count, draft.maxCapacity, draft.minCapacity, lockedNow]);

  const pickProfile = (id) => {
    // Only warn when there is something to lose: a room that still matches its
    // profile's defaults has no edits worth protecting.
    const current = PROFILE_BY_ID[draft.profile];
    const dirty = current && Object.entries(current.defaults).some(([k, v]) => (
      Array.isArray(v) ? String(v) !== String(draft[k]) : v !== draft[k]
    ));
    if (dirty && !window.confirm('Switching profile replaces the capacity, dwell, schedule and privacy values below. Continue?')) return;
    setDraft((d) => applyProfile(d, id));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    const res = await saveRoom({ ...draft, monitorId: zone.id, cameraId: zone.cameraId }, { cameraEnabled: zone.cameraEnabled });
    setSaving(false);
    setResult(res);
    onSaved?.(res.rooms);
  };

  const reset = () => {
    if (!window.confirm(`Remove the saved settings for ${draft.name || 'this space'}? It falls back to the camera's own limit.`)) return;
    const rooms = deleteRoom(zone.id);
    setDraft(defaultRoom(zone));
    setResult(null);
    onSaved?.(rooms);
  };

  const body = (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {/* ── 1. Context & profile ─────────────────────────────────────────── */}
      <Group icon={Building2} title="Room context & profile">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field htmlFor="room-name" label="Room name">
            <input id="room-name" className={INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Reception Lobby" />
          </Field>
          <Field htmlFor="room-floor" label="Floor level">
            <input id="room-floor" className={INPUT} value={draft.floor} onChange={(e) => set({ floor: e.target.value })} placeholder="Ground floor" />
          </Field>
        </div>

        <Field
          className="mt-3"
          label="Room profile"
          hint={profile?.blurb}
        >
          <Select value={draft.profile} onValueChange={pickProfile}>
            <SelectTrigger className="mt-1.5 w-full"><SelectValue placeholder="Choose a profile" /></SelectTrigger>
            <SelectContent>
              {ROOM_PROFILES.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </Group>

      {/* ── 2. Capacity & dwell ──────────────────────────────────────────── */}
      <Group icon={Gauge} title="Capacity & dwell thresholds">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field htmlFor="room-max" label="Max capacity limit" hint="Over this count, the room is a breach. Pushed to the camera.">
            <input id="room-max" type="number" min="0" className={INPUT} value={draft.maxCapacity}
              onChange={(e) => set({ maxCapacity: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field htmlFor="room-min" label="Min required capacity" hint="Under this count during operating hours, the room is under-staffed. 0 turns it off.">
            <input id="room-min" type="number" min="0" className={INPUT} value={draft.minCapacity}
              onChange={(e) => set({ minCapacity: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
        </div>

        <DwellLimit
          enabled={draft.dwellEnabled !== false}
          idPrefix="room-dwell"
          minutes={Number(draft.maxDwellMin) || 0}
          onChange={set}
        />

        <p className={`mt-3 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[10.5px] leading-relaxed ${
          preview.tone === 'crit' ? 'border-danger-line bg-danger-soft text-danger-ink'
            : preview.tone === 'warn' ? 'border-warning-line bg-warning-soft text-warning-ink'
              : 'border-line bg-surface-sunken text-fg-muted'
        }`}>
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
          <span>{preview.text}</span>
        </p>
      </Group>

      {/* ── 3. Schedule & security ───────────────────────────────────────── */}
      <Group icon={CalendarClock} title="Operating schedule & security">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field htmlFor="room-start" label="Opens at">
            <input id="room-start" type="time" className={INPUT} value={draft.hours?.[0] || '09:00'}
              onChange={(e) => set({ hours: [e.target.value, draft.hours?.[1] || '18:00'] })} />
          </Field>
          <Field htmlFor="room-end" label="Closes at">
            <input id="room-end" type="time" className={INPUT} value={draft.hours?.[1] || '18:00'}
              onChange={(e) => set({ hours: [draft.hours?.[0] || '09:00', e.target.value] })} />
          </Field>
        </div>

        <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-fg-secondary">
              <Lock className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
              Off-hours security lock
            </p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-fg-subtle">
              Outside the hours above, the allowed occupancy becomes 0 — so anyone inside is a breach, with no schedule to maintain by hand.
              {draft.offHoursLock ? (
                <span className={`ml-1 font-semibold ${lockedNow ? 'text-danger-ink' : 'text-success-ink'}`}>
                  {lockedNow ? 'Locked right now.' : 'Open right now.'}
                </span>
              ) : null}
            </p>
          </div>
          <Toggle checked={Boolean(draft.offHoursLock)} onChange={(v) => set({ offHoursLock: v })} label="Off-hours security lock" />
        </div>
      </Group>

      {/* ── 4. Privacy ───────────────────────────────────────────────────── */}
      <Group icon={ShieldCheck} title="Identity & privacy mode">
        <Segmented name="Identity and privacy mode" options={PRIVACY_MODES} value={draft.privacy} onChange={(v) => set({ privacy: v })} />
      </Group>

      {result?.error ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning-line bg-warning-soft px-2.5 py-2 text-[11px] leading-relaxed text-warning-ink">
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
          <span>{result.error}</span>
        </p>
      ) : result ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-success-line bg-success-soft px-2.5 py-2 text-[11px] leading-relaxed text-success-ink">
          <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
          <span>Saved. The capacity limit is armed on the camera; schedule, dwell and privacy are held on this browser.</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2.25} />}
          Save room behaviour
        </button>
        {onClose ? (
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken">
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-muted transition hover:border-danger-line hover:bg-danger-soft hover:text-danger-ink"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
          Reset
        </button>
      </div>
    </form>
  );

  if (embedded) return body;

  return (
    <Panel
      icon={Timer}
      title={draft.name || zone?.label || 'Room behaviour'}
      right={<HeaderInfo label="Room behaviour" text="Capacity limits are pushed to the camera and armed by the detector. Profile, dwell ceiling, operating hours and privacy mode are held on this browser until the head-count service exposes fields for them." />}
      bodyClass="p-4"
    >
      {body}
    </Panel>
  );
}

/** A labelled group inside the form. Local: it exists only to keep the four sections apart. */
function Group({ icon: Icon, title, children }) {
  return (
    <section>
      <p className="flex items-center gap-1.5 border-b border-line-subtle pb-1.5 text-[11px] font-bold uppercase tracking-wide text-fg-muted">
        <Icon className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
        {title}
      </p>
      <div className="pt-3">{children}</div>
    </section>
  );
}
