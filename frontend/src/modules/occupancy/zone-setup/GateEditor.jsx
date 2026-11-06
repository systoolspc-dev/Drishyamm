/**
 * Gate mode of Zone Setup — one camera as a line-crossing counter.
 *
 * Same frame as zone mode (the rail on the left, two numbered halves) so the
 * page does not change shape under the operator when they switch from drawing
 * a zone to placing a gate on the same camera:
 *
 *   1  Place the line   draw or drag it at any angle; swap which side is IN
 *   2  Gate             counting on or off, and today's IN / OUT / net
 *
 * The footfall service is the only store for any of it. Nothing is cached on
 * this browser: a gate has to count identically whichever screen set it up.
 */
import { useEffect, useState } from 'react';
import {
  ArrowDownUp, CircleAlert, DoorOpen, Loader2, Save, Waypoints,
} from 'lucide-react';
import { OperationsPage, PageAction, PageContent } from '@/core/layout/OperationsPage';
import ConfirmDialog from '@/core/ui/confirm-dialog';
import Panel from '@/core/ui/panel';
import { GateGlyph, InfoTip, Toggle } from '../components/bits';
import { nfmt } from '../occupancy-data';
import { describeLine, flipDirection } from '../gate-model';
import CleanFeed from './CleanFeed';
import GateCanvas from './GateCanvas';
import {
  CanvasFrame, ResultNote, SetupGrid, SetupHeader, StepTitle,
} from './SetupChrome';
import { useGateDraft } from './useGateDraft';

