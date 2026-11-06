/**
 * Tab 4 — Vehicle Records.
 *
 * The audit table. Everything the other tabs summarise, listed, searchable and
 * exportable — this is the tab someone opens to answer a question in writing.
 *
 * The confidence range is two handles rather than one threshold because the
 * useful queries sit at both ends: "show me everything the model was unsure
 * about" and "show me only reads I would put in a report".
 */
import { useMemo, useState } from 'react';
import { Download, FileSearch, Search } from 'lucide-react';
import Panel from '@/core/ui/panel';
import { Empty, Confidence, Plate, PlateThumb, WatchBadge } from '../components/bits';
import { fmtDateTime, hitOf, plateMatcher, readsToCsv } from '../vehicle-data';

const PAGE_SIZE = 25;

export default function VehicleRecords({ reads, watchIndex, cameraOptions }) {
  const [query, setQuery] = useState('');
  const [cam, setCam] = useState('all');
  const [minConf, setMinConf] = useState(0);
  const [maxConf, setMaxConf] = useState(100);
  const [page, setPage] = useState(0);

  // Any filter change puts you back on page one -- staying on page 9 of a
  // three-page result reads as an empty table. Done in the setters rather than
  // an effect, so the reset happens with the change instead of one render later.
  const filterBy = (setter) => (value) => { setter(value); setPage(0); };

  const rows = useMemo(() => {
    const matches = plateMatcher(query);
    const q = query.trim().toLowerCase();
    return reads.filter((r) => {
      // Plate match OR a plain text hit on the camera name, so the one search
      // box answers "MH12*" and "north gate" without a mode switch.
      const byPlate = matches(r.plate || '');
      const byText = !q || r.cameraLabel.toLowerCase().includes(q);
      if (!(byPlate || byText)) return false;
      if (cam !== 'all' && r.monitorId !== cam) return false;
      if (r.confidence != null && (r.confidence < minConf || r.confidence > maxConf)) return false;
      // A read with no confidence is only hidden once the floor is raised off
      // zero -- otherwise the default view would silently drop them.
      if (r.confidence == null && minConf > 0) return false;
      return true;
    });
  }, [reads, query, cam, minConf, maxConf]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const slice = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const exportCsv = () => {
    const blob = new Blob([readsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plate-reads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      bodyClass="p-0"
      count={rows.length}
      icon={FileSearch}
      right={
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-micro font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
          disabled={!rows.length}
          onClick={exportCsv}
          type="button"
        >
          <Download className="h-3 w-3" strokeWidth={2} />
          Export CSV
        </button>
      }
      title="Plate read records"
    >
      <div className="flex flex-wrap items-end gap-3 border-b border-line-subtle px-3 py-2.5">
        <label className="relative inline-flex min-w-[200px] flex-1 items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
          <input
            className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3 text-small text-fg-secondary placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            onChange={(e) => filterBy(setQuery)(e.target.value)}
            placeholder="Plate (wildcards work) or camera name…"
            value={query}
          />
        </label>

        <select
          className="h-8 shrink-0 rounded-lg border border-line bg-surface px-2 text-small font-semibold text-fg-secondary focus:border-brand focus:outline-none"
          onChange={(e) => filterBy(setCam)(e.target.value)}
          value={cam}
        >
          <option value="all">All cameras</option>
          {cameraOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>

        <div className="shrink-0">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            Confidence {minConf}–{maxConf}%
          </span>
          <div className="flex items-center gap-2">
            <input
              aria-label="Minimum confidence"
              className="app-range h-1.5 w-[88px]"
              max={100}
              min={0}
              onChange={(e) => filterBy(setMinConf)(Math.min(Number(e.target.value), maxConf))}
              type="range"
              value={minConf}
            />
            <input
              aria-label="Maximum confidence"
              className="app-range h-1.5 w-[88px]"
              max={100}
              min={0}
              onChange={(e) => filterBy(setMaxConf)(Math.max(Number(e.target.value), minConf))}
              type="range"
              value={maxConf}
            />
          </div>
        </div>
      </div>

      {slice.length ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line-subtle text-micro font-bold uppercase tracking-wide text-fg-subtle">
                  <th className="px-3 py-2 font-bold">Snapshot</th>
                  <th className="px-3 py-2 font-bold">Plate</th>
                  <th className="px-3 py-2 font-bold">Camera</th>
                  <th className="px-3 py-2 font-bold">When</th>
                  <th className="px-3 py-2 font-bold">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((r) => {
                  const hit = hitOf(r, watchIndex);
                  return (
                    <tr className={`border-b border-line-subtle last:border-0 ${hit ? 'bg-danger-soft/30' : ''}`} key={r.id}>
                      <td className="px-3 py-2">
                        <PlateThumb alt={`Plate at ${r.cameraLabel}`} className="h-10 w-16" uri={r.snapshot} />
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Plate size="sm" value={r.plate} />
                          <WatchBadge hit={hit} />
                          {r.corrected ? (
                            <span className="rounded-full bg-info-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-info-ink">
                              corrected
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-2 text-[11.5px] text-fg-secondary">{r.cameraLabel}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-[11.5px] tabular-nums text-fg-secondary">{fmtDateTime(r.at)}</td>
                      <td className="px-3 py-2"><Confidence value={r.confidence} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2 border-t border-line-subtle px-3 py-2">
            <span className="text-[10.5px] tabular-nums text-fg-subtle">
              {safePage * PAGE_SIZE + 1}–{Math.min(rows.length, (safePage + 1) * PAGE_SIZE)} of {rows.length}
            </span>
            <span className="flex-1" />
            <button
              className="rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              type="button"
            >
              Previous
            </button>
            <span className="text-[10.5px] tabular-nums text-fg-muted">Page {safePage + 1} of {pages}</span>
            <button
              className="rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
              disabled={safePage >= pages - 1}
              onClick={() => setPage(safePage + 1)}
              type="button"
            >
              Next
            </button>
          </div>
        </>
      ) : (
        <Empty
          body="Nothing in the recorded reads matches these filters. Widen the confidence range or clear the search."
          icon={FileSearch}
          title="No records"
        />
      )}
    </Panel>
  );
}
