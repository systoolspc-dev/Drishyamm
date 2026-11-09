import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, Bell, SearchX, ShieldCheck } from 'lucide-react';
import {
  OperationsPage,
  PageContent,
  PageHeader,
} from '@/core/layout/OperationsPage';
import api from '@/core/services/api';
import { cameraHealthService } from '@/core/services/cameraHealth';
import { ErrorState } from '@/core/ui/states';
import { RequireCameras } from '@/core/components/RequireCameras';
import HealthSummary from './camera-health/HealthSummary';
import HealthTable from './camera-health/HealthTable';
import HealthToolbar, { ANY } from './camera-health/HealthToolbar';
import HealthExportDialog from './camera-health/HealthExportDialog';
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  PAGE_SIZES,
} from './camera-health/health-columns';
import {
  bucketMeta,
  bucketOf,
  FILTER_BUCKETS,
  isStreaming,
  needsAttention,
} from './camera-health/health-vocabulary';

const REFRESH_INTERVAL_MS = 10_000;
const PREFS_KEY = 'cameraHealth.tablePrefs';

const EMPTY_FILTER = { siteId: ANY, groupId: ANY, statuses: new Set() };

/** What Health does once cameras exist, shown on the no-cameras screen. */
const HEALTH_BENEFITS = [
  { icon: Activity,  title: 'Monitor health',     text: 'Track camera status, connectivity and performance in real time.' },
  { icon: Bell,      title: 'Get alerts',         text: 'Identify offline or unstable cameras early and take action.' },
  { icon: BarChart3, title: 'Ensure reliability', text: 'Maintain stable video streams for uninterrupted monitoring.' },
];

/** Table shape the operator chose last time — columns, sort, page size. */
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    const known = new Set(COLUMNS.map((c) => c.id));
    return {
      columns: Array.isArray(saved.columns) && saved.columns.length
        ? saved.columns.filter((id) => known.has(id))
        : DEFAULT_COLUMNS,
      sort: saved.sort?.id && known.has(saved.sort.id) ? saved.sort : { id: 'status', dir: 'asc' },
      pageSize: PAGE_SIZES.includes(saved.pageSize) ? saved.pageSize : 10,
      thumbnails: saved.thumbnails !== false,
    };
  } catch {
    return { columns: DEFAULT_COLUMNS, sort: { id: 'status', dir: 'asc' }, pageSize: 10, thumbnails: true };
  }
}

function sameFilter(a, b) {
  return (
    a.siteId === b.siteId &&
    a.groupId === b.groupId &&
    a.statuses.size === b.statuses.size &&
    [...a.statuses].every((s) => b.statuses.has(s))
  );
}

function EmptyState({ filtered }) {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center p-8 text-center">
      <SearchX className="h-9 w-9 text-fg-disabled" />
      <p className="mt-3 text-body font-bold text-fg">
        {filtered ? 'No cameras match these filters' : 'No cameras to show'}
      </p>
      <p className="mt-1 max-w-sm text-small leading-relaxed text-fg-muted">
        {filtered
          ? 'Try a different site, group or status — or clear the filters to see the whole estate.'
          : 'Add cameras and start their streams to see health here.'}
      </p>
    </div>
  );
}

