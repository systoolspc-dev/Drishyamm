import { useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { DoorClosed, Users, Armchair, ClipboardCheck, Gauge, LineChart, CalendarClock } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { Chip } from './components/bits';
import { CLASS_ROOMS, CLASS_OCCUPANCY, CLASS_SCHEDULE } from './pages-data';

export default function ClassRoomAnalytics() {
  const [roomId, setRoomId] = useState(CLASS_ROOMS[0].id);
  const room = CLASS_ROOMS.find((r) => r.id === roomId) || CLASS_ROOMS[0];

  const cards = [
    { icon: Users, label: 'Occupancy', value: `${room.occupancy}`, sub: `of ${room.capacity} seats` },
    { icon: Armchair, label: 'Capacity', value: `${room.capacity}`, sub: 'total seats' },
    { icon: ClipboardCheck, label: 'Attendance', value: `${room.attendance}%`, sub: 'present vs enrolled' },
    { icon: Gauge, label: 'Utilization', value: `${room.utilization}%`, sub: 'of scheduled time' },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><DoorClosed className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Class / Room Analytics</h1>
            <p className="mt-1 text-small text-fg-muted">Per-room occupancy, attendance, utilization and schedule.</p>
          </div>
        </div>

        {/* Room selector */}
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-2.5 shadow-sm">
          <label className="relative inline-flex items-center">
            <DoorClosed className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
            <select value={room.id} onChange={(e) => setRoomId(e.target.value)} className="w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none lg:w-72">
              {CLASS_ROOMS.map((r) => <option key={r.id} value={r.id}>{r.wingLabel} · {r.label}</option>)}
            </select>
          </label>
          <span className="ml-auto text-small font-bold text-fg">{room.wingLabel} · {room.label} · {room.grade}</span>
          <Chip status={room.status} label={room.status.replace('-', ' ')} />
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {cards.map((c) => (
              <div key={c.label} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><c.icon className="h-4 w-4" strokeWidth={2} /></span>
                <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
                <p className="mt-1 text-metric-sm font-bold leading-none tracking-tight text-fg">{c.value}</p>
                <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>
              </div>
            ))}
          </div>

          <Panel icon={LineChart} title="Occupancy Timeline" right={<span className="text-caption text-fg-subtle">capacity {room.capacity}</span>} bodyClass="p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={CLASS_OCCUPANCY} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <defs><linearGradient id="schRoomOcc" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} /><stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} /></linearGradient></defs>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, Math.max(room.capacity, 10)]} />
                  <Tooltip {...TIP} />
                  <ReferenceLine y={room.capacity} stroke="var(--line-strong)" strokeDasharray="4 3" label={{ value: 'Capacity', position: 'insideTopRight', fontSize: 10, fill: 'var(--text-subtle)' }} />
                  <Area type="monotone" dataKey="occupancy" name="Occupancy" stroke="#F7983A" strokeWidth={2} fill="url(#schRoomOcc)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel icon={CalendarClock} title="Today's Schedule" count={CLASS_SCHEDULE.length} bodyClass="p-4">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                <th className="px-2 pb-2 font-semibold">Time</th><th className="px-2 pb-2 font-semibold">Subject</th><th className="px-2 pb-2 font-semibold">Teacher</th>
                <th className="px-2 pb-2 text-right font-semibold">Present</th><th className="px-2 pb-2 text-right font-semibold">Status</th>
              </tr></thead>
              <tbody className="divide-y divide-line-subtle">
                {CLASS_SCHEDULE.map((c, i) => (
                  <tr key={i} className="hover:bg-surface-sunken">
                    <td className="px-2 py-2 font-mono text-small font-semibold text-fg-secondary">{c.time}</td>
                    <td className="px-2 py-2 text-heading font-semibold text-fg">{c.subject}</td>
                    <td className="px-2 py-2 text-fg-muted">{c.teacher}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{c.present || '—'}</td>
                    <td className="px-2 py-2 text-right"><Chip status={c.status} label={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}
