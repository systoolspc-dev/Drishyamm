import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Radio, BarChart3, Search, FileText, Flame, Zap } from 'lucide-react';

import SectionCard from '../campus/components/SectionCard';
import HostelHeader from './components/HostelHeader';
import HostelFilterBar from './components/HostelFilterBar';
import HostelModules from './components/HostelModules';
import KeyMetrics from './components/KeyMetrics';
import ActivityInsights from './components/ActivityInsights';
import LiveOverview from './components/LiveOverview';
import SafetyOccupancyAnalytics from './components/SafetyOccupancyAnalytics';

// ─────────────────────────────────────────────────────────────────────────────
// Hostel Activity Monitoring — landing dashboard (residence workforce + facility
// intelligence). Transformed from the standalone Hostel/ app into this repo's
// design system + vertical pattern. Boys/Girls toggle (in the header) drives
// every widget via useHostelStore. FRONTEND-ONLY.
// ─────────────────────────────────────────────────────────────────────────────

const VIS_KEY = 'hostel-activity-sections';
const DEFAULT_VIS = { insights: true, live: true, analytics: false };
const loadVis = () => { try { return { ...DEFAULT_VIS, ...JSON.parse(localStorage.getItem(VIS_KEY) || '{}') }; } catch { return DEFAULT_VIS; } };
const nowStamp = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export default function HostelDashboard() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ block: 'all', floor: 'all', wing: 'all', room: 'all', range: 'live' });
  const [query, setQuery] = useState('');
  const [lastUpdated, setLastUpdated] = useState(nowStamp);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef(null);

  const refresh = () => { setRefreshing(true); setTimeout(() => { setLastUpdated(nowStamp()); setRefreshing(false); }, 700); };
  useEffect(() => {
    if (!autoRefresh) return undefined;
    timer.current = setInterval(() => setLastUpdated(nowStamp()), 30000);
    return () => clearInterval(timer.current);
  }, [autoRefresh]);

  const [vis, setVis] = useState(loadVis);
  const toggle = (key) => setVis((prev) => { const next = { ...prev, [key]: !prev[key] }; try { localStorage.setItem(VIS_KEY, JSON.stringify(next)); } catch { /* private */ } return next; });

  const focusSearch = () => { const el = document.querySelector('input[placeholder^="Search staff"]'); if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } };

  const actions = [
    { label: 'Search', icon: Search, primary: true, onClick: focusSearch },
    { label: 'Generate Report', icon: FileText, onClick: () => navigate('/activity-monitoring/hostel/reports') },
    { label: 'View Heatmap', icon: Flame, onClick: () => navigate('/map') },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <HostelHeader
          query={query} onQuery={setQuery} lastUpdated={lastUpdated}
          autoRefresh={autoRefresh} onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
          refreshing={refreshing} onRefresh={refresh}
        />

        <HostelModules />
        <HostelFilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <KeyMetrics />
          <SectionCard icon={LineChart} title="Activity Insights" subtitle="Entry/exit trend and current occupancy" visible={vis.insights} onToggle={() => toggle('insights')}>
            <ActivityInsights />
          </SectionCard>
          <SectionCard icon={Radio} title="Live Overview" subtitle="Live feed, active tasks and recent alerts" visible={vis.live} onToggle={() => toggle('live')}>
            <LiveOverview />
          </SectionCard>
          <SectionCard icon={BarChart3} title="Safety & Occupancy Analytics" subtitle="Hourly entry/exit, zone compliance and housekeeping" visible={vis.analytics} onToggle={() => toggle('analytics')}>
            <SafetyOccupancyAnalytics />
          </SectionCard>
        </div>

        {/* Sticky quick actions */}
        <div className="sticky bottom-0 z-20 page-bleed mt-4 border-t border-line bg-white/85 page-inset-x py-2.5 backdrop-blur supports-[backdrop-filter]:bg-white/70">
          <div className="flex w-full flex-wrap items-center gap-2">
            <span className="mr-1 inline-flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle"><Zap className="h-3.5 w-3.5 text-brand" /> Quick Actions</span>
            {actions.map((a) => (
              <button key={a.label} onClick={a.onClick} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-small font-semibold transition ${a.primary ? 'bg-brand text-white shadow-sm hover:bg-brand-hover' : 'border border-line bg-surface text-fg-secondary hover:border-brand/40 hover:text-brand-ink'}`}>
                <a.icon className="h-4 w-4" /> {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
