import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { LogOut, Clock, ShieldCheck, ShieldX, Timer, Bus, DoorOpen, ArrowUpRight, Check, X, CheckCircle2, ClipboardCheck } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import SchoolFilterBar from './components/SchoolFilterBar';
import { StatCards, Chip } from './components/bits';
import { DIS_CARDS, DIS_FLOW, DIS_MODES, DIS_LOG } from './pages-data';

const ICONS = { dismissed: LogOut, awaiting: Clock, verified: ShieldCheck, unauthorized: ShieldX, wait: Timer, boarded: Bus };
const DEFAULT_FILTERS = { school: 'greenwood', wing: 'all', grade: 'all', section: 'all', room: 'all', range: 'today' };

export default function Dismissal() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [log, setLog] = useState(DIS_LOG);
  // Ack policy — configurable: 'deviation' auto-approves clean temp-pass pickups
  // (ack only on a deviation); 'all' requires an operator ack on every temp
  // pickup. Deviations (face-mismatch / outside-window / OTP fail) ALWAYS need
  // review. Unacknowledged reviews SLA-auto-escalate (backend) — never fail open.
  const [ackPolicy, setAckPolicy] = useState('deviation');
  const [toast, setToast] = useState(null);
  const notify = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500); };

  const needsAck = (r) => r.status === 'temporary-review' && (ackPolicy === 'all' || !r.clean);
  // Clean temp pickups auto-approve under the 'deviation' policy.
  const effStatus = (r) => (r.status === 'temporary-review' && r.clean && ackPolicy === 'deviation' ? 'approved' : r.status);
  const queue = log.filter(needsAck);
  const acknowledge = (id) => { setLog((prev) => prev.map((r) => (r.id === id ? { ...r, status: 'approved', ackBy: 'Operator', ackAt: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) } : r))); notify('Pickup acknowledged & approved.'); };
  const escalate = (id) => { setLog((prev) => prev.map((r) => (r.id === id ? { ...r, status: 'escalated' } : r))); notify('Escalated — security & parent notified.'); };

  const total = DIS_MODES.reduce((s, d) => s + d.value, 0);
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><DoorOpen className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Dismissal &amp; Pickup</h1>
            <p className="mt-1 text-small text-fg-muted">Guardian verification, pickup mode and unauthorized-pickup prevention.</p>
          </div>
          <Link to="/activity-monitoring/school/guardians" className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink">
            <ShieldCheck className="h-4 w-4" /> Manage Guardians <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <SchoolFilterBar value={filters} onChange={setFilters} />

        {toast && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-success-line bg-success-soft px-3 py-2.5 text-small text-success-ink">
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast}</span>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          {/* Pickup Review Queue — temporary-pass pickups awaiting operator ack */}
          <Panel
            icon={ClipboardCheck} title="Pickup Review Queue" count={queue.length}
            right={
              <span className="inline-flex items-center gap-1.5 text-caption font-medium text-fg-muted">
                Ack policy:
                <span className="inline-flex rounded-lg bg-surface-muted p-0.5 font-semibold">
                  <button onClick={() => setAckPolicy('deviation')} className={`rounded-md px-2 py-1 transition ${ackPolicy === 'deviation' ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>Auto-approve clean</button>
                  <button onClick={() => setAckPolicy('all')} className={`rounded-md px-2 py-1 transition ${ackPolicy === 'all' ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>Require ack on all</button>
                </span>
              </span>
            }
            bodyClass="p-4"
          >
            {queue.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft/60 px-3 py-2.5 text-small text-success-ink">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> Nothing awaiting review — all temporary pickups handled.
              </div>
            ) : (
              <ul className="space-y-2">
                {queue.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2.5 rounded-lg border border-warning-line bg-warning-soft/50 p-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5"><span className="truncate text-small font-semibold text-fg">{r.student}</span><Chip status="temporary-review" label="review" /></span>
                      <span className="mt-0.5 block truncate text-caption text-fg-muted">{r.guardian} · {r.reason} · {r.time}</span>
                    </span>
                    <button onClick={() => acknowledge(r.id)} className="inline-flex items-center gap-1 rounded-md bg-success px-2.5 py-1.5 text-caption font-semibold text-white transition hover:bg-success"><Check className="h-3.5 w-3.5" /> Acknowledge</button>
                    <button onClick={() => escalate(r.id)} className="inline-flex items-center gap-1 rounded-md border border-danger-line bg-surface px-2.5 py-1.5 text-caption font-semibold text-danger-ink transition hover:bg-danger-soft"><ArrowUpRight className="h-3.5 w-3.5" /> Escalate</button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <StatCards cards={DIS_CARDS} icons={ICONS} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={LogOut} title="Pickup Flow" right={<span className="text-caption text-fg-subtle">students leaving</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={DIS_FLOW} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="t" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} />
                    <Line type="monotone" dataKey="count" name="Departures" stroke="#F7983A" strokeWidth={2} dot={{ r: 2.5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={ShieldCheck} title="Pickup Mode" right={<span className="text-caption text-fg-subtle">distribution</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={DIS_MODES} dataKey="value" nameKey="mode" cx="42%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2} stroke="none">
                      {DIS_MODES.map((d) => <Cell key={d.mode} fill={d.color} />)}
                    </Pie>
                    <Tooltip {...TIP} formatter={(v, n) => [`${v} (${((v / total) * 100).toFixed(0)}%)`, n]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <Panel icon={ShieldCheck} title="Pickup Verification Log" count={log.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Student</th><th className="px-2 pb-2 font-semibold">Guardian</th><th className="px-2 pb-2 font-semibold">Mode</th>
                  <th className="px-2 pb-2 text-right font-semibold">Time</th><th className="px-2 pb-2 text-right font-semibold">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {log.map((r) => (
                    <tr key={r.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{r.student}</td>
                      <td className="px-2 py-2.5 text-fg-secondary">{r.guardian}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{r.mode}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-secondary">{r.time}</td>
                      <td className="px-2 py-2.5 text-right">
                        {needsAck(r) ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Chip status="temporary-review" label="review" />
                            <button onClick={() => acknowledge(r.id)} title="Acknowledge" className="rounded-md border border-success-line bg-surface p-1 text-success-ink transition hover:bg-success-soft"><Check className="h-3.5 w-3.5" /></button>
                            <button onClick={() => escalate(r.id)} title="Escalate" className="rounded-md border border-danger-line bg-surface p-1 text-danger-ink transition hover:bg-danger-soft"><ArrowUpRight className="h-3.5 w-3.5" /></button>
                          </span>
                        ) : r.status === 'blocked' ? (
                          <Link to="/activity-monitoring/school/guardians" title="Review in Guardian Registry" className="inline-flex items-center gap-1">
                            <Chip status={r.status} label={r.status} /><ArrowUpRight className="h-3 w-3 text-danger" />
                          </Link>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Chip status={effStatus(r)} label={effStatus(r)} />
                            {r.status === 'temporary-review' && r.clean && <span className="text-micro font-semibold uppercase text-fg-disabled">auto</span>}
                          </span>
                        )}
                      </td>
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
