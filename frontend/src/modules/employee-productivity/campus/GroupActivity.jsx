import { useState } from 'react';
import { Users } from 'lucide-react';

import FilterBar from './components/FilterBar';
import GroupCards from './components/group/GroupCards';
import GroupCharts from './components/group/GroupCharts';
import GroupHeatmap from './components/group/GroupHeatmap';
import GroupTable from './components/group/GroupTable';

// ─────────────────────────────────────────────────────────────────────────────
// Group Activity — campus subpage (Prompt 5).
//
// Detects collaboration: clusters the AI reads as groups — study groups, project
// huddles, club meets, crowds. Cards · charts (duration / size / formation /
// heatmap) · active-groups table. FRONTEND-ONLY: dummy data from ./group-data.js.
// ─────────────────────────────────────────────────────────────────────────────

export default function GroupActivity() {
  const [filters, setFilters] = useState({
    university: 'sharda', building: 'all', department: 'all', floor: 'all', room: 'all', range: 'live',
  });

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Users className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Group Activity</h1>
            <p className="mt-1 text-small text-fg-muted">AI-detected collaboration — who is grouping, where and for how long.</p>
          </div>
        </div>

        <FilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <GroupCards />
          <GroupCharts />
          <GroupHeatmap />
          <GroupTable />
        </div>
      </div>
    </div>
  );
}
