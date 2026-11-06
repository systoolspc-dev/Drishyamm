import { Users, Armchair, ClipboardCheck, Gauge, Clock3, Hourglass } from 'lucide-react';
import { ROOMS } from '../../room-data';

// Six room cards. Occupancy shows against capacity; utilization/attendance are
// percentages. Uniform accent tiles — one calm system.
export default function RoomCards({ roomId }) {
  const r = ROOMS.find((x) => x.id === roomId) || ROOMS[0];
  const cards = [
    { icon: Users, label: 'Occupancy', value: `${r.occupancy}`, sub: `of ${r.capacity} seats` },
    { icon: Armchair, label: 'Capacity', value: `${r.capacity}`, sub: 'total seats' },
    { icon: ClipboardCheck, label: 'Attendance', value: `${r.attendance}`, unit: '%', sub: 'present vs enrolled' },
    { icon: Gauge, label: 'Utilization', value: `${r.utilization}`, unit: '%', sub: 'of scheduled time' },
    { icon: Clock3, label: 'Average Stay', value: r.avgStay, small: r.avgStay.length > 4, sub: 'per person' },
    { icon: Hourglass, label: 'Idle Time', value: r.idleTime, small: true, sub: 'unused today' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div key={c.label} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
            <p className={`mt-1 font-bold tracking-tight text-fg ${c.small ? 'text-heading leading-tight' : 'text-metric-sm leading-none'}`}>
              {c.value}{c.unit && <span className="ml-0.5 text-small font-semibold text-fg-subtle">{c.unit}</span>}
            </p>
            <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}
