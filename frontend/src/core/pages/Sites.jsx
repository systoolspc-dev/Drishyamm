import { useEffect, useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Building2, Plus, RefreshCw, MoreHorizontal, Archive, ArchiveRestore,
  Trash2, Pencil, MapPin, Upload, AlertCircle, Loader2, X,
  Search, Sparkles, Check,
} from 'lucide-react';
import { siteService } from '@/core/services/site';
import BulkImportDialog from '@/core/components/BulkImportDialog';
import { PageAttention, PageToolbar } from '@/core/layout/OperationsPage';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import { cn } from '@/core/lib/utils';
import { EmptyState } from '@/core/ui/states';
import { SetupEmptyState, SetupErrorState } from '@/core/components/SetupState';
import { isEmptyPreview } from '@/core/lib/emptyPreview'; // TEMP-PREVIEW
import { StatusBadge } from '@/core/ui/status-badge';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';
import { toneClass } from '@/core/ui/tone';

/**
 * Sites — list + manage physical locations.
 *
 * Each site groups camera_groups + (later) MediaMTX servers + AI workers.
 * The Sites page is the entry point for bulk camera onboarding — the Import
 * Cameras CTA is the primary action for any new site.
 */
/**
 * Rendered inside Camera Setup's tab strip, so it draws NO heading of its
 * own — the active tab is the section title. `summary` (fleet counts from
 * CameraSetup) feeds the AI metric and the first-run checklist; `onNavigate`
 * jumps to a sibling tab.
 */
