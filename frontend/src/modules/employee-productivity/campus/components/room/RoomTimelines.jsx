import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { LineChart, CalendarClock, GraduationCap, UserCog } from 'lucide-react';
import Panel from '../Panel';
import { AXIS, GRID, TIP } from '../profileConstants';
import { PROFILE, ROOMS, BAND_TYPE } from '../../room-data';

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// A proportional "gantt" band for a day window — used for Activity, Lecture and
// Teacher timelines. Gaps in the data read as empty (free) track.
function TimelineBand({ segments }) {
  const start = toMin(PROFILE.dayStart);
  const end = toMin(PROFILE.dayEnd);
  const span = end - start;
  const ticks = [];
  for (let m = start; m <= end; m += 120) ticks.push(m);

  return (
    <div>
      <div className="relative h-10 overflow-hidden rounded-lg bg-surface-sunken ring-1 ring-line-subtle">
        {segments.map((s, i) => {
          const type = BAND_TYPE[s.type] || BAND_TYPE.idle;
          const left = ((toMin(s.start) - start) / span) * 100;
          const width = ((toMin(s.end) - toMin(s.start)) / span) * 100;
          return (
            <div
              key={i}
              title={`${s.label} · ${s.start}–${s.end}`}
              className="absolute top-1 bottom-1 flex items-center justify-center overflow-hidden rounded-md px-1"
              style={{ left: `${left}%`, width: `${width}%`, background: type.bg, color: type.text }}
            >
              <span className="truncate text-micro font-semibold">{s.label}</span>
            </div>
          );
        })}
      </div>
      {/* hour axis */}
      <div className="relative mt-1 h-3">
        {ticks.map((m) => (
          <span key={m} className="absolute -translate-x-1/2 text-micro text-fg-subtle" style={{ left: `${((m - start) / span) * 100}%` }}>
            {String(Math.floor(m / 60)).padStart(2, '0')}:00
          </span>
        ))}
      </div>
    </div>
  );
}

export default function RoomTimelines({ roomId }) {
  const room = ROOMS.find((r) => r.id === roomId) || ROOMS[0];

  return (
    <div className="space-y-4">
      {/* Occupancy Timeline — numeric area with a capacity reference line */}
      <Panel icon={LineChart} title="Occupancy Timeline" right={<span className="text-caption text-fg-subtle">capacity {room.capacity}</span>} bodyClass="p-4">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={PROFILE.occupancyTimeline} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="roomOcc" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, Math.max(room.capacity, 10)]} />
              <Tooltip {...TIP} />
              <ReferenceLine y={room.capacity} stroke="var(--line-strong)" strokeDasharray="4 3" label={{ value: 'Capacity', position: 'insideTopRight', fontSize: 10, fill: 'var(--text-subtle)' }} />
              <Area type="monotone" dataKey="occupancy" name="Occupancy" stroke="#F7983A" strokeWidth={2} fill="url(#roomOcc)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {/* Activity Timeline — with a small legend */}
      <Panel
        icon={CalendarClock} title="Activity Timeline"
        right={
          <span className="hidden items-center gap-2.5 text-micro text-fg-subtle sm:flex">
            {[['Lecture', '#F7983A'], ['Lab', '#8b5cf6'], ['Break', '#f59e0b'], ['Idle', 'var(--line-strong)']].map(([l, c]) => (
              <span key={l} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: c }} />{l}</span>
            ))}
          </span>
        }
        bodyClass="p-4"
      >
        <TimelineBand segments={PROFILE.activity} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel icon={GraduationCap} title="Lecture Timeline" right={<span className="text-caption text-fg-subtle">scheduled sessions</span>} bodyClass="p-4">
          <TimelineBand segments={PROFILE.lectures} />
        </Panel>
        <Panel icon={UserCog} title="Teacher Timeline" right={<span className="text-caption text-fg-subtle">room occupancy by faculty</span>} bodyClass="p-4">
          <TimelineBand segments={PROFILE.teachers} />
        </Panel>
      </div>
    </div>
  );
}
