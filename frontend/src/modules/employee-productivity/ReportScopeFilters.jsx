import { CalendarRange, Clock, MapPin } from 'lucide-react';
import { PERIODS, shortRange } from './report-scope';

// Compact inline scope filters (period · shift · site) for a page header. The
// Reports hub and Staff Performance both wear them, over one shared scope.
// Below md they stack full width.

const SELECT = 'h-9 w-full appearance-none rounded-lg border border-line bg-surface pl-8 pr-7 text-small font-medium text-fg-secondary transition hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30';
const DATE = 'h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-small text-fg-secondary focus:border-brand focus:outline-none md:w-36 md:flex-none';

function FilterSelect({ icon: Icon, label, value, onChange, children, className = '', invalid = false }) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{label}</span>
      <Icon className={`pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${invalid ? 'text-warning-ink' : 'text-fg-subtle'}`} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        className={`${SELECT} ${invalid ? 'border-warning-line text-fg-muted' : ''}`}
      >
        {children}
      </select>
      <svg className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  );
}

// A single-site user's site: fixed context, not a choice.
function SiteBadge({ label }) {
  return (
    <span
      title="Your account covers this site only"
      className="inline-flex h-9 w-full items-center gap-1.5 rounded-lg border border-brand-line bg-brand-soft px-2.5 text-small font-semibold text-brand-ink md:w-auto"
    >
      <MapPin className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export default function ReportScopeFilters({ scope, siteRef }) {
  const { period, setPeriod, custom, setCustom, shift, setShift, shifts, sites, multiSite, storeObj, setStore, site } = scope;
  return (
    <div className="flex w-full flex-col gap-2 md:flex-row md:flex-wrap md:items-center lg:w-auto">
      <FilterSelect icon={CalendarRange} label="Date range" value={period} onChange={setPeriod} className="md:w-52">
        {PERIODS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label ? `${p.label} (${shortRange(p.from, p.to)})` : shortRange(p.from, p.to)}
          </option>
        ))}
        <option value="custom">Custom range…</option>
      </FilterSelect>
      {period === 'custom' && (
        <div className="flex items-center gap-1.5">
          <input
            type="date" aria-label="From" value={custom.from} max={custom.to} className={DATE}
            onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
          />
          <span className="text-caption text-fg-subtle">to</span>
          <input
            type="date" aria-label="To" value={custom.to} min={custom.from} className={DATE}
            onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
          />
        </div>
      )}
      <FilterSelect icon={Clock} label="Shift" value={shift} onChange={setShift} className="md:w-48">
        <option value="all">All shifts</option>
        {shifts.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.start}–{s.end})</option>)}
      </FilterSelect>
      {multiSite ? (
        <span ref={siteRef} className="block md:w-56">
          <FilterSelect icon={MapPin} label={site} value={storeObj?.id ?? ''} onChange={setStore} invalid={!storeObj}>
            <option value="" disabled>Select a {site.toLowerCase()} site…</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </FilterSelect>
        </span>
      ) : (
        <SiteBadge label={storeObj?.label ?? 'No site assigned'} />
      )}
    </div>
  );
}