export default function Sites({ summary, onNavigate }) {
  const queryClient = useQueryClient();
  const [sites, setSites]         = useState([]);
  const [search, setSearch]       = useState('');
  const [statusFilter, setStatus] = useState('all');
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [formSite, setFormSite]   = useState(undefined); // undefined = closed, null = create, object = edit
  const [importSite, setImport]   = useState(null);
  const [deleting, setDeleting]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await siteService.list();
      setSites(res.data || []);
      // Keep the tab-strip count (CameraSetup's ['sites'] query) in step
      // with what this page just loaded.
      queryClient.setQueryData(['sites'], res.data || []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load sites.');
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => { load(); }, [load]);

  const handleArchive = async (site) => { await siteService.archive(site.id); load(); };
  const handleRestore = async (site) => { await siteService.restore(site.id); load(); };

  const totalCameras   = sites.reduce((acc, s) => acc + (s.camerasTotal || 0), 0);
  const onlineCameras  = sites.reduce((acc, s) => acc + (s.camerasOnline || 0), 0);
  const aiOn           = summary?.aiOn;

  // Account-wide counts from CameraSetup's summary. The site totals above
  // only count cameras attached to a site through a device group, so they
  // read "0 cameras" for an account whose devices are not linked to a site
  // yet. That is not an empty account, and must not trigger first run.
  const fleetDevices = summary?.devices;
  const fleetCameras = summary?.cameras;
  const fleetKnown   = fleetDevices != null && fleetCameras != null;

  // Attention counts are ACCOUNT-wide, like the tab counts above; the site
  // cards below report each site. Cameras that no site claims are called
  // out — that gap is the thing to fix.
  const camerasShown = fleetCameras ?? totalCameras;
  const onlineShown  = summary?.camerasOnline ?? onlineCameras;
  const offlineShown = Math.max(0, camerasShown - onlineShown);
  const unlinked     = Math.max(0, camerasShown - totalCameras);

  const q = search.trim().toLowerCase();
  const visibleSites = sites.filter((s) =>
    (statusFilter === 'all' || siteStatus(s) === statusFilter)
    && (!q || s.name?.toLowerCase().includes(q) || (s.address || '').toLowerCase().includes(q)));
  const hasFilters = Boolean(q) || statusFilter !== 'all';

  // First run: a site exists but the ACCOUNT has no device and no camera.
  // Show the four setup steps with the next action instead of a row of
  // cards saying 0. Hidden until the account counts have loaded, so it never
  // flashes for an account that turns out to have cameras.
  const firstRun = !loading && !error && sites.length > 0
    && fleetKnown && fleetDevices === 0 && fleetCameras === 0;

  return (
    <div className="w-full space-y-4">
      <PageToolbar
        actions={(
          <>
            <Button variant="outline" onClick={load}>
              <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Button onClick={() => setFormSite(null)}>
              <Plus /> New site
            </Button>
          </>
        )}
      >
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sites…"
            aria-label="Search sites"
            className="bg-surface pl-9 pr-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Select value={statusFilter} onValueChange={setStatus}>
          <SelectTrigger className="w-40 bg-surface" aria-label="Filter by status"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="healthy">Healthy</SelectItem>
            <SelectItem value="degraded">Degraded</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
            <SelectItem value="unknown">No cameras</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </PageToolbar>

      {/* What needs attention, if anything. Fleet size lives in the tab strip
          and on Home; a setup page only says what is wrong. */}
      {!firstRun && (
        <PageAttention
          items={[
            offlineShown > 0 && {
              key: 'offline',
              label: `${offlineShown} camera${offlineShown === 1 ? '' : 's'} offline`,
              onClick: () => onNavigate?.('cameras', { status: 'offline' }),
            },
            unlinked > 0 && {
              key: 'unlinked',
              label: `${unlinked} camera${unlinked === 1 ? '' : 's'} not linked to a site`,
              onClick: () => onNavigate?.('devices'),
            },
          ]}
        />
      )}

      {firstRun && (
        <SetupChecklist
          steps={[
            {
              label: 'Create a site',
              detail: sites.map((s) => s.name).slice(0, 2).join(', '),
              done: true,
            },
            {
              label: 'Add a recorder or camera device',
              detail: 'NVR, DVR or IP camera. Channels are found automatically.',
              done: fleetDevices > 0,
              action: <Button size="sm" onClick={() => onNavigate?.('devices')}><Plus /> Add device</Button>,
            },
            {
              label: 'Import cameras into the site',
              detail: 'Pick channels from the device, or paste a CSV.',
              done: fleetCameras > 0,
              action: <Button size="sm" onClick={() => setImport(sites[0])}><Upload /> Import cameras</Button>,
            },
            {
              label: 'Turn on AI detection',
              detail: 'Choose gates, reception and restricted areas.',
              done: (aiOn || 0) > 0,
              action: <Button size="sm" variant="outline" onClick={() => onNavigate?.('ai-detection')}>Open AI Detection</Button>,
            },
          ]}
        />
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {/* Loading, failed and empty are three different answers and never
          share a screen: an empty state after a failed request would tell
          the operator they have no sites when we simply could not ask. */}
      {/* Loading, failed and empty are three different answers and never
          share a screen. TEMP-PREVIEW: isEmptyPreview() is dev-only. */}
      {isEmptyPreview() ? (
        <NoSitesState onCreate={() => setFormSite(null)} />
      ) : error ? (
        <SetupErrorState
          title="Couldn't load sites"
          description="There was a problem connecting to the server."
          onRetry={load}
        />
      ) : loading && sites.length === 0 ? (
        <SkeletonList />
      ) : sites.length === 0 ? (
        <NoSitesState onCreate={() => setFormSite(null)} />
      ) : visibleSites.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No sites match"
          description="Try a different name, or clear the filters."
          action={hasFilters ? (
            <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatus('all'); }}>
              Clear filters
            </Button>
          ) : null}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleSites.map((s) => (
            <SiteCard
              key={s.id}
              site={s}
              onImport={() => setImport(s)}
              onEdit={() => setFormSite(s)}
              onArchive={() => handleArchive(s)}
              onRestore={() => handleRestore(s)}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </div>
      )}

      {formSite !== undefined && (
        <SiteFormDialog
          site={formSite}
          onClose={() => setFormSite(undefined)}
          onCreated={(site) => {
            setFormSite(undefined);
            load();
            setImport(site);   // push straight into bulk-import flow
          }}
          onUpdated={() => { setFormSite(undefined); load(); }}
        />
      )}

      {importSite && (
        <BulkImportDialog
          site={importSite}
          onClose={() => setImport(null)}
          onDone={() => { setImport(null); load(); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(v) => { if (!v) setDeleting(null); }}
        title="Delete site"
        description={deleting ? <>Delete <b>{deleting.name}</b>? Camera groups must be empty first. This cannot be undone.</> : null}
        confirmLabel="Delete"
        onConfirm={async () => {
          await siteService.remove(deleting.id);
          setDeleting(null);
          load();
        }}
      />
    </div>
  );
}

/* ─────────────────────────── pieces ─────────────────────────── */

function NoSitesState({ onCreate }) {
  return (
    <SetupEmptyState
      illustration="site"
      title="No sites configured"
      description="Create your first site to start setting up cameras, recorder devices and AI detection."
      action={<Button onClick={onCreate}><Plus /> Create site</Button>}
      steps={[
        { title: 'Create a site', detail: 'Add a site to organize your cameras and devices.' },
        { title: 'Add devices',   detail: 'Connect recorders or NVRs to the site.' },
        { title: 'Add cameras',   detail: 'Configure camera feeds and enable AI detection.' },
      ]}
    />
  );
}

/**
 * First-run checklist. A real sequence — site → device → cameras → AI — so
 * the steps are numbered; the first unfinished step carries the action.
 */
function SetupChecklist({ steps }) {
  // Strictly sequential: a step counts as done only when every step before
  // it is, so "Turn on AI detection" can never carry a tick above an
  // unfinished "Import cameras".
  const done = steps.map((_, i) => steps.slice(0, i + 1).every((s) => s.done));
  const nextIndex = done.findIndex((d) => !d);
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm" aria-label="Setup steps">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-heading text-fg">Set up in four steps</h2>
          <p className="mt-0.5 text-small text-fg-muted">Finish these once and this page becomes your fleet overview.</p>
        </div>
      </div>
      <ol className="mt-3 grid gap-x-6 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, i) => {
          const isNext = i === nextIndex;
          return (
            <li key={step.label} className="flex items-start gap-3 border-t border-line-subtle py-3">
              <span
                className={cn(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full border text-caption font-bold',
                  done[i]
                    ? 'border-success-line bg-success-soft text-success-ink'
                    : isNext ? 'border-brand bg-brand text-white' : 'border-line bg-surface text-fg-muted',
                )}
              >
                {done[i] ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </span>
              <div className="min-w-0">
                <p className={cn('text-body font-semibold', done[i] ? 'text-fg-muted line-through' : 'text-fg')}>
                  {step.label}
                </p>
                {step.detail ? <p className="mt-0.5 text-small text-fg-muted">{step.detail}</p> : null}
                {isNext && step.action ? <div className="mt-2">{step.action}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Healthy / Degraded / Offline / No cameras — derived from the same ratio
 *  the mini-stats already computed, just surfaced as a real status badge so
 *  a site's state reads the same way a camera's or a device's does. */
function siteStatus(site) {
  if (site.status === 'archived') return 'archived';
  if (!site.camerasTotal) return 'unknown';
  if (site.camerasOnline >= site.camerasTotal) return 'healthy';
  if (site.camerasOnline > 0) return 'degraded';
  return 'offline';
}

const SITE_STATUS_LABEL = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'No cameras',
  archived: 'Archived',
};

function SiteCard({ site, onImport, onEdit, onArchive, onRestore, onDelete }) {
  const [menuOpen, setMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const archived = site.status === 'archived';
  const status = siteStatus(site);
  const onlineRatio = site.camerasTotal > 0
    ? Math.round((site.camerasOnline / site.camerasTotal) * 100)
    : 0;

  return (
    <div className={`rounded-xl border border-line bg-surface p-4 transition hover:border-brand/40 hover:shadow-md ${archived ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-heading text-fg">{site.name}</h3>
          {site.address && (
            <div className="mt-0.5 flex items-center gap-1 truncate text-small text-fg-muted">
              <MapPin size={11} className="shrink-0" /> {site.address}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge status={status} label={SITE_STATUS_LABEL[status]} size="sm" />
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenu((v) => !v)}
              aria-label="Site actions"
              className="rounded-md p-1.5 text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-10 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-line bg-popover shadow-xl">
                <MenuItem icon={Pencil} onClick={() => { setMenu(false); onEdit(); }}>Edit</MenuItem>
                {archived ? (
                  <MenuItem icon={ArchiveRestore} onClick={() => { setMenu(false); onRestore(); }}>Restore</MenuItem>
                ) : (
                  <MenuItem icon={Archive} onClick={() => { setMenu(false); onArchive(); }}>Archive</MenuItem>
                )}
                <MenuItem icon={Trash2} danger onClick={() => { setMenu(false); onDelete(); }}>Delete</MenuItem>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-small">
        <Mini label="Devices" value={site.groupsCount} />
        <Mini label="Cameras" value={site.camerasTotal} />
        <Mini
          label="Online"
          value={`${onlineRatio}%`}
          tone={onlineRatio >= 100 ? 'success' : onlineRatio > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <button
        onClick={onImport}
        disabled={archived}
        className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md border border-brand-line bg-brand-soft px-3 py-2 text-small font-bold text-brand-ink transition hover:bg-brand/10 disabled:opacity-40"
      >
        <Upload size={12} /> Import cameras
      </button>
    </div>
  );
}

function MenuItem({ icon: Icon, children, danger, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-body transition ${
        danger ? 'text-danger-ink hover:bg-danger-soft' : 'text-fg hover:bg-surface-sunken'
      }`}
    >
      {Icon && <Icon size={14} />} {children}
    </button>
  );
}

function Mini({ label, value, tone = 'neutral' }) {
  return (
    <div className="rounded-md border border-line-subtle bg-surface-sunken px-2 py-1.5">
      <div className="text-micro uppercase text-fg-muted">{label}</div>
      <div className={`font-semibold ${tone === 'neutral' ? 'text-fg' : toneClass(tone, 'text')}`}>{value}</div>
    </div>
  );
}

/* ─────────────────────────── Create / edit drawer ──────────────────────────
   Right-side slide-in drawer. Doesn't dim or blur the page — only a
   thin transparent layer to capture click-outside. Animates in with a
   subtle slide. Closing slides out before unmounting. Same component
   handles both create (site=null) and edit (site=<record>).
*/

function SiteFormDialog({ site, onClose, onCreated, onUpdated }) {
  const isEdit = Boolean(site);
  const [name, setName]    = useState(site?.name || '');
  const [address, setAddr] = useState(site?.address || '');
  const [busy, setBusy]    = useState(false);
  const [err, setErr]      = useState(null);
  const [visible, setVisible] = useState(false);   // controls slide-in
  const [closing, setClosing] = useState(false);   // controls slide-out

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    const onKey = (e) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    setVisible(false);
    setTimeout(onClose, 220);   // matches the CSS duration below
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try {
      if (isEdit) {
        await siteService.update(site.id, { name, address: address || null });
        onUpdated?.();
      } else {
        const res = await siteService.create({ name, address: address || null });
        onCreated?.(res.data);
      }
    } catch (e) {
      setErr(e?.response?.data?.message || `Could not ${isEdit ? 'update' : 'create'} site.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* Click-catcher — invisible, just for click-outside-to-close.
          NO blur, NO dim, page stays fully visible behind. */}
      <div
        className="absolute inset-0 pointer-events-auto"
        onClick={requestClose}
        aria-hidden="true"
      />

      {/* Drawer — slides in from the right */}
      <form
        onSubmit={submit}
        className={`absolute top-0 right-0 h-full w-full sm:w-[420px] bg-surface border-l border-line shadow-2xl shadow-black/40 pointer-events-auto flex flex-col transform transition-transform duration-200 ease-out ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-line flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="p-1.5 rounded-md bg-brand-soft text-brand ring-1 ring-brand-line shrink-0">
              <Building2 size={14} />
            </div>
            <div className="min-w-0">
              <h2 className="text-heading text-fg leading-tight">
                {isEdit ? 'Edit site' : 'Create site'}
              </h2>
              <p className="text-small text-fg-muted leading-tight">
                A physical location for your cameras.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            className="shrink-0 p-1.5 rounded-md hover:bg-surface-sunken text-fg-muted hover:text-fg transition"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 flex-1 overflow-y-auto">
          <p className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">Site information</p>

          <Field label="Site name">
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mumbai HQ"
              className="w-full rounded-lg border border-line bg-background px-3 py-2.5 text-fg placeholder:text-fg-subtle transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
              required
            />
          </Field>

          <Field label="Location" optional>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="Street, city, country"
              className="w-full rounded-lg border border-line bg-background px-3 py-2.5 text-fg placeholder:text-fg-subtle transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            />
          </Field>

          {err && (
            <div className="flex items-start gap-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-body text-danger-ink">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <p className="leading-snug">{err}</p>
            </div>
          )}

          {!isEdit && (
            <p className="text-small leading-relaxed text-fg-muted">
              After creating, you'll go straight to bulk camera import — paste a CSV
              with NVR / IP camera details and we provision them all at once.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line bg-surface-sunken flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={requestClose}
            className="px-3 py-2 rounded-lg text-body text-fg-muted transition hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-body font-semibold text-white transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : isEdit ? <Pencil size={14} /> : <Plus size={14} />}
            {isEdit ? 'Save changes' : 'Create site'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, optional, children }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-micro font-semibold uppercase tracking-wide text-fg-muted">
          {label}
        </label>
        {optional && <span className="text-micro text-fg-subtle">optional</span>}
      </div>
      {children}
    </div>
  );
}

/* ─────────────────────────── loading skeleton ─────────────────────────── */

function SkeletonList() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl border border-line bg-surface p-4">
          <div className="h-4 w-1/2 rounded bg-surface-muted" />
          <div className="mt-2 h-3 w-1/3 rounded bg-surface-muted" />
          <div className="mt-4 grid grid-cols-3 gap-2">
            <div className="h-10 rounded-md border border-line-subtle bg-surface-sunken" />
            <div className="h-10 rounded-md border border-line-subtle bg-surface-sunken" />
            <div className="h-10 rounded-md border border-line-subtle bg-surface-sunken" />
          </div>
          <div className="mt-4 h-9 rounded-md bg-surface-muted/70" />
        </div>
      ))}
    </div>
  );
}