export default function GateEditor({
  monitorId, cameraName, gate, others, rail, onCancel, onSaved, dirtyRef, flash, footfallDown,
}) {
  const {
    draft, set, baseline, known, dirty, saving, result, save, stop,
  } = useGateDraft({ gate, cameraName, onSaved });
  useEffect(() => { dirtyRef.current = dirty; }, [dirty, dirtyRef]);
  // `stop` no longer raises its own window.confirm -- asking is the caller's
  // job, so the rail can offer the same action from a row menu.
  const [confirming, setConfirming] = useState(false);

  return (
    <OperationsPage>
      <SetupHeader
        onCancel={onCancel}
        right={
          <>
            {known && baseline.enabled ? (
              <PageAction className="disabled:opacity-60" disabled={saving} onClick={() => setConfirming(true)} type="button">
                <DoorOpen className="h-3.5 w-3.5 text-danger" strokeWidth={2} />
                <span className="hidden sm:inline">Stop counting at this gate</span>
              </PageAction>
            ) : null}
            <button
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-brand px-3.5 text-body font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-60"
              disabled={saving || !known || !dirty}
              onClick={save}
              type="button"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" strokeWidth={2} />}
              <span className="hidden sm:inline">Save Gate</span>
              <span className="sm:hidden">Save</span>
            </button>
          </>
        }
      />

      <PageContent className="gap-3" scroll>
        <ResultNote flash={flash} result={result} />

        {!known ? (
          <p className="flex items-start gap-1.5 rounded-xl border border-warning-line bg-warning-soft px-3.5 py-2.5 text-body leading-relaxed text-warning-ink">
            <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
            {footfallDown ? (
              <span>
                The footfall service is not responding, so the gate for {cameraName} cannot be saved right now.
                The camera is not the problem; try again in a moment.
              </span>
            ) : (
              <span>
                The footfall service does not list {cameraName} yet, so there is nowhere to save a gate for it.
                It appears once the camera is registered with the AI service.
              </span>
            )}
          </p>
        ) : null}

        <SetupGrid
          rail={rail}
          center={(
            <Panel
              bodyClass="p-3 xl:overflow-y-auto"
              icon={Waypoints}
              right={
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-body font-semibold text-fg-muted transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink"
                  onClick={() => set({ direction: flipDirection(draft.direction) })}
                  type="button"
                >
                  <ArrowDownUp className="h-3.5 w-3.5" strokeWidth={2.25} />
                  Swap direction
                </button>
              }
              title={<StepTitle n={1} text="Place the line" />}
            >
              <CanvasFrame>
                <GateCanvas
                  direction={draft.direction}
                  label={`Counting line for ${cameraName}`}
                  line={draft.line}
                  media={<CleanFeed monitorId={monitorId} />}
                  onChange={(line) => set({ line })}
                  others={others}
                />
              </CanvasFrame>
              <p className="mt-2 flex items-center gap-1.5 text-body text-fg-subtle">
                Drag an end to turn the line · drag the line to move it · draw anywhere for a new one
                <InfoTip label="How to place the line">
                  Draw the line across the doorway, end to end, at whatever angle the doorway has on
                  the picture: only people crossing between its two ends are counted. Drag an end to
                  turn or stretch it, drag the line to move it, or focus an end and use the arrow keys
                  (Shift for bigger steps). Keep it away from where people stand and wait. Dashed
                  outlines are this camera&apos;s zones.
                </InfoTip>
              </p>
            </Panel>
          )}
          right={(
            <Panel bodyClass="p-3 xl:overflow-y-auto" icon={DoorOpen} title={<StepTitle n={2} text="Gate" />}>
              <div className="flex flex-col gap-3">
                <div>
                  <p className="flex items-center gap-1 text-body font-semibold text-fg-secondary">
                    Gate name
                    <InfoTip label="About the gate name">A gate is named after its camera: the footfall service stores no separate name.</InfoTip>
                  </p>
                  <p className="mt-1.5 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-body font-semibold text-fg">{cameraName}</p>
                </div>

                <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-body font-semibold text-fg-secondary">Counting</p>
                    <p className="mt-1 text-small leading-relaxed text-fg-subtle">
                      {draft.enabled
                        ? 'On. Everyone crossing the line is counted IN or OUT.'
                        : 'Off. The line is kept, but nothing is counted.'}
                    </p>
                  </div>
                  <Toggle checked={draft.enabled} id="gate-on" label="Counting" onChange={(v) => set({ enabled: v })} />
                </div>

                <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-body font-semibold text-fg-secondary">
                    <GateGlyph className="h-[18px] w-8 shrink-0 text-fg-muted" direction={draft.direction} line={draft.line} />
                    Crossing toward the arrow counts as IN
                    <InfoTip label="About direction">
                      People crossing the line toward the shaded, arrowed side add to IN; crossing the
                      other way adds to OUT. Swap direction flips which side that is.
                    </InfoTip>
                  </p>
                  <p className="mt-1 pl-[38px] text-small text-fg-subtle">{describeLine(draft.line)}</p>
                </div>

                <div>
                  <p className="text-micro font-bold uppercase text-fg-muted">Today, since midnight</p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Stat label="In" tone="text-success-ink" value={gate?.in} />
                    <Stat label="Out" tone="text-fg-secondary" value={gate?.out} />
                    <Stat label="Net inside" tone="text-brand-ink" value={gate?.net} />
                  </div>
                  {!baseline.enabled ? (
                    <p className="mt-1.5 text-small text-fg-subtle">Counts start once the gate is saved with counting on.</p>
                  ) : null}
                </div>
              </div>
            </Panel>
          )}
        />
      </PageContent>

      <ConfirmDialog
        confirmLabel="Stop counting"
        description={(
          <>
            Stop counting at <b>{cameraName}</b>? It disappears from the rail and from the
            Gate Activity Matrix, and nothing new is counted. Today&apos;s IN and OUT are kept in
            the history, and the line stays where you put it — setting this camera up as a gate
            again restores it.
          </>
        )}
        onConfirm={stop}
        onOpenChange={setConfirming}
        open={confirming}
        title="Stop counting at this gate"
      />
    </OperationsPage>
  );
}

export function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-2.5 py-2">
      <p className="text-small font-semibold text-fg-subtle">{label}</p>
      <p className={`mt-0.5 text-section font-extrabold leading-none tabular-nums ${tone}`}>{value == null ? '—' : nfmt(value)}</p>
    </div>
  );
}
