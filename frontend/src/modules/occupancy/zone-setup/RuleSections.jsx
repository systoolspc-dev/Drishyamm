/**
 * Capacity & rules: four accordion sections, one per question.
 *
 *   Capacity & alerts        open by default -- a zone counts with just this
 *   Schedule & security      hours, off-hours lock
 *   Staffing & dwell         min staffing, loitering ceiling
 *   Access & identity        who may enter, whitelist, privacy mode
 *
 * Replaces one "More rules" drawer that opened everything at once into a
 * column taller than the screen. A closed section still says what is set in
 * one line ("09:00–18:00 · locked off-hours"), so a rule nobody expected is
 * visible without opening anything.
 *
 * It now renders inside the right-hand drawer (RulesDrawer.jsx) rather than a
 * third page column, and kept the accordion through that move -- the reasoning
 * is in that file, next to the decision.
 *
 * Which sections are open is remembered per browser: someone tuning dwell
 * across twenty zones should not reopen it twenty times.
 *
 * `locked` is a brand-new zone with no boundary yet. Everything but capacity
 * waits until it has one: the shape is the next thing to do, and schedules or
 * whitelists for a zone that does not exist yet are a distraction from it.
 */
import { useState } from 'react';
import {
  CalendarClock, ChevronRight, Gauge, Lock, ShieldCheck, Timer,
} from 'lucide-react';
import {
  CapacityStep, IdentityTracking, ScheduleRules, StaffingRules,
} from './StepBehaviour';
import StepAccess from './StepAccess';
import { summaries } from './rule-summary';

const OPEN_KEY = 'drishyam.zoneSetup.openSections';
const DEFAULT_OPEN = ['capacity'];

const readOpen = () => {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null');
    return new Set(Array.isArray(v) ? v : DEFAULT_OPEN);
  } catch { return new Set(DEFAULT_OPEN); }
};
const writeOpen = (set) => {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* storage blocked: per-visit */ }
};

export default function RuleSections({
  draft, set, access, lockedOut, suggestions, locked = false,
}) {
  const [open, setOpen] = useState(readOpen);
  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeOpen(next);
    return next;
  });
  const sum = summaries(draft, lockedOut);

  const sections = [
    {
      id: 'capacity', icon: Gauge, title: 'Capacity & alerts',
      body: <CapacityStep draft={draft} lockedOut={lockedOut} set={set} />,
    },
    {
      id: 'schedule', icon: CalendarClock, title: 'Schedule & security',
      body: <ScheduleRules draft={draft} set={set} />,
    },
    {
      id: 'staffing', icon: Timer, title: 'Staffing & dwell',
      body: <StaffingRules draft={draft} set={set} />,
    },
    {
      id: 'access', icon: ShieldCheck, title: 'Access & identity',
      body: (
        <div className="flex flex-col gap-3">
          <StepAccess
            access={access}
            alertAfterSec={draft.alertAfterSec ?? 5}
            onChange={(a) => set({ access: a })}
            onRule={set}
            severity={draft.severity || 'critical'}
            suggestions={suggestions}
          />
          <IdentityTracking draft={draft} set={set} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      {sections.map(({
        id, icon, title, body,
      }) => {
        const Icon = icon;
        const waits = locked && id !== 'capacity';
        const isOpen = !waits && open.has(id);
        const summary = waits ? 'Draw the boundary first' : sum[id].filter(Boolean).join(' · ');
        return (
          <section className={`overflow-hidden rounded-lg border border-line bg-surface ${waits ? 'opacity-55' : ''}`} key={id}>
            <button
              aria-controls={`rules-${id}`}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition enabled:hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand disabled:cursor-not-allowed"
              disabled={waits}
              onClick={() => toggle(id)}
              type="button"
            >
              <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
              <span className="shrink-0 text-heading font-bold text-fg">{title}</span>
              {!isOpen && summary ? (
                <span className="min-w-0 flex-1 truncate text-right text-small text-fg-subtle" title={summary}>{summary}</span>
              ) : <span className="flex-1" />}
              {waits ? <Lock className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2.25} /> : (
                <ChevronRight
                  className={`h-4 w-4 shrink-0 text-fg-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  strokeWidth={2.25}
                />
              )}
            </button>
            {isOpen ? (
              <div className="border-t border-line-subtle px-3 py-2.5" id={`rules-${id}`}>{body}</div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
