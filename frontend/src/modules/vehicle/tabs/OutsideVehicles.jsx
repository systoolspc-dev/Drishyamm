/**
 * Tab 3 — Outside Vehicles.
 *
 * Non-local registrations, one row per VEHICLE rather than per read. The
 * questions here are about a vehicle over time — how long has that truck been
 * on site, does it keep coming back — and a per-read table answers neither.
 *
 * "Local" is a two-letter registering state, and it is editable rather than
 * hardcoded: the same build runs on sites in different states, and a hub that
 * silently treats GJ as home on a Maharashtra deployment would call every local
 * car an outsider.
 */
import { useMemo, useState } from 'react';
import { Clock, DoorOpen, Globe2, Repeat, Settings2 } from 'lucide-react';
import Panel from '@/core/ui/panel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { Empty, Plate, PlateThumb } from '../components/bits';
import { buildOutside, fmtDateTime, fmtStay } from '../vehicle-data';

const OVERSTAY = [
  { id: 'any', label: 'Any duration', hours: null },
  { id: '2', label: 'Over 2 hours', hours: 2 },
  { id: '8', label: 'Over 8 hours', hours: 8 },
  { id: '24', label: 'Over 24 hours', hours: 24 },
];

export default function OutsideVehicles({ reads, localState, onLocalState, cameraOptions }) {
  const [overstay, setOverstay] = useState('any');
  const [entry, setEntry] = useState('all');
  const [frequentOnly, setFrequentOnly] = useState(false);

  const all = useMemo(() => buildOutside(reads, localState), [reads, localState]);

  const rows = useMemo(() => {
    const limit = OVERSTAY.find((o) => o.id === overstay)?.hours;
    return all
      .filter((v) => (limit == null || v.stayMs >= limit * 3600_000))
      .filter((v) => (entry === 'all' || v.entryMonitorId === entry))
      .filter((v) => (!frequentOnly || v.frequent));
  }, [all, overstay, entry, frequentOnly]);

  const states = useMemo(() => {
    const counts = new Map();
    for (const v of all) counts.set(v.state, (counts.get(v.state) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [all]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(240px,300px)]">
        <Panel
          bodyClass="p-0"
          count={rows.length}
          icon={Globe2}
          right={<span className="text-micro font-semibold text-fg-subtle">Not registered in {localState || '—'}</span>}
          title="Non-local vehicles"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2.5">
            <Select onChange={setOverstay} options={OVERSTAY.map((o) => ({ id: o.id, label: o.label }))} value={overstay} />
            <Select
              onChange={setEntry}
              options={[{ id: 'all', label: 'Any entry point' }, ...cameraOptions]}
              value={entry}
            />
            <button
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-small font-semibold transition ${
                frequentOnly ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-muted hover:border-brand/40'
              }`}
              onClick={() => setFrequentOnly((v) => !v)}
              type="button"
            >
              <Repeat className="h-3.5 w-3.5" strokeWidth={2} />
              Frequent visitors
            </button>
          </div>

          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line-subtle text-micro font-bold uppercase tracking-wide text-fg-subtle">
                    <th className="px-3 py-2 font-bold">Vehicle</th>
                    <th className="px-3 py-2 font-bold">State</th>
                    <th className="px-3 py-2 font-bold">Entry point</th>
                    <th className="px-3 py-2 font-bold">First seen</th>
                    <th className="px-3 py-2 text-right font-bold">On site</th>
                    <th className="px-3 py-2 text-right font-bold">Visits</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr className="border-b border-line-subtle last:border-0" key={v.plate}>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <PlateThumb alt={v.plate} className="h-9 w-14" uri={v.snapshot} />
                          <span className="flex flex-col gap-1">
                            <Plate size="sm" value={v.plate} />
                            {v.frequent ? (
                              <span className="inline-flex w-fit items-center gap-1 rounded-full bg-info-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-info-ink">
                                <Repeat className="h-2.5 w-2.5" strokeWidth={2.5} />
                                frequent
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] font-bold text-fg-secondary">
                          {v.state}
                        </span>
                      </td>
                      <td className="max-w-[180px] truncate px-3 py-2 text-[11.5px] text-fg-secondary">
                        <span className="flex items-center gap-1">
                          <DoorOpen className="h-3 w-3 shrink-0 text-fg-subtle" strokeWidth={2} />
                          {v.entryCamera}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[11.5px] tabular-nums text-fg-secondary">
                        {fmtDateTime(v.first)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1 text-[11.5px] font-bold tabular-nums text-fg">
                              <Clock className="h-3 w-3 shrink-0 text-fg-subtle" strokeWidth={2} />
                              {fmtStay(v.stayMs)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[19rem] text-[10.5px] leading-relaxed" side="left" variant="card">
                            First to last sighting. Not a parking duration — nothing in the reads
                            proves the vehicle stayed between them, so this is time on site, not
                            time parked.
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="px-3 py-2 text-right text-[11.5px] font-bold tabular-nums text-fg">{v.visits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              body={`Every plate read so far is registered in ${localState || 'the local state'}, or nothing matches these filters.`}
              icon={Globe2}
              title="No non-local vehicles"
            />
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel bodyClass="p-3" className="shrink-0" fill={false} icon={Settings2} title="Local registration">
            <label className="block">
              <span className="mb-1.5 block text-[11.5px] font-semibold text-fg-secondary">Treat this state as local</span>
              <input
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-center font-mono text-[15px] font-bold uppercase tracking-[0.2em] text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
                maxLength={2}
                onChange={(e) => onLocalState(e.target.value)}
                placeholder="GJ"
                value={localState}
              />
              <span className="mt-1.5 block text-[10px] leading-relaxed text-fg-subtle">
                The two-letter registering state. Everything else counts as outside jurisdiction,
                including the KPI in the header. Held on this browser.
              </span>
            </label>
          </Panel>

          <Panel bodyClass="p-3" className="shrink-0" count={states.length} fill={false} icon={Globe2} title="Where they are from">
            {states.length ? (
              <ul className="flex flex-col gap-1.5">
                {states.map(([code, n]) => {
                  const max = states[0][1] || 1;
                  return (
                    <li className="flex items-center gap-2" key={code}>
                      <span className="w-7 shrink-0 rounded-md bg-surface-muted py-0.5 text-center font-mono text-[10.5px] font-bold text-fg-secondary">
                        {code}
                      </span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${(n / max) * 100}%` }} />
                      </span>
                      <span className="w-6 shrink-0 text-right text-[10.5px] font-bold tabular-nums text-fg-muted">{n}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="py-6 text-center text-[10.5px] text-fg-subtle">Nothing to break down yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Select({ value, onChange, options }) {
  return (
    <select
      className="h-8 shrink-0 rounded-lg border border-line bg-surface px-2 text-small font-semibold text-fg-secondary focus:border-brand focus:outline-none"
      onChange={(e) => onChange(e.target.value)}
      value={value}
    >
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}
