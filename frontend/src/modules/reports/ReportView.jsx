/**
 * ReportView.jsx — one report, open.
 *
 * Serves two routes with one component, because they are the same document:
 *   /reports/view?type=…&days=…   a live preview, nothing saved yet
 *   /reports/:id                  a saved report, replayed from its frozen payload
 *
 * A saved report deliberately does NOT re-query: the copy a manager was sent
 * on Monday must still say on Friday what it said on Monday. "Re-run" is the
 * explicit way to ask for today's numbers.
 *
 * "Download PDF" is always the server-rendered document (GET /reports/:id/pdf,
 * or /reports/preview/pdf for a preview): the printed report carries event
 * records with stills and an evidence section that the screen does not.
 *
 * The document itself — which cards a type is made of, in the order its PDF
 * puts them — is ReportBody.jsx, shared with the preview dialog on the hub.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Download, FileText, Loader2, RefreshCw, Save,
} from 'lucide-react';
import { ErrorState, LoadingState } from '@/core/ui/states';
import { OperationsPage, PageHeader, PageContent } from '@/core/layout/OperationsPage';
import { Button } from '@/core/ui/button';
import { reportService } from '@/core/services/reports';
import ReportBody from './ReportBody';
import { fmtPeriod, fmtWhen, nf, typeMeta } from './report-vocabulary';

export default function ReportView() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [payload, setPayload] = useState(null);
  const [row, setRow] = useState(null);
  const [state, setState] = useState('loading');   // loading | ready | error
  const [busy, setBusy] = useState(null);          // 'save' | 'rerun' | 'csv' | 'pdf'
  const [error, setError] = useState('');

  const preview = !id;
  const type = params.get('type') || 'ai_events';
  const days = Number(params.get('days')) || 7;
  const siteId = params.get('siteId') || undefined;
  const groupId = params.get('groupId') || undefined;

  const load = useCallback(async () => {
    setState('loading');
    setError('');
    try {
      if (preview) {
        setPayload(await reportService.preview({ type, days, siteId, groupId }));
      } else {
        const res = await reportService.get(id);
        setRow(res.report);
        setPayload(res.payload);
      }
      setState('ready');
    } catch (e) {
      setError(e?.response?.data?.message || 'Could not load this report.');
      setState('error');
    }
  }, [preview, id, type, days, siteId, groupId]);

  useEffect(() => { load(); }, [load]);

  const meta = typeMeta(payload?.type || type);
  const TypeIcon = meta.icon;

  /** Keep a preview: the same question, saved with its answer. */
  const save = async () => {
    setBusy('save');
    try {
      const res = await reportService.create({
        type, days, scope: { siteId, groupId },
      });
      navigate(`/reports/${res.report.id}`, { replace: true });
    } catch (e) {
      setError(e?.response?.data?.message || 'Could not save this report.');
    } finally { setBusy(null); }
  };

  const rerun = async () => {
    setBusy('rerun');
    try {
      const res = await reportService.rerun(id);
      setRow(res.report);
      setPayload(res.payload);
    } catch (e) {
      setError(e?.response?.data?.message || 'Could not re-run this report.');
    } finally { setBusy(null); }
  };

  const csv = async () => {
    setBusy('csv');
    try { await reportService.downloadCsv(id, row?.name); }
    catch { setError('Could not download the CSV.'); }
    finally { setBusy(null); }
  };

  const pdf = async () => {
    setBusy('pdf');
    try {
      if (preview) await reportService.downloadPreviewPdf({ type, days, siteId, groupId }, `${meta.label} preview`);
      else await reportService.downloadPdf(id, row?.name);
    } catch { setError('Could not build the PDF. Try again in a moment.'); }
    finally { setBusy(null); }
  };

  const title = row?.name || meta.label;

  // Period · scope, and for a saved report when it was frozen and by whom. A
  // preview is live, so it carries no timestamp.
  const subtitle = useMemo(() => {
    if (!payload) return '';
    const n = payload.scope?.cameraCount ?? 0;
    const bits = [fmtPeriod(payload.from, payload.to)];
    if (payload.scope?.siteName) bits.push(payload.scope.siteName);
    bits.push(`${nf(n)} camera${n === 1 ? '' : 's'}`);
    if (!preview) bits.push(`saved ${fmtWhen(payload.generatedAt)}${row?.createdBy ? ` by ${row.createdBy}` : ''}`);
    return bits.join(' · ');
  }, [payload, row, preview]);

  if (state === 'loading') {
    return (
      <OperationsPage>
        <PageContent><LoadingState message="Building the report…" /></PageContent>
      </OperationsPage>
    );
  }
  if (state === 'error') {
    return (
      <OperationsPage>
        <PageContent><ErrorState title="Report unavailable" description={error} onRetry={load} /></PageContent>
      </OperationsPage>
    );
  }

  const onOpenClip = (i) => navigate(
    `/playback?monitorId=${encodeURIComponent(i.monitorId)}&t=${encodeURIComponent(i.firstSeen)}`,
  );

  return (
    // Same frame as the library and every other Operations page, so the
    // breadcrumb, title and cards all start on the shared content edge.
    <OperationsPage>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Link to="/reports" className="inline-flex items-center gap-1.5 text-small font-semibold text-brand-ink hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Reports
        </Link>
        <span className="text-fg-subtle">/</span>
        <span className="text-small text-fg-muted">{meta.label}</span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {preview ? (
            <Button variant="outline" size="sm" onClick={save} disabled={busy === 'save'}>
              {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save to library
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={rerun} disabled={busy === 'rerun'}>
                {busy === 'rerun' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Re-run
              </Button>
              <Button variant="outline" size="sm" onClick={csv} disabled={busy === 'csv'}>
                {busy === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                CSV
              </Button>
            </>
          )}
          {/* Same server-rendered document for a preview and a saved report;
              a preview's file is marked "not saved" on its first page. */}
          <Button size="sm" onClick={pdf} disabled={busy === 'pdf'}>
            {busy === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            {busy === 'pdf' ? 'Building PDF…' : 'Download PDF'}
          </Button>
        </div>
      </div>

      <PageHeader
        icon={TypeIcon}
        title={title}
        description={subtitle}
        actions={preview ? (
          <span className="hidden shrink-0 rounded-full border border-line bg-surface-muted px-2.5 py-1 text-caption font-semibold text-fg-muted sm:block">
            Preview · not saved
          </span>
        ) : null}
      />

      <PageContent scroll>
        {error && (
          <p className="mb-4 rounded-lg border border-danger-line bg-danger-soft p-2.5 text-small text-danger-ink">{error}</p>
        )}

        <ReportBody report={payload} onOpenClip={onOpenClip} />
      </PageContent>
    </OperationsPage>
  );
}
