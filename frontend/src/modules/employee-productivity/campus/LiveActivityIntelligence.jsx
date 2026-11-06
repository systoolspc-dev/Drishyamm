import { useState } from 'react';
import {
  Radar, Activity, Users, Gauge, DoorOpen, BellRing,
} from 'lucide-react';

import KpiBand from '../kpi-card';

import FilterBar from './components/FilterBar';
import LiveTimeline from './components/LiveTimeline';
import ActiveSessions from './components/ActiveSessions';
import RecentEventsList from './components/RecentEventsList';
import AIDecisionPanel from './components/AIDecisionPanel';
import PersonDrawer from './components/PersonDrawer';
import { LIVE_SUMMARY, PEOPLE } from './live-data';

// ─────────────────────────────────────────────────────────────────────────────
// Live Activity Intelligence — campus subpage (Prompt 2).
//
// Shows what the AI currently *understands* is happening on campus — classified
// activities, per-person tracking sessions, and the reasoning behind each call.
// NOT a CCTV wall. FRONTEND-ONLY: dummy data from ./live-data.js. Selecting any
// tracked person opens the right drawer with their full context.
//
// Layout: filters · activity summary (shared KPI band)
//         · [ live timeline | AI decision panel ]
//         · [ active sessions | recent events ] · right person drawer
// ─────────────────────────────────────────────────────────────────────────────

// Summary band icons, keyed by LIVE_SUMMARY key. Cards carry their own tone
// (Live Alerts is 'warn'); the rest default to brand.
const SUMMARY_ICONS = {
  sessions: Activity, people: Users, confidence: Gauge, rooms: DoorOpen, alerts: BellRing,
};

export default function LiveActivityIntelligence() {
  const [filters, setFilters] = useState({
    university: 'sharda', building: 'all', department: 'all', floor: 'all', room: 'all', range: 'live',
  });
  const [selected, setSelected] = useState(null); // personId or null
  const person = selected ? PEOPLE[selected] : null;

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Radar className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Live Activity Intelligence</h1>
            <p className="mt-1 text-small text-fg-muted">What the AI understands is happening on campus, right now — not CCTV.</p>
          </div>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-caption font-bold uppercase tracking-wide text-success-ink ring-1 ring-success-line">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live
          </span>
        </div>

        {/* Filters */}
        <FilterBar value={filters} onChange={setFilters} />

        {/* Activity summary — under the filter bar, like every KPI band */}
        <KpiBand cards={LIVE_SUMMARY} className="mb-4" icons={SUMMARY_ICONS} />

        {/* Timeline | AI decisions */}
        <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <LiveTimeline onSelect={setSelected} />
          </div>
          <AIDecisionPanel />
        </div>

        {/* Active sessions | Recent events */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ActiveSessions onSelect={setSelected} selectedId={selected} />
          <RecentEventsList onSelect={setSelected} />
        </div>
      </div>

      {/* Right drawer — selected person */}
      <PersonDrawer person={person} onClose={() => setSelected(null)} />
    </div>
  );
}
