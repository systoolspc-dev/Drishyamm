import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Radio, Search, FileText, Users, Zap } from 'lucide-react';

import SectionCard from '../campus/components/SectionCard';
import HospitalityHeader from './components/HospitalityHeader';
import HospitalityFilterBar from './components/HospitalityFilterBar';
import HospitalityModules from './components/HospitalityModules';
import KeyMetrics from './components/KeyMetrics';
import ActivityInsights from './components/ActivityInsights';
import LiveOverview from './components/LiveOverview';

// ─────────────────────────────────────────────────────────────────────────────
// Hospitality Activity Monitoring — landing dashboard (hotel workforce + guest-
// service intelligence). Transformed from the standalone Hospitality/ app into
// this repo's design system + vertical pattern. Single property (no boys/girls-
// style toggle), so widgets read HOSPITALITY_DATA directly. FRONTEND-ONLY.
// ─────────────────────────────────────────────────────────────────────────────

const VIS_KEY = 'hospitality-activity-sections';
const DEFAULT_VIS = { insights: true, live: true };
const loadVis = () => { try { return { ...DEFAULT_VIS, ...JSON.parse(localStorage.getItem(VIS_KEY) || '{}') }; } catch { return DEFAULT_VIS; } };
const nowStamp = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export default function HospitalityDashboard() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ area: 'all', zone: 'all', range: 'live' });
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

  const actions = [
    { label: 'Staff Roster', icon: Users, primary: true, onClick: () => navigate('/activity-monitoring/hospitality/staff') },
    { label: 'Generate Report', icon: FileText, onClick: () => navigate('/activity-monitoring/hospitality/reports') },
    { label: 'Search', icon: Search, onClick: () => { const el = document.querySelector('input[placeholder^="Search staff"]'); if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } } },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <HospitalityHeader
          query={query} onQuery={setQuery} lastUpdated={lastUpdated}
          autoRefresh={autoRefresh} onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
          refreshing={refreshing} onRefresh={refresh}
        />

        <HospitalityModules />
        <HospitalityFilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <KeyMetrics />
          <SectionCard icon={LineChart} title="Activity Insights" subtitle="Rooms cleaned per day and guest response time" visible={vis.insights} onToggle={() => toggle('insights')}>
            <ActivityInsights />
          </SectionCard>
          <SectionCard icon={Radio} title="Live Overview" subtitle="Live feed, active housekeeping tasks and recent alerts" visible={vis.live} onToggle={() => toggle('live')}>
            <LiveOverview />
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
