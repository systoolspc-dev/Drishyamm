import { ShieldCheck, BadgeCheck, HardHat, Ban, Timer, AlertTriangle } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { SAFETY_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards, Chip, LevelChip } from './components/bits';

const ICONS = { uniform: BadgeCheck, ppe: HardHat, restricted: Ban, emergency: Timer, violations: AlertTriangle };

export default function Safety() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = SAFETY_DATA[hostel];
  const cards = [
    { key: 'uniform', label: 'Uniform Compliance', value: d.uniformCompliance.value, sub: d.uniformCompliance.deltaLabel },
    { key: 'ppe', label: 'PPE Compliance', value: d.ppeComplianceHousekeeping.value, sub: d.ppeComplianceHousekeeping.deltaLabel },
    { key: 'restricted', label: 'Restricted-Area Entry', value: `${d.restrictedAreaEntry.value}`, sub: d.restrictedAreaEntry.deltaLabel },
    { key: 'emergency', label: 'Emergency Response', value: d.emergencyResponseTime.value, sub: d.emergencyResponseTime.deltaLabel },
    { key: 'violations', label: 'Safety Violations', value: `${d.safetyViolationCount.value}`, sub: d.safetyViolationCount.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ShieldCheck className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Safety &amp; Compliance</h1><p className="mt-1 text-small text-fg-muted">Uniform/PPE compliance, safety checkpoints and violations.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={ShieldCheck} title="Safety Checkpoints" count={d.checkpoints.length} bodyClass="p-4">
              <ul className="space-y-1.5">
                {d.checkpoints.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-lg border border-line p-2">
                    <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg-secondary">{c.point}</span>
                    <span className="shrink-0 text-micro text-fg-subtle">{c.updated}</span>
                    <Chip status={c.status} label={c.status} />
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel icon={AlertTriangle} title="Safety Incidents" count={d.incidents.length} bodyClass="p-4">
              <ul className="space-y-2">
                {d.incidents.length === 0 ? (
                  <li className="rounded-lg border border-success-line bg-success-soft/60 px-3 py-2.5 text-caption text-success-ink">No safety incidents recorded.</li>
                ) : d.incidents.map((e, i) => (
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
    </div>
  );
}
