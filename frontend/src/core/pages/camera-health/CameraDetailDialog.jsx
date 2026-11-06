import { useNavigate } from 'react-router-dom';
import { Copy, MonitorPlay, RefreshCw, VideoOff, Zap } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { Button } from '@/core/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/core/ui/dialog';
import { StatusBadge } from '@/core/ui/status-badge';
import { useSnapshot } from '@/core/hooks/useSnapshot';
import { COLUMNS, csvValue } from './health-columns';
import {
  bucketMeta,
  bucketOf,
  DASH,
  engineState,
  fmtTimestampFull,
} from './health-vocabulary';

/** Every reading except the two the dialog's own header already shows. */
const METRICS = COLUMNS.filter((c) => c.id !== 'camera' && c.id !== 'status');

/**
 * The value for one metric row.
 *
 * `csvValue` is the single declaration of what a column's plain value is, so
 * the dialog reads from it rather than growing a second set of formatters that
 * could disagree with the table. The one exception is Last Update, which the
 * CSV renders as a machine-readable ISO string — correct in a spreadsheet,
 * unreadable in a dialog.
 */
function detailValue(camera, columnId) {
  if (columnId === 'lastUpdate') return fmtTimestampFull(camera.lastUpdate);
  return csvValue(camera, columnId) || DASH;
}

/**
 * One camera, in full.
 *
 * The table can only ever show the columns that fit, and on a tablet that is
 * two of them. This is the page's answer to "what is actually wrong with THIS
 * camera": every reading the health payload carries, the engine's own words
 * for the state, and the three actions worth taking — in one place, reached by
 * clicking the camera's name.
 *
 * It takes a live camera object: the caller looks the row up again on each
 * poll, so an operator who hits Reconnect watches the status change here
 * rather than closing the dialog to find out whether it worked.
 */
export function CameraDetailDialog({ camera, open, onClose, onAction, busy }) {
  const navigate = useNavigate();

  // Hooks run before the early return, and `useSnapshot(null)` is the hook's
  // own "don't fetch" signal — so a closed dialog costs no recorder session.
  const online = camera ? bucketOf(camera) === 'online' : false;
  const snap = useSnapshot(open && online ? camera.monitorId : null);

  if (!camera) return null;

  const state = engineState(camera.status);
  const meta = bucketMeta(state.bucket);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[calc(var(--app-vh)*0.9)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            <span className="grid h-24 w-full shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-surface-muted sm:h-20 sm:w-32">
              {snap?.url ? (
                <img
                  src={snap.url}
                  alt={`Latest still from ${camera.name}`}
                  className={cn('h-full w-full object-cover', snap.stale && 'opacity-60')}
                />
              ) : (
                <VideoOff className="h-5 w-5 text-fg-disabled" aria-hidden />
              )}
            </span>

            <div className="min-w-0">
              <DialogTitle className="truncate">{camera.name}</DialogTitle>
              <p className="mt-1 truncate text-caption font-medium uppercase tracking-wide text-fg-muted">
                {camera.monitorId}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge status={meta.status} label={meta.label} size="sm" />
                <span className="text-small text-fg-secondary">{state.headline}</span>
              </div>
              {/* The engine's reason when it has one, our generic advice when
                  it does not — never both, and never a blank line. */}
              <p className="mt-1.5 text-small leading-relaxed text-fg-muted">
                {camera.reason || state.action}
              </p>
            </div>
          </div>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line bg-surface-sunken p-4 sm:grid-cols-3">
          {METRICS.map((column) => (
            <div key={column.id} className="min-w-0">
              {/* The column's own help text as the tooltip, so the words here
                  are the words the guide dialog uses. */}
              <dt
                className="truncate text-caption font-semibold uppercase tracking-wide text-fg-muted"
                title={column.help}
              >
                {column.label}
              </dt>
              <dd className="mt-0.5 truncate text-body tabular-nums text-fg" title={detailValue(camera, column.id)}>
                {detailValue(camera, column.id)}
              </dd>
            </div>
          ))}
        </dl>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => navigator.clipboard?.writeText(camera.monitorId)}
          >
            <Copy className="h-4 w-4" />
            Copy camera ID
          </Button>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => onAction(camera, 'keyframe')} disabled={busy}>
              <Zap className="h-4 w-4" />
              Clear freeze
            </Button>
            <Button variant="outline" onClick={() => onAction(camera, 'heal')} disabled={busy}>
              <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
              Reconnect
            </Button>
            <Button onClick={() => navigate(`/live?monitor=${encodeURIComponent(camera.monitorId)}`)}>
              <MonitorPlay className="h-4 w-4" />
              Open in Live View
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default CameraDetailDialog;
