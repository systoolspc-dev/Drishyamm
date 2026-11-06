import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2, ChevronDown, Download, FileText, Info, Loader2, RefreshCw, ScrollText, SearchX,
  Sheet as SheetIcon, ShieldQuestion, X,
} from 'lucide-react';
import { aiService } from '@/core/services/ai';
import { useGroups } from '@/core/hooks/useQueries';
import { useMediaQuery, BELOW_XL } from '@/core/hooks/useMediaQuery';
import {
  OperationsPage, PageAction, PageCard, PageContent, PageHeader,
} from '@/core/layout/OperationsPage';
import { EmptyState } from '@/core/ui/states';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/core/ui/sheet';
import { normalizeEvent } from '@/modules/ai-feed/aifeed/event-model';
import { ALL_SITES, useSiteStore } from '@/modules/employee-productivity/siteStore';
import EventDetail from './eventlog/EventDetail';
import LogFilterChips from './eventlog/LogFilterChips';
import LogFilters from './eventlog/LogFilters';
import LogQuickFilters from './eventlog/LogQuickFilters';
import LogTable from './eventlog/LogTable';
import SiteScopeNotice from './eventlog/SiteScopeNotice';
import {
  CONTINUOUS, CSV_COLUMNS, FETCH_LIMIT, REPORT_COLUMNS, SCROLL_CHUNK, SOURCE_META, csvValue, endOfDay,
  matchesQuery, normalizeActivityRow, rangeLabel, startOfDay, statusOf,
  severityLabel, todayInput,
} from './eventlog/log-model';
import {
  CATEGORIES, VIEWS, VIOLATIONS, categoryOf, eventLogHref, eventTypeLabel, parseLogParams,
  violationOf, viewMatches, zoneMatches,
} from './eventlog/log-query';
import { download, exportScorecardPdf, istNow } from '@/modules/employee-productivity/scorecard-export';

/**
 * Event Log — the forensic record.
 *
 * Three pages show AI events and it matters which one you are on:
 *
 *   AI Feed     what is happening NOW — live tiles, boxes drawn on video.
 *   AI Alerts   what NOTIFIED somebody — the subset that rang a phone.
 *   Event Log   what HAPPENED — every event, filterable, exportable, with the
 *               evidence attached. This page. It is the one you open after the
 *               fact, and the one an auditor is shown.
 *
 * It reads from two stores and makes them look like one: the backend's
 * `ai_events` (plus the vms_face mirror it already merges) and the activity
 * service's own attendance/alert timeline. Both are folded into the single
 * event vocabulary in ai-feed/aifeed/event-model.js so the table never has to
 * ask which service a row came from.
 *
 * Over the filters sits a row of quick views — All Activity, Staff
 * Violations, Queue Alerts, System Events — the four questions people open
 * this page to answer. System Events keeps its honest empty state, because
 * camera status transitions are not persisted anywhere a UI can query yet
 * (see log-model.js).
 */

const REPORT_TITLE = 'Event Log Report';
const exportName = (from, to) => `event-log-${from}${to !== from ? `_to_${to}` : ''}`;

// Every row matching the filters, not just the page on screen. Metadata first
// (title, export date, the filters the rows were cut by), then the table —
// so a CSV forwarded on its own still says what it is a record of.
// `filters` is [label, value][], the same list the PDF prints.
function downloadCsv(rows, from, to, filters) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const line = (...cells) => cells.map(esc).join(',');
  const csv = [
    line('DRISHYAM  |  AI Video Analytics  -  Event Log'),
    line(REPORT_TITLE),
    line('Export Date', istNow().label),
    line('Date Range', rangeLabel(from, to)),
    line('Total Events', rows.length),
    '',
    line('Applied Filters'),
    ...filters.map(([k, v]) => line(k, v)),
    '',
    line(...CSV_COLUMNS.map((c) => c.label)),
    ...rows.map((evt) => line(...CSV_COLUMNS.map((c) => csvValue(evt, c.id)))),
  ].join('\r\n');
  // BOM so Excel reads the file as UTF-8 (em dashes, ·, non-Latin names).
  download(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }), `${exportName(from, to)}.csv`);
}

