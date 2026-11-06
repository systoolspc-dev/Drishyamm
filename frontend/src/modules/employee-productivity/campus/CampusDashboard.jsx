import { useEffect, useRef, useState } from 'react';
import { LineChart, Radio, BarChart3 } from 'lucide-react';

import PolicyBar from '../PolicyBar';
import CampusHeader from './components/CampusHeader';
import FilterBar from './components/FilterBar';
import SectionCard from './components/SectionCard';
import KeyMetrics from './components/KeyMetrics';
import ActivityInsights from './components/ActivityInsights';
import LiveOverview from './components/LiveOverview';
import ActivityAnalytics from './components/ActivityAnalytics';
import QuickActionsFooter from './components/QuickActionsFooter';

// ─────────────────────────────────────────────────────────────────────────────
// Campus Activity Monitoring — landing page (Education vertical).
//
// AI Analytics dashboard (NOT a CCTV page). Light theme, white surfaces, orange
// (#F7983A) accents, rounded-2xl cards, soft shadows — enterprise security-ops
// style. FRONTEND-ONLY: every widget renders dummy data from ./data.js.
//
// Layout:
//   header (breadcrumb · search · notifications · profile · last-updated · auto-refresh)
//   filter bar (University → Building → Department → Floor → Room · Time Range)
//   § Key Metrics       — 6 KPI cards, section eye toggle, People-Present popover
//   § Activity Insights — distribution + trend, section + per-chart eye toggles
//   § Live Overview     — feed · active table · alerts, section eye toggle
//   § Activity Analytics— hourly · status, section eye toggle
//   sticky Quick Actions footer
// ─────────────────────────────────────────────────────────────────────────────

const VIS_KEY = 'campus-activity-sections';
// Activity Analytics starts collapsed (eye-off) by default — it's the deep-dive
// section; users open it on demand.
const DEFAULT_VIS = { insights: true, live: true, analytics: false };
const loadVis = () => {
  try { return { ...DEFAULT_VIS, ...JSON.parse(localStorage.getItem(VIS_KEY) || '{}') }; }
  catch { return DEFAULT_VIS; }
};

function nowStamp() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export default function CampusDashboard() {
  const [filters, setFilters] = useState({
    university: 'sharda', building: 'all', department: 'all', floor: 'all', room: 'all', range: 'live',
  });
  const [query, setQuery] = useState('');

  // Header status: last-updated stamp + auto-refresh toggle + manual refresh.
  const [lastUpdated, setLastUpdated] = useState(nowStamp);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef(null);

  const refresh = () => {
    setRefreshing(true);
    // Simulated fetch — in the real build this is queryClient.invalidateQueries.
    setTimeout(() => { setLastUpdated(nowStamp()); setRefreshing(false); }, 700);
  };

  // Auto-refresh every 30s while enabled.
  useEffect(() => {
    if (!autoRefresh) return undefined;
    timer.current = setInterval(() => setLastUpdated(nowStamp()), 30000);
    return () => clearInterval(timer.current);
  }, [autoRefresh]);

  // Per-section visibility (each section's "One Eye Toggle"), persisted.
  const [vis, setVis] = useState(loadVis);
  const toggle = (key) => setVis((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem(VIS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  const focusSearch = () => {
    const el = document.querySelector('input[placeholder^="Search activity"]');
    if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  };

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <CampusHeader
          query={query} onQuery={setQuery}
          lastUpdated={lastUpdated}
          autoRefresh={autoRefresh} onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
          refreshing={refreshing} onRefresh={refresh}
        />

        {/* Active-vertical thresholds + the Corporate / Retail / Campus switcher */}
        <PolicyBar />

        <FilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          {/* SECTION 1 · Key Metrics — cards only, no section chrome */}
          <KeyMetrics />

          {/* SECTION 2 · Activity Insights */}
          <SectionCard
            icon={LineChart} title="Activity Insights"
            subtitle="Activity distribution and trend across the day"
            visible={vis.insights} onToggle={() => toggle('insights')}
          >
            <ActivityInsights />
          </SectionCard>

          {/* SECTION 3 · Live Overview */}
          <SectionCard
            icon={Radio} title="Live Overview"
            subtitle="Real-time feed, active activities and recent alerts"
            visible={vis.live} onToggle={() => toggle('live')}
          >
            <LiveOverview />
          </SectionCard>

          {/* SECTION 4 · Activity Analytics */}
          <SectionCard
            icon={BarChart3} title="Activity Analytics"
            subtitle="Hourly volume and activity status breakdown"
            visible={vis.analytics} onToggle={() => toggle('analytics')}
          >
            <ActivityAnalytics />
          </SectionCard>
        </div>

        <QuickActionsFooter onSearchActivity={focusSearch} />
      </div>
    </div>
  );
}
