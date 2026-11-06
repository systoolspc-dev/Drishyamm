import { useState } from 'react';
import { Gauge } from 'lucide-react';

import FilterBar from './components/FilterBar';
import ProductivityCards from './components/productivity/ProductivityCards';
import ProductivityCharts from './components/productivity/ProductivityCharts';

// ─────────────────────────────────────────────────────────────────────────────
// Productivity Analytics — campus subpage.
//
// How productively the campus is learning: five cards (productivity · study time
// · idle time · learning score · collaboration) and four charts (focus ·
// discussion · library usage · department productivity).
// FRONTEND-ONLY: dummy data from ./productivity-data.js.
// ─────────────────────────────────────────────────────────────────────────────

export default function ProductivityAnalytics() {
  const [filters, setFilters] = useState({
    university: 'sharda', building: 'all', department: 'all', floor: 'all', room: 'all', range: 'today',
  });

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Gauge className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Productivity Analytics</h1>
            <p className="mt-1 text-small text-fg-muted">How productively the campus is learning — focus, study time and collaboration.</p>
          </div>
        </div>

        <FilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <ProductivityCards />
          <ProductivityCharts />
        </div>
      </div>
    </div>
  );
}
