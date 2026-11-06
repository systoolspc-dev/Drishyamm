import { ArrowLeftRight, MapPin, ShieldAlert, Grid3x3, LayoutGrid } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { MOVEMENT_DATA } from './pages-data';
import { StatCards, LevelChip } from './components/bits';

const ICONS = { transitions: ArrowLeftRight, compliance: MapPin, restricted: ShieldAlert, coverage: Grid3x3 };
const ZONE_TONE = {
  low: 'border-success-line bg-success-soft/50',
  medium: 'border-warning-line bg-warning-soft/50',
  high: 'border-danger-line bg-danger-soft/50',
};

export default function Movement() {
  const d = MOVEMENT_DATA;
  const cards = [
    { key: 'transitions', label: 'Zone Transitions', value: d.stats.transitions.value, sub: `${d.stats.transitions.deltaLabel} today` },
    { key: 'compliance', label: 'Zone Compliance', value: d.stats.zoneCompliance.value, sub: `${d.stats.zoneCompliance.deltaLabel} of shift` },
    { key: 'restricted', label: 'Restricted Entries', value: d.stats.restrictedEntries.value, sub: `${d.stats.restrictedEntries.deltaLabel} today` },
    { key: 'coverage', label: 'Area Coverage', value: d.stats.areaCoverage.value, sub: `${d.stats.areaCoverage.deltaLabel} · monitored zones` },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ArrowLeftRight className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Movement Analytics</h1><p className="mt-1 text-small text-fg-muted">Where staff are right now, and whether they're where they should be.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel
            icon={LayoutGrid} title="Live Zone Occupancy"
            right={<div className="flex items-center gap-3 text-micro text-fg-subtle"><span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-success" /> Normal</span><span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-warning" /> Busy</span><span className="inline-flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-danger" /> Near capacity</span></div>}
            bodyClass="p-4"
          >
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {d.zones.map((z) => (
                <div key={z.name} className={`rounded-xl border p-3 ${ZONE_TONE[z.level] || ZONE_TONE.low}`}>
                  <div className="truncate text-small font-bold text-fg">{z.name}</div>
                  <div className="truncate text-micro text-fg-muted">{z.assigned}</div>
                  <div className="mt-2 text-section font-bold leading-none text-fg">{z.count}<span className="ml-1 text-micro font-medium text-fg-subtle">/ {z.capacity} capacity</span></div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel icon={ArrowLeftRight} title="Movement Alerts" count={d.events.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Event</th><th className="px-2 pb-2 font-semibold">Detail</th><th className="px-2 pb-2 font-semibold">Level</th><th className="px-2 pb-2 text-right font-semibold">Time</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.events.map((e, i) => (
                    <tr key={i} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{e.type}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{e.detail}</td>
                      <td className="px-2 py-2.5"><LevelChip level={e.level} /></td>
                      <td className="px-2 py-2.5 text-right text-small text-fg-muted">{e.time}</td>
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
