import { useState } from 'react';
import { ClipboardCheck } from 'lucide-react';

import FilterBar from './components/FilterBar';
import AttendanceCards from './components/attendance/AttendanceCards';
import AttendanceCharts from './components/attendance/AttendanceCharts';
import AttendanceTables from './components/attendance/AttendanceTables';

// ─────────────────────────────────────────────────────────────────────────────
// Attendance Intelligence — campus subpage (Prompt 7).
//
// Attendance analytics for the campus: six headline cards (present · absent ·
// late · temporary away · early exit · teacher overrides), four comparison
// charts (trend · late analysis · department · semester) and three tables
// (attendance sessions · temporary absence · teacher verification).
// FRONTEND-ONLY: dummy data from ./attendance-data.js.
// ─────────────────────────────────────────────────────────────────────────────

export default function AttendanceIntelligence() {
  const [filters, setFilters] = useState({
    university: 'sharda', building: 'all', department: 'all', floor: 'all', room: 'all', range: 'today',
  });

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <ClipboardCheck className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Attendance Intelligence</h1>
            <p className="mt-1 text-small text-fg-muted">AI attendance analytics — presence, lateness, exceptions and teacher-verified counts.</p>
          </div>
        </div>

        <FilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <AttendanceCards />
          <AttendanceCharts />
          <AttendanceTables />
        </div>
      </div>
    </div>
  );
}
