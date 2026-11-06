import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  MapPin,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { aiService } from '@/core/services/ai';
import { PageAttention, PageTabs, PageToolbar } from '@/core/layout/OperationsPage';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import { SetupEmptyState, SetupErrorState } from '@/core/components/SetupState';
import { isEmptyPreview } from '@/core/lib/emptyPreview'; // TEMP-PREVIEW

const PURPOSES = [
  'Main gate',
  'Reception',
  'Restricted area',
  'Server room',
  'Cash counter',
  'Exam hall',
  'Store room',
];

const SHOW_TABS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'available', label: 'Available' },
];

const PRIORITY = [
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

export default function AiDetectionSetup({ onNavigate }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');            // a camera update failed
  // The list itself failed to load. Kept apart from `error` so a failed
  // fetch with nothing loaded shows the error card, never the empty state.
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [show, setShow] = useState('all');
  const queryClient = useQueryClient();

  const load = async () => {
    setLoading(true);
    try {
      const payload = await aiService.listCameraAiSettings();
      setRows(payload.data || []);
      setLoadError('');
      setLoaded(true);
      // Keep the tab-strip count (CameraSetup's summary query) in step.
      queryClient.setQueryData(['ai-camera-settings-summary'], payload.summary || {});
      if (!selectedId && payload.data?.length) {
        const first = payload.data.find((camera) => camera.ai?.enabled) || payload.data[0];
        setSelectedId(first.id);
      }
    } catch (err) {
      setLoadError(err?.response?.data?.message || err.message || 'Could not load AI camera settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((camera) =>
      camera.name?.toLowerCase().includes(q)
      || camera.groupName?.toLowerCase().includes(q)
      || camera.ai?.purpose?.toLowerCase().includes(q)
      || camera.monitorId?.toLowerCase().includes(q)
    );
  }, [rows, query]);

  const selected = rows.find((camera) => camera.id === selectedId) || filtered[0] || null;
  const activeCameras = filtered.filter((camera) => camera.ai?.enabled);

  // Selected for AI but not running (and not merely starting): the one thing
  // on this tab that needs a hand. Counted from the rows, so the link and the
  // count agree with the list it narrows.
  const stalled = rows.filter((camera) =>
    camera.ai?.enabled && !camera.runtime?.running && camera.lifecycle !== 'starting');
  const attention = stalled.length > 0 ? [{
    key: 'stalled',
    label: `${stalled.length} AI camera${stalled.length === 1 ? '' : 's'} selected but not running`,
    onClick: () => { setQuery(''); setShow('running'); setSelectedId(stalled[0].id); },
  }] : [];
  const inactiveCameras = filtered.filter((camera) => !camera.ai?.enabled);

  const updateCamera = async (camera, patch) => {
    setSavingId(camera.id);
    setError('');
    try {
      const payload = await aiService.updateCameraAiLifecycle(camera.id, patch);
      const nextCamera = payload.data;
      setRows((prev) => prev.map((item) => item.id === camera.id ? nextCamera : item));
      setSelectedId(nextCamera.id);
      if (payload.reconcile && payload.reconcile.ok === false) {
        setError(payload.reconcile.error || 'AI service did not start. Retry after checking AI service.');
      }
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Could not update this camera.');
    } finally {
      setSavingId('');
    }
  };

  const enableCamera = (camera, overrides = {}) => updateCamera(camera, {
    enabled: true,
    mode: 'continuous',
    fps: camera.ai?.fps || 4,
    purpose: camera.ai?.purpose || inferPurpose(camera),
    priority: camera.ai?.priority || 'normal',
    unknownAlerts: camera.ai?.unknownAlerts !== false,
    watchlistAlerts: camera.ai?.watchlistAlerts !== false,
    journeyMapping: camera.ai?.journeyMapping !== false,
    ...overrides,
  });

  const disableCamera = (camera) => updateCamera(camera, {
    enabled: false,
    mode: 'off',
    fps: camera.ai?.fps || 4,
    purpose: camera.ai?.purpose || '',
    priority: camera.ai?.priority || 'normal',
    unknownAlerts: camera.ai?.unknownAlerts !== false,
    watchlistAlerts: camera.ai?.watchlistAlerts !== false,
    journeyMapping: camera.ai?.journeyMapping !== false,
  });

  return (
    <div className="h-full min-h-0 w-full">
      <div className="flex h-full w-full flex-col gap-4">
        {/* No heading here — Camera Setup's tab strip names the section. */}
        <PageToolbar
          actions={(
            <Button variant="outline" onClick={load} type="button">
              <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
          )}
        >
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search camera, site or area…"
              aria-label="Search cameras"
              className="bg-surface pl-9 pr-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <PageTabs tabs={SHOW_TABS} active={show} onChange={setShow} />
        </PageToolbar>

        <PageAttention items={attention} className="shrink-0" />

        {/* Poll every 8 s: a failure after cameras have loaded keeps the
            list and shows the strip; a failure with nothing loaded gets the
            error card. TEMP-PREVIEW: isEmptyPreview() is dev-only. */}
        {isEmptyPreview() || (loaded && !loadError && rows.length === 0) ? (
          <NoAiCamerasState onNavigate={onNavigate} />
        ) : loadError && rows.length === 0 ? (
          <SetupErrorState
            title="Couldn't load AI detection"
            description="There was a problem connecting to the server."
            onRetry={load}
          />
        ) : (
        <>
        {error || loadError ? (
          <div className="shrink-0 rounded-xl border border-warning-line bg-warning-soft px-4 py-3 text-body font-medium text-warning-ink">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error || loadError}
            </div>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            <div className="shrink-0 border-b border-line p-4">
              <h3 className="text-body font-semibold text-fg">Camera lifecycle</h3>
              <p className="mt-1 text-small text-fg-muted">Start, pause, update, or remove cameras from continuous AI detection.</p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {loading && rows.length === 0 ? (
                <div className="grid min-h-[360px] place-items-center">
                  <Loader2 className="h-8 w-8 animate-spin text-brand" />
                </div>
              ) : (
                <div className="grid gap-4">
                  {show !== 'available' && (
                  <LifecycleBlock
                    cameras={activeCameras}
                    empty="No cameras are running AI detection yet."
                    onSelect={setSelectedId}
                    onEnable={enableCamera}
                    onDisable={disableCamera}
                    savingId={savingId}
                    selectedId={selected?.id}
                    title="Running AI detection"
                  />
                  )}

                  {show !== 'running' && (
                  <LifecycleBlock
                    cameras={inactiveCameras}
                    empty="No more cameras available."
                    onSelect={setSelectedId}
                    onEnable={enableCamera}
                    onDisable={disableCamera}
                    savingId={savingId}
                    selectedId={selected?.id}
                    title="Available cameras"
                  />
                  )}
                </div>
              )}
            </div>
          </section>

          <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            <div className="shrink-0 border-b border-line p-4">
              <h3 className="text-body font-semibold text-fg">Detection settings</h3>
              <p className="mt-1 text-small text-fg-muted">Choose how this camera should behave when AI is enabled.</p>
            </div>

            {selected ? (
              <CameraEditor
                camera={selected}
                onEnable={enableCamera}
                onDisable={disableCamera}
                saving={savingId === selected.id}
              />
            ) : (
              <div className="grid flex-1 place-items-center p-8 text-center text-body text-fg-muted">
                Select a camera to configure AI detection.
              </div>
            )}
          </aside>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

function NoAiCamerasState({ onNavigate }) {
  return (
    <SetupEmptyState
      illustration="ai"
      title="No cameras to run AI on"
      description="AI detection runs on your cameras. Add a camera or connect a recorder first, then come back to choose which feeds to watch."
      action={onNavigate ? (
        <Button onClick={() => onNavigate('cameras')}>Go to Cameras</Button>
      ) : null}
      secondary={onNavigate ? (
        <Button variant="outline" onClick={() => onNavigate('devices')}>Connect a recorder</Button>
      ) : null}
      steps={[
        { title: 'Add cameras',     detail: 'Connect a recorder or add IP cameras.' },
        { title: 'Pick feeds',      detail: 'Choose gates, reception and restricted areas.' },
        { title: 'Set alerts',      detail: 'Decide which detections raise an alert.' },
      ]}
    />
  );
}

function LifecycleBlock({ title, cameras, empty, selectedId, savingId, onSelect, onEnable, onDisable }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-small font-semibold uppercase tracking-wide text-fg-muted">{title}</p>
        <span className="rounded-full bg-surface-muted px-2 py-1 text-caption font-medium text-fg-muted">{cameras.length}</span>
      </div>
      {cameras.length ? (
        <div className="grid gap-2">
          {cameras.map((camera) => (
            <CameraLifecycleRow
              camera={camera}
              key={camera.id}
              onDisable={onDisable}
              onEnable={onEnable}
              onSelect={onSelect}
              saving={savingId === camera.id}
              selected={selectedId === camera.id}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-line bg-surface-sunken px-4 py-8 text-center text-body font-medium text-fg-subtle">
          {empty}
        </div>
      )}
    </div>
  );
}

function CameraLifecycleRow({ camera, selected, saving, onSelect, onEnable, onDisable }) {
  const enabled = camera.ai?.enabled;
  const status = lifecycleCopy(camera.lifecycle);
  return (
    <article
      className={`rounded-lg border p-3 transition ${
        selected ? 'border-brand-line bg-brand-soft/40' : 'border-line bg-surface hover:border-line-strong'
      }`}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(camera.id)} type="button">
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${status.dot}`} />
            <div className="min-w-0">
              <p className="truncate text-body font-semibold text-fg">{camera.name}</p>
              <p className="mt-0.5 truncate text-small font-medium text-fg-muted">
                {camera.groupName || 'Standalone'}{camera.channel ? ` / Ch ${camera.channel}` : ''}
              </p>
            </div>
          </div>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex h-8 items-center rounded-lg px-2.5 text-small font-medium ${status.className}`}>
            {status.label}
          </span>
          {enabled ? (
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-small font-medium text-fg-secondary hover:bg-surface-sunken"
              disabled={saving}
              onClick={() => onDisable(camera)}
              type="button"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="h-3.5 w-3.5" />}
              Pause
            </button>
          ) : (
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-small font-medium text-white hover:bg-brand-hover"
              disabled={saving}
              onClick={() => onEnable(camera)}
              type="button"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
              Run AI
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function CameraEditor({ camera, saving, onEnable, onDisable }) {
  const [draft, setDraft] = useState(() => draftFromCamera(camera));

  useEffect(() => {
    setDraft(draftFromCamera(camera));
  }, [camera.id]);

  const updateDraft = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const save = () => onEnable(camera, draft);
  const remove = () => onDisable(camera);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="rounded-lg border border-line bg-surface-sunken p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface text-brand-ink">
            <Video className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-body font-semibold text-fg">{camera.name}</p>
            <p className="mt-1 text-small font-medium text-fg-muted">{camera.groupName || 'Standalone camera'}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        <Field label="Area purpose">
          <select
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-body font-medium text-fg outline-none focus:border-brand-line"
            onChange={(event) => updateDraft('purpose', event.target.value)}
            value={draft.purpose}
          >
            <option value="">Select area</option>
            {PURPOSES.map((purpose) => <option key={purpose} value={purpose}>{purpose}</option>)}
          </select>
        </Field>

        <Field label="Priority">
          <div className="grid grid-cols-3 gap-2">
            {PRIORITY.map((item) => (
              <button
                className={`h-10 rounded-lg border text-small font-medium ${
                  draft.priority === item.value
                    ? 'border-brand-line bg-brand-soft text-brand-ink'
                    : 'border-line bg-surface text-fg-secondary'
                }`}
                key={item.value}
                onClick={() => updateDraft('priority', item.value)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="AI checking speed">
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="flex items-center justify-between">
              <span className="text-body font-semibold text-fg">{draft.fps} frames/sec</span>
              <span className="text-small font-medium text-fg-subtle">Recommended: 4</span>
            </div>
            <input
              className="mt-3 w-full accent-brand"
              max="12"
              min="1"
              onChange={(event) => updateDraft('fps', Number(event.target.value))}
              type="range"
              value={draft.fps}
            />
            <p className="mt-2 text-small leading-5 text-fg-muted">
              Higher speed catches faster movement but uses more GPU tokens.
            </p>
          </div>
        </Field>

        <Field label="Face detail">
          <div className="grid grid-cols-3 gap-2">
            {[
              { value: 640, label: 'Fast' },
              { value: 960, label: 'Clear' },
              { value: 1280, label: 'Best' },
            ].map((item) => (
              <button
                className={`h-10 rounded-lg border text-small font-medium ${
                  draft.detectionInputSize === item.value
                    ? 'border-brand-line bg-brand-soft text-brand-ink'
                    : 'border-line bg-surface text-fg-secondary'
                }`}
                key={item.value}
                onClick={() => updateDraft('detectionInputSize', item.value)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Alerts and tracking">
          <div className="grid gap-2">
            <ToggleRow Icon={Bell} label="Unknown person alerts" value={draft.unknownAlerts} onChange={(v) => updateDraft('unknownAlerts', v)} />
            <ToggleRow Icon={ShieldAlert} label="Watchlist alerts" value={draft.watchlistAlerts} onChange={(v) => updateDraft('watchlistAlerts', v)} />
            <ToggleRow Icon={Route} label="Journey mapping" value={draft.journeyMapping} onChange={(v) => updateDraft('journeyMapping', v)} />
          </div>
        </Field>

        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="grid gap-2 text-small font-medium text-fg-muted">
            <InfoLine Icon={Clock} label="Mode" value={camera.ai?.enabled ? 'Continuous AI detection' : 'Not running'} />
            <InfoLine Icon={Eye} label="Runtime" value={camera.runtime?.running ? `${camera.runtime.fps.toFixed(1)} fps, ${camera.runtime.persons} people` : 'Stopped'} />
            <InfoLine Icon={SlidersHorizontal} label="Lifecycle" value={lifecycleCopy(camera.lifecycle).label} />
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2">
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand text-body font-semibold text-white hover:bg-brand-hover disabled:opacity-60"
          disabled={saving}
          onClick={save}
          type="button"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Save and run continuously
        </button>
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-danger-line bg-surface text-body font-semibold text-danger-ink hover:bg-danger-soft disabled:opacity-60"
          disabled={saving || !camera.ai?.enabled}
          onClick={remove}
          type="button"
        >
          <Trash2 className="h-4 w-4" />
          Remove from AI detection
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-caption font-semibold uppercase tracking-wide text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function ToggleRow({ Icon, label, value, onChange }) {
  return (
    <button
      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 text-left"
      onClick={() => onChange(!value)}
      type="button"
    >
      <span className="flex items-center gap-2 text-body font-medium text-fg">
        <Icon className="h-4 w-4 text-fg-subtle" />
        {label}
      </span>
      <span className={`relative h-6 w-11 rounded-full transition ${value ? 'bg-brand' : 'bg-line-strong'}`}>
        <span className={`absolute top-1 h-4 w-4 rounded-full bg-surface transition ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

function InfoLine({ Icon, label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-fg-subtle" />
        {label}
      </span>
      <span className="text-right font-semibold text-fg">{value}</span>
    </div>
  );
}

function draftFromCamera(camera) {
  return {
    enabled: true,
    mode: 'continuous',
    fps: Number(camera.ai?.fps || 4),
    detectionInputSize: Number(camera.ai?.detectionInputSize || 960),
    purpose: camera.ai?.purpose || inferPurpose(camera),
    priority: camera.ai?.priority || 'normal',
    unknownAlerts: camera.ai?.unknownAlerts !== false,
    watchlistAlerts: camera.ai?.watchlistAlerts !== false,
    journeyMapping: camera.ai?.journeyMapping !== false,
  };
}

function inferPurpose(camera) {
  const text = `${camera.name || ''} ${camera.groupName || ''}`.toLowerCase();
  if (text.includes('gate') || text.includes('entrance')) return 'Main gate';
  if (text.includes('server')) return 'Server room';
  if (text.includes('reception')) return 'Reception';
  if (text.includes('cash')) return 'Cash counter';
  if (text.includes('store')) return 'Store room';
  return 'Restricted area';
}

function lifecycleCopy(status) {
  switch (status) {
    case 'detecting':
      return { label: 'Detecting', dot: 'bg-success', className: 'bg-success-soft text-success-ink' };
    case 'starting':
      return { label: 'Starting', dot: 'bg-info animate-pulse', className: 'bg-info-soft text-info-ink' };
    case 'pending':
      return { label: 'Needs retry', dot: 'bg-warning', className: 'bg-warning-soft text-warning-ink' };
    case 'attention':
      return { label: 'Attention', dot: 'bg-danger', className: 'bg-danger-soft text-danger-ink' };
    default:
      return { label: 'Off', dot: 'bg-line-strong', className: 'bg-surface-muted text-fg-muted' };
  }
}
