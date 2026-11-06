import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/core/ui/card';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/core/ui/dialog';
import {
  Plus, Pencil, Trash2, Camera, Search, X, AlertCircle, CheckCircle2,
  Eye, EyeOff, Cctv, RefreshCw,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  useCameras, useAddCamera, useUpdateCamera, useDeleteCamera, useGroups,
} from '@/core/hooks/useQueries';
import { PageAttention, PageToolbar } from '@/core/layout/OperationsPage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/core/ui/table';
import { cn } from '@/core/lib/utils';
import { EmptyState } from '@/core/ui/states';
import { SetupEmptyState, SetupErrorState } from '@/core/components/SetupState';
import { isEmptyPreview } from '@/core/lib/emptyPreview'; // TEMP-PREVIEW
import { StatusBadge } from '@/core/ui/status-badge';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';

// ─── Constants ────────────────────────────────────────────────────────────────
const VIDEO_TYPES = [
  { value: 'h264',  label: 'H.264' },
  { value: 'h265',  label: 'H.265' },
  { value: 'mjpeg', label: 'MJPEG' },
];

const PROTOCOLS = [
  { value: 'rtsp',  label: 'RTSP' },
  { value: 'http',  label: 'HTTP' },
  { value: 'onvif', label: 'ONVIF' },
];

