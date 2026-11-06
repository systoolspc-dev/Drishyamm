import { useState } from 'react';
import { Presentation } from 'lucide-react';

import FacultySearchBar from './components/faculty/FacultySearchBar';
import FacultyCards, { FacultyIdentity } from './components/faculty/FacultyCards';
import FacultyTabs from './components/faculty/FacultyTabs';
import { DIRECTORY } from './faculty-data';

// ─────────────────────────────────────────────────────────────────────────────
// Faculty Activity — campus subpage (Prompt 4).
//
// Same style as Student Activity: search (name / ID · face search · department ·
// designation), five summary cards, and deep tabs — here tuned to teaching:
// Lecture Timeline · Teaching Hours · Office Hours · Room Utilization · Student
// Interaction · Attendance (+ Overview · Alerts · Reports). FRONTEND-ONLY.
// ─────────────────────────────────────────────────────────────────────────────

export default function FacultyActivity() {
  const [selectedId, setSelectedId] = useState(DIRECTORY[0].id);
  const faculty = DIRECTORY.find((f) => f.id === selectedId) || DIRECTORY[0];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Presentation className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Faculty Activity</h1>
            <p className="mt-1 text-small text-fg-muted">Complete AI activity profile for a faculty member.</p>
          </div>
        </div>

        {/* Top search */}
        <FacultySearchBar selectedId={selectedId} onSelect={setSelectedId} />

        {/* Identity + summary cards */}
        <FacultyIdentity faculty={faculty} />
        <FacultyCards faculty={faculty} />

        {/* Deep tabs */}
        <FacultyTabs faculty={faculty} />
      </div>
    </div>
  );
}
