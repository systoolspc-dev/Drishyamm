import { ShieldCheck, BadgeCheck, AlertTriangle, DoorOpen, Flame } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { SAFETY_DATA } from './pages-data';
import { StatCards, Chip, LevelChip } from './components/bits';

const ICONS = { ppe: BadgeCheck, incidents: AlertTriangle, exits: DoorOpen, hazard: Flame };
const STATUS_LABEL = { clear: 'Clear', attention: 'Needs attention', blocked: 'Blocked' };

export default function Safety() {
  const d = SAFETY_DATA;
  const cards = [
    { key: 'ppe', label: 'PPE Compliance', value: d.stats.ppeCompliance.value, sub: `${d.stats.ppeCompliance.deltaLabel} of shift` },
    { key: 'incidents', label: 'Open Incidents', value: d.stats.openIncidents.value, sub: d.stats.openIncidents.deltaLabel },
    { key: 'exits', label: 'Exit Clearance', value: d.stats.exitClearance.value, sub: 'exits clear' },
    { key: 'hazard', label: 'Hazard Zone Entries', value: d.stats.hazardEntries.value, sub: `${d.stats.hazardEntries.deltaLabel} unauthorized` },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ShieldCheck className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Safety &amp; Compliance</h1><p className="mt-1 text-small text-fg-muted">PPE, evacuation routes and hazard zones — monitored continuously.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel icon={DoorOpen} title="Exit & Equipment Status" count={d.points.length} bodyClass="p-4">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {d.points.map((p) => (
                <div key={p.name} className="rounded-xl border border-line bg-surface p-3">
                  <div className="mb-1.5 flex items-center justify-between gap-1"><span className="truncate text-small font-bold text-fg">{p.name}</span><Chip status={p.status} label={STATUS_LABEL[p.status] || p.status} /></div>
                  <p className="truncate text-micro text-fg-muted">{p.detail}</p>
                </div>
              ))}
            </div>
          </Panel>
          <Panel icon={AlertTriangle} title="Safety Incidents" count={d.incidents.length} bodyClass="p-4">
            <ul className="space-y-2">
              {d.incidents.map((e, i) => (
                <li key={i} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-center gap-1.5"><p className="truncate text-small font-semibold text-fg">{e.type}</p><span className="ml-auto"><LevelChip level={e.level} /></span></div>
                  <p className="mt-0.5 truncate text-micro text-fg-muted">{e.detail} · {e.time}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
