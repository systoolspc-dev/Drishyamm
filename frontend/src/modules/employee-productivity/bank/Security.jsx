import { ShieldAlert, BadgeCheck, ShieldCheck, Siren, Users, Clock, Wrench } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { SECURITY_DATA, ALERTS_DATA } from './pages-data';
import { StatCards, LevelChip } from './components/bits';

const ICONS = { uniform: BadgeCheck, id: ShieldCheck, emergency: Siren, violations: ShieldAlert };
const KIND_ICON = { vault: ShieldAlert, queue: Users, counter: Clock, emergency: Siren, maintenance: Wrench };
const LEVEL_TONE = { high: 'bg-danger-soft text-danger-ink', medium: 'bg-warning-soft text-warning-ink', low: 'bg-surface-muted text-fg-muted' };

export default function Security() {
  const d = SECURITY_DATA;
  const cards = [
    { key: 'uniform', label: 'Uniform Compliance', value: d.stats.uniformCompliance.value, sub: `${d.stats.uniformCompliance.deltaLabel} rolling 24h` },
    { key: 'id', label: 'ID Card Compliance', value: d.stats.idCompliance.value, sub: `${d.stats.idCompliance.deltaLabel} rolling 24h` },
    { key: 'emergency', label: 'Emergency Response', value: d.stats.emergencyResponse.value, sub: `${d.stats.emergencyResponse.deltaLabel} · avg today` },
    { key: 'violations', label: 'Safety Violations', value: d.stats.violations.value, sub: d.stats.violations.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ShieldAlert className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Security &amp; Compliance</h1><p className="mt-1 text-small text-fg-muted">Operational safety and banking policy compliance, branch-wide.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel icon={ShieldAlert} title="Flagged Incidents" count={ALERTS_DATA.length} bodyClass="p-4">
            <ul className="space-y-2">
              {ALERTS_DATA.map((n) => {
                const Icon = KIND_ICON[n.kind] || ShieldAlert;
                return (
                  <li key={n.id} className="flex items-start gap-2.5 rounded-lg border border-line p-2.5">
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${LEVEL_TONE[n.level] || LEVEL_TONE.low}`}><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5"><span className="truncate text-small font-semibold text-fg">{n.type}</span><span className="ml-auto"><LevelChip level={n.level} /></span></span>
                      <p className="mt-0.5 truncate text-caption text-fg-muted">{n.detail}</p>
                      <p className="text-micro text-fg-subtle">{n.time}</p>
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
