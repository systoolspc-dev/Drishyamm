import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ShieldAlert, Timer, Clock, ArrowLeftRight, Ban, MoonStar, UserCheck } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { SECURITY_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards, LevelChip } from './components/bits';

const ICONS = { verify: Timer, visitor: Clock, entryexit: ArrowLeftRight, unauth: Ban, latenight: MoonStar, staff: UserCheck };

export default function Security() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = SECURITY_DATA[hostel];
  const cards = [
    { key: 'verify', label: 'Entry Verification', value: d.entryVerificationTime.value, sub: d.entryVerificationTime.deltaLabel },
    { key: 'visitor', label: 'Visitor Wait', value: d.visitorWaitingTime.value, sub: d.visitorWaitingTime.deltaLabel },
    { key: 'entryexit', label: 'Student Entry/Exit', value: `${d.studentEntryExit.value}`, sub: d.studentEntryExit.deltaLabel },
    { key: 'unauth', label: 'Unauthorized Entry', value: `${d.unauthorizedEntry.value}`, sub: d.unauthorizedEntry.deltaLabel },
    { key: 'latenight', label: 'Late-Night Entry', value: `${d.lateNightEntry.value}`, sub: d.lateNightEntry.deltaLabel },
    { key: 'staff', label: 'Security Staff', value: `${d.securityStaffAvailability.value} / ${d.securityStaffAvailability.of}`, sub: d.securityStaffAvailability.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ShieldAlert className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Security &amp; Access</h1><p className="mt-1 text-small text-fg-muted">Entry verification, unauthorized &amp; late-night entry and incidents.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel icon={Timer} title="Verification Time Trend" right={<span className="text-caption text-fg-subtle">seconds</span>} bodyClass="p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={d.verificationTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="time" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="s" />
                  <Tooltip {...TIP} />
                  <Line type="monotone" dataKey="avgSeconds" name="Avg (s)" stroke="#F7983A" strokeWidth={2} dot={{ r: 2.5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={ShieldAlert} title="Security Incidents" count={d.incidents.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Incident</th><th className="px-2 pb-2 font-semibold">Detail</th><th className="px-2 pb-2 font-semibold">Level</th><th className="px-2 pb-2 text-right font-semibold">Time</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.incidents.map((e, i) => (
                    <tr key={i} className="hover:bg-surface-sunken"><td className="px-2 py-2.5 text-heading font-semibold text-fg">{e.type}</td><td className="px-2 py-2.5 text-fg-muted">{e.detail}</td><td className="px-2 py-2.5"><LevelChip level={e.level} /></td><td className="px-2 py-2.5 text-right font-mono text-small text-fg-secondary">{e.time}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
