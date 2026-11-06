import { Building2, GraduationCap, Layers, DoorClosed, Clock3, University, RotateCcw } from 'lucide-react';
import { HIERARCHY, TIME_RANGES } from '../data';

// A labelled select with a leading icon. Declared at module scope so it is a
// stable component (not recreated on every FilterBar render).
function Field({ icon, children }) {
  const Icon = icon;
  return (
    <label className="relative inline-flex min-w-0 items-center">
      <Icon className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
      {children}
    </label>
  );
}

// Cascading filter bar: University → Building → Department → Floor → Room, plus
// a Time Range preset. Choosing a level resets everything below it so the
// selection can never point at an invalid combination.
export default function FilterBar({ value, onChange }) {
  const { university, building, department, floor, room, range } = value;

  const buildings = HIERARCHY.buildings[university] || [];
  const departments = HIERARCHY.departments[building] || [];
  const floors = HIERARCHY.floors[building] || [];
  const rooms = HIERARCHY.rooms[`${building}:${floor}`] || [];

  // Setting a level clears the levels beneath it (dependent selects).
  const set = (patch) => onChange({ ...value, ...patch });

  const selectCls =
    'w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-subtle';

  const dirty =
    building !== 'all' || department !== 'all' || floor !== 'all' || room !== 'all' || range !== 'live';

  const reset = () =>
    onChange({ university, building: 'all', department: 'all', floor: 'all', room: 'all', range: 'live' });

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {/* University */}
        <Field icon={University}>
          <select value={university} onChange={(e) => onChange({ university: e.target.value, building: 'all', department: 'all', floor: 'all', room: 'all', range })} className={selectCls}>
            {HIERARCHY.universities.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        </Field>

        {/* Building */}
        <Field icon={Building2}>
          <select value={building} onChange={(e) => set({ building: e.target.value, department: 'all', floor: 'all', room: 'all' })} className={selectCls}>
            <option value="all">All Schools</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </Field>

        {/* Department */}
        <Field icon={GraduationCap}>
          <select value={department} onChange={(e) => set({ department: e.target.value })} disabled={building === 'all'} className={selectCls}>
            <option value="all">{building === 'all' ? 'Select school first' : 'All Departments'}</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </Field>

        {/* Floor */}
        <Field icon={Layers}>
          <select value={floor} onChange={(e) => set({ floor: e.target.value, room: 'all' })} disabled={building === 'all'} className={selectCls}>
            <option value="all">{building === 'all' ? 'Select building first' : 'All Floors'}</option>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>

        {/* Room */}
        <Field icon={DoorClosed}>
          <select value={room} onChange={(e) => set({ room: e.target.value })} disabled={floor === 'all'} className={selectCls}>
            <option value="all">{floor === 'all' ? 'Select floor first' : 'All Rooms'}</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </Field>

        {/* Time range */}
        <Field icon={Clock3}>
          <select value={range} onChange={(e) => set({ range: e.target.value })} className={selectCls}>
            {TIME_RANGES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
      </div>

      {dirty && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink"
          >
            <RotateCcw className="h-3 w-3" /> Reset filters
          </button>
        </div>
      )}
    </div>
  );
}