const defaultForm = {
  name: '', host: '', port: '554', path: '',
  type: 'h264', protocol: 'rtsp',
  username: '', password: '',
  width: '1920', height: '1080', fps: '30',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const cameraStatus = (camera) => (camera.mode === 'start' ? 'online' : 'offline');

// Build monitorId → parent group map from groups list
function buildParentMap(groups) {
  const map = {};
  groups.forEach(g => {
    (g.cameras || []).forEach(c => {
      map[c.monitorId] = { groupId: g.id, groupName: g.name, deviceType: g.deviceType };
    });
  });
  return map;
}

// ─── Notification ─────────────────────────────────────────────────────────────
function Notification({ note, onDismiss }) {
  if (!note) return null;
  const isError = note.type === 'error';
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-body mb-4
      ${isError ? 'bg-danger-soft border-danger-line text-danger-ink' : 'bg-success-soft border-success-line text-success-ink'}`}>
      {isError
        ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-danger" />
        : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-success" />
      }
      <span className="flex-1">{note.message}</span>
      <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Add / Edit Dialog ────────────────────────────────────────────────────────
function CameraFormDialog({ open, editingCamera, onClose, onSaved, onNotify }) {
  const addMut    = useAddCamera();
  const updateMut = useUpdateCamera();

  const [form, setForm]           = useState(defaultForm);
  const [showPass, setShowPass]   = useState(false);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setShowPass(false);
    setShowAdvanced(false);
    if (editingCamera) {
      setForm({
        name:     editingCamera.name     || '',
        host:     editingCamera.host     || '',
        port:     String(editingCamera.port || 554),
        path:     editingCamera.path     || '',
        type:     editingCamera.type     || 'h264',
        protocol: editingCamera.protocol || 'rtsp',
        username: editingCamera.username || '',
        password: '', // Never pre-fill — user must re-enter to change
        width:    String(editingCamera.width  || 1920),
        height:   String(editingCamera.height || 1080),
        fps:      String(editingCamera.fps    || 30),
      });
    } else {
      setForm(defaultForm);
    }
  }, [open, editingCamera]);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const canSave = !!(form.name.trim() && form.host.trim() && form.username.trim());

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editingCamera) {
        const body = { ...form };
        // Only send password if user typed a new one — never expose existing
        if (!body.password.trim()) delete body.password;
        await updateMut.mutateAsync({ monitorId: editingCamera.mid, data: body });
        onNotify({ type: 'success', message: `"${form.name}" updated successfully.` });
      } else {
        await addMut.mutateAsync({
          ...form,
          mid: crypto.randomUUID().replace(/-/g, '').slice(0, 24),
        });
        onNotify({ type: 'success', message: `"${form.name}" added and streaming.` });
      }
      onSaved();
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to save camera. Check the connection details.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md max-h-[calc(var(--app-vh)*0.9)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-heading font-semibold text-fg">
            {editingCamera ? 'Edit Camera' : 'Add IP Camera'}
          </DialogTitle>
          <p className="text-body text-fg-muted mt-0.5">
            {editingCamera
              ? `Update connection details for ${editingCamera.name}`
              : 'Connect a standalone IP camera directly via RTSP or HTTP.'
            }
          </p>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Name */}
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">
              Camera Name <span className="text-danger">*</span>
            </label>
            <Input
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder='e.g. "Front Door", "Server Room"'
              autoFocus
            />
          </div>

          {/* Protocol */}
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">Protocol</label>
            <div className="flex gap-2">
              {PROTOCOLS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => set('protocol', p.value)}
                  className={`flex-1 py-2 rounded-lg border-2 text-small font-semibold transition-all
                    ${form.protocol === p.value
                      ? 'border-brand bg-brand-soft text-brand'
                      : 'border-line text-fg-secondary hover:border-line-strong'
                    }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Video codec */}
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">Video Codec</label>
            <div className="flex gap-2">
              {VIDEO_TYPES.map(t => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => set('type', t.value)}
                  className={`flex-1 py-2 rounded-lg border-2 text-small font-semibold transition-all
                    ${form.type === t.value
                      ? 'border-brand bg-brand-soft text-brand'
                      : 'border-line text-fg-secondary hover:border-line-strong'
                    }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* IP + Port */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-body font-medium text-fg-secondary mb-1.5">
                IP Address <span className="text-danger">*</span>
              </label>
              <Input
                value={form.host}
                onChange={e => set('host', e.target.value)}
                placeholder="192.168.1.100"
              />
            </div>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">Port</label>
              <Input
                value={form.port}
                onChange={e => set('port', e.target.value)}
                placeholder="554"
              />
            </div>
          </div>

          {/* Stream path */}
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">Stream Path</label>
            <Input
              value={form.path}
              onChange={e => set('path', e.target.value)}
              placeholder="/stream1  or  /h264/ch1/main/av_stream"
            />
            <p className="text-small text-fg-subtle mt-1">
              RTSP path after the IP — e.g. <code className="bg-surface-muted px-1 rounded">/stream1</code>
            </p>
          </div>

          {/* Credentials */}
          <div className="border border-line rounded-xl p-4 space-y-3">
            <p className="text-small font-semibold text-fg-muted uppercase tracking-wider">Credentials</p>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">
                Username <span className="text-danger">*</span>
              </label>
              <Input
                value={form.username}
                onChange={e => set('username', e.target.value)}
                placeholder="admin"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">
                Password
                {editingCamera && (
                  <span className="text-fg-subtle font-normal ml-1">(leave blank to keep current)</span>
                )}
              </label>
              <div className="relative">
                <Input
                  type={showPass ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  placeholder={editingCamera ? 'Enter new password to change' : 'Camera password'}
                  className="pr-9"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* Advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            className="text-small text-fg-subtle hover:text-fg-secondary flex items-center gap-1 transition-colors"
          >
            {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {showAdvanced ? 'Hide' : 'Show'} advanced settings (resolution, FPS)
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-3 gap-3 border border-line rounded-xl p-3 bg-surface-sunken">
              <div>
                <label className="block text-small font-medium text-fg-secondary mb-1.5">Width px</label>
                <Input value={form.width}  onChange={e => set('width',  e.target.value)} placeholder="1920" className="text-body h-8" />
              </div>
              <div>
                <label className="block text-small font-medium text-fg-secondary mb-1.5">Height px</label>
                <Input value={form.height} onChange={e => set('height', e.target.value)} placeholder="1080" className="text-body h-8" />
              </div>
              <div>
                <label className="block text-small font-medium text-fg-secondary mb-1.5">FPS</label>
                <Input value={form.fps}    onChange={e => set('fps',    e.target.value)} placeholder="30"   className="text-body h-8" />
              </div>
            </div>
          )}

          {error && (
            <div className="bg-danger-soft border border-danger-line rounded-xl p-3 text-body text-danger-ink flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="flex-row gap-2 mt-4">
          <Button variant="outline" onClick={onClose} disabled={saving} className="flex-1 sm:flex-none">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="bg-brand hover:bg-brand-hover text-white flex-1 sm:flex-none"
          >
            {saving
              ? <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving…
                </span>
              : editingCamera ? 'Save Changes' : 'Add Camera'
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Camera table, grouped by device ──────────────────────────────────────────
// A table, not card rows: at fleet size (40+ feeds) the eye scans columns —
// name, source, device, status — and a card per camera hid that behind
// three lines of mixed metadata each. Groups stay collapsible.
function CameraTable({ sections, standalone, total, hasFilters, onEdit, onDelete }) {
  const shown = sections.reduce((s, x) => s + x.cameras.length, 0) + standalone.length;
  const groupCount = sections.length + (standalone.length > 0 ? 1 : 0);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-surface-sunken">
            <TableHead className="pl-4">Camera</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Device</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-20 pr-3 text-right"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.map((section) => (
            <CameraGroupRows
              key={section.groupId}
              title={section.groupName}
              subtitle={section.deviceType || 'NVR/DVR'}
              cameras={section.cameras}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
          {standalone.length > 0 && (
            <CameraGroupRows
              title="Direct IP cameras"
              subtitle="Not attached to a recorder"
              cameras={standalone}
              deviceLabel="—"
              onEdit={onEdit}
              onDelete={onDelete}
            />
          )}
        </TableBody>
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle px-4 py-2.5 text-small text-fg-muted">
        <span>
          {hasFilters
            ? `Showing ${shown} of ${total} cameras`
            : `${total} camera${total === 1 ? '' : 's'} in ${groupCount} group${groupCount === 1 ? '' : 's'}`}
        </span>
        <span>Stream quality and recording retention are set per device, under Devices.</span>
      </div>
    </div>
  );
}

function CameraGroupRows({ title, subtitle, cameras, deviceLabel, onEdit, onDelete }) {
  const [open, setOpen] = useState(true);
  const online  = cameras.filter(c => c.mode === 'start').length;
  const offline = cameras.length - online;
  return (
    <>
      <TableRow className="bg-surface-sunken hover:bg-surface-muted">
        <TableCell colSpan={5} className="p-0">
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2 text-left"
          >
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-fg-subtle" /> : <ChevronRight className="h-4 w-4 shrink-0 text-fg-subtle" />}
            <Cctv className="h-4 w-4 shrink-0 text-brand" />
            <span className="text-body font-semibold text-fg">{title}</span>
            <span className="text-small text-fg-muted">
              <span className="capitalize">{subtitle}</span>
              {' · '}{cameras.length} camera{cameras.length !== 1 ? 's' : ''}
              {' · '}<span className="text-success-ink">{online} online</span>
              {offline > 0 && <>{' · '}<span className="text-danger-ink">{offline} offline</span></>}
            </span>
          </button>
        </TableCell>
      </TableRow>
      {open && cameras.map(cam => (
        <CameraTableRow key={cam.mid} camera={cam} deviceLabel={deviceLabel ?? title} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </>
  );
}

function CameraTableRow({ camera, deviceLabel, onEdit, onDelete }) {
  const isOnline = camera.mode === 'start';
  const detail = [
    camera.width && camera.height ? `${camera.width}×${camera.height}` : null,
    camera.type ? String(camera.type).toUpperCase() : null,
  ].filter(Boolean).join(' · ');
  return (
    <TableRow>
      <TableCell className="pl-4">
        <div className="flex items-center gap-2.5">
          <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-md', isOnline ? 'bg-brand-soft text-brand' : 'bg-surface-muted text-fg-subtle')}>
            <Camera className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-body font-semibold text-fg">{camera.name}</p>
            {detail ? <p className="text-caption text-fg-subtle">{detail}</p> : null}
          </div>
        </div>
      </TableCell>
      <TableCell>
        {/* Connection string — no credentials, just host/path */}
        <span className="font-mono text-small text-fg-muted">
          {camera.protocol || 'rtsp'}://{camera.host}:{camera.port || 554}{camera.path || ''}
        </span>
      </TableCell>
      <TableCell className="text-fg-secondary">{deviceLabel}</TableCell>
      <TableCell><StatusBadge status={cameraStatus(camera)} size="sm" /></TableCell>
      <TableCell className="pr-3">
        <div className="flex items-center justify-end gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={() => onEdit(camera)} aria-label={`Edit ${camera.name}`} className="text-fg-subtle hover:text-fg">
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onDelete(camera)} aria-label={`Delete ${camera.name}`} className="text-fg-subtle hover:bg-danger-soft hover:text-danger-ink">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function SkeletonSection() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 animate-pulse space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-lg bg-line" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3.5 bg-line rounded w-1/4" />
          <div className="h-3 bg-surface-muted rounded w-1/3" />
        </div>
      </div>
      {[1, 2].map(i => (
        <div key={i} className="h-14 bg-surface-muted rounded-lg" />
      ))}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function NoCamerasState({ onAdd, onNavigate }) {
  return (
    <SetupEmptyState
      illustration="camera"
      title="No cameras connected"
      description="Add a standalone IP camera, or connect an NVR/DVR under Devices to bring in all its channels at once."
      action={<Button onClick={onAdd}><Plus /> Add camera</Button>}
      secondary={onNavigate ? (
        <Button variant="outline" onClick={() => onNavigate('devices')}>Connect a recorder</Button>
      ) : null}
      steps={[
        { title: 'Add a camera',     detail: 'Enter the stream address, or connect a recorder.' },
        { title: 'Check the feed',   detail: 'Confirm the camera comes online and streams.' },
        { title: 'Enable AI',        detail: 'Turn on AI detection for the cameras that need it.' },
      ]}
    />
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
/**
 * Rendered inside Camera Setup's tab strip, so it draws NO heading of its
 * own. Opens straight on the toolbar; `?status=offline&device=<id>` in the
 * URL (an attention link from Sites) pre-sets the filters.
 */
export default function Cameras({ onNavigate }) {
  const { data: cameras = [], isLoading: camLoading, isError, error: fetchError, refetch: refetchCameras } = useCameras();
  const { data: groups  = [], isLoading: grpLoading, refetch: refetchGroups } = useGroups();
  const deleteMut = useDeleteCamera();

  const [formOpen,      setFormOpen]      = useState(false);
  const [editingCamera, setEditingCamera] = useState(null);
  const [deleteTarget,  setDeleteTarget]  = useState(null);
  const [search,        setSearch]        = useState('');
  const [params] = useSearchParams();
  const [statusFilter,  setStatusFilter]  = useState(() =>          // all | online | offline
    (['online', 'offline'].includes(params.get('status')) ? params.get('status') : 'all'));
  const [deviceFilter,  setDeviceFilter]  = useState(() => params.get('device') || 'all'); // all | <groupId> | standalone
  const [notification,  setNotification]  = useState(null);

  const isLoading = camLoading || grpLoading;
  const refetchAll = () => { refetchCameras(); refetchGroups(); };

  // Auto-dismiss notification
  useEffect(() => {
    if (!notification) return;
    const t = setTimeout(() => setNotification(null), 4000);
    return () => clearTimeout(t);
  }, [notification]);

  const notify = (note) => setNotification(note);

  // Build parent map and partition cameras into grouped + standalone
  const { deviceSections, standalone } = useMemo(() => {
    const parentMap = buildParentMap(groups);
    const sections  = {};
    const solo      = [];

    cameras.forEach(cam => {
      const info = parentMap[cam.mid];
      if (info) {
        if (!sections[info.groupId]) {
          sections[info.groupId] = { groupId: info.groupId, groupName: info.groupName, deviceType: info.deviceType, cameras: [] };
        }
        sections[info.groupId].cameras.push(cam);
      } else {
        solo.push(cam);
      }
    });

    return {
      deviceSections: Object.values(sections),
      standalone: solo,
    };
  }, [cameras, groups]);

  // Options for the Device filter — there's no site association on a camera
  // or its parent group, so "Site" isn't an available filter here; "Device"
  // is the real, always-present grouping instead.
  const deviceOptions = useMemo(() => ([
    { value: 'all', label: 'All devices' },
    ...deviceSections.map(s => ({ value: s.groupId, label: s.groupName })),
    ...(standalone.length > 0 ? [{ value: 'standalone', label: 'Standalone' }] : []),
  ]), [deviceSections, standalone]);

  const openAdd  = () => { setEditingCamera(null); setFormOpen(true); };
  const openEdit = (cam) => { setEditingCamera(cam); setFormOpen(true); };

  // ConfirmDialog owns busy/error state — a thrown error keeps it open with
  // the message inline instead of needing a duplicate toast here.
  const handleDelete = async () => {
    await deleteMut.mutateAsync(deleteTarget.mid);
    notify({ type: 'success', message: `"${deleteTarget.name}" deleted successfully.` });
  };

  // Counts before search/filters
  const total   = cameras.length;
  const offline = cameras.filter(c => c.mode !== 'start').length;

  // Offline cameras, attributed to their device when they all sit on one, so
  // the link narrows the table to exactly those rows.
  const offlineSections   = deviceSections.filter(s => s.cameras.some(c => c.mode !== 'start'));
  const offlineStandalone = standalone.some(c => c.mode !== 'start');
  const oneDevice = offlineSections.length === 1 && !offlineStandalone ? offlineSections[0] : null;
  const attention = offline > 0 ? [{
    key: 'offline',
    label: `${offline} camera${offline === 1 ? '' : 's'} offline${oneDevice ? ` on ${oneDevice.groupName}` : ''}`,
    onClick: () => { setSearch(''); setStatusFilter('offline'); setDeviceFilter(oneDevice ? oneDevice.groupId : 'all'); },
  }] : [];

  const q = search.trim().toLowerCase();
  const matchesQuery = (c) => !q || c.name?.toLowerCase().includes(q) || c.host?.toLowerCase().includes(q);
  const matchesStatus = (c) => statusFilter === 'all' || cameraStatus(c) === statusFilter;

  const sectionsAfterDevice = deviceFilter === 'all'
    ? deviceSections
    : deviceFilter === 'standalone' ? [] : deviceSections.filter(s => s.groupId === deviceFilter);
  const standaloneAfterDevice = deviceFilter === 'all' || deviceFilter === 'standalone' ? standalone : [];

  const filteredSections = sectionsAfterDevice
    .map(s => {
      // A query can match an individual camera OR the device's own name
      // ("NVR-01" should surface all its channels) — status still applies
      // on top, so an active status filter never shows the wrong-status ones.
      const deviceNameMatches = q && s.groupName.toLowerCase().includes(q);
      const cams = s.cameras.filter(c => matchesStatus(c) && (matchesQuery(c) || deviceNameMatches));
      return { ...s, cameras: cams };
    })
    .filter(s => s.cameras.length > 0);

  const filteredStandalone = standaloneAfterDevice.filter(c => matchesQuery(c) && matchesStatus(c));

  const hasFilters = Boolean(q) || statusFilter !== 'all' || deviceFilter !== 'all';
  const hasResults = filteredSections.length > 0 || filteredStandalone.length > 0;

  return (
    <div className="flex w-full flex-col gap-4">
      <PageToolbar
        actions={(
          <>
            <Button variant="outline" onClick={refetchAll}>
              <RefreshCw className={isLoading ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Button onClick={openAdd}>
              <Plus /> Add camera
            </Button>
          </>
        )}
      >
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or IP…"
            aria-label="Search cameras"
            className="bg-surface pl-9 pr-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36 bg-surface" aria-label="Filter by status"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="online">Online</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
          </SelectContent>
        </Select>
        {deviceOptions.length > 2 && (
          <Select value={deviceFilter} onValueChange={setDeviceFilter}>
            <SelectTrigger className="w-44 bg-surface" aria-label="Filter by device"><SelectValue placeholder="Device" /></SelectTrigger>
            <SelectContent>
              {deviceOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </PageToolbar>

      {notification && <Notification note={notification} onDismiss={() => setNotification(null)} />}

      {/* Error stops here — it used to fall through to "No cameras connected"
          underneath the error banner, reading as though the account had
          genuinely never had a camera. */}
      {isEmptyPreview() ? (
        <NoCamerasState onAdd={openAdd} onNavigate={onNavigate} />
      ) : isError ? (
        <SetupErrorState
          title="Couldn't load cameras"
          description={fetchError?.message || 'We couldn’t retrieve camera information. Check your connection and try again.'}
          onRetry={refetchAll}
        />
      ) : isLoading ? (
        <div className="space-y-4">
          <SkeletonSection />
          <SkeletonSection />
        </div>
      ) : total === 0 ? (
        <NoCamerasState onAdd={openAdd} onNavigate={onNavigate} />
      ) : (
        <>
          {/* What needs attention, if anything. Fleet size lives in the tab
              strip; the group rows below carry their own online/offline. */}
          <PageAttention items={attention} />

          {/* ── Camera list ── */}
          {!hasResults ? (
            <EmptyState
              icon={Search}
              title="No cameras match these filters"
              description="Try a different name or IP, or clear the filters."
              action={(
                <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter('all'); setDeviceFilter('all'); }}>
                  Clear filters
                </Button>
              )}
            />
          ) : (
            <CameraTable
              sections={filteredSections}
              standalone={filteredStandalone}
              total={total}
              hasFilters={hasFilters}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          )}
        </>
      )}

      {/* ── Add/Edit Dialog ── */}
      <CameraFormDialog
        open={formOpen}
        editingCamera={editingCamera}
        onClose={() => setFormOpen(false)}
        onSaved={() => setFormOpen(false)}
        onNotify={notify}
      />

      {/* ── Delete Confirm ── */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title="Delete camera"
        description={deleteTarget ? <>Delete <b>{deleteTarget.name}</b>? This will permanently remove the camera and stop its stream. This cannot be undone.</> : null}
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}