// The same rows as a branded, paginated A4 PDF — the report writer the
// Reports hub uses (logo, generated stamp, zebra table, "Page X of Y"), so a
// log handed to an auditor looks like every other Drishyam export.
function downloadPdf(rows, from, to, filters) {
  const now = istNow();
  const bySev = (sev) => rows.filter((e) => e.severity === sev).length;
  return exportScorecardPdf({
    title: REPORT_TITLE,
    reportId: `RPT-LOG-${now.stamp}`,
    header: [
      ['Report Type', REPORT_TITLE],
      ['Date Range', rangeLabel(from, to)],
      ['Generated At', now.label],
      ['Total Events', `${rows.length.toLocaleString()} events`],
    ],
    policy: filters,
    kpis: [
      { label: 'Events', value: rows.length.toLocaleString(), note: 'Matching the filters' },
      { label: 'High', value: String(bySev('high')), note: 'Severity high' },
      { label: 'Medium', value: String(bySev('medium')), note: 'Severity medium' },
      { label: 'Unacknowledged', value: String(rows.filter((e) => statusOf(e) === 'new').length), note: 'Still need a human' },
    ],
    tables: [{
      title: 'Events',
      columns: REPORT_COLUMNS.map((c) => c.label),
      rows: rows.map((evt) => REPORT_COLUMNS.map((c) => csvValue(evt, c.id))),
    }],
    labels: {
      subtitle: 'Every event matching the filters below, in the order the log lists them.',
      tagline: 'AI VIDEO ANALYTICS  -  EVENT LOG',
      policy: 'Applied filters',
      summary: 'Summary',
      footer: 'Exported from the Drishyam Event Log.',
      rowNoun: 'events',
    },
    filename: exportName(from, to),
  });
}

const EXPORT_FORMATS = [
  { id: 'csv', label: 'Export as CSV', icon: SheetIcon },
  { id: 'pdf', label: 'Export as PDF', icon: FileText },
];

