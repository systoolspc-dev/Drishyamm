import { PlayCircle, History, Clock } from 'lucide-react';
import Panel from '../Panel';
import { PROFILE } from '../../room-data';

function SessionDetail({ s }) {
  const rows = [
    ['Subject', s.subject],
    ['Teacher', s.teacher],
    ['Batch', s.batch],
    ['Time', s.time],
    ['Occupancy', `${s.occupancy} / ${s.capacity}`],
    ['Attendance', `${s.attendance}%`],
  ];
  return (
    <dl className="divide-y divide-line-subtle">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between py-1.5 text-small">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="font-semibold text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function RoomTables() {
  const cur = PROFILE.currentSession;
  const prev = PROFILE.previousSession;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          icon={PlayCircle} title="Current Session"
          right={<span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-success-ink ring-1 ring-success-line"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Ongoing</span>}
          bodyClass="p-4"
        >
          <SessionDetail s={cur} />
        </Panel>
        <Panel
          icon={Clock} title="Previous Session"
          right={<span className="rounded-full bg-surface-muted px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-fg-muted ring-1 ring-line">Ended</span>}
          bodyClass="p-4"
        >
          <SessionDetail s={prev} />
        </Panel>
      </div>

      <Panel icon={History} title="Session History" count={PROFILE.history.length} bodyClass="p-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                <th className="px-2 pb-2 font-semibold">Time</th>
                <th className="px-2 pb-2 font-semibold">Subject</th>
                <th className="px-2 pb-2 font-semibold">Teacher</th>
                <th className="px-2 pb-2 font-semibold">Batch</th>
                <th className="px-2 pb-2 text-right font-semibold">Attendance</th>
                <th className="px-2 pb-2 text-right font-semibold">Occupancy</th>
                <th className="px-2 pb-2 text-right font-semibold">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {PROFILE.history.map((h, i) => (
                <tr key={i} className="hover:bg-surface-sunken">
                  <td className="px-2 py-2 font-mono text-small font-semibold text-fg-secondary">{h.time}</td>
                  <td className="px-2 py-2 text-heading font-semibold text-fg">{h.subject}</td>
                  <td className="px-2 py-2 text-fg-secondary">{h.teacher}</td>
                  <td className="px-2 py-2 text-fg-muted">{h.batch}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{h.attendance}%</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{h.occupancy}</td>
                  <td className={`px-2 py-2 text-right ${h.duration === 'ongoing' ? 'font-semibold text-success-ink' : 'text-fg-muted'}`}>{h.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
