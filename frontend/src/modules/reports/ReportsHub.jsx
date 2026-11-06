/**
 * ReportsHub.jsx — the report library.
 *
 * Two things, in the order they are used: ONE row that says what report to
 * make and makes it, and the reports your account already made.
 *
 * It used to be three, and the middle one was an eight-card grid of report
 * types. The grid drew every type at full size on every visit — including the
 * seven you were not there for — and between it and a four-field filter card
 * the saved-reports table started below the fold. The types now live in a
 * searchable picker in the filter row (ReportTypePicker), which is the only
 * place the choice is made, so the table is the page.
 *
 * Generating OPENS A PREVIEW rather than saving straight away. Saving first
 * would fill the library with reports nobody asked to keep — you look, then
 * you save. That used to be a sentence of permanent headline text; it is now
 * the tooltip on the picker's info icon, next to the button it describes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Download, FileBarChart, Loader2, MoreVertical,
  RefreshCw, RotateCcw, Search, Sparkles, Trash2, TriangleAlert, VideoOff,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import { EmptyState, LoadingState } from '@/core/ui/states';
import { OperationsPage, PageHeader, PageContent } from '@/core/layout/OperationsPage';
import { HeaderInfo } from '@/core/ui/header-info';
import { BRAND_SHEEN, toneClass } from '@/core/ui/tone';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import { siteService } from '@/core/services/site';
import { cameraGroupService } from '@/core/services/cameraGroup';
import { reportService } from '@/core/services/reports';
import ReportPreviewDialog from './ReportPreviewDialog';
import ReportTypePicker from './ReportTypePicker';
import { scopeCameraCount, scopeCameraWarning } from './scope-cameras';
import { fmtPeriod, fmtStamp, nf, PERIODS, REPORT_TYPES, typeMeta } from './report-vocabulary';

const PAGE_SIZE = 8;

/** Label above a filter control. One place, so the four cannot drift apart. */
function Field({ label, children }) {
  return (
    <div className="min-w-[160px] flex-1">
      <label className="mb-1.5 block text-caption font-semibold text-fg-muted">{label}</label>
      {children}
    </div>
  );
}

/** Status pill. "Generating" is neutral, not blue — blue means a category. */
function StatusPill({ status }) {
  const map = {
    ready: { tone: 'success', label: 'Ready' },
    generating: { tone: 'neutral', label: 'Generating' },
    failed: { tone: 'danger', label: 'Failed' },
  };
  const s = map[status] || map.ready;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption font-semibold',
      toneClass(s.tone, 'soft'))}>
      <span className={cn('h-1.5 w-1.5 rounded-full', toneClass(s.tone, 'dot'),
        status === 'generating' && 'animate-pulse')} />
      {s.label}
    </span>
  );
}

