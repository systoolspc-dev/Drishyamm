import { useState } from 'react';
import { Camera, Clock, Filter, Search, X } from 'lucide-react';
import faceWatchlistMockData from '../../data/faceWatchlistMockData';

const data = faceWatchlistMockData.faceSearch;

const riskClass = {
  High: 'bg-red-50 text-red-700 border-red-200',
  Medium: 'bg-[var(--color-primary-bg)] text-[var(--color-info-text)] border-[var(--color-border-accent)]',
  Low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

function RiskBadge({ level }) {
  return <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${riskClass[level] || riskClass.Low}`}>{level}</span>;
}

function Confidence({ value }) {
  const color = value >= 90 ? '#22c55e' : value >= 80 ? '#b7791f' : '#94a3b8';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-surface-high)]">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="font-mono text-[10px] font-bold" style={{ color }}>{value}%</span>
    </div>
  );
}

export default function FaceSearchPage() {
  const [searched, setSearched] = useState(false);
  const [location, setLocation] = useState(data.filters.location);
  const [nameQuery, setNameQuery] = useState('');

  return (
    <main className="face-watchlist-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[var(--color-on-bg)]">Face Search</h2>
          <p className="text-xs text-[var(--color-text-muted)]">Search by person, timeline and location from one place.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
          <Clock size={11} />
          {data.recentSearches.map((entry) => (
            <button
              key={entry.query}
              type="button"
              onClick={() => {
                setNameQuery(entry.query);
                setSearched(true);
              }}
              className="rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1 hover:border-[var(--color-primary)]"
            >
              {entry.query} <span className="text-[var(--color-text-muted)]">({entry.results})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <aside className="col-span-12 space-y-3 lg:col-span-4">
          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold"><Search size={13} /> Search Criteria</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Person Name / Watchlist ID</label>
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                  <input
                    value={nameQuery}
                    onChange={(event) => setNameQuery(event.target.value)}
                    placeholder="Enter name or ID..."
                    className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] py-2.5 pl-8 pr-3 text-xs text-[var(--color-on-bg)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)]"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Timeline / Date Range</label>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <input defaultValue={data.filters.dateRange.from} className="min-w-0 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 font-mono text-[10px] text-[var(--color-on-bg)] outline-none focus:border-[var(--color-primary)]" />
                  <input defaultValue={data.filters.dateRange.to} className="min-w-0 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 font-mono text-[10px] text-[var(--color-on-bg)] outline-none focus:border-[var(--color-primary)]" />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Location</label>
                <select value={location} onChange={(event) => setLocation(event.target.value)} className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 text-xs text-[var(--color-on-bg)] outline-none focus:border-[var(--color-primary)]">
                  {data.filterOptions.locations.map((item) => <option key={item}>{item}</option>)}
                </select>
              </div>

              <button onClick={() => setSearched(true)} className="w-full rounded-lg bg-[var(--action-primary)] py-2.5 text-sm font-bold hover:bg-[var(--action-primary-hover)]">
                Search Matches
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold"><Filter size={13} /> Active Query</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                <span className="text-[var(--color-text-muted)]">Person</span>
                <span className="text-right font-semibold text-[var(--color-on-bg)]">{nameQuery || 'Any watchlist person'}</span>
              </div>
              <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                <span className="text-[var(--color-text-muted)]">Timeline</span>
                <span className="text-right font-mono text-[var(--color-on-bg)]">{data.filters.dateRange.from} - {data.filters.dateRange.to}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[var(--color-text-muted)]">Location</span>
                <span className="text-right font-semibold text-[var(--color-on-bg)]">{location}</span>
              </div>
            </div>
          </section>
        </aside>

        <section className="col-span-12 space-y-4 lg:col-span-8">
          {!searched ? (
            <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
              <Search size={32} className="mb-3 text-slate-500" />
              <h3 className="text-lg font-bold text-[var(--color-on-bg)]">Ready for face search</h3>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">Enter a person, timeline and location to begin.</p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
                  <div>
                    <div className="text-sm font-bold">Search Results <span className="font-normal text-[var(--color-text-secondary)]">({data.searchResults.length})</span></div>
                    <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{nameQuery || 'All persons'} - {location} - {data.filters.dateRange.from} to {data.filters.dateRange.to}</div>
                  </div>
                  <button onClick={() => setSearched(false)} className="flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-on-bg)]"><X size={11} /> Clear</button>
                </div>
                <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                  {data.searchResults.map((result) => (
                    <div key={`${result.camera}-${result.time}`} className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                      <div className="relative flex aspect-video items-center justify-center border-b border-[var(--color-border)] bg-[var(--color-bg)]">
                        <div className="h-14 w-10 rounded bg-[var(--color-surface-low)] ring-2 ring-[var(--color-border-accent)]" />
                        <div className="absolute left-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[8px] text-[var(--color-on-bg)]"><Camera size={8} /> {result.camera}</div>
                      </div>
                      <div className="space-y-2 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold">{result.name}</div>
                          <RiskBadge level={result.riskLevel} />
                        </div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">{result.date} - {result.time} - {result.matchId}</div>
                        <Confidence value={result.confidence} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                <h3 className="mb-3 text-sm font-bold">Person Matches</h3>
                <div className="space-y-2">
                  {data.nameSearchResults.map((person) => (
                    <div key={person.id} className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                      <div>
                        <div className="text-xs font-semibold text-[var(--color-on-bg)]">{person.name}</div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">{person.category} - {person.matchCount} matches - Last {person.lastSeen}</div>
                      </div>
                      <RiskBadge level={person.riskLevel} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
