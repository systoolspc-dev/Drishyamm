import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/core/ui/dialog';
import { Button } from '@/core/ui/button';
import { toneClass } from '@/core/ui/tone';

/**
 * The one confirm dialog for every destructive action in the app.
 *
 * Before this, "delete" was implemented three different ways in Camera Setup
 * alone — a bare `window.confirm()` in Sites, and two independently
 * copy-pasted dialog components in Devices and Cameras with near-identical
 * markup. A destructive action should look and behave the same everywhere,
 * so an operator's caution transfers from one page to the next instead of
 * resetting.
 *
 *   <ConfirmDialog
 *     open={confirming} onOpenChange={setConfirming}
 *     title="Delete camera"
 *     description={<>Delete <b>{camera.name}</b>? This stops its stream and cannot be undone.</>}
 *     confirmLabel="Delete"
 *     onConfirm={() => deleteCamera(camera.id)}
 *   />
 *
 * `onConfirm` may return a promise — the dialog shows a busy state on the
 * confirm button and stays open until it resolves, closing itself on
 * success. A thrown/rejected `onConfirm` leaves the dialog open with the
 * error message shown inline, so the operator doesn't lose their place.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleConfirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await onConfirm?.();
      onOpenChange?.(false);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange?.(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${toneClass(tone, 'soft')}`}>
              <TriangleAlert className="h-5 w-5" strokeWidth={2} />
            </span>
            <div className="min-w-0 pt-0.5">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription className="mt-1">{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>

        {error && (
          <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-small font-medium text-danger-ink">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === 'danger' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ConfirmDialog;