export default function ReportsHub() {
  const navigate = useNavigate();

  // The filter row parameterises the NEXT report you make, and nothing else.
  // It used to do double duty — the same four fields narrowed the saved list
  // too, behind an Apply button — which is why picking a type to GENERATE also
  // silently hid most of the table. The table now owns its own filter, down in
  // its toolbar where the rows it hides are visible.
  const [days, setDays] = useState(7);
  const [siteId, setSiteId] = useState('all');
  const [groupId, setGroupId] = useState('all');
  const [reportType, setReportType] = useState('ai_events');

  // The saved list's own filter.
  const [listType, setListType] = useState('all');

  const [sites, setSites] = useState([]);
  const [groups, setGroups] = useState([]);
  // Whether GET /groups came back at all. An empty `groups` means "this site
  // has no cameras" only if it did — a failed catalogue request must not be
  // read as a site with nothing on it, or a backend hiccup disables Generate.
  const [groupsLoaded, setGroupsLoaded] = useState(false);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    siteService.list()
      .then((r) => setSites(r?.sites || r?.data || (Array.isArray(r) ? r : [])))
      .catch(() => setSites([]));
    cameraGroupService.getGroups()
      .then((r) => { setGroups(Array.isArray(r) ? r : (r?.groups || [])); setGroupsLoaded(true); })
      .catch(() => { setGroups([]); setGroupsLoaded(false); });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await reportService.list({
        page, limit: PAGE_SIZE, type: listType, q: query || undefined,
      });
      setRows(res.reports || []);
      setTotal(res.total || 0);
    } catch (e) {
      setError(e?.response?.data?.message || 'Could not load your reports.');
    } finally {
      setLoading(false);
    }
  }, [page, listType, query]);

  useEffect(() => { load(); }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const visibleGroups = siteId === 'all' ? groups : groups.filter((g) => g.siteId === siteId);

  // The preview opens over the page, not instead of it: the filter row stays
  // put behind the dialog, so a wrong answer is one Close and one field away
  // from the right one rather than a Back button and a re-pick.
  const [previewOpen, setPreviewOpen] = useState(false);

  // Cameras the chosen scope actually covers, checked BEFORE the button rather
  // than after the request. A site created in Camera Setup minutes ago has
  // none, and a report over it comes back a full document of honest zeroes
  // with nothing on it to say why — so the row says why instead, and the
  // button that would have asked the question is turned off.
  //
  // `null` is "cannot tell yet" (catalogue still in flight, or it failed), and
  // that never blocks: the server is the backstop for the cases the browser
  // cannot see.
  const scopeCameras = useMemo(
    () => scopeCameraCount({ sites, groups, siteId, groupId, groupsLoaded }),
    [sites, groups, siteId, groupId, groupsLoaded],
  );
  const scopeWarning = scopeCameraWarning({ count: scopeCameras, siteId, groupId });
  const noCameras = scopeCameras === 0;

  const filtersActive = days !== 7 || siteId !== 'all' || groupId !== 'all' || reportType !== 'ai_events';

  const reset = () => {
    setDays(7); setSiteId('all'); setGroupId('all'); setReportType('ai_events');
  };

  const remove = async (row) => {
    setBusyId(row.id);
    try { await reportService.remove(row.id); await load(); }
    catch { setError('Could not delete that report.'); }
    finally { setBusyId(null); }
  };

  const download = async (row, format = 'pdf') => {
    setBusyId(row.id);
    try {
      if (format === 'csv') await reportService.downloadCsv(row.id, row.name);
      else await reportService.downloadPdf(row.id, row.name);
    } catch { setError(`Could not download that report as ${format.toUpperCase()}.`); }
    finally { setBusyId(null); }
  };

  const rerun = async (row) => {
    setBusyId(row.id);
    try { await reportService.rerun(row.id); await load(); }
    catch { setError('Could not re-run that report.'); }
    finally { setBusyId(null); }
  };

  const periodLabel = useMemo(
    () => PERIODS.find((p) => p.days === days)?.label || `Last ${days} days`,
    [days],
  );

  return (
    // The shared Operations frame, so the content edge sits exactly where Live
    // View, Playback, Activity and Event Log put theirs. This page used to
    // centre itself in a 1340px cap, which left it indented from every
    // neighbouring page on a wide screen.
    <OperationsPage>
      {/* No action in the header. "Create Report" used to sit here and open a
          dialog that asked for a type, a period and a scope — the same four
          answers the generate row below now takes inline, against a table of
          what those answers produced last time. Two ways to start the same
          job, one of them hiding the page behind a modal. The row won. */}
      <PageHeader
        icon={FileBarChart}
        title="Reports"
        description="Generate and export reports from your surveillance data. Pick a period, a scope and a report type, preview it, then save the ones worth keeping."
        descriptionAs="tooltip"
      />

      {/* Not `scroll`: the frame stays fixed and the TABLE scrolls, so the
          generate row and the table's toolbar stay put while the rows move
          under them. */}
      <PageContent className="gap-4">
      {/* The generate row: what to make, over what, and the button that
          makes it. Four fields and one action — the Apply button that used to
          sit here had nothing to apply once the saved list stopped reading
          these fields. */}
      <section className="shrink-0 rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Period">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
              <SelectContent align="start" position="popper" side="bottom" sideOffset={8}>
                {PERIODS.map((p) => <SelectItem key={p.key} value={String(p.days)}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Site">
            <Select value={siteId} onValueChange={(v) => { setSiteId(v); setGroupId('all'); }}>
              <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
              <SelectContent align="start" position="popper" side="bottom" sideOffset={8}>
                <SelectItem value="all">All sites</SelectItem>
                {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Camera group">
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
              <SelectContent align="start" position="popper" side="bottom" sideOffset={8}>
                <SelectItem value="all">All cameras</SelectItem>
                {visibleGroups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>

          {/* The eight cards, in one control. */}
          <Field label="Report type">
            <ReportTypePicker value={reportType} onChange={setReportType} />
          </Field>

          <div className="flex items-center gap-1.5">
            <Button
              onClick={() => setPreviewOpen(true)}
              disabled={noCameras}
              // The banner below carries the explanation; this is for the
              // pointer that lands on a dead button without reading it.
              title={noCameras ? scopeWarning : undefined}
            >
              <Sparkles className="h-4 w-4" />
              Generate preview
            </Button>
            {/* The sentence that used to be a permanent subheading, now beside
                the button it is actually about. */}
            <HeaderInfo
              label="Generate preview"
              ariaLabel="About generating a preview"
              side="bottom"
              text={noCameras
                ? scopeWarning
                : `Opens ${typeMeta(reportType).label} for ${periodLabel.toLowerCase()} using the filters on this row. Nothing is saved until you choose to save it.`}
            />
            {filtersActive ? (
              <Button variant="ghost" onClick={reset} className="px-2.5">
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
            ) : null}
          </div>
        </div>

        {/* Directly under the fields, so the reason sits with the controls that
            caused it rather than at the top of the page. Warning, not danger:
            nothing is broken and nothing failed — the scope is just empty, and
            the fix is one field away. `aria-live` because the row changes under
            a keyboard user who never sees the button grey out. */}
        {noCameras && (
          <p
            role="status"
            aria-live="polite"
            className="mt-3 flex items-start gap-2 rounded-lg border border-warning-line bg-warning-soft p-2.5 text-small font-medium text-warning-ink"
          >
            <VideoOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {scopeWarning}
          </p>
        )}
      </section>

      {/* Saved reports — the page's centre of gravity. `flex-1` with a
          `min-h-0` scroll region, so it takes every pixel the generate row
          leaves rather than starting below the fold behind a card grid. */}
      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface shadow-sm">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-section text-fg">Recent Reports</h2>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
              <Input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                placeholder="Search reports…"
                className="h-9 w-[220px] pl-8"
              />
            </div>
            {/* The table's own type filter. It used to live in the row above,
                where choosing a type to GENERATE also hid every saved report
                of a different type — two jobs, one control, no way to tell
                which one you had just done. */}
            <Select
              value={listType}
              onValueChange={(v) => { setListType(v); setPage(1); }}
            >
              <SelectTrigger className="h-9 w-[170px]" aria-label="Filter saved reports by type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" position="popper" side="bottom" sideOffset={8}>
                <SelectItem value="all">All types</SelectItem>
                {REPORT_TYPES.map((t) => <SelectItem key={t.type} value={t.type}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" className={BRAND_SHEEN} onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>

        {error && (
          <p className="mx-4 mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-danger-line bg-danger-soft p-2.5 text-small text-danger-ink">
            <TriangleAlert className="h-4 w-4 shrink-0" /> {error}
          </p>
        )}

        {loading && rows.length === 0 ? (
          <div className="grid min-h-0 flex-1 place-items-center p-10">
            <LoadingState message="Loading reports…" />
          </div>
        ) : rows.length === 0 ? (
          /* Minimal on purpose, and it points at the one row that does
             anything: the filters are right there, so the empty state's job is
             to say so and hand over the button, not to re-teach the page. */
          <div className="grid min-h-0 flex-1 place-items-center p-6">
            <EmptyState
              icon={FileBarChart}
              title={listType === 'all' && !query ? 'No reports saved yet' : 'No reports match that search'}
              description={
                listType === 'all' && !query
                  ? 'Set the period, scope and type in the row above, then Generate preview. Save the ones worth keeping and they land here.'
                  : 'Try a different type or search term.'
              }
              // No Generate button here. The one in the row above is three
              // inches up and already in view — a second copy of the page's
              // primary action, inside the thing it is meant to fill, reads
              // as a different action and is the first thing to go stale when
              // the real one moves.
              action={
                listType === 'all' && !query ? null : (
                  <Button variant="outline" onClick={() => { setListType('all'); setQuery(''); setPage(1); }}>
                    <RotateCcw className="h-4 w-4" />
                    Clear search
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr className="border-y border-line bg-surface-sunken text-left">
                  {['Report Name', 'Type', 'Period', 'Created By', 'Created On', 'Status', ''].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  // Capitalised because it is rendered as a component; a
                  // lowercase `<meta.icon />` also reads as the HTML tag.
                  const TypeIcon = typeMeta(r.type).icon;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/reports/${r.id}`)}
                      className="cursor-pointer border-b border-line-subtle last:border-0 hover:bg-surface-sunken"
                    >
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2.5">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-brand-line bg-brand-soft text-brand">
                            <TypeIcon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-body font-semibold text-fg">{r.name}</span>
                            {r.summary && (
                              <span className="block text-caption text-fg-subtle">
                                {nf(r.summary.alerts)} needing attention · {r.summary.coverage}% coverage
                              </span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-small text-fg-muted">{r.typeLabel}</td>
                      <td className="px-4 py-3 text-small text-fg-muted">{fmtPeriod(r.from, r.to)}</td>
                      <td className="px-4 py-3 text-small text-fg-muted">{r.createdBy}</td>
                      <td className="px-4 py-3 text-small text-fg-muted">{fmtStamp(r.createdAt)}</td>
                      <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                      <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <span className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            title="Download PDF"
                            disabled={r.status !== 'ready' || busyId === r.id}
                            onClick={() => download(r, 'pdf')}
                            className="grid h-8 w-8 place-items-center rounded-lg text-fg-muted transition hover:bg-surface-muted disabled:opacity-40"
                          >
                            {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" className="grid h-8 w-8 place-items-center rounded-lg text-fg-muted transition hover:bg-surface-muted">
                                <MoreVertical className="h-4 w-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => navigate(`/reports/${r.id}`)}>Open</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => rerun(r)}>Re-run with today's data</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => download(r, 'pdf')} disabled={r.status !== 'ready'}>Download PDF</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => download(r, 'csv')} disabled={r.status !== 'ready'}>Download CSV</DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onClick={() => remove(r)}>
                                <Trash2 className="h-4 w-4" /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line p-4">
            <span className="text-small text-fg-muted">
              Showing {rows.length} of {nf(total)} report{total === 1 ? '' : 's'}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                className="grid h-8 w-8 place-items-center rounded-lg border border-line text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
                aria-label="Previous page"
              ><ChevronLeft className="h-4 w-4" /></button>
              {Array.from({ length: Math.min(5, pages) }, (_, i) => i + 1).map((n) => (
                <button
                  key={n} type="button" onClick={() => setPage(n)}
                  className={cn('h-8 w-8 rounded-lg border text-small font-semibold',
                    n === page ? 'border-brand bg-brand text-white' : 'border-line text-fg-secondary hover:bg-surface-sunken')}
                >{n}</button>
              ))}
              <button
                type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}
                className="grid h-8 w-8 place-items-center rounded-lg border border-line text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
                aria-label="Next page"
              ><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        )}
      </section>
      </PageContent>

      <ReportPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        type={reportType}
        days={days}
        siteId={siteId}
        groupId={groupId}
        // The button is already disabled for an empty scope; the dialog is told
        // the count as well so it refuses to ask the server rather than
        // trusting whoever opened it.
        scopeCameras={scopeCameras}
        // A saved report belongs in the table that is already on screen, so
        // reload it and leave the operator where they are.
        onSaved={() => { setPage(1); load(); }}
      />
    </OperationsPage>
  );
}
