import { Building2, Layers, Compass, DoorClosed, Clock3, RotateCcw } from 'lucide-react';
import { HOSTEL_HIERARCHY, TIME_RANGES } from '../data';
import { useHostelStore } from '../useHostelStore';

// Cascading Block → Floor → Wing → Room + Time-range (the Hostel level is the
// Boys/Girls toggle in the header). Choosing a level resets those beneath it.
function Field({ icon, children }) {
  const Icon = icon;
  return (
    <label className="relative inline-flex min-w-0 items-center">
      <Icon className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
      {children}
    </label>
  );
}

export default function HostelFilterBar({ value, onChange }) {
  const hostel = useHostelStore((s) => s.hostel);
  const { block, floor, wing, room, range } = value;
  const blocks = HOSTEL_HIERARCHY.blocks[hostel] || [];
  const floors = HOSTEL_HIERARCHY.floors[block] || [];
  const wings = HOSTEL_HIERARCHY.wings[block] || [];
  const rooms = HOSTEL_HIERARCHY.rooms[`${block}:${wing}`] || [];

  const set = (patch) => onChange({ ...value, ...patch });
  const selectCls = 'w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-subtle';
  const dirty = block !== 'all' || floor !== 'all' || wing !== 'all' || room !== 'all' || range !== 'live';

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Field icon={Building2}>
          <select value={block} onChange={(e) => set({ block: e.target.value, floor: 'all', wing: 'all', room: 'all' })} className={selectCls}>
            <option value="all">All Blocks</option>
            {blocks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </Field>
        <Field icon={Layers}>
          <select value={floor} onChange={(e) => set({ floor: e.target.value })} disabled={block === 'all'} className={selectCls}>
            <option value="all">{block === 'all' ? 'Select block first' : 'All Floors'}</option>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
        <Field icon={Compass}>
          <select value={wing} onChange={(e) => set({ wing: e.target.value, room: 'all' })} disabled={block === 'all'} className={selectCls}>
            <option value="all">{block === 'all' ? 'Select block first' : 'All Wings'}</option>
            {wings.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </Field>
        <Field icon={DoorClosed}>
          <select value={room} onChange={(e) => set({ room: e.target.value })} disabled={wing === 'all'} className={selectCls}>
            <option value="all">{wing === 'all' ? 'Select wing first' : 'All Rooms'}</option>
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
          <button onClick={() => onChange({ block: 'all', floor: 'all', wing: 'all', room: 'all', range: 'live' })} className="inline-flex items-center gap-1.5 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink">
            <RotateCcw className="h-3 w-3" /> Reset filters
          </button>
        </div>
      )}
    </div>
  );
}
