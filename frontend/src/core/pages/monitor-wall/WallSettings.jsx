// Wall settings — grid size, how the wall plays (rotation, offline cameras,
// audio), and the recorder-load check that keeps a wall from flooding an NVR.

import { Copy, Grid2x2, Save, Timer } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/core/ui/select';
import {
  GRID_OPTIONS, NVR_PULL_LIMIT, ROTATE_OPTIONS, capacity,
} from './model';

const SHOWN_RECORDERS = 5;

export default function WallSettings({
  draft, cameraCount, recorders,
  onChange, onResize, onSave, onSaveAsNew, saving, dirty,
}) {
  const gridId = `${draft.cols}x${draft.rows}`;
  const shown = recorders.slice(0, SHOWN_RECORDERS);
  const hidden = recorders.length - shown.length;

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-3.5 text-heading text-fg">Wall settings</h2>

      <div className="flex flex-col gap-3.5">
        <Select
          value={gridId}
          onValueChange={(id) => {
            const opt = GRID_OPTIONS.find((o) => o.id === id);
            if (opt) onResize(opt.cols, opt.rows);
          }}
        >
          <SelectTrigger size="sm" className="w-full text-body" aria-label="Grid size">
            <span className="flex items-center gap-2">
              <Grid2x2 className="h-3.5 w-3.5 text-fg-muted" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent position="popper">
            {GRID_OPTIONS.map((o) => {
              const tooSmall = capacity(o.cols, o.rows) < cameraCount;
              return (
                <SelectItem key={o.id} value={o.id} disabled={tooSmall} className="text-body">
                  {o.label}{tooSmall ? ' · too few tiles' : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Rotate pages"
            checked={draft.rotate}
            onChange={(v) => onChange({ rotate: v })}
          />
          <Select
            value={String(draft.rotateSeconds)}
            onValueChange={(v) => onChange({ rotateSeconds: Number(v) })}
            disabled={!draft.rotate}
          >
            <SelectTrigger size="sm" className="w-full text-body" aria-label="Rotation interval">
              <span className="flex items-center gap-2">
                <Timer className="h-3.5 w-3.5 text-fg-muted" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent position="popper">
              {ROTATE_OPTIONS.map((o) => (
                <SelectItem key={o.seconds} value={String(o.seconds)} className="text-body">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <ToggleRow
          label="Skip offline cameras"
          checked={draft.skipOffline}
          onChange={(v) => onChange({ skipOffline: v })}
        />
        <ToggleRow
          label="Audio from focused camera"
          checked={draft.focusAudio}
          onChange={(v) => onChange({ focusAudio: v })}
        />
      </div>

      <div className="my-3.5 h-px bg-line" />

      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-body font-semibold text-fg">Recorder load</h3>
        <span className="text-caption text-fg-subtle">limit {NVR_PULL_LIMIT}</span>
      </div>
      <p className="mb-3 text-caption text-fg-muted">
        Streams the wall pulls on its busiest page. Cameras past a recorder’s limit play as refreshing stills.
      </p>

      {recorders.length === 0 ? (
        <p className="text-small text-fg-muted">No cameras on the wall yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((r) => <RecorderRow key={r.groupId} {...r} rotate={draft.rotate} />)}
          {hidden > 0 && (
            <p className="text-caption text-fg-muted">
              and {hidden} more recorder{hidden === 1 ? '' : 's'}, each with fewer cameras on the wall
            </p>
          )}
        </div>
      )}

      <div className="mt-auto grid grid-cols-2 gap-2 border-t border-line pt-3.5">
        <button
          type="button"
          onClick={onSaveAsNew}
          disabled={saving}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-50"
        >
          <Copy className="h-3.5 w-3.5" />
          Save as new
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving || (!dirty && !!draft.id)}
          title={!dirty && draft.id ? 'No changes to save' : undefined}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-brand-line bg-brand/5 px-2 text-small font-semibold text-brand transition hover:bg-brand-soft disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? 'Saving…' : 'Save layout'}
        </button>
      </div>
    </section>
  );
}

function ToggleRow({ label, helper, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-body font-medium text-fg">{label}</p>
        {helper && <p className="mt-0.5 text-caption text-fg-muted">{helper}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-px h-[18px] w-[30px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${checked
          ? 'bg-brand'
          : 'bg-surface-muted ring-1 ring-inset ring-line-strong'}`}
      >
        <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full shadow-sm transition-[left] ${checked ? 'left-[14px] bg-white' : 'left-[2px] bg-fg-subtle'}`} />
      </button>
    </div>
  );
}

// `live` never passes the limit - the wall budgets each page. `peak` can,
// through the rotation handover, and that is the only red state left.
function RecorderRow({ name, detail, live, preview, peak, rotate }) {
  const over = peak > NVR_PULL_LIMIT;
  const atLimit = live >= NVR_PULL_LIMIT;
  // The bar is the page's own load, which is never over the limit - amber at
  // it, never red. Red belongs to the handover badge, the one real problem.
  const fill = atLimit ? 'bg-warning' : 'bg-success';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-small">
        <span className="min-w-0 truncate">
          <span className="font-semibold text-fg">{name}</span>
          {detail && <span className="ml-1.5 text-fg-muted">{detail}</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {over && (
            <span
              title={`When the wall changes page this recorder serves ${peak} streams for a moment, because the outgoing page is still pulling.`}
              className="rounded-full border border-danger-line bg-danger-soft px-1.5 text-micro normal-case tracking-normal text-danger-ink"
            >
              {peak} on page change
            </span>
          )}
          {atLimit && !rotate && <span className="rounded-full border border-warning-line bg-warning-soft px-1.5 text-micro normal-case tracking-normal text-warning-ink">At limit</span>}
          <span className={`font-semibold tabular-nums ${over ? 'text-danger-ink' : atLimit ? 'text-warning-ink' : 'text-fg-secondary'}`}>
            {live}/{NVR_PULL_LIMIT}
          </span>
        </span>
      </div>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${NVR_PULL_LIMIT}, minmax(0, 1fr))` }}>
        {Array.from({ length: NVR_PULL_LIMIT }, (_, i) => (
          <span key={i} className={`h-1.5 rounded-sm ${i < live ? fill : 'bg-surface-muted'}`} />
        ))}
      </div>
      {preview > 0 && (
        <p className="text-caption text-fg-muted">
          + {preview} more on this page as refreshing still{preview === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}
