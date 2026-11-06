import { useState } from 'react';
import { GraduationCap } from 'lucide-react';

import StudentSearchBar from './components/student/StudentSearchBar';
import StudentCards, { StudentIdentity } from './components/student/StudentCards';
import StudentTabs from './components/student/StudentTabs';
import { DIRECTORY } from './student-data';

// ─────────────────────────────────────────────────────────────────────────────
// Student Activity — campus subpage (Prompt 3).
//
// Complete activity profile of ONE student. Top: search (name / ID · face search
// · department · semester). Then five summary cards (Attendance · Current
// Activity · Risk Score · Productivity · Last Seen) and nine deep tabs.
// FRONTEND-ONLY: identity/cards from the DIRECTORY, deep analytics from PROFILE
// in ./student-data.js.
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentActivity() {
  const [selectedId, setSelectedId] = useState(DIRECTORY[0].id);
  const student = DIRECTORY.find((s) => s.id === selectedId) || DIRECTORY[0];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <GraduationCap className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Student Activity</h1>
            <p className="mt-1 text-small text-fg-muted">Complete AI activity profile for a single student.</p>
          </div>
        </div>

        {/* Top search */}
        <StudentSearchBar selectedId={selectedId} onSelect={setSelectedId} />

        {/* Identity + summary cards */}
        <StudentIdentity student={student} />
        <StudentCards student={student} />

        {/* Deep tabs */}
        <StudentTabs student={student} />
      </div>
    </div>
  );
}
