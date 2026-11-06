/**
 * Tab 5 — Check Reads.
 *
 * The human-in-the-loop queue: every read the model scored under the review
 * threshold, snapshot beside OCR output, with the text editable.
 *
 * One read at a time, not a table of inputs. Correcting a plate means reading
 * characters off a photograph, and a grid of twenty crops invites the eye to
 * skim — which is the one thing this task cannot survive. The queue shows how
 * much is left so the operator can still see the shape of the work.
 *
 * A correction is held on THIS BROWSER. The service has no endpoint to write an
 * OCR fix back to and no training loop to feed, so the panel says so plainly
 * rather than implying the model learned something.
 */
import { useMemo, useState } from 'react';
import {
  ArrowRight, Check, CircleAlert, Info, RotateCcw, ScanLine, SkipForward,
} from 'lucide-react';
import Panel from '@/core/ui/panel';
import { Empty, Confidence, Plate, PlateThumb, WatchBadge } from '../components/bits';
import {
  REVIEW_BELOW, fmtDateTime, hitOf, looksLikePlate, normalisePlate,
} from '../vehicle-data';

export default function CheckReads({ reads, watchIndex, corrections, onCorrect }) {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState(null);

  // Lowest confidence first: the worst read is the one most likely to be wrong,
  // and an operator who only has ten minutes should spend them there.
  const queue = useMemo(
    () => reads
      .filter((r) => r.confidence != null && r.confidence < REVIEW_BELOW)
      .sort((a, b) => a.confidence - b.confidence),
    [reads],
  );

  const done = queue.filter((r) => corrections[r.id]).length;
  const current = queue[Math.min(index, Math.max(0, queue.length - 1))] || null;
  const value = draft ?? (current?.plate || '');
  const valid = !value || looksLikePlate(value);

  const advance = () => { setDraft(null); setIndex((i) => Math.min(i + 1, queue.length - 1)); };

  const confirm = () => {
    if (!current) return;
    onCorrect(current.id, normalisePlate(value));
    advance();
  };

  if (!queue.length) {
    return (
      <Panel bodyClass="p-0" icon={ScanLine} title="Review queue">
        <Empty
          body={`Nothing the model scored under ${REVIEW_BELOW}% is waiting. Reads land here automatically when the OCR confidence falls below that line.`}
          icon={Check}
          title="Queue is clear"
        />
      </Panel>
    );
  }

  const hit = current ? hitOf(current, watchIndex) : null;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(240px,300px)]">
      <Panel
        bodyClass="p-4"
        icon={ScanLine}
        right={
          <span className="text-micro font-semibold text-fg-subtle">
            {index + 1} of {queue.length}
          </span>
        }
        title="Verify this read"
      >
        {current ? (
          <div className="flex flex-col gap-4">
            {/* Side by side: what the camera saw, and what the model made of
                it. The comparison is the task, so nothing else sits between. */}
            <div className="grid gap-4 sm:grid-cols-2">
              <figure className="min-w-0">
                <figcaption className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle">
                  Camera snapshot
                </figcaption>
                <PlateThumb
                  alt={`Raw snapshot from ${current.cameraLabel}`}
                  className="h-[168px] w-full"
                  uri={current.snapshot}
                />
              </figure>

              <div className="min-w-0">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle">AI reading</p>
                <div className="flex h-[168px] flex-col justify-center gap-3 rounded-lg border border-line bg-surface-sunken px-4">
                  <Plate size="lg" value={current.aiPlate} />
                  <Confidence value={current.confidence} />
                  <p className="text-[10.5px] leading-relaxed text-fg-subtle">
                    Below the {REVIEW_BELOW}% line, so this read is not trusted for reports
                    or watchlist matching until someone confirms it.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-[11.5px] font-semibold text-fg-secondary" htmlFor="plate-fix">
                Corrected plate
              </label>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  className={`min-w-[220px] flex-1 rounded-lg border bg-surface px-3 py-2 text-center font-mono text-[17px] font-bold uppercase tracking-[0.14em] text-fg focus:outline-none focus:ring-2 ${
                    valid ? 'border-line focus:border-brand focus:ring-brand/25' : 'border-danger focus:ring-danger/25'
                  }`}
                  id="plate-fix"
                  onChange={(e) => setDraft(e.target.value.toUpperCase())}
                  placeholder="MH12AB1234"
                  value={value}
                />
                <button
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-small font-semibold text-white transition hover:bg-brand-hover disabled:opacity-50"
                  disabled={!value || !valid}
                  onClick={confirm}
                  type="button"
                >
                  <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Confirm
                </button>
                <button
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken"
                  onClick={advance}
                  type="button"
                >
                  <SkipForward className="h-3.5 w-3.5" strokeWidth={2} />
                  Skip
                </button>
                {current.corrected ? (
                  <button
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-small font-semibold text-fg-muted transition hover:border-danger-line hover:bg-danger-soft hover:text-danger-ink"
                    onClick={() => { onCorrect(current.id, null); setDraft(null); }}
                    type="button"
                  >
                    <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
                    Undo
                  </button>
                ) : null}
              </div>

              {/* Warn, do not block: a plate that does not fit the Indian
                  pattern may still be exactly what is on the vehicle -- a
                  trade plate, a foreign registration -- and the operator is
                  looking at the photograph. */}
              {!valid ? (
                <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-warning-ink">
                  <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                  That is not the usual Indian plate shape. Confirm anyway if it matches the photo.
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-line-subtle pt-3 text-[10.5px] text-fg-subtle">
              <span>{current.cameraLabel}</span>
              <span>{fmtDateTime(current.at)}</span>
              <WatchBadge hit={hit} />
              {current.corrected ? (
                <span className="font-semibold text-info-ink">Already corrected to {current.plate}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </Panel>

      <div className="flex flex-col gap-4">
        <Panel bodyClass="p-3" icon={Info} title="Queue">
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] font-extrabold leading-none tabular-nums text-fg">{queue.length - done}</span>
            <span className="text-[11px] text-fg-muted">left to check</span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-success transition-[width]"
              style={{ width: `${queue.length ? (done / queue.length) * 100 : 0}%` }}
            />
          </div>
          <p className="mt-1.5 text-[10.5px] text-fg-subtle">{done} corrected this session</p>

          <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-line bg-surface-sunken px-2.5 py-2 text-[10px] leading-relaxed text-fg-muted">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span>
              Corrections are held on this browser. The ANPR service has no endpoint to write a
              fix back to and no training loop to feed, so a correction improves what the other
              tabs show — not what the model does next time.
            </span>
          </p>
        </Panel>

        <Panel bodyClass="p-2" count={queue.length} icon={ScanLine} title="Up next">
          <ul className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
            {queue.map((r, i) => (
              <li key={r.id}>
                <button
                  className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition ${
                    i === index ? 'border-brand bg-brand-soft' : 'border-transparent hover:border-line hover:bg-surface-sunken'
                  }`}
                  onClick={() => { setIndex(i); setDraft(null); }}
                  type="button"
                >
                  {corrections[r.id]
                    ? <Check className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2.5} />
                    : <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-disabled" strokeWidth={2} />}
                  <span className="min-w-0 flex-1">
                    <Plate size="sm" value={r.plate} />
                    <span className="mt-0.5 block truncate text-[10px] text-fg-subtle">{r.cameraLabel}</span>
                  </span>
                  <span className="shrink-0 text-[10.5px] font-bold tabular-nums text-danger-ink">{r.confidence}%</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
