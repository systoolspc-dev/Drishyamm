/**
 * The "Entry line" tool inside zone mode: place a counting line on the camera
 * already on screen, without leaving the zone being edited.
 *
 * An operator drawing a zone on a camera that looks at a doorway is the
 * person best placed to say "count everyone through here too". Sending them
 * to gate mode for that meant a different page for the same picture. This is
 * the same line, the same service and the same save as gate mode (both go
 * through useGateDraft) -- only the frame is smaller.
 *
 * It stays MOUNTED while the canvas shows the zone or Live, and only renders
 * while `visible`, so flipping between tools does not throw away a line that
 * has been moved but not saved. It is keyed by camera: another camera is
 * another gate.
 *
 * The line saves on its own button, not with the zone: it is written to the
 * footfall service, not to the zone record, and saving a zone should never
 * start or stop a gate as a side effect.
 */
import { useEffect } from 'react';
import {
  ArrowDownUp, CircleAlert, Loader2, RefreshCw, Save,
} from 'lucide-react';
import { Toggle } from '../components/bits';
import { flipDirection } from '../gate-model';
import CleanFeed from './CleanFeed';
import GateCanvas from './GateCanvas';
import { Stat } from './GateEditor';
import { useGateDraft } from './useGateDraft';

export default function GateLineEditor({
  monitorId, cameraName, gate, others, onSaved, onDirty, visible, footfallDown,
}) {
  const {
    draft, set, baseline, known, dirty, saving, result, save,
  } = useGateDraft({ gate, cameraName, onSaved });
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  if (!visible) return null;

  const note = result?.error || result?.message;

  return (
    <>
      <GateCanvas
        direction={draft.direction}
        label={`Counting line for ${cameraName}`}
        line={draft.line}
        media={monitorId ? <CleanFeed monitorId={monitorId} /> : null}
        onChange={(line) => set({ line })}
        others={others}
      />

      {!known ? (
        <p className="mt-2 flex items-start gap-1.5 text-body leading-relaxed text-warning-ink">
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
          {footfallDown
            ? 'The footfall service is not responding, so the line cannot be saved right now. The camera is not the problem; try again in a moment.'
            : 'The footfall service does not list this camera yet, so the line cannot be saved. It appears once the camera is registered with the AI service.'}
        </p>
      ) : (
        <div className="mt-2 rounded-lg border border-line bg-surface-sunken p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-body font-semibold text-fg-secondary" htmlFor="line-on">
              <Toggle checked={draft.enabled} id="line-on" label="Count footfall on this line" onChange={(v) => set({ enabled: v })} />
              Count footfall
            </label>
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-body font-semibold text-fg-muted transition hover:border-brand/40 hover:text-brand-ink"
              onClick={() => set({ direction: flipDirection(draft.direction) })}
              type="button"
            >
              <ArrowDownUp className="h-3.5 w-3.5" strokeWidth={2.25} />
              Swap IN side
            </button>
            <button
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-body font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-50"
              disabled={saving || !dirty}
              onClick={save}
              type="button"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" strokeWidth={2} />}
              {dirty ? 'Save line' : 'Line saved'}
            </button>
          </div>

          {/* The check: today's crossings on this camera, straight from the
              footfall service, so a newly placed line can be watched filling. */}
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-micro font-bold uppercase text-fg-subtle">Footfall today</span>
            {baseline.enabled ? (
              <button
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-small font-semibold text-fg-muted transition hover:bg-surface hover:text-brand-ink"
                onClick={onSaved}
                title="Re-read today's counts from the footfall service"
                type="button"
              >
                <RefreshCw className="h-3 w-3" strokeWidth={2.25} />
                Refresh
              </button>
            ) : null}
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <Stat label="In" tone="text-success-ink" value={baseline.enabled ? gate?.in : null} />
            <Stat label="Out" tone="text-fg-secondary" value={baseline.enabled ? gate?.out : null} />
            <Stat label="Net inside" tone="text-brand-ink" value={baseline.enabled ? gate?.net : null} />
          </div>
          {!baseline.enabled ? (
            <p className="mt-1.5 text-small text-fg-subtle">Counts start once the line is saved with footfall on.</p>
          ) : null}
        </div>
      )}

      {note ? (
        <p className={`mt-2 text-body leading-relaxed ${result?.error ? 'text-warning-ink' : 'text-success-ink'}`} role="status">{note}</p>
      ) : null}
    </>
  );
}
