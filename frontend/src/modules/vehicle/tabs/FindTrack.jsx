/**
 * Tab 1 — Find & Track.
 *
 * Filters on the left, the plate's route on the right. The route is the point
 * of the tab: a list of reads tells you a car was seen; the chain between
 * cameras tells you where it went, and the GAP between two stops is what an
 * investigator actually reads — four minutes between two gates is a car
 * driving, forty is a car that stopped somewhere nobody was watching.
 *
 * The map is a schematic, not a geographic one. Camera positions in this
 * platform are floor-plan coordinates, and there is no lat/long for a gate —
 * so the route is drawn as an ordered chain rather than pinned to a world map
 * that would place every camera in the Gulf of Guinea.
 */
import { useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Camera, Clock, Image as ImageIcon, MapPin, Route, Search, Upload, X,
} from 'lucide-react';
import Panel from '@/core/ui/panel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { Empty, Plate, PlateThumb } from '../components/bits';
import {
  SEVERITIES, buildTrack, fmtDateTime, fmtGap, fmtTime, hitOf, plateMatcher,
} from '../vehicle-data';

const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-small text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25';

export default function FindTrack({ reads, watchIndex, cameraOptions }) {
  const [plateQuery, setPlateQuery] = useState('');
  const [cams, setCams] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [severities, setSeverities] = useState([]);
  const [image, setImage] = useState(null);
  const [selected, setSelected] = useState(null);
  const fileRef = useRef(null);

  const filtered = useMemo(() => {
    const matches = plateMatcher(plateQuery);
    const fromT = from ? new Date(from).getTime() : null;
    const toT = to ? new Date(to).getTime() : null;
    return reads.filter((r) => {
      if (!matches(r.plate || '')) return false;
      if (cams.length && !cams.includes(r.monitorId)) return false;
      if (fromT && r.at.getTime() < fromT) return false;
      if (toT && r.at.getTime() > toT) return false;
      if (severities.length && !hitOf(r, watchIndex, severities)) return false;
      return true;
    });
  }, [reads, plateQuery, cams, from, to, severities, watchIndex]);

  // Candidate plates, most recent first. With a wildcard query this is the
  // answer list; the route below is for one of them at a time.
  const candidates = useMemo(() => {
    const seen = new Map();
    for (const r of filtered) {
      if (!r.plate) continue;
      const cur = seen.get(r.plate);
      if (!cur) seen.set(r.plate, { plate: r.plate, last: r.at, count: 1, snapshot: r.snapshot });
      else { cur.count += 1; if (r.at > cur.last) cur.last = r.at; }
    }
    return [...seen.values()].sort((a, b) => b.last - a.last);
  }, [filtered]);

  const active = selected || candidates[0]?.plate || null;
  const track = useMemo(() => buildTrack(filtered, active), [filtered, active]);

  const clearAll = () => {
    setPlateQuery(''); setCams([]); setFrom(''); setTo(''); setSeverities([]); setImage(null); setSelected(null);
  };

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <Panel bodyClass="p-3" icon={Search} title="Find a vehicle">
        <div className="flex flex-col gap-3">
          <Field
            hint="Use * for any run of characters and ? for exactly one — MH12??1234 asks a different question from MH12*1234. Plain text falls back to a partial match."
            label="Number plate"
          >
            <input
              className={`${INPUT} font-mono tracking-wider`}
              onChange={(e) => { setPlateQuery(e.target.value); setSelected(null); }}
              placeholder="MH12AB* or ??12AB1234"
              value={plateQuery}
            />
          </Field>

          <Field hint="Matched against the plate crops on the reads below." label="Reference image">
            <input
              accept="image/*"
              className="hidden"
              onChange={(e) => setImage(e.target.files?.[0] || null)}
              ref={fileRef}
              type="file"
            />
            {image ? (
              <span className="flex items-center gap-2 rounded-lg border border-brand/50 bg-brand-soft px-2.5 py-2">
                <ImageIcon className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-brand-ink">{image.name}</span>
                <button aria-label="Remove image" className="shrink-0 text-fg-subtle hover:text-danger-ink" onClick={() => setImage(null)} type="button">
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </span>
            ) : (
              <button
                className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-line px-3 py-4 text-center transition hover:border-brand/40 hover:bg-surface-sunken"
                onClick={() => fileRef.current?.click()}
                type="button"
              >
                <Upload className="h-4 w-4 text-fg-subtle" strokeWidth={2} />
                <span className="text-[11px] font-semibold text-fg-secondary">Drop a photo or click to browse</span>
                <span className="text-[10px] text-fg-subtle">JPG · PNG · max 20 MB</span>
              </button>
            )}
            {image ? (
              <p className="mt-1.5 rounded-lg border border-warning-line bg-warning-soft px-2 py-1.5 text-[10px] leading-relaxed text-warning-ink">
                Reverse image search is not wired to a service yet — the file is held here and the
                results below are still driven by the plate and filters.
              </p>
            ) : null}
          </Field>

          <Field label="Cameras">
            <div className="max-h-[168px] overflow-y-auto rounded-lg border border-line">
              {cameraOptions.length ? cameraOptions.map((c) => {
                const on = cams.includes(c.id);
                return (
                  <button
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition ${
                      on ? 'bg-brand-soft font-semibold text-brand-ink' : 'text-fg-secondary hover:bg-surface-sunken'
                    }`}
                    key={c.id}
                    onClick={() => setCams((prev) => (on ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                    type="button"
                  >
                    <span className={`grid h-3 w-3 shrink-0 place-items-center rounded-sm border ${on ? 'border-brand bg-brand' : 'border-line-strong'}`}>
                      {on ? <span className="block h-1.5 w-1.5 rounded-[1px] bg-white" /> : null}
                    </span>
                    <span className="truncate">{c.label}</span>
                  </button>
                );
              }) : (
                <p className="px-2.5 py-3 text-center text-[10.5px] text-fg-subtle">No cameras registered</p>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <input className={INPUT} onChange={(e) => setFrom(e.target.value)} type="datetime-local" value={from} />
            </Field>
            <Field label="To">
              <input className={INPUT} onChange={(e) => setTo(e.target.value)} type="datetime-local" value={to} />
            </Field>
          </div>

          <Field hint="Show only reads that hit the watchlist at this level." label="Watchlist severity">
            <div className="flex gap-1.5">
              {SEVERITIES.map((s) => {
                const on = severities.includes(s.id);
                return (
                  <button
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition ${
                      on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-muted hover:border-brand/40'
                    }`}
                    key={s.id}
                    onClick={() => setSeverities((prev) => (on ? prev.filter((x) => x !== s.id) : [...prev, s.id]))}
                    type="button"
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <button
            className="rounded-lg border border-line px-3 py-2 text-small font-semibold text-fg-muted transition hover:bg-surface-sunken"
            onClick={clearAll}
            type="button"
          >
            Clear filters
          </button>
        </div>
      </Panel>

      {/* ── Results + route ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <Panel
          bodyClass="p-2"
          count={candidates.length}
          icon={Camera}
          right={<span className="text-micro font-semibold text-fg-subtle">{filtered.length} reads</span>}
          title="Matching plates"
        >
          {candidates.length ? (
            <div className="flex flex-wrap gap-1.5">
              {candidates.slice(0, 24).map((c) => {
                const on = c.plate === active;
                return (
                  <button
                    className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition ${
                      on ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-brand/40'
                    }`}
                    key={c.plate}
                    onClick={() => setSelected(c.plate)}
                    type="button"
                  >
                    <Plate size="sm" value={c.plate} />
                    <span className="text-[10px] text-fg-subtle">{c.count} read{c.count === 1 ? '' : 's'}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty
              body="No plate in the recorded reads matches these filters. A wildcard — MH12* — widens the search without guessing the missing characters."
              icon={Search}
              title="Nothing matches"
            />
          )}
        </Panel>

        <Panel
          bodyClass="p-3"
          icon={Route}
          right={active ? <Plate size="sm" value={active} /> : null}
          title="Movement between cameras"
        >
          {track.length ? <TrackMap track={track} /> : (
            <Empty
              body="Pick a plate above to draw its chronological route between cameras."
              icon={MapPin}
              title={active ? 'Only one sighting' : 'No route yet'}
            />
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * The route, as an ordered chain of camera nodes.
 *
 * Horizontal and scrollable rather than laid out in two dimensions: the axis
 * that carries meaning here is TIME, and a chain makes the order unambiguous
 * where a scatter of pins would need arrows to say which came first.
 */
function TrackMap({ track }) {
  return (
    <div className="overflow-x-auto pb-2">
      <ol className="flex min-w-max items-stretch gap-0">
        {track.map((stop, i) => (
          <li className="flex items-stretch" key={`${stop.monitorId}-${stop.firstSeen.getTime()}`}>
            {i > 0 ? (
              <span className="flex w-24 shrink-0 flex-col items-center justify-center gap-1 px-1">
                <span className="flex w-full items-center gap-1">
                  <span className="h-px flex-1 bg-line-strong" />
                  <ArrowRight className="h-3 w-3 shrink-0 text-fg-subtle" strokeWidth={2.5} />
                </span>
                {/* The gap is the finding, not the decoration. */}
                <span className="whitespace-nowrap text-[10px] font-semibold tabular-nums text-fg-muted">
                  {fmtGap(stop.gapMs)}
                </span>
              </span>
            ) : null}

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="w-[178px] shrink-0 rounded-xl border border-line bg-surface p-2.5 shadow-sm transition hover:border-brand/40">
                  <div className="flex items-center gap-1.5">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand text-[10px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span className="min-w-0 truncate text-[11.5px] font-bold text-fg">{stop.cameraLabel}</span>
                  </div>
                  <PlateThumb alt={stop.cameraLabel} className="mt-2 h-16 w-full" uri={stop.snapshot} />
                  <p className="mt-1.5 flex items-center gap-1 text-[10px] tabular-nums text-fg-secondary">
                    <Clock className="h-2.5 w-2.5 shrink-0" strokeWidth={2} />
                    {fmtTime(stop.firstSeen)}
                    {stop.count > 1 ? <span className="text-fg-subtle">→ {fmtTime(stop.lastSeen)}</span> : null}
                  </p>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-[20rem] text-[10.5px] leading-relaxed" side="top" variant="card">
                <p><span className="font-bold">{stop.cameraLabel}</span></p>
                <p className="mt-1">First seen {fmtDateTime(stop.firstSeen)}</p>
                {stop.count > 1 ? (
                  <p>Last seen {fmtDateTime(stop.lastSeen)} — {stop.count} reads over {fmtGap(stop.dwellMs) || '0s'}</p>
                ) : <p>A single read.</p>}
                {stop.gapMs != null ? <p className="mt-1">{fmtGap(stop.gapMs)} since the previous camera.</p> : null}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11.5px] font-semibold text-fg-secondary">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] leading-relaxed text-fg-subtle">{hint}</span> : null}
    </label>
  );
}
