/**
 * Tab 2 — Live ANPR Stream.
 *
 * One column per camera that is reading plates, newest at the top. Grouped by
 * camera rather than one merged river because the question at a control-room
 * screen is "what is coming through the north gate", and a single interleaved
 * list makes an operator filter it in their head.
 *
 * A watchlist hit pulses. Only here — a table of fifty pulsing badges is noise,
 * and the animation exists to catch an eye that is looking somewhere else.
 */
import { useEffect, useMemo, useState } from 'react';
import { Camera, Pause, Play, Radio, ShieldAlert } from 'lucide-react';
import Panel from '@/core/ui/panel';
import { Empty, Plate, PlateThumb, WatchBadge, Confidence } from '../components/bits';
import { fmtTime, hitOf } from '../vehicle-data';

// A hit stays "live" — and keeps pulsing — for this long after the read.
const FLASH_MS = 60_000;

export default function LiveStream({ reads, watchIndex, cameraOptions, paused, onTogglePause }) {
  // A clock of its own, because "is this hit still fresh" is a question about
  // wall time rather than about the data. Reading Date.now() in render would be
  // impure and would also never re-render to STOP the pulse once the minute is
  // up -- the badge would keep flashing until the next poll happened to arrive.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Group by camera, keeping each column short. Fifty rows in a live pane is
  // scrollback nobody reads; the records tab is where history lives.
  const columns = useMemo(() => {
    const by = new Map();
    for (const r of reads) {
      const arr = by.get(r.monitorId) || [];
      if (arr.length < 12) arr.push(r);
      by.set(r.monitorId, arr);
    }
    return [...by.entries()]
      .map(([monitorId, list]) => ({
        monitorId,
        label: list[0]?.cameraLabel || cameraOptions.find((c) => c.id === monitorId)?.label || 'Unnamed camera',
        reads: list,
        hits: list.filter((r) => hitOf(r, watchIndex)).length,
      }))
      .sort((a, b) => b.hits - a.hits || b.reads[0].at - a.reads[0].at);
  }, [reads, watchIndex, cameraOptions]);

  const liveHits = reads.filter((r) => hitOf(r, watchIndex) && now - r.at.getTime() < FLASH_MS);

  return (
    <div className="flex flex-col gap-4">
      {/* The banner exists so a hit is impossible to miss while an operator is
          reading a different column. */}
      {liveHits.length ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-danger-line bg-danger-soft px-3.5 py-3">
          <ShieldAlert className="mt-px h-4 w-4 shrink-0 animate-pulse text-danger-ink" strokeWidth={2.25} />
          <div className="min-w-0 flex-1">
            <p className="text-small font-bold text-danger-ink">
              {liveHits.length === 1 ? 'Watchlist vehicle on site' : `${liveHits.length} watchlist vehicles on site`}
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {liveHits.slice(0, 6).map((r) => (
                <li className="flex items-center gap-1.5" key={r.id}>
                  <Plate size="sm" value={r.plate} />
                  <span className="text-[10.5px] text-fg-secondary">{r.cameraLabel} · {fmtTime(r.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-caption text-fg-muted">
          <span className={`h-2 w-2 rounded-full ${paused ? 'bg-line-strong' : 'animate-pulse bg-success'}`} />
          {paused ? 'Stream paused' : 'Streaming'}
        </span>
        <span className="flex-1" />
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken"
          onClick={onTogglePause}
          type="button"
        >
          {paused ? <Play className="h-3.5 w-3.5" strokeWidth={2} /> : <Pause className="h-3.5 w-3.5" strokeWidth={2} />}
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {columns.length ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {columns.map((col) => (
            <Panel
              bodyClass="p-2"
              count={col.reads.length}
              icon={Camera}
              key={col.monitorId}
              right={col.hits ? (
                <span className="rounded-full bg-danger-soft px-2 py-0.5 text-micro font-bold text-danger-ink">
                  {col.hits} hit{col.hits === 1 ? '' : 's'}
                </span>
              ) : null}
              title={col.label}
            >
              <ul className="flex flex-col gap-1">
                {col.reads.map((r) => {
                  const hit = hitOf(r, watchIndex);
                  const fresh = now - r.at.getTime() < FLASH_MS;
                  return (
                    <li key={r.id}>
                      <div
                        className={`flex items-center gap-2.5 rounded-lg border px-2 py-1.5 ${
                          hit && fresh
                            ? 'animate-pulse border-danger-line bg-danger-soft'
                            : hit
                              ? 'border-danger-line bg-danger-soft/40'
                              : 'border-line bg-surface'
                        }`}
                      >
                        <PlateThumb alt={`Plate at ${col.label}`} className="h-9 w-14" uri={r.snapshot} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Plate size="sm" value={r.plate} />
                            <WatchBadge flashing={fresh} hit={hit} />
                          </span>
                          <span className="mt-0.5 block text-[10px] tabular-nums text-fg-subtle">
                            {fmtTime(r.at)}
                          </span>
                        </span>
                        <Confidence showBar={false} value={r.confidence} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ))}
        </div>
      ) : (
        <Panel bodyClass="p-0" icon={Radio} title="Live reads">
          <Empty
            body="No camera has produced a plate read yet. Reads appear here the moment the ANPR pipeline emits one — this pane does not poll the cameras directly, it follows the events feed."
            icon={Radio}
            title="Nothing on the stream"
          />
        </Panel>
      )}
    </div>
  );
}
