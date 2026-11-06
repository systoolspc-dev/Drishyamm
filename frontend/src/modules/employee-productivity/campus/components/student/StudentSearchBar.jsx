import { useState } from 'react';
import { Search, ScanFace, GraduationCap, CalendarRange, X } from 'lucide-react';
import { DIRECTORY, DEPARTMENTS, SEMESTERS } from '../../student-data';

// Top search row for the Student Activity page: free-text (name / ID), a
// Face Search action, and Department + Semester filters. Matching students drop
// down live; picking one loads their profile.
export default function StudentSearchBar({ selectedId, onSelect }) {
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('all');
  const [sem, setSem] = useState('all');
  const [open, setOpen] = useState(false);
  const [faceMock, setFaceMock] = useState(false);

  const results = DIRECTORY.filter((s) => {
    const matchQ = !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.id.toLowerCase().includes(q.toLowerCase());
    const matchD = dept === 'all' || s.dept === dept;
    const matchS = sem === 'all' || String(s.sem) === sem;
    return matchQ && matchD && matchS;
  });

  const selectCls =
    'w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none';

  const pick = (id) => { onSelect(id); setOpen(false); setQ(''); };

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-2.5 shadow-sm">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        {/* Search + results dropdown */}
        <div className="relative flex-1">
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              placeholder="Search by name or Student ID…"
              className="w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-3 text-small text-fg-secondary placeholder:text-fg-subtle focus:border-brand focus:outline-none"
            />
          </label>

          {open && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
              <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl">
                {results.length === 0 ? (
                  <p className="px-3 py-4 text-center text-small text-fg-subtle">No students match.</p>
                ) : results.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => pick(s.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-sunken ${selectedId === s.id ? 'bg-brand/[0.06]' : ''}`}
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/15 text-micro font-bold text-brand-ink">
                      {(s.name.match(/\b\w/g) || []).slice(0, 2).join('')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-small font-semibold text-fg">{s.name}</span>
                      <span className="block truncate text-micro text-fg-subtle">{s.id} · {s.deptLabel} · Sem {s.sem}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Face Search */}
        <button
          onClick={() => setFaceMock((v) => !v)}
          title="Identify a student from a photo or a live camera frame"
          className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-small font-semibold transition ${
            faceMock ? 'border-brand/40 bg-brand/10 text-brand-ink' : 'border-line bg-surface text-fg-secondary hover:border-brand/40 hover:text-brand-ink'
          }`}
        >
          <ScanFace className="h-4 w-4" /> Face Search
        </button>

        {/* Department */}
        <label className="relative flex items-center lg:w-44">
          <GraduationCap className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
          <select value={dept} onChange={(e) => setDept(e.target.value)} className={selectCls}>
            {DEPARTMENTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>

        {/* Semester */}
        <label className="relative flex items-center lg:w-44">
          <CalendarRange className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
          <select value={sem} onChange={(e) => setSem(e.target.value)} className={selectCls}>
            {SEMESTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>

      {faceMock && (
        <div className="mt-2 flex items-start gap-3 rounded-xl border border-dashed border-brand/40 bg-brand/[0.04] p-3">
          <ScanFace className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div className="flex-1 text-caption text-fg-secondary">
            <p className="font-semibold text-fg">Face Search</p>
            <p>Drop a photo or pick a live frame to match against the enrolled student database. (Wiring pending — connects to the face-recognition service.)</p>
          </div>
          <button onClick={() => setFaceMock(false)} className="text-fg-subtle hover:text-fg-secondary"><X className="h-4 w-4" /></button>
        </div>
      )}
    </div>
  );
}
