import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, FileText, Loader2, Save, VideoOff } from 'lucide-react';
import logo from '@/assets/drishyam-logo.svg';
import { Button } from '@/core/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/core/ui/dialog';
import { ErrorState, LoadingState } from '@/core/ui/states';
import { reportService } from '@/core/services/reports';
import ReportBody from './ReportBody';
import { scopeCameraWarning } from './scope-cameras';
import { fmtPeriod, nf, typeMeta } from './report-vocabulary';

/** The scope the service wants: "all" is the absence of a filter, not a value. */
function scopeOf(siteId, groupId) {
  return {
    siteId: siteId === 'all' ? undefined : siteId,
    groupId: groupId === 'all' ? undefined : groupId,
  };
}

/**
 * The report, before it is a report.
 *
 * Generate used to leave the hub for /reports/view, which meant losing the
 * filter row and the library to look at one answer — and coming back with the
 * browser's Back button if it was the wrong one. The document here is the one
 * the route and the PDF render (ReportBody), so what is reviewed is what gets
 * saved; only the frame changed.
 *
 * Nothing is written until "Save to Recent Reports". The dialog closes on save
 * and hands the row back for the table behind it to show, rather than
 * navigating away — the common next move after saving one report is generating
 * another.
 */
export function ReportPreviewDialog({ open, onClose, type, days, siteId, groupId, scopeCameras, onSaved }) {
  const navigate = useNavigate();

  const [payload, setPayload] = useState(null);
  const [state, setState] = useState('loading');   // loading | ready | error
  const [busy, setBusy] = useState(null);          // 'save' | 'pdf'
  const [error, setError] = useState('');

  const meta = typeMeta(type);
  const TypeIcon = meta.icon;
  const noCameras = scopeCameras === 0;

  const load = useCallback(async () => {
    setState('loading');
    setError('');
    // A scope with no cameras has no report in it, so there is no request to
    // make. The hub disables the button for this case; the check is repeated
    // here so the dialog cannot be opened into an empty query by a caller that
    // forgot to look — the request that comes back a page of zeroes is worse
    // than no request at all.
    if (scopeCameras === 0) {
      setError(scopeCameraWarning({ count: 0, siteId, groupId }));
      setState('error');
      return;
    }
    try {
      const res = await reportService.preview({ type, days, ...scopeOf(siteId, groupId) });
      // `preview` unwraps to `data.report`, so a reachable server that answers
      // with a different shape — or with nothing for this scope — resolves to
      // undefined rather than throwing. Rendering that gave a dialog that
      // opened empty and said nothing about why, which is worse than an error.
      if (!res) {
        setError('The server did not return a report for these filters. Try a wider period or a different scope.');
        setState('error');
        return;
      }
      setPayload(res);
      setState('ready');
    } catch (e) {
      setError(
        e?.response?.data?.message
        || (e?.response ? `The report service answered ${e.response.status}.` : 'Could not reach the report service.'),
      );
      setState('error');
    }
  }, [type, days, siteId, groupId, scopeCameras]);

  // Only while open: a dialog that is not on screen must not be querying, and
  // reopening it after the filters changed has to ask the question again.
  useEffect(() => {
    if (!open) { setPayload(null); setState('loading'); setError(''); return; }
    load();
  }, [open, load]);

  const save = async () => {
    setBusy('save');
    try {
      const res = await reportService.create({ type, days, scope: scopeOf(siteId, groupId) });
      onSaved?.(res.report);
      onClose();
    } catch (e) {
      setError(e?.response?.data?.message || 'Could not save this report.');
    } finally { setBusy(null); }
  };

  const pdf = async () => {
    setBusy('pdf');
    try {
      // One argument: the service builds the query string from it and names
      // the file from the Content-Disposition the server sends back.
      await reportService.downloadPreviewPdf({ type, days, ...scopeOf(siteId, groupId) });
    } catch { setError('Could not build the PDF. Try again in a moment.'); }
    finally { setBusy(null); }
  };

  const openFullView = () => {
    const p = new URLSearchParams({ type, days: String(days) });
    if (siteId !== 'all') p.set('siteId', siteId);
    if (groupId !== 'all') p.set('groupId', groupId);
    onClose();
    navigate(`/reports/view?${p.toString()}`);
  };

  // Period and scope — the same line the full view puts under its title.
  const cameraCount = payload?.scope?.cameraCount ?? 0;
  const subtitle = payload
    ? [
      fmtPeriod(payload.from, payload.to),
      payload.scope?.siteName,
      `${nf(cameraCount)} camera${cameraCount === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ')
    : `Last ${days} days`;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[calc(var(--app-vh)*0.92)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        {/* A letterhead, because that is what this becomes. The document the
            operator is about to save, send or print carries the Drishyam mark
            at its head, so the preview shows the mark too rather than making
            them imagine it. `gap-0` because the two rows set their own
            spacing, and `pr-10` on the first so the chip clears the dialog's
            close button. */}
        <DialogHeader className="shrink-0 gap-0 border-b border-line p-5">
          <div className="flex items-center gap-2.5 pr-10">
            <img src={logo} alt="" aria-hidden className="h-7 w-auto shrink-0" />
            <span className="text-body font-bold tracking-tight text-fg">Drishyam</span>
            <span className="ml-auto shrink-0 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-caption font-semibold text-fg-muted">
              Preview · not saved
            </span>
          </div>

          <div className="mt-3 flex items-start gap-3 border-t border-line-subtle pt-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
              <TypeIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="truncate">{meta.label}</DialogTitle>
              <DialogDescription className="mt-1 truncate">{subtitle}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* The document scrolls inside the frame, so the header and the
            actions stay put while a long report moves under them. */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-surface-app p-5">
          {state === 'loading' ? (
            <LoadingState message="Building the report…" className="py-16" />
          ) : state === 'error' ? (
            <ErrorState
              icon={noCameras ? VideoOff : undefined}
              title={noCameras ? 'No cameras in this scope' : 'Preview unavailable'}
              description={error}
              // Nothing to retry when the scope is empty — the answer will not
              // change until a different site is picked, behind this dialog.
              onRetry={noCameras ? undefined : load}
            />
          ) : (
            <>
              {/* A save or PDF that failed — the document is still good, so it
                  stays on screen with the problem above it. */}
              {error && (
                <p className="mb-4 rounded-lg border border-danger-line bg-danger-soft p-2.5 text-small text-danger-ink">
                  {error}
                </p>
              )}
              <ReportBody
                report={payload}
                className="pb-0"
                // Leaving for the clip closes the dialog first: coming back
                // from Playback to a modal over a stale page would be worse
                // than coming back to the library.
                onOpenClip={(i) => {
                  onClose();
                  navigate(`/playback?monitorId=${encodeURIComponent(i.monitorId)}&t=${encodeURIComponent(i.firstSeen)}`);
                }}
              />
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-row flex-wrap items-center gap-2 border-t border-line p-4 sm:justify-between">
          {/* Disabled for an empty scope too: the full view would re-ask the
              same unanswerable question from its own route. */}
          <Button variant="ghost" onClick={openFullView} disabled={noCameras}>
            <ExternalLink className="h-4 w-4" />
            Open full view
          </Button>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button variant="outline" onClick={pdf} disabled={state !== 'ready' || busy === 'pdf'}>
              {busy === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {busy === 'pdf' ? 'Building PDF…' : 'Download PDF'}
            </Button>
            <Button onClick={save} disabled={state !== 'ready' || busy === 'save'}>
              {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save to Recent Reports
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ReportPreviewDialog;
