import { useEffect, useRef, useState } from 'react';
import { LineChart, Radio, BarChart3 } from 'lucide-react';

import SectionCard from '../campus/components/SectionCard';
import SchoolHeader from './components/SchoolHeader';
import SchoolModules from './components/SchoolModules';
import SchoolFilterBar from './components/SchoolFilterBar';
import KeyMetrics from './components/KeyMetrics';
import ActivityInsights from './components/ActivityInsights';
import LiveOverview from './components/LiveOverview';
import SafetyAnalytics from './components/SafetyAnalytics';
import QuickActionsFooter from './components/QuickActionsFooter';

// ─────────────────────────────────────────────────────────────────────────────
// School Activity Monitoring — landing dashboard (K-12 vertical).
//
// AI analytics dashboard (NOT a CCTV page). Same design system as the other
// verticals; child-safety + attendance + transport focus. FRONTEND-ONLY.
// ─────────────────────────────────────────────────────────────────────────────

const VIS_KEY = 'school-activity-sections';
const DEFAULT_VIS = { insights: true, live: true, analytics: false };
const loadVis = () => {
  try { return { ...DEFAULT_VIS, ...JSON.parse(localStorage.getItem(VIS_KEY) || '{}') }; }
  catch { return DEFAULT_VIS; }
};
const nowStamp = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export default function SchoolDashboard() {
  const [filters, setFilters] = useState({
    school: 'greenwood', wing: 'all', grade: 'all', section: 'all', room: 'all', range: 'live',
  });
  const [query, setQuery] = useState('');
  const [lastUpdated, setLastUpdated] = useState(nowStamp);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);

  const refresh = () => { setRefreshing(true); setTimeout(() => { setLastUpdated(nowStamp()); setRefreshing(false); }, 700); };

  useEffect(() => {
    if (!autoRefresh) return undefined;
    timer.current = setInterval(() => setLastUpdated(nowStamp()), 30000);
    return () => clearInterval(timer.current);
  }, [autoRefresh]);

  const [vis, setVis] = useState(loadVis);
  const toggle = (key) => setVis((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    try { localStorage.setItem(VIS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  const focusSearch = () => {
    const el = document.querySelector('input[placeholder^="Search student"]');
    if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  };
  const notifyParents = () => {
    setNotice('134 absentee parents notified via SMS + app.');
    setTimeout(() => setNotice(null), 3500);
  };

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <SchoolHeader
          query={query} onQuery={setQuery}
          lastUpdated={lastUpdated}
          autoRefresh={autoRefresh} onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
          refreshing={refreshing} onRefresh={refresh}
        />

        <SchoolModules />

        <SchoolFilterBar value={filters} onChange={setFilters} />

        {notice && (
          <div className="mb-4 rounded-xl border border-success-line bg-success-soft px-3 py-2.5 text-small font-medium text-success-ink">
            {notice}
          </div>
        )}

        <div className="space-y-4">
          {/* Key Metrics — cards only */}
          <KeyMetrics />

          <SectionCard icon={LineChart} title="Activity Insights" subtitle="Activity distribution and trend across the day"
            visible={vis.insights} onToggle={() => toggle('insights')}>
            <ActivityInsights />
          </SectionCard>

          <SectionCard icon={Radio} title="Live Overview" subtitle="Real-time feed, active classes and safety alerts"
            visible={vis.live} onToggle={() => toggle('live')}>
            <LiveOverview />
          </SectionCard>

          <SectionCard icon={BarChart3} title="Safety & Attendance Analytics" subtitle="Hourly activity, attendance by grade and gate flow"
            visible={vis.analytics} onToggle={() => toggle('analytics')}>
            <SafetyAnalytics />
          </SectionCard>
        </div>

        <QuickActionsFooter onSearch={focusSearch} onNotifyParents={notifyParents} />
      </div>
    </div>
  );
}