export default function CameraHealth() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Search and the structured filters both run live. There is no staged copy
  // and no Apply button: the controls now sit in the header toolbar, and a
  // dropdown you close with nothing happening reads as a broken control rather
  // than as a change waiting to be committed.
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(EMPTY_FILTER);

  const prefs = useRef(loadPrefs()).current;
  const [columns, setColumns] = useState(prefs.columns);
  const [sort, setSort] = useState(prefs.sort);
  const [pageSize, setPageSize] = useState(prefs.pageSize);
  const [thumbnails, setThumbnails] = useState(prefs.thumbnails);

  const [selected, setSelected] = useState(new Set());
  const [busyCamera, setBusyCamera] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ columns, sort, pageSize, thumbnails }));
    } catch { /* a browser with storage disabled still gets a working table */ }
  }, [columns, sort, pageSize, thumbnails]);

  const load = useCallback(async () => {
    try {
      const res = await cameraHealthService.list();
      setData(res);
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Failed to load camera health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const cameras = useMemo(() => data?.cameras || [], [data]);

  // Sites and groups come from the cameras themselves rather than from their
  // own endpoints: two fewer requests, and the options cannot offer a site
  // that has no camera on this page to show for it.
  const { sites, groups } = useMemo(() => {
    const siteMap = new Map();
    const groupMap = new Map();
    for (const camera of cameras) {
      if (camera.siteId && !siteMap.has(camera.siteId)) {
        siteMap.set(camera.siteId, { id: camera.siteId, name: camera.siteName || 'Unnamed site' });
      }
      if (camera.groupId && !groupMap.has(camera.groupId)) {
        groupMap.set(camera.groupId, {
          id: camera.groupId,
          name: camera.groupName || 'Unnamed group',
          siteId: camera.siteId || null,
        });
      }
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    return { sites: [...siteMap.values()].sort(byName), groups: [...groupMap.values()].sort(byName) };
  }, [cameras]);

  /** Bucket counts over the WHOLE estate — the filter list never renumbers. */
  const counts = useMemo(() => {
    const out = Object.fromEntries(FILTER_BUCKETS.map((b) => [b, 0]));
    for (const camera of cameras) {
      const bucket = bucketOf(camera);
      out[bucket] = (out[bucket] || 0) + 1;
    }
    return out;
  }, [cameras]);

  const summary = useMemo(() => {
    const streamingCameras = cameras.filter(isStreaming);
    const totalDelay = streamingCameras.reduce((sum, c) => sum + (Number(c.jitterMs) || 0), 0);
    return {
      total: cameras.length,
      online: counts.online || 0,
      attention: cameras.filter(needsAttention).length,
      streamingCount: streamingCameras.length,
      avgDelay: streamingCameras.length ? totalDelay / streamingCameras.length : 0,
    };
  }, [cameras, counts]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = cameras;

    if (filter.siteId !== ANY) list = list.filter((c) => c.siteId === filter.siteId);
    if (filter.groupId !== ANY) list = list.filter((c) => c.groupId === filter.groupId);
    if (filter.statuses.size) list = list.filter((c) => filter.statuses.has(bucketOf(c)));
    if (needle) {
      list = list.filter((c) =>
        [c.name, c.monitorId, c.groupName, c.siteName]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)));
    }

    const column = COLUMNS.find((c) => c.id === sort.id) || COLUMNS[0];
    const direction = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = column.sort(a);
      const bv = column.sort(b);
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
      // Same rank — fall back to name so the order never shuffles between polls.
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [cameras, filter, query, sort]);

  const filtersActive = !sameFilter(filter, EMPTY_FILTER) || query.trim().length > 0;

  const clearFilters = () => {
    setFilter(EMPTY_FILTER);
    setQuery('');
  };

  // ── Export ────────────────────────────────────────────────────────────────
  // Pressing Export opens the format-and-delivery dialog over a FROZEN list:
  // the rows as they stood at that moment, not a live view the 10-second poll
  // can reshuffle under the operator while they pick a format. The file then
  // matches the screen they exported from.
  const [exportScope, setExportScope] = useState(null);

  // The filters the export was taken under, printed in the report's "Applied
  // filters" block. Built here because this is where the site and group NAMES
  // live — a report that says "siteId: 7f3c…" tells a reader nothing.
  const exportFilters = useMemo(() => {
    const out = [];
    if (filter.siteId !== ANY) {
      out.push(['Site', sites.find((s) => s.id === filter.siteId)?.name || filter.siteId]);
    }
    if (filter.groupId !== ANY) {
      out.push(['Camera group', groups.find((g) => g.id === filter.groupId)?.name || filter.groupId]);
    }
    if (filter.statuses.size) {
      out.push(['Status', [...filter.statuses].map((s) => bucketMeta(s).label).join(', ')]);
    }
    if (query.trim()) out.push(['Search', query.trim()]);
    return out;
  }, [filter, groups, query, sites]);

  const runAction = useCallback(async (camera, kind) => {
    if (!camera.monitorId) return;
    setBusyCamera(camera.monitorId);
    try {
      await api.post(`/cameras/${camera.monitorId}/${kind}`);
    } catch {
      /* The next poll shows what actually happened — the row is the feedback. */
    } finally {
      setBusyCamera('');
      load();
    }
  }, [load]);

  /**
   * Reconnect every selected camera — ONE AT A TIME.
   *
   * A reconnect re-opens the source, and the recorders behind these cameras
   * are the weak link: a burst of simultaneous pulls is what has taken a
   * whole NVR offline before. Sequential is slower and correct; the progress
   * counter is there because it is slower.
   */
  const bulkReconnect = useCallback(async () => {
    const targets = rows.filter((c) => selected.has(c.id) && c.monitorId);
    if (!targets.length) return;

    setBulkBusy(true);
    for (let i = 0; i < targets.length; i += 1) {
      setBulkStatus(`Reconnecting ${i + 1} of ${targets.length}...`);
      try {
        await api.post(`/cameras/${targets[i].monitorId}/heal`);
      } catch { /* keep going — one unreachable camera must not stop the rest */ }
    }
    setBulkStatus(`Reconnected ${targets.length}`);
    setBulkBusy(false);
    load();
  }, [rows, selected, load]);

  const engineDown = data?.mediamtxOk === false;

  // A failed health call with nothing to show is an error (retry), NOT an
  // empty estate. Whether the account has cameras at all is RequireCameras'
  // call, the same answer every camera page uses. A poll that fails after
  // cameras have loaded keeps the dashboard and shows the error strip above it.
  const failed = Boolean(error) && cameras.length === 0;

  return (
    <OperationsPage>
      {/* `tagline`, not `description`: one line that orients, dropped below
          `md`, instead of the two-line paragraph that used to sit here. The
          full explanation — what every column and status means — is in the
          guide dialog behind the toolbar's info icon, along with the "How to
          read this" card that used to sit in the sidebar. Between them those
          two cost ~180px above the first camera row to say something an
          operator reads once. */}
      <PageHeader
        icon={ShieldCheck}
        title="Camera Status"
        tagline="Live connectivity, delay and stream health across every camera."
        actions={(
          <>
            <HealthToolbar
              query={query}
              onQueryChange={setQuery}
              filter={filter}
              onFilterChange={setFilter}
              onClear={clearFilters}
              active={filtersActive}
              sites={sites}
              groups={groups}
              counts={counts}
              loading={loading}
              onRefresh={load}
              autoRefresh={autoRefresh}
              onAutoRefreshChange={setAutoRefresh}
            />

            {engineDown ? (
              <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-danger-line bg-danger-soft px-3 text-small font-bold text-danger-ink">
                <AlertTriangle className="h-3.5 w-3.5" />
                Stream engine unreachable
              </span>
            ) : null}
          </>
        )}
      />

      <PageContent className="gap-4">
        {failed ? (
          <section className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-line bg-surface shadow-sm">
            <ErrorState
              title={/network/i.test(error) ? 'Network Error' : 'Server Error'}
              description={/network/i.test(error)
                ? 'Unable to retrieve camera health data.'
                : `Unable to retrieve camera health data. ${error}`}
              onRetry={() => { setLoading(true); load(); }}
              retryLabel="Retry"
            />
          </section>
        ) : (
          <RequireCameras
            description="Add your cameras to start monitoring their health, connectivity and streaming performance."
            benefits={HEALTH_BENEFITS}
          >
            {error ? (
              <div className="flex shrink-0 items-center gap-2 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-body font-semibold text-danger-ink">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            ) : null}

            <HealthSummary {...summary} />

            {/* The table is the page. With the filters in the header it gets
                the full width — it used to share the row with a 320px sidebar,
                which is where the horizontal scroll on anything under a
                desktop monitor came from. */}
            <HealthTable
              rows={rows}
              total={cameras.length}
              loading={loading && cameras.length === 0}
              columns={columns}
              onColumnsChange={setColumns}
              sort={sort}
              onSortChange={setSort}
              selected={selected}
              onSelectedChange={setSelected}
              thumbnails={thumbnails}
              onThumbnailsChange={setThumbnails}
              pageSize={pageSize}
              onPageSizeChange={setPageSize}
              onExport={(list) => setExportScope({
                rows: list,
                label: filtersActive ? 'Filtered cameras' : 'All cameras',
              })}
              onAction={runAction}
              busyCamera={busyCamera}
              bulk={{
                busy: bulkBusy,
                status: bulkStatus,
                onReconnect: bulkReconnect,
                onExport: () => setExportScope({
                  rows: rows.filter((c) => selected.has(c.id)),
                  label: `${selected.size} selected ${selected.size === 1 ? 'camera' : 'cameras'}`,
                }),
              }}
              emptyState={<EmptyState filtered={filtersActive} />}
            />
          </RequireCameras>
        )}
      </PageContent>

      <HealthExportDialog
        open={Boolean(exportScope)}
        onOpenChange={(next) => { if (!next) setExportScope(null); }}
        rows={exportScope?.rows || []}
        total={cameras.length}
        columns={columns}
        filters={exportFilters}
        scopeLabel={exportScope?.label || 'All cameras'}
      />
    </OperationsPage>
  );
}
