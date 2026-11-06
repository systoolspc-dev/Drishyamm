import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Footprints, MapPinned, DoorOpen, Users2, ArrowRight } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { MOVEMENT_DATA } from './pages-data';
import { StatCards } from './components/bits';

const ICONS = { transitions: Footprints, compliance: MapPinned, restricted: DoorOpen, congestion: Users2 };

export default function Movement() {
  const d = MOVEMENT_DATA;
  const cards = [
    { key: 'transitions', label: 'Zone Transition Count', value: d.stats.transitions.value, sub: `${d.stats.transitions.deltaLabel} · avg/staff` },
    { key: 'compliance', label: 'Assigned Zone Compliance', value: d.stats.zoneCompliance.value, sub: d.stats.zoneCompliance.deltaLabel },
    { key: 'restricted', label: 'Restricted Area Entries', value: d.stats.restrictedEntries.value, sub: `${d.stats.restrictedEntries.deltaLabel} · this week` },
    { key: 'congestion', label: 'Congestion Flags', value: d.stats.congestionFlags.value, sub: `${d.stats.congestionFlags.deltaLabel} · flagged today` },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Footprints className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Workforce Movement</h1><p className="mt-1 text-small text-fg-muted">Staff movement and operational efficiency across branch zones.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Footprints} title="Zone Transitions Through the Day" right={<span className="text-caption text-fg-subtle">movements / hr</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.transitionsTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <defs><linearGradient id="bankMove" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="transitions" name="Transitions" stroke="#0ea5e9" strokeWidth={2} fill="url(#bankMove)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={MapPinned} title="Area Coverage" right={<span className="text-caption text-fg-subtle">minutes present</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.areaCoverage} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke="var(--line)" horizontal={false} />
                    <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="zone" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={92} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                    <Bar dataKey="minutes" name="Minutes" fill="#F7983A" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <Panel icon={DoorOpen} title="Restricted Area Activity" bodyClass="p-4">
            <p className="text-small text-fg-muted">3 entries this week — this is the trend view. For per-incident detail (who, when, severity), see the alert feed on the Security &amp; Compliance page.</p>
            <Link to="/activity-monitoring/bank/security" className="mt-3 inline-flex items-center gap-1 text-small font-semibold text-brand-ink hover:underline">View Security &amp; Compliance <ArrowRight className="h-3.5 w-3.5" /></Link>
          </Panel>
        </div>
      </div>
    </div>
  );
}
