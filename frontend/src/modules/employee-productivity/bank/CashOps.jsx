import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Coins, Gauge, Lock, Timer } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { CASHOPS_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { handling: Coins, utilization: Gauge, vault: Lock, idle: Timer };

export default function CashOps() {
  const d = CASHOPS_DATA;
  const cards = [
    { key: 'handling', label: 'Cash Handling Duration', value: d.stats.handlingDuration.value, sub: d.stats.handlingDuration.deltaLabel },
    { key: 'utilization', label: 'Counter Utilization', value: d.stats.utilization.value, sub: d.stats.utilization.deltaLabel },
    { key: 'vault', label: 'Vault Visit Count', value: d.stats.vaultVisits.value, sub: `${d.stats.vaultVisits.deltaLabel} · today` },
    { key: 'idle', label: 'Cash Counter Idle Time', value: d.stats.idleTime.value, sub: d.stats.idleTime.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Coins className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Cash Operations</h1><p className="mt-1 text-small text-fg-muted">Cash handling efficiency and counter operations, branch-wide.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Coins} title="Cash Handling Duration Through the Day" right={<span className="text-caption text-fg-subtle">seconds</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.handlingTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <defs><linearGradient id="bankCash" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="s" />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="seconds" name="Handling (s)" stroke="#0ea5e9" strokeWidth={2} fill="url(#bankCash)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={Gauge} title="Counter Utilization" right={<span className="text-caption text-fg-subtle">minutes</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.utilizationByCounter} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="counter" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="active" name="Active" stackId="a" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={40} />
                    <Bar dataKey="idle" name="Idle" stackId="a" fill="var(--line)" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <Panel icon={Lock} title="Vault Visit Log" count={d.vaultLog.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Time</th><th className="px-2 pb-2 font-semibold">Staff</th><th className="px-2 pb-2 font-semibold">Purpose</th><th className="px-2 pb-2 font-semibold">Duration</th><th className="px-2 pb-2 text-right font-semibold">Dual authorization</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.vaultLog.map((v) => (
                    <tr key={v.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 font-mono text-small text-fg-secondary">{v.time}</td>
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{v.staff}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{v.purpose}</td>
                      <td className="px-2 py-2.5 font-mono text-small text-fg-secondary">{v.duration}</td>
                      <td className="px-2 py-2.5 text-right"><Chip status={v.dualAuth ? 'confirmed' : 'single'} label={v.dualAuth ? 'Confirmed' : 'Single badge'} /></td>
                    </tr>
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
