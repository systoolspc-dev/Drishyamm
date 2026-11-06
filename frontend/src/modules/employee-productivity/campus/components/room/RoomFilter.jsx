import { Building2, GraduationCap, DoorClosed } from 'lucide-react';
import { ROOMS, ROOM_STATUS } from '../../room-data';

// Building → Department → Room selector. Picking a building/department narrows
// the room list; the chosen room drives the whole page. Also shows the selected
// room's identity + live status chip.
export default function RoomFilter({ selectedId, onSelect }) {
  const room = ROOMS.find((r) => r.id === selectedId) || ROOMS[0];

  const buildings = [...new Map(ROOMS.map((r) => [r.building, r.buildingLabel])).entries()];
  const depts = [...new Map(ROOMS.filter((r) => r.building === room.building).map((r) => [r.dept, r.deptLabel])).entries()];
  const rooms = ROOMS.filter((r) => r.building === room.building && r.dept === room.dept);

  const selectCls =
    'w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none';

  // Changing a level jumps to the first room that matches it.
  const setBuilding = (b) => { const first = ROOMS.find((r) => r.building === b); if (first) onSelect(first.id); };
  const setDept = (d) => { const first = ROOMS.find((r) => r.building === room.building && r.dept === d); if (first) onSelect(first.id); };

  const st = ROOM_STATUS[room.status] || ROOM_STATUS.free;

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-2.5 shadow-sm">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <label className="relative flex items-center lg:w-56">
          <Building2 className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
          <select value={room.building} onChange={(e) => setBuilding(e.target.value)} className={selectCls}>
            {buildings.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>

        <label className="relative flex items-center lg:w-44">
          <GraduationCap className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
          <select value={room.dept} onChange={(e) => setDept(e.target.value)} className={selectCls}>
            {depts.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>

        <label className="relative flex items-center lg:flex-1">
          <DoorClosed className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
          <select value={room.id} onChange={(e) => onSelect(e.target.value)} className={selectCls}>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>

        {/* Selected room identity */}
        <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2 lg:ml-auto">
          <span className="truncate text-small font-bold text-fg">{room.buildingLabel} · {room.label}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${st.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} /> {st.label}
          </span>
        </div>
      </div>
    </div>
  );
}