export default function EventLog() {
  const navigate = useNavigate();
  // Whether the details are a column or a drawer is layout STATE, not styling:
  // a Sheet hidden with a CSS class still paints its overlay over the table.
  const narrow = useMediaQuery(BELOW_XL);
  // Seeded from the URL so the dashboard omnibox, Zone Coverage's status
  // badges, the Activity Monitoring "View all in Event Log" link and the
  // module dashboards land here already scoped. The contract (?siteId|site,
  // zoneId, eventType, status, category, severity, date, camera, q) lives in
  // eventlog/log-query.js, with its tests.
  //
  // Read ONCE, into state. The URL seeds this page; it does not drive it.
  // Making every control write the URL and every render read it back would
  // put a router round-trip inside each keystroke of the search box, and
  // would fight the "resolve during render" guards below (a ?camera= that no
  // longer exists resolves to "all" for filtering while the URL still says
  // otherwise — two sources of truth that are allowed to differ).
  // `setParams` below keeps the address bar honest in the other direction.
  const [params, setParams] = useSearchParams();
  const [seed] = useState(() => parseLogParams(params, todayInput()));

  const [from, setFrom] = useState(seed.date);
  const [to, setTo] = useState(seed.date);
  // `null` = no site in the link: follow the Activity Monitoring site
  // (siteStore.js), so the log opens on the store the operator was watching.
  const [site, setSite] = useState(seed.site === 'all' ? null : seed.site);
  const globalSite = useSiteStore((st) => st.selectedSiteId);
  const setGlobalSite = useSiteStore((st) => st.setSelectedSiteId);
  const [camera, setCamera] = useState(seed.camera);
  const [zone, setZone] = useState(seed.zone);
  const [type, setType] = useState(seed.type);
  const [severity, setSeverity] = useState(seed.severity);
  const [status, setStatus] = useState(seed.status);
  const [category, setCategory] = useState(seed.category);
  const [query, setQuery] = useState(seed.query);
  const [view, setView] = useState(seed.view);
  const [violation, setViolation] = useState(seed.violation);
  const [sortDesc, setSortDesc] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [requestedPage, setRequestedPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [shown, setShown] = useState(SCROLL_CHUNK); // rows rendered in Continuous mode
  const [checked, setChecked] = useState(() => new Set()); // bulk selection
  const [selectedId, setSelectedId] = useState(null);
  const [acked, setAcked] = useState(() => new Set());
  const [acking, setAcking] = useState(false);
  const [ackError, setAckError] = useState('');
  // The arrival-time "No site selected" notice. Live until dismissed or until
  // the operator picks a site any way at all — it is about how the page
  // OPENED, so clearing back to All Sites later does not bring it back.
  const [siteNoticeOpen, setSiteNoticeOpen] = useState(true);

  // ── Cameras and sites ──────────────────────────────────────────────────────
  // "Site" here is a camera group, which is what the rest of the app calls a
  // site (/sites redirects into Camera Setup's Sites tab) and what the
  // dashboard's ?site= parameter carries.
  const { data: groups = [], isSuccess: groupsReady } = useGroups();
  const sites = useMemo(() => groups.map((g) => ({ id: g.id, name: g.name })), [groups]);
  const cameras = useMemo(() => groups.flatMap((g) => (g.cameras || []).map((c) => ({
    ...c, location: g.name || '', groupId: g.id,
  }))), [groups]);
  const cameraIndex = useMemo(() => {
    const out = {};
    for (const c of cameras) out[c.monitorId] = { name: c.name, location: c.location, siteId: c.groupId };
    return out;
  }, [cameras]);
  // A ?site= or ?camera= from an old link — or a camera deleted since — would
  // otherwise filter every row away while its control still read "All Sites",
  // because a Radix Select whose value matches no item renders blank. Resolved
  // during render rather than reset in an effect, so the control and the filter
  // are the same value and can never disagree.
  // The shared site only applies when it is one of these camera groups — a
  // demo store id from a workspace with no sites must not empty the table.
  const isGroup = (id) => groups.some((g) => String(g.id) === String(id));
  const wantedSite = site ?? (isGroup(globalSite) ? String(globalSite) : 'all');
  const siteValue = wantedSite === 'all' || !groups.length || isGroup(wantedSite)
    ? wantedSite : 'all';
  const siteCodes = useMemo(() => {
    if (siteValue === 'all') return null;
    const g = groups.find((grp) => String(grp.id) === String(siteValue));
    return g ? new Set((g.cameras || []).map((c) => c.monitorId).filter(Boolean)) : new Set();
  }, [siteValue, groups]);
  // A link asked for a site that is not one of ours (deleted, another
  // workspace's, a demo id): named in the notice instead of dropped silently.
  const missingSite = groupsReady && seed.site !== 'all'
    && !groups.some((g) => String(g.id) === String(seed.site)) ? seed.site : null;
  // Only once the sites are known — before then "all" just means "loading" —
  // and only when there is more than one site to choose between. An operator
  // who deliberately chose All Sites elsewhere (stored 'all') is not told
  // that nothing was selected; a link naming a missing site still is.
  const choseAll = seed.site === 'all' && globalSite === ALL_SITES;
  const showSiteNotice = siteNoticeOpen && groupsReady && sites.length > 1 && siteValue === 'all'
    && (!choseAll || !!missingSite);
  // A site picked here is the module's site too, so the dashboard and
  // analytics follow it back.
  const pickSite = useCallback((v) => {
    setSite(v); setGlobalSite(v); setCamera('all'); setSiteNoticeOpen(false);
  }, [setGlobalSite]);
  // A link that names one of our sites becomes the shared site as well.
  useEffect(() => {
    if (groupsReady && seed.site !== 'all' && groups.some((g) => String(g.id) === String(seed.site))) {
      setGlobalSite(String(seed.site));
    }
  }, [groupsReady, groups, seed.site, setGlobalSite]);
  const camerasInScope = useMemo(
    () => (siteCodes ? cameras.filter((c) => siteCodes.has(c.monitorId)) : cameras),
    [cameras, siteCodes],
  );
  const cameraValue = camera === 'all' || !camerasInScope.length
    || camerasInScope.some((c) => c.monitorId === camera) ? camera : 'all';

  // ── The two stores ─────────────────────────────────────────────────────────
  const sinceIso = useMemo(() => startOfDay(from).toISOString(), [from]);
  const untilIso = useMemo(() => endOfDay(to).toISOString(), [to]);
  const live = to === todayInput();

  const aiQuery = useQuery({
    queryKey: ['event-log', 'ai', sinceIso, untilIso],
    queryFn: () => aiService.listEvents({ since: sinceIso, until: untilIso, limit: FETCH_LIMIT }),
    refetchInterval: live ? 30_000 : false,
    staleTime: 10_000,
  });

  // The activity service's timeline takes ONE day, not a range — asking it for
  // a month would be a request per day. A multi-day range therefore shows AI
  // events only, and the header says so rather than quietly dropping rows.
  const singleDay = from === to ? from : null;
  const activityQuery = useQuery({
    queryKey: ['event-log', 'activity', singleDay],
    queryFn: () => aiService.activityEvents({ date: singleDay, limit: 500 }),
    enabled: Boolean(singleDay),
    refetchInterval: live ? 30_000 : false,
    staleTime: 10_000,
    retry: false,   // 502 when the activity service is not deployed — not an error worth retrying
  });

  const events = useMemo(() => {
    const ai = (aiQuery.data?.data || [])
      .map((row) => normalizeEvent(row, cameraIndex))
      .filter(Boolean);
    const activity = (activityQuery.data?.events || [])
      .map((row) => normalizeActivityRow(row, cameraIndex))
      .filter(Boolean);
    return [...ai, ...activity].map((evt) => {
      const out = acked.has(evt.id) ? { ...evt, acknowledged: true } : evt;
      // A type the vocabulary does not know normalizes to the generic "AI
      // Event" — two different detectors under one vague name in the table and
      // the Event Type menu. Its own slug, prettified, says more.
      return out.title === 'AI Event' && out.type ? { ...out, title: eventTypeLabel(out.type) } : out;
    });
  }, [aiQuery.data, activityQuery.data, cameraIndex, acked]);

  // ── Filtering ──────────────────────────────────────────────────────────────
  // Types on offer are the ones present in the window — a menu that can only
  // return rows. Built before the view filter so switching views never empties
  // it. Violations are listed under the same words the Violation menu uses.
  const typeOptions = useMemo(() => {
    const seen = new Map();
    for (const e of events) if (!seen.has(e.type)) seen.set(e.type, violationOf(e)?.label || e.title);
    return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [events]);
  // Same guard as the site and camera above: a type chosen on Monday may not
  // occur in Tuesday's events, and a filter that can only return nothing is not
  // a state worth preserving through a date change.
  const typeValue = type === 'all' || !typeOptions.length || typeOptions.some((t) => t.id === type)
    ? type : 'all';

  // Everything except the view and violation kind, so the pill counts and the
  // table can never disagree about what "142" means.
  const beforeView = useMemo(() => events.filter((e) => (
    (!siteCodes || siteCodes.has(e.monitorId))
    && (cameraValue === 'all' || e.monitorId === cameraValue)
    && zoneMatches(e, zone)
    && (typeValue === 'all' || e.type === typeValue)
    && (severity === 'all' || e.severity === severity)
    && (status === 'all' || statusOf(e) === status)
    && (category === 'all' || categoryOf(e) === category)
    && matchesQuery(e, query)
  )), [events, siteCodes, cameraValue, zone, typeValue, severity, status, category, query]);

  const counts = useMemo(() => {
    const out = Object.fromEntries(VIEWS.map((v) => [v.id, 0]));
    let activeViolations = 0;
    for (const e of beforeView) {
      for (const v of VIEWS) if (viewMatches(e, v.id)) out[v.id] += 1;
      if (violationOf(e) && statusOf(e) === 'new') activeViolations += 1;
    }
    return { ...out, activeViolations };
  }, [beforeView]);

  const rows = useMemo(() => {
    const list = beforeView.filter((e) => viewMatches(e, view)
      && (violation === 'all' || violationOf(e)?.kind === violation));
    return list.sort((a, b) => (sortDesc ? b.ts - a.ts : a.ts - b.ts));
  }, [beforeView, view, violation, sortDesc]);

  const continuous = pageSize === CONTINUOUS;
  const pageCount = continuous ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const pageRows = continuous ? rows.slice(0, shown) : rows.slice((page - 1) * pageSize, page * pageSize);
  const selected = rows.find((e) => e.id === selectedId) || null;
  const loadMore = useCallback(() => setShown((n) => n + SCROLL_CHUNK), []);

  // Any filter change: back to page 1 / the first chunk, selection cleared —
  // a bulk action must only ever touch rows the operator can currently see.
  const refilter = useCallback(() => {
    setRequestedPage(1); setShown(SCROLL_CHUNK); setChecked(new Set());
  }, []);

  const dirty = siteValue !== 'all' || cameraValue !== 'all' || zone !== 'all' || typeValue !== 'all'
    || severity !== 'all' || status !== 'all' || category !== 'all' || violation !== 'all' || query !== '';
  // The view is a place, not a filter: clearing keeps you on Staff Violations
  // and only widens it back to every kind.
  const clearFilters = useCallback(() => {
    setSiteNoticeOpen(false);
    setSite('all'); setGlobalSite('all'); setCamera('all'); setZone('all'); setType('all'); setSeverity('all');
    setStatus('all'); setCategory('all'); setViolation('all'); setQuery('');
    refilter();
  }, [refilter, setGlobalSite]);

  // A violation kind lives under Staff Violations; leaving that view drops it,
  // and entering it drops an Event Type that would only fight the kind menu.
  const pickView = useCallback((v) => {
    setView(v);
    if (v === 'violations') setType('all'); else setViolation('all');
    refilter();
  }, [refilter]);

  // ── The chip row ───────────────────────────────────────────────────────────
  // One entry per filter that is actually narrowing the table, in the order it
  // narrows: where, then what, then how bad, then the free text. Built from the
  // RESOLVED values (siteValue / cameraValue / typeValue), so a chip can never
  // claim a filter the rows below are not actually subject to.
  //
  // Date is not a chip: see LogFilterChips for why.
  const chips = useMemo(() => {
    const out = [];
    const add = (id, label, value, onClear) => { if (value) out.push({ id, label, value, onClear }); };

    add('site', 'Site',
      siteValue === 'all' ? null : (sites.find((x) => String(x.id) === String(siteValue))?.name || siteValue),
      () => { pickSite('all'); refilter(); });
    add('zone', 'Zone', zone === 'all' ? null : zone, () => { setZone('all'); refilter(); });
    add('camera', 'Camera',
      cameraValue === 'all' ? null : (cameras.find((c) => c.monitorId === cameraValue)?.name || cameraValue),
      () => { setCamera('all'); refilter(); });
    // The events in view name their own type; `eventTypeLabel` covers the
    // case a deep link creates — a type this day contains none of.
    add('type', 'Event',
      typeValue === 'all' ? null : (typeOptions.find((t) => t.id === typeValue)?.label || eventTypeLabel(typeValue)),
      () => { setType('all'); refilter(); });
    add('violation', 'Violation',
      violation === 'all' ? null : VIOLATIONS.find((v) => v.id === violation)?.label,
      () => { setViolation('all'); refilter(); });
    add('category', 'Category',
      category === 'all' ? null : (CATEGORIES.find((c) => c.id === category)?.label || category),
      () => { setCategory('all'); refilter(); });
    add('status', 'Status',
      status === 'all' ? null : (status === 'new' ? 'Unacknowledged' : 'Acknowledged'),
      () => { setStatus('all'); refilter(); });
    add('severity', 'Severity',
      severity === 'all' ? null : (severity === 'info' ? 'Low' : severity[0].toUpperCase() + severity.slice(1)),
      () => { setSeverity('all'); refilter(); });
    add('q', 'Search', query || null, () => { setQuery(''); refilter(); });

    return out;
  }, [siteValue, sites, zone, cameraValue, cameras, typeValue, typeOptions, violation, category, status, severity, query, refilter, pickSite]);

  // ── The address bar, kept honest ───────────────────────────────────────────
  // Whatever is on screen must be re-openable from the URL: an operator who
  // narrows the log by hand and then sends the link to a colleague should be
  // sending the view they are looking at, not the view they started from.
  // `replace` so filtering does not fill the back button with every keystroke;
  // the date rides along because a link without it means "today", which is a
  // different view tomorrow.
  const href = eventLogHref({
    siteId: siteValue, zoneId: zone, camera: cameraValue, eventType: typeValue,
    status, category, severity, view, violation, date: from === to ? from : undefined, q: query,
  });
  useEffect(() => {
    const next = href.split('?')[1] || '';
    if (next !== params.toString()) setParams(next, { replace: true });
    // `params` is intentionally absent: it is the value being written, and
    // depending on it would re-run this the moment it lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href, setParams]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const goLive = useCallback((evt) => {
    navigate(`/live?camera=${encodeURIComponent(evt.monitorId)}`);
  }, [navigate]);

  const goPlayback = useCallback((evt) => {
    navigate(`/playback?camera=${encodeURIComponent(evt.monitorId)}&t=${encodeURIComponent(new Date(evt.ts).toISOString())}`);
  }, [navigate]);

  const goTrack = useCallback((evt) => {
    navigate(evt.subject && !evt.isUnknown
      ? `/person-tracker?name=${encodeURIComponent(evt.subject)}`
      : '/person-tracker');
  }, [navigate]);

  // Activity-service rows carry no event id, so there is nothing to mark.
  const canAck = useCallback(
    (evt) => Boolean(evt?.raw?.id) && !evt.fromActivityService && statusOf(evt) !== 'acknowledged',
    [],
  );
  const checkedRows = useMemo(() => rows.filter((e) => checked.has(e.id) && canAck(e)), [rows, checked, canAck]);

  const acknowledgeMany = useCallback(async () => {
    if (!checkedRows.length) return;
    setAcking(true);
    setAckError('');
    const results = await Promise.allSettled(checkedRows.map((evt) => aiService.acknowledge(evt.raw.id)));
    const done = checkedRows.filter((_, i) => results[i].status === 'fulfilled').map((e) => e.id);
    const failed = results.length - done.length;
    setAcked((prev) => new Set([...prev, ...done]));
    setChecked(new Set());
    setAcking(false);
    if (failed) setAckError(`${failed} of ${results.length} events could not be acknowledged — events mirrored from the face service have no record to mark.`);
  }, [checkedRows]);

  const acknowledge = useCallback(async (evt) => {
    if (!evt?.raw?.id || evt.fromActivityService || acked.has(evt.id)) return;
    setAcking(true);
    setAckError('');
    try {
      await aiService.acknowledge(evt.raw.id);
      setAcked((prev) => new Set(prev).add(evt.id));
    } catch {
      // Face events mirrored from vms_face are not rows in `ai_events`, so the
      // ack endpoint has nothing to mark. The row stays "New" — and says why,
      // rather than leaving a button that looks broken.
      setAckError('This event could not be acknowledged — it is mirrored from the face service and has no record to mark.');
    } finally {
      setAcking(false);
    }
  }, [acked]);

  // ── Empty states ───────────────────────────────────────────────────────────
  const meta = view === 'system' ? SOURCE_META.system : null;
  let empty;
  if (meta && !meta.available) {
    empty = (
      <EmptyState
        icon={ShieldQuestion}
        title={meta.emptyTitle}
        description={meta.emptyDescription}
        className="py-16"
      />
    );
  } else if (view === 'violations' && !dirty) {
    empty = (
      <EmptyState
        icon={CheckCircle2}
        title="No staff violations in this range"
        description="Phone use on the floor, unattended counters, over-breaks and group gatherings appear here as soon as they are detected."
        className="py-16"
      />
    );
  } else if (dirty || events.length) {
    empty = (
      <EmptyState
        icon={SearchX}
        title="No events match these filters"
        description="Widen the date range, or clear the filters to see everything recorded in this window."
        action={dirty ? <PageAction onClick={clearFilters} type="button">Clear filters</PageAction> : null}
        className="py-16"
      />
    );
  } else {
    empty = (
      <EmptyState
        icon={ScrollText}
        title="No events recorded in this range"
        description={`Nothing was detected ${singleDay ? `on ${rangeLabel(from, to)}` : `between ${rangeLabel(from, from)} and ${rangeLabel(to, to)}`}. Pick another date, or check that AI is enabled on your cameras in Camera Setup.`}
        className="py-16"
      />
    );
  }

  // What the exported rows were cut by — printed at the top of both files.
  // Resolved values (siteValue / cameraValue / typeValue), like the chips.
  const filterSummary = [
    ['Date Range', rangeLabel(from, to)],
    ['Site', siteValue === 'all' ? 'All sites' : (sites.find((x) => String(x.id) === String(siteValue))?.name || siteValue)],
    ['Camera', cameraValue === 'all' ? 'All cameras' : (cameras.find((c) => c.monitorId === cameraValue)?.name || cameraValue)],
    ['View', VIEWS.find((v) => v.id === view)?.label],
    ...(violation !== 'all' ? [['Violation', VIOLATIONS.find((v) => v.id === violation)?.label]] : []),
    ['Event Type', typeValue === 'all' ? 'All events' : (typeOptions.find((t) => t.id === typeValue)?.label || eventTypeLabel(typeValue))],
    ['Severity', severity === 'all' ? 'All' : severityLabel(severity)],
    ['Category', category === 'all' ? 'All' : CATEGORIES.find((c) => c.id === category)?.label],
    ['Zone', zone === 'all' ? 'All zones' : zone],
    ['Status', status === 'all' ? 'All' : status === 'new' ? 'Unacknowledged' : 'Acknowledged'],
    ...(query ? [['Search', query]] : []),
  ];

  const runExport = async (format) => {
    if (format === 'csv') { downloadCsv(rows, from, to, filterSummary); return; }
    setExporting(true);
    try {
      await downloadPdf(rows, from, to, filterSummary);
    } finally {
      setExporting(false);
    }
  };

  const capped = events.length >= FETCH_LIMIT;
  const loading = aiQuery.isLoading || (Boolean(singleDay) && activityQuery.isLoading);

  return (
    <OperationsPage>
      <PageHeader
        icon={ScrollText}
        title="Activity history"
        description="Every AI detection, security event and system event, in one searchable record — with the evidence attached."
        descriptionAs="tooltip"
        tagline={`${rangeLabel(from, to)} · ${counts.all.toLocaleString()} events${singleDay ? '' : ' · attendance events need a single-day range'}`}
        actions={
          <>
            <PageAction
              type="button"
              onClick={() => { aiQuery.refetch(); if (singleDay) activityQuery.refetch(); }}
              title="Reload the log"
            >
              <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} strokeWidth={2} />
              Refresh
            </PageAction>
            {/* One primary [Export ▾]; the menu closes itself on select. */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild disabled={!rows.length || exporting}>
                <PageAction
                  type="button"
                  className="border-brand bg-brand text-white shadow-sm hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-brand-hover"
                  title="Export every row matching the current filters, not just this page"
                >
                  {exporting
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                    : <Download className="h-3.5 w-3.5" strokeWidth={2} />}
                  {exporting ? 'Preparing…' : 'Export'}
                  {!exporting && <ChevronDown className="h-3.5 w-3.5 opacity-80" strokeWidth={2} />}
                </PageAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44 border-line bg-surface">
                {EXPORT_FORMATS.map((f) => (
                  <DropdownMenuItem key={f.id} onSelect={() => runExport(f.id)} className="gap-2 text-small">
                    <f.icon className="text-fg-muted" /> {f.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <PageContent className="gap-3">
        {/* Quick views on top, the fine controls beneath — one card, so the
            whole of "what am I looking at" is stated in one place. */}
        <PageCard className="flex shrink-0 flex-col gap-3 p-3">
          <LogQuickFilters
            view={view}
            onView={pickView}
            counts={counts}
            activeViolations={counts.activeViolations}
          />
          <div className="border-t border-line-subtle" aria-hidden="true" />
          <LogFilters
            from={from} to={to}
            onFrom={(v) => { setFrom(v); if (v > to) setTo(v); refilter(); }}
            onTo={(v) => { setTo(v); if (v < from) setFrom(v); refilter(); }}
            site={siteValue} onSite={(v) => { pickSite(v); refilter(); }} sites={sites}
            camera={cameraValue} onCamera={(v) => { setCamera(v); refilter(); }} cameras={camerasInScope}
            type={typeValue} onType={(v) => { setType(v); refilter(); }} types={typeOptions}
            view={view} violation={violation}
            onViolation={(v) => { setViolation(v); refilter(); }}
            severity={severity} onSeverity={(v) => { setSeverity(v); refilter(); }}
            query={query} onQuery={(v) => { setQuery(v); refilter(); }}
            dirty={dirty} onClear={clearFilters}
          />
        </PageCard>

        {showSiteNotice ? (
          <SiteScopeNotice
            sites={sites}
            missingSite={missingSite}
            onPick={(v) => { pickSite(v); refilter(); }}
            onDismiss={() => setSiteNoticeOpen(false)}
          />
        ) : null}

        {/* Directly above the table, because it explains the table. */}
        <LogFilterChips chips={chips} onClearAll={clearFilters} />

        {checked.size > 0 || ackError ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-brand-line bg-brand-soft px-3 py-2">
            {checked.size > 0 ? (
              <>
                <span className="text-small font-semibold text-brand-ink">{checkedRows.length} selected</span>
                <PageAction type="button" onClick={acknowledgeMany} disabled={acking || !checkedRows.length}>
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                  {acking ? 'Acknowledging…' : 'Acknowledge selected'}
                </PageAction>
                <button
                  type="button"
                  onClick={() => setChecked(new Set())}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-small font-semibold text-fg-muted hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" /> Clear
                </button>
              </>
            ) : null}
            {ackError ? <p className="text-caption text-danger-ink sm:ml-auto">{ackError}</p> : null}
          </div>
        ) : null}

        {capped ? (
          <p className="flex shrink-0 items-center gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-caption text-fg-muted">
            <Info className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2} />
            This range has more events than the server returns in one request ({FETCH_LIMIT}). These are the most
            recent — narrow the date range to reach older ones.
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1 gap-3">
          <PageCard className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <LogTable
              rows={pageRows}
              totalRows={rows.length}
              loading={loading}
              empty={empty}
              page={page}
              pageCount={pageCount}
              pageSize={pageSize}
              onPage={setRequestedPage}
              onPageSize={(size) => { setPageSize(size); refilter(); }}
              onLoadMore={loadMore}
              checked={checked}
              canAck={canAck}
              onCheck={(id) => setChecked((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
              })}
              onCheckAll={(ids, on) => setChecked((prev) => {
                const next = new Set(prev);
                ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
                return next;
              })}
              sortDesc={sortDesc}
              onToggleSort={() => setSortDesc((v) => !v)}
              selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setAckError(''); }}
              onLive={goLive}
              onPlayback={goPlayback}
              onAcknowledge={acknowledge}
            />
          </PageCard>

          {/* Wide screens keep the record and the detail side by side — an
              operator comparing three rows should not have to open and close a
              drawer three times. Below xl the same component is that drawer. */}
          {selected && !narrow ? (
            <PageCard className="flex min-h-0 w-[22rem] shrink-0 flex-col overflow-hidden">
              <EventDetail
                event={selected}
                onClose={() => { setSelectedId(null); setAckError(''); }}
                onLive={goLive}
                onPlayback={goPlayback}
                onAcknowledge={acknowledge}
                onTrack={goTrack}
                acking={acking}
                ackError={ackError}
              />
            </PageCard>
          ) : null}
        </div>

        <Sheet
          open={Boolean(selected) && narrow}
          onOpenChange={(open) => { if (!open) { setSelectedId(null); setAckError(''); } }}
        >
          <SheetContent side="right" className="flex w-[26rem] max-w-[calc(var(--app-vw)*0.94)] flex-col gap-0 p-0">
            <SheetTitle className="sr-only">Event details</SheetTitle>
            <SheetDescription className="sr-only">
              Full record and actions for the selected event.
            </SheetDescription>
            <EventDetail
              event={selected}
              onLive={goLive}
              onPlayback={goPlayback}
              onAcknowledge={acknowledge}
              onTrack={goTrack}
              acking={acking}
              ackError={ackError}
            />
          </SheetContent>
        </Sheet>
      </PageContent>
    </OperationsPage>
  );
}
