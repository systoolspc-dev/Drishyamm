/**
 * Step 3 — Access authorisation & whitelist.
 *
 * The whole step hangs off one radio: a Public zone has no whitelist to write,
 * and a Strict-lockout zone has one that would never be consulted. Both hide
 * the selectors rather than disabling them, because a greyed-out list of names
 * invites an operator to believe the names still mean something.
 *
 * The honest limitation, stated in the UI and not just here: there is no
 * directory service behind this app. A "role" is a label attached to a name on
 * this screen, not something looked up and verified. So the individual
 * whitelist is the part that actually decides access, and roles are a way to
 * organise it.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle, Check, CircleAlert, Clock, Plus, ShieldCheck, UserPlus, Users, X,
} from 'lucide-react';
import { Field, InfoTip, Segmented } from '../components/bits';
import { ACCESS_MODES, DEFAULT_ROLES, SCHEDULE_MODES } from './access-data';

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-body text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';

export default function StepAccess({ access, onChange, suggestions = [], severity, alertAfterSec, onRule }) {
  const [query, setQuery] = useState('');
  const [newRole, setNewRole] = useState('');

  const set = (patch) => onChange({ ...access, ...patch });

  const roles = useMemo(
    () => Array.from(new Set([...DEFAULT_ROLES, ...(access.roles || [])])),
    [access.roles],
  );

  // Names the cameras have actually recognised, or that were enrolled on this
  // browser — minus whoever is already on the list. Suggesting a name that is
  // already whitelisted is just a way to create duplicates.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const already = new Set((access.people || []).map((p) => p.name.toLowerCase()));
    return suggestions
      .filter((s) => !already.has(s.name.toLowerCase()))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.id || '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, suggestions, access.people]);

  const addPerson = (person) => {
    if (!person?.name?.trim()) return;
    const exists = (access.people || []).some((p) => p.name.toLowerCase() === person.name.trim().toLowerCase());
    if (exists) return;
    set({ people: [...(access.people || []), { id: person.id || '', name: person.name.trim(), role: person.role || '' }] });
    setQuery('');
  };

  const restricted = access.mode === 'restricted';

  return (
    <div className="flex flex-col gap-3">
      <Group icon={ShieldCheck} title="Who may enter">
        <Segmented compact name="Who may enter" onChange={(v) => set({ mode: v })} options={ACCESS_MODES} value={access.mode} />

        {access.mode === 'lockout' ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-small font-semibold text-danger-ink">
            <CircleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
            Capacity held at 0 — any presence is a breach.
          </p>
        ) : null}
      </Group>

      {/* How loud, and how soon. Both are armed on the server alongside the
          whitelist, so they sit with it rather than with the capacity numbers
          -- an intrusion severity has nothing to do with how full a room is. */}
      {access.mode !== 'public' ? (
        <Group icon={AlertTriangle} title="Alert behaviour">
          <div className="grid grid-cols-2 gap-2">
            <Field
              hintAs="tooltip"
              hint="Sets the tone of the breach row and how hard the alert pushes."
              htmlFor="z-sev"
              label="Breach severity"
            >
              <select className={INPUT} id="z-sev" onChange={(e) => onRule({ severity: e.target.value })} value={severity}>
                <option value="critical">Critical</option>
                <option value="warn">Warning</option>
                <option value="info">Info</option>
              </select>
            </Field>
            <Field
              hintAs="tooltip"
              hint="A debounce, not the loitering ceiling: how long someone must be inside before it counts as an intrusion."
              htmlFor="z-delay"
              label="Alert after"
            >
              <select className={INPUT} id="z-delay" onChange={(e) => onRule({ alertAfterSec: Number(e.target.value) })} value={alertAfterSec}>
                <option value={0}>Instantly</option>
                <option value={3}>3 seconds</option>
                <option value={5}>5 seconds</option>
                <option value={10}>10 seconds</option>
                <option value={30}>30 seconds</option>
              </select>
            </Field>
          </div>
        </Group>
      ) : null}

      {/* Hidden, not disabled: a greyed-out whitelist still reads as a rule that
          is in force somewhere. */}
      {restricted ? (
        <>
          <Group
            icon={Users}
            info="There is no staff directory wired to this app yet, so a role only grants access to people you tag with it in the whitelist below. The individual list is what the detector actually checks."
            title="Authorized roles"
          >
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => {
                const on = (access.roles || []).includes(r);
                return (
                  <button
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body font-semibold transition ${
                      on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-muted hover:border-brand/40 hover:text-fg'
                    }`}
                    key={r}
                    onClick={() => set({
                      roles: on ? access.roles.filter((x) => x !== r) : [...(access.roles || []), r],
                    })}
                    type="button"
                  >
                    {on ? <Check className="h-3 w-3" strokeWidth={3} /> : <Plus className="h-3 w-3" strokeWidth={2.5} />}
                    {r}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 flex gap-2">
              <input
                className={`${INPUT} mt-0 flex-1`}
                onChange={(e) => setNewRole(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !newRole.trim()) return;
                  e.preventDefault();
                  set({ roles: [...(access.roles || []), newRole.trim()] });
                  setNewRole('');
                }}
                placeholder="Add another role…"
                value={newRole}
              />
              <button
                className="shrink-0 rounded-lg border border-line px-3 text-body font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
                disabled={!newRole.trim()}
                onClick={() => { set({ roles: [...(access.roles || []), newRole.trim()] }); setNewRole(''); }}
                type="button"
              >
                Add
              </button>
            </div>

          </Group>

          <Group icon={UserPlus} title="Individual whitelist">
            <Field
              hintAs="tooltip"
              hint="Search the people these cameras have recognised, or type any name or employee ID and press Enter."
              htmlFor="wl-search"
              label="Add a person"
            >
              <input
                className={INPUT}
                id="wl-search"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && query.trim()) {
                    e.preventDefault();
                    addPerson({ name: query, id: '' });
                  }
                }}
                placeholder="Name or employee ID…"
                value={query}
              />
            </Field>

            {matches.length ? (
              <ul className="mt-1.5 flex flex-col gap-1 rounded-lg border border-line bg-surface-sunken p-1">
                {matches.map((s) => (
                  <li key={s.name}>
                    <button
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body text-fg-secondary transition hover:bg-brand-soft hover:text-brand-ink"
                      onClick={() => addPerson(s)}
                      type="button"
                    >
                      <Plus className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                      <span className="flex-1 truncate font-semibold">{s.name}</span>
                      <span className="shrink-0 text-small text-fg-subtle">{s.source}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {access.people?.length ? (
              <ul className="mt-2 flex flex-col gap-1">
                {access.people.map((p) => (
                  <li
                    className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5"
                    key={p.name}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-semibold text-fg">{p.name}</span>
                      {p.id ? <span className="block truncate text-small text-fg-subtle">ID {p.id}</span> : null}
                    </span>
                    <select
                      className="h-7 shrink-0 rounded-md border border-line bg-surface px-1.5 text-small text-fg-secondary focus:border-brand focus:outline-none"
                      onChange={(e) => set({
                        people: access.people.map((q) => (q.name === p.name ? { ...q, role: e.target.value } : q)),
                      })}
                      value={p.role || ''}
                    >
                      <option value="">No role</option>
                      {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <button
                      aria-label={`Remove ${p.name}`}
                      className="shrink-0 rounded p-1 text-fg-subtle transition hover:bg-danger-soft hover:text-danger-ink"
                      onClick={() => set({ people: access.people.filter((q) => q.name !== p.name) })}
                      type="button"
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-small font-semibold text-warning-ink">
                Nobody whitelisted — everyone inside is a breach.
              </p>
            )}
          </Group>

          <Group icon={Clock} title="Access schedule">
            <Segmented compact name="Access schedule" onChange={(v) => set({ scheduleMode: v })} options={SCHEDULE_MODES} value={access.scheduleMode} />

            {access.scheduleMode === 'hours' ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field htmlFor="acc-start" label="Access from">
                  <input
                    className={INPUT}
                    id="acc-start"
                    onChange={(e) => set({ scheduleHours: [e.target.value, access.scheduleHours?.[1] || '17:00'] })}
                    type="time"
                    value={access.scheduleHours?.[0] || '09:00'}
                  />
                </Field>
                <Field htmlFor="acc-end" label="Access until">
                  <input
                    className={INPUT}
                    id="acc-end"
                    onChange={(e) => set({ scheduleHours: [access.scheduleHours?.[0] || '09:00', e.target.value] })}
                    type="time"
                    value={access.scheduleHours?.[1] || '17:00'}
                  />
                </Field>
              </div>
            ) : null}
          </Group>
        </>
      ) : null}
    </div>
  );
}

function Group({
  icon: Icon, title, info, children,
}) {
  return (
    <section>
      <p className="flex items-center gap-1.5 text-body font-semibold text-fg-secondary">
        <Icon className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
        {title}
        {info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
      </p>
      <div className="pt-1.5">{children}</div>
    </section>
  );
}
