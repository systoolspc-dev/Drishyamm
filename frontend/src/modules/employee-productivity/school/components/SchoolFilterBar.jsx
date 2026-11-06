import { School, Building2, GraduationCap, Users, DoorClosed, Clock3, RotateCcw } from 'lucide-react';
import { HIERARCHY, TIME_RANGES } from '../data';

// Labelled select with a leading icon (module-scope so it stays a stable component).
function Field({ icon, children }) {
  const Icon = icon;
  return (
    <label className="relative inline-flex min-w-0 items-center">
      <Icon className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
      {children}
    </label>
  );
}

// Cascading filter: School → Wing → Grade → Section → Room + Time Range.
export default function SchoolFilterBar({ value, onChange }) {
  const { school, wing, grade, section, room, range } = value;
  const wings = HIERARCHY.wings[school] || [];
  const grades = HIERARCHY.grades[wing] || [];
  const sections = HIERARCHY.sections[wing] || [];
  const rooms = HIERARCHY.rooms[`${wing}:${section}`] || [];

  const set = (patch) => onChange({ ...value, ...patch });
  const selectCls =
    'w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-subtle';

  const dirty = wing !== 'all' || grade !== 'all' || section !== 'all' || room !== 'all' || range !== 'live';
  const reset = () => onChange({ school, wing: 'all', grade: 'all', section: 'all', room: 'all', range: 'live' });

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Field icon={School}>
          <select value={school} onChange={(e) => onChange({ school: e.target.value, wing: 'all', grade: 'all', section: 'all', room: 'all', range })} className={selectCls}>
            {HIERARCHY.schools.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>

        <Field icon={Building2}>
          <select value={wing} onChange={(e) => set({ wing: e.target.value, grade: 'all', section: 'all', room: 'all' })} className={selectCls}>
            <option value="all">All Wings</option>
            {wings.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </Field>

        <Field icon={GraduationCap}>
          <select value={grade} onChange={(e) => set({ grade: e.target.value })} disabled={wing === 'all'} className={selectCls}>
            <option value="all">{wing === 'all' ? 'Select wing first' : 'All Grades'}</option>
            {grades.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </Field>

        <Field icon={Users}>
          <select value={section} onChange={(e) => set({ section: e.target.value, room: 'all' })} disabled={wing === 'all'} className={selectCls}>
            <option value="all">{wing === 'all' ? 'Select wing first' : 'All Sections'}</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>

        <Field icon={DoorClosed}>
          <select value={room} onChange={(e) => set({ room: e.target.value })} disabled={section === 'all'} className={selectCls}>
            <option value="all">{section === 'all' ? 'Select section first' : 'All Rooms'}</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </Field>

        <Field icon={Clock3}>
          <select value={range} onChange={(e) => set({ range: e.target.value })} className={selectCls}>
            {TIME_RANGES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
      </div>

      {dirty && (
        <div className="mt-2 flex justify-end">
          <button onClick={reset} className="inline-flex items-center gap-1.5 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink">
            <RotateCcw className="h-3 w-3" /> Reset filters
          </button>
        </div>
      )}
    </div>
  );
}
