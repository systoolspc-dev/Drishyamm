import { Building2, Compass, Clock3, RotateCcw } from 'lucide-react';
import { BANK_HIERARCHY, TIME_RANGES } from '../data';

// Cascading Area → Zone + Time-range. Cosmetic (mirrors the Hospitality filter
// bar); choosing an area resets the zone beneath it. Single branch, no top toggle.
function Field({ icon, children }) {
  const Icon = icon;
  return (
    <label className="relative inline-flex min-w-0 items-center">
      <Icon className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
      {children}
    </label>
  );
}

export default function BankFilterBar({ value, onChange }) {
  const { area, zone, range } = value;
  const areas = BANK_HIERARCHY.areas;
  const zones = BANK_HIERARCHY.zones[area] || [];

  const set = (patch) => onChange({ ...value, ...patch });
  const selectCls = 'w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-subtle';
  const dirty = area !== 'all' || zone !== 'all' || range !== 'live';

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field icon={Building2}>
          <select value={area} onChange={(e) => set({ area: e.target.value, zone: 'all' })} className={selectCls}>
            <option value="all">All Areas</option>
            {areas.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </Field>
        <Field icon={Compass}>
          <select value={zone} onChange={(e) => set({ zone: e.target.value })} disabled={area === 'all'} className={selectCls}>
            <option value="all">{area === 'all' ? 'Select area first' : 'All Zones'}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
          </select>
        </Field>
        <Field icon={Clock3}>
          <select value={range} onChange={(e) => set({ range: e.target.value })} className={selectCls}>
            {TIME_RANGES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
      </div>
      {dirty && (
        <div className="mt-2 flex justify-end">
          <button onClick={() => onChange({ area: 'all', zone: 'all', range: 'live' })} className="inline-flex items-center gap-1.5 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink">
            <RotateCcw className="h-3 w-3" /> Reset filters
          </button>
        </div>
      )}
    </div>
  );
}
