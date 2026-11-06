import { useMemo, useState } from 'react';
import { BellRing, ShieldAlert, ArrowLeftRight, ShieldCheck } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { SECURITY_DATA, MOVEMENT_DATA, SAFETY_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards, LevelChip } from './components/bits';

const SECTION_ICON = { Security: ShieldAlert, Movement: ArrowLeftRight, Safety: ShieldCheck };
const LEVEL_TONE = { high: 'bg-danger-soft text-danger-ink', medium: 'bg-warning-soft text-warning-ink', low: 'bg-surface-muted text-fg-muted' };
const FILTERS = ['all', 'high', 'medium', 'low'];

export default function Alerts() {
  const hostel = useHostelStore((s) => s.hostel);
  const [filter, setFilter] = useState('all');

  const all = useMemo(() => [
    ...(SECURITY_DATA[hostel].incidents || []).map((a) => ({ ...a, section: 'Security' })),
    ...(MOVEMENT_DATA[hostel].movementEvents || []).map((a) => ({ ...a, section: 'Movement' })),
    ...(SAFETY_DATA[hostel].incidents || []).map((a) => ({ ...a, section: 'Safety' })),
  ], [hostel]);

  const countFor = (l) => (l === 'all' ? all.length : all.filter((a) => a.level === l).length);
  const visible = filter === 'all' ? all : all.filter((a) => a.level === filter);
  const cards = [
    { key: 'all', label: 'Total Alerts', value: `${all.length}`, sub: 'across all sources' },
    { key: 'high', label: 'High', value: `${countFor('high')}`, sub: 'need action' },
    { key: 'medium', label: 'Medium', value: `${countFor('medium')}`, sub: 'monitor' },
    { key: 'low', label: 'Low', value: `${countFor('low')}`, sub: 'informational' },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><BellRing className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Alerts</h1><p className="mt-1 text-small text-fg-muted">Aggregated security, movement and safety alerts.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={{}} />
          <Panel
            icon={BellRing} title="Alert Feed" count={visible.length}
            right={
              <div className="inline-flex rounded-lg bg-surface-muted p-0.5 text-caption font-semibold">
                {FILTERS.map((f) => <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-2 py-1 capitalize transition ${filter === f ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>{f} ({countFor(f)})</button>)}
              </div>
            }
            bodyClass="p-4"
          >
            <ul className="space-y-2">
              {visible.length === 0 ? (
                <li className="rounded-lg border border-success-line bg-success-soft/60 px-3 py-2.5 text-caption text-success-ink">No alerts at this level.</li>
              ) : visible.map((a, i) => {
                const Icon = SECTION_ICON[a.section] || BellRing;
                return (
                  <li key={i} className="flex items-start gap-2.5 rounded-lg border border-line p-2.5">
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${LEVEL_TONE[a.level] || LEVEL_TONE.low}`}><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5"><span className="truncate text-small font-semibold text-fg">{a.type}</span><span className="rounded bg-surface-muted px-1.5 py-0.5 text-micro font-semibold text-fg-muted">{a.section}</span><span className="ml-auto"><LevelChip level={a.level} /></span></span>
                      <p className="mt-0.5 truncate text-caption text-fg-muted">{a.detail}</p>
                      <p className="text-micro text-fg-subtle">{a.time}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
