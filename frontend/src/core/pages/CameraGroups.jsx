import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/core/ui/card';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/core/ui/dialog';
import {
  Plus, Trash2, ChevronDown, ChevronRight, Camera, MapPin, Wifi,
  Cctv, CheckCircle2, ArrowRight, ArrowLeft, RefreshCw, Pencil, AlertTriangle,
  X, Search, AlertCircle, Eye, EyeOff, Lock, WifiOff,
  Clock, Check, HardDrive, Gauge, Network,
} from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import {
  useGroups, useCreateGroup, useDeleteGroup, useSyncGroup, useUpdateGroup,
  useDeleteGroupCamera, useSetGroupRetention, useSetCameraRetention,
  useSetCamerasRetentionBulk,
  useSetGroupQuality, useSetCameraQuality, useSetCamerasQualityBulk,
} from '@/core/hooks/useQueries';
import { PageAttention, PageToolbar } from '@/core/layout/OperationsPage';
import { EmptyState } from '@/core/ui/states';
import { SetupEmptyState, SetupErrorState } from '@/core/components/SetupState';
import { isEmptyPreview } from '@/core/lib/emptyPreview'; // TEMP-PREVIEW
import { StatusBadge } from '@/core/ui/status-badge';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';

// ─── Constants ────────────────────────────────────────────────────────────────
const DEVICE_TYPES = [
  { value: 'hikvision', label: 'Hikvision', hint: '/Streaming/Channels/101, 201…' },
  { value: 'dahua',     label: 'Dahua',     hint: '/cam/realmonitor?channel=1…' },
  { value: 'cpplus',    label: 'CP Plus',   hint: '/cam/realmonitor?channel=1… (Dahua OEM)' },
  { value: 'axis',      label: 'Axis',      hint: '/axis-media/media.amp?camera=1…' },
  { value: 'generic',   label: 'Generic',   hint: 'Manual RTSP path per channel' },
];

const defaultForm = {
  name: '', host: '', port: '554', httpPort: '80',
  username: 'admin', password: '', deviceType: 'hikvision',
  totalChannels: '4', location: '',
};

// ─── Inline Notification ──────────────────────────────────────────────────────
function Notification({ note, onDismiss }) {
  if (!note) return null;
  const isError = note.type === 'error';
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-body mb-4
      ${isError
        ? 'bg-danger-soft border-danger-line text-danger-ink'
        : 'bg-success-soft border-success-line text-success-ink'
      }`}>
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

// ─── Step Wizard Indicators ───────────────────────────────────────────────────
function StepDot({ step, current, label }) {
  const done   = current > step;
  const active = current === step;
  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-body font-semibold transition-all
        ${done || active ? 'bg-brand text-white' : 'bg-line text-fg-muted'}
        ${active ? 'ring-4 ring-brand-line' : ''}`}>
        {done ? <CheckCircle2 className="w-4 h-4" /> : step}
      </div>
      <span className={`text-small font-medium truncate max-w-18 text-center
        ${active ? 'text-brand' : done ? 'text-fg-secondary' : 'text-fg-subtle'}`}>
        {label}
      </span>
    </div>
  );
}

function StepConnector({ done }) {
  return (
    <div className={`flex-1 h-0.5 mb-5 transition-all ${done ? 'bg-brand' : 'bg-line'}`} />
  );
}

// ─── Edit Group Dialog ────────────────────────────────────────────────────────
function EditGroupDialog({ group, open, onClose, onSaved, onNotify }) {
  const updateMut = useUpdateGroup();
  const syncMut   = useSyncGroup();
  const [form, setForm] = useState({});
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingMsg, setSyncingMsg] = useState('');
  const [error, setError] = useState('');

  // Reset form when dialog opens with a group
  useEffect(() => {
    if (group && open) {
      // Use actual camera count as source of truth
      const ch = group.cameras?.length ?? group.totalChannels ?? 0;
      setForm({
        name:          group.name       || '',
        host:          group.host       || '',
        port:          String(group.port || 554),
        httpPort:      String(group.httpPort || 80),
        username:      group.username   || '',
        password:      '',
        deviceType:    group.deviceType || 'hikvision',
        location:      group.location   || '',
        totalChannels: String(ch),
      });
      setError('');
      setSyncingMsg('');
      setShowPass(false);
    }
  }, [group, open]);

  if (!group) return null;

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // Source of truth: actual provisioned camera count (not stored totalChannels which may lag)
  const currentChannels = group.cameras?.length ?? group.totalChannels ?? 0;

  // Parse the channel input — blank/NaN is treated as "no change" to avoid false errors
  const rawInput    = String(form.totalChannels ?? '').trim();
  const parsedInput = rawInput === '' ? NaN : parseInt(rawInput, 10);
  const newChannels = isNaN(parsedInput) ? currentChannels : parsedInput;
  const inputBlank  = rawInput === '' || isNaN(parsedInput);

  const channelError =
    !inputBlank && newChannels < currentChannels
      ? `Cannot reduce channels — ${currentChannels} cameras already exist. Delete cameras individually to remove them.`
    : !inputBlank && newChannels > 64
      ? 'Maximum 64 channels allowed.'
    : '';

  const canSave = !!(form.name?.trim() && form.host?.trim() && form.username?.trim() && !channelError);

  const handleSave = async () => {
    setSaving(true);
    setSyncingMsg('');
    setError('');
    // Effective total: if user left input blank, keep the current count (no channels added)
    const effectiveTotal = inputBlank ? currentChannels : newChannels;
    const added = effectiveTotal - currentChannels;
    try {
      const body = {
        name:          form.name.trim(),
        host:          form.host.trim(),
        port:          parseInt(form.port) || 554,
        httpPort:      parseInt(form.httpPort) || 80,
        username:      form.username.trim(),
        deviceType:    form.deviceType,
        location:      form.location.trim(),
        totalChannels: effectiveTotal,
      };
      if (form.password.trim()) body.password = form.password;
      await updateMut.mutateAsync({ groupId: group.id, body });

      // Auto-sync to refresh camera statuses after save
      if (added > 0) {
        setSyncingMsg(`Syncing ${added} new channel${added !== 1 ? 's' : ''}…`);
      }
      try {
        await syncMut.mutateAsync(group.id);
      } catch {
        // Sync failure is non-fatal — cameras already saved in backend
      }

      const msg = added > 0
        ? `"${body.name}" updated — ${added} new camera channel${added !== 1 ? 's' : ''} provisioned.`
        : `"${body.name}" updated successfully.`;
      onNotify({ type: 'success', message: msg });
      onSaved();
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to update device. Please try again.');
    } finally {
      setSaving(false);
      setSyncingMsg('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[calc(var(--app-vh)*0.9)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-heading font-semibold text-fg">
            Edit Device
          </DialogTitle>
          <p className="text-body text-fg-muted mt-0.5">
            Update connection details for <span className="font-medium text-fg-secondary">{group.name}</span>
          </p>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Name */}
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">
              Device Name <span className="text-danger">*</span>
            </label>
            <Input
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder='e.g. "Office NVR", "Warehouse Gate"'
              autoFocus
            />
          </div>

          {/* Device type */}
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">Device Type</label>
            <div className="grid grid-cols-2 gap-2">
              {DEVICE_TYPES.map(d => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => set('deviceType', d.value)}
                  className={`p-3 rounded-lg border-2 text-left transition-all
                    ${form.deviceType === d.value
                      ? 'border-brand bg-brand-soft'
                      : 'border-line hover:border-line-strong'
                    }`}
                >
                  <p className="font-medium text-body text-fg">{d.label}</p>
                  <p className="text-small text-fg-subtle mt-0.5 truncate">{d.hint}</p>
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
                placeholder="192.168.1.50"
              />
            </div>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">RTSP Port</label>
              <Input
                value={form.port}
                onChange={e => set('port', e.target.value)}
                placeholder="554"
              />
            </div>
          </div>

          {/* HTTP Port + Location */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">HTTP Port</label>
              <Input
                value={form.httpPort}
                onChange={e => set('httpPort', e.target.value)}
                placeholder="80"
              />
            </div>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">Location</label>
              <Input
                value={form.location}
                onChange={e => set('location', e.target.value)}
                placeholder="3rd Floor, Block B"
              />
            </div>
          </div>

          {/* Credentials */}
          <div className="border border-line rounded-xl p-4 space-y-3">
            <p className="text-small font-semibold text-fg-muted uppercase tracking-wider flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" /> Credentials
            </p>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">
                Username <span className="text-danger">*</span>
              </label>
              <Input
                value={form.username}
                onChange={e => set('username', e.target.value)}
                placeholder="admin"
              />
            </div>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">
                Password
                <span className="text-fg-subtle font-normal ml-1">(leave blank to keep current)</span>
              </label>
              <div className="relative">
                <Input
                  type={showPass ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  placeholder="Enter new password to change"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* ── Camera Channels ── */}
          <div className="border border-line rounded-xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-surface-sunken border-b border-line-subtle">
              <p className="text-small font-semibold text-fg-muted uppercase tracking-wider flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5" /> Camera Channels
              </p>
              <span className="text-small text-fg-subtle">
                Provisioned: <span className="font-semibold text-fg-secondary">{currentChannels}</span>
              </span>
            </div>

            <div className="p-4 space-y-3">
              {/* Zero-camera state */}
              {currentChannels === 0 && (
                <div className="flex items-start gap-2 p-3 bg-warning-soft border border-warning-line rounded-xl text-small text-warning-ink">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" />
                  <span>
                    <strong>No cameras provisioned yet.</strong> This device was created but no channels
                    were set up. Use the buttons below to add channels now.
                  </span>
                </div>
              )}

              {/* Quick-add buttons */}
              <div>
                <label className="block text-body font-medium text-fg-secondary mb-2">
                  {currentChannels === 0
                    ? 'How many cameras does this device have?'
                    : 'Total channels — increase to add more'
                  }
                </label>
                <div className="grid grid-cols-5 gap-2 mb-2">
                  {(currentChannels === 0
                    ? [1, 4, 8, 16, 32]
                    : [currentChannels, currentChannels + 1, currentChannels + 2,
                       currentChannels + 4, currentChannels + 8]
                  )
                    .filter((n, i, arr) => arr.indexOf(n) === i && n <= 64)
                    .map(n => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => set('totalChannels', String(n))}
                        className={`h-9 rounded-xl border-2 text-small font-semibold transition-all
                          ${(!inputBlank && newChannels === n) || (inputBlank && n === currentChannels)
                            ? 'border-brand bg-brand text-white'
                            : n === currentChannels && currentChannels > 0
                              ? 'border-line-strong bg-surface-sunken text-fg-muted'
                              : 'border-line text-fg-secondary hover:border-line-strong bg-surface'
                          }`}
                      >
                        {currentChannels === 0
                          ? n
                          : n === currentChannels
                            ? `${n} ✓`
                            : `+${n - currentChannels}`
                        }
                      </button>
                    ))
                  }
                </div>

                <Input
                  type="number"
                  min={currentChannels === 0 ? 1 : currentChannels}
                  max="64"
                  value={form.totalChannels}
                  onChange={e => set('totalChannels', e.target.value)}
                  placeholder={currentChannels === 0 ? 'Enter channel count (1–64)' : `Current: ${currentChannels}`}
                />

                {/* Validation & feedback messages */}
                {channelError ? (
                  <p className="text-small text-danger mt-1.5 flex items-start gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" /> {channelError}
                  </p>
                ) : !inputBlank && newChannels > currentChannels ? (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-small text-success-ink flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 shrink-0" />
                      {newChannels - currentChannels} new camera channel{newChannels - currentChannels !== 1 ? 's' : ''} will be created.
                    </p>
                    <p className="text-small text-warning-ink flex items-start gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      New cameras start as <strong>offline</strong>. They go online only when the
                      physical channel is active on the device.
                    </p>
                  </div>
                ) : inputBlank ? (
                  <p className="text-small text-fg-subtle mt-1.5">
                    Enter a number to add more channels, or leave blank to keep current ({currentChannels}).
                  </p>
                ) : (
                  <p className="text-small text-fg-subtle mt-1.5">
                    Increase the count to auto-provision additional camera channels.
                  </p>
                )}
              </div>
            </div>
          </div>

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
                  {syncingMsg || 'Saving…'}
                </span>
              : 'Save Changes'
            }
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Recording-retention inline editor ───────────────────────────────────────
// Small number input + Save. Empty value = inherit (placeholder shows the
// inherited days). Used both per-camera (inherits the group) and per-group.
const RETENTION_PRESETS = [7, 15, 30, 60, 90, 180, 365];
const retLabel = (d) => (d === 365 ? '1 year' : d === 180 ? '6 months' : `${d} days`);

function RetentionEditor({ value, inheritedDays = 30, allowInherit = false, inheritLabel = 'Inherit', onSave }) {
  const [saving, setSaving]         = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customVal, setCustomVal]   = useState('');

  const isOverride  = value != null;
  const selectValue = isOverride ? String(value) : (allowInherit ? '__inherit__' : String(inheritedDays));

  // Presets, plus the current custom value (if not already a preset) so the
  // trigger can display it.
  const options = RETENTION_PRESETS.map((d) => ({ v: String(d), label: retLabel(d) }));
  if (isOverride && !RETENTION_PRESETS.includes(Number(value))) {
    options.push({ v: String(value), label: `${value} days` });
  }

  const commit = async (days) => {
    setSaving(true);
    try { await onSave(days); } finally { setSaving(false); }
  };

  const onChange = (v) => {
    if (v === '__custom__')  { setCustomVal(isOverride ? String(value) : ''); setCustomOpen(true); return; }
    if (v === '__inherit__') { commit(null); return; }
    commit(Math.max(1, parseInt(v, 10)));
  };

  const confirmCustom = () => {
    const days = customVal === '' ? null : Math.max(1, parseInt(customVal, 10) || 30);
    setCustomOpen(false);
    commit(days);
  };

  if (customOpen) {
    return (
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Input
          type="number" min="1" autoFocus value={customVal}
          onChange={(e) => setCustomVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirmCustom(); if (e.key === 'Escape') setCustomOpen(false); }}
          placeholder="days"
          className="h-7 w-16 text-small px-2"
        />
        <button onClick={confirmCustom} title="Apply" className="text-success-ink hover:text-success-ink">
          <Check className="w-4 h-4" />
        </button>
        <button onClick={() => setCustomOpen(false)} title="Cancel" className="text-fg-subtle hover:text-fg-secondary">
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0" onClick={(e) => e.stopPropagation()} title="Recording retention">
      <Select value={selectValue} onValueChange={onChange} disabled={saving}>
        <SelectTrigger
          className={`h-7 gap-1.5 rounded-full border px-2.5 text-small font-medium whitespace-nowrap ${
            isOverride
              ? 'border-brand/40 bg-brand-soft text-brand'
              : 'border-line bg-surface text-fg-muted'
          }`}
        >
          <Clock className="w-3 h-3 shrink-0 opacity-70" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" className="min-w-44">
          {allowInherit && (
            <SelectItem value="__inherit__">
              <span className="text-fg-muted">{inheritLabel} · {inheritedDays}d</span>
            </SelectItem>
          )}
          {options.map((o) => (
            <SelectItem key={o.v} value={o.v}>{o.label}</SelectItem>
          ))}
          <SelectItem value="__custom__">
            <span className="text-brand font-medium">Custom…</span>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Bulk retention selector (for multi-selected cameras) ─────────────────────
// A command-style dropdown: picking a value applies it to ALL selected cameras.
// Stays unselected (placeholder) so the same value can be re-applied.
function BulkRetentionSelect({ count, onApply, disabled }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customVal, setCustomVal]   = useState('');

  if (customOpen) {
    const confirm = () => {
      const days = customVal === '' ? null : Math.max(1, parseInt(customVal, 10) || 30);
      setCustomOpen(false); setCustomVal('');
      onApply(days);
    };
    return (
      <div className="flex items-center gap-1">
        <Input
          type="number" min="1" autoFocus value={customVal}
          onChange={(e) => setCustomVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') setCustomOpen(false); }}
          placeholder="days"
          className="h-8 w-20 text-small px-2"
        />
        <button onClick={confirm} title="Apply" className="text-success-ink hover:text-success-ink"><Check className="w-4 h-4" /></button>
        <button onClick={() => setCustomOpen(false)} title="Cancel" className="text-fg-subtle hover:text-fg-secondary"><X className="w-4 h-4" /></button>
      </div>
    );
  }

  return (
    <Select
      value=""
      disabled={disabled}
      onValueChange={(v) => {
        if (v === '__custom__')  { setCustomOpen(true); return; }
        onApply(v === '__inherit__' ? null : Math.max(1, parseInt(v, 10)));
      }}
    >
      <SelectTrigger className="h-8 gap-1.5 rounded-lg border-brand/40 bg-surface px-3 text-small font-semibold text-brand">
        <Clock className="w-3.5 h-3.5" />
        <SelectValue placeholder={`Set retention for ${count}…`} />
      </SelectTrigger>
      <SelectContent align="end" className="min-w-44">
        <SelectItem value="__inherit__"><span className="text-fg-muted">Inherit from group</span></SelectItem>
        {RETENTION_PRESETS.map((d) => (
          <SelectItem key={d} value={String(d)}>{retLabel(d)}</SelectItem>
        ))}
        <SelectItem value="__custom__"><span className="text-brand font-medium">Custom…</span></SelectItem>
      </SelectContent>
    </Select>
  );
}

// ─── Stream-quality selector (auto / main / sub) ──────────────────────────────
const QUALITY_OPTS = [
  { v: 'auto', label: 'Auto' },
  { v: 'main', label: 'High · HD' },
  { v: 'sub',  label: 'Low · Saver' },
];
const qLabel = (v) => QUALITY_OPTS.find((o) => o.v === v)?.label || v;

function QualitySelect({ value, inheritedQuality = 'auto', allowInherit = false, inheritLabel = 'Inherit', onSave }) {
  const [saving, setSaving] = useState(false);
  const isOverride  = value != null;
  const selectValue = isOverride ? value : (allowInherit ? '__inherit__' : inheritedQuality);
  const commit = async (v) => { setSaving(true); try { await onSave(v); } finally { setSaving(false); } };
  return (
    <div className="shrink-0" onClick={(e) => e.stopPropagation()} title="Default stream quality">
      <Select value={selectValue} onValueChange={(v) => commit(v === '__inherit__' ? null : v)} disabled={saving}>
        <SelectTrigger className={`h-7 gap-1.5 rounded-full border px-2.5 text-small font-medium whitespace-nowrap ${
          isOverride ? 'border-info-line bg-info-soft text-info-ink' : 'border-line bg-surface text-fg-muted'
        }`}>
          <Gauge className="w-3 h-3 shrink-0 opacity-70" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" className="min-w-40">
          {allowInherit && (
            <SelectItem value="__inherit__"><span className="text-fg-muted">{inheritLabel} · {qLabel(inheritedQuality)}</span></SelectItem>
          )}
          {QUALITY_OPTS.map((o) => <SelectItem key={o.v} value={o.v}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function BulkQualitySelect({ count, onApply, disabled }) {
  return (
    <Select value="" disabled={disabled} onValueChange={(v) => onApply(v === '__inherit__' ? null : v)}>
      <SelectTrigger className="h-8 gap-1.5 rounded-lg border-info-line bg-surface px-3 text-small font-semibold text-info-ink">
        <Gauge className="w-3.5 h-3.5" />
        <SelectValue placeholder={`Quality for ${count}…`} />
      </SelectTrigger>
      <SelectContent align="end" className="min-w-40">
        <SelectItem value="__inherit__"><span className="text-fg-muted">Inherit from group</span></SelectItem>
        {QUALITY_OPTS.map((o) => <SelectItem key={o.v} value={o.v}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ─── Camera Channel Row ───────────────────────────────────────────────────────
function CameraRow({ camera, groupId, groupRetention, groupQuality, selected, onToggleSelect, onDelete }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const isOffline = camera.status === 'offline' || camera.status === 'unknown';
  const setCamRetention = useSetCameraRetention();
  const setCamQuality   = useSetCameraQuality();

  const handleRetention = async (retentionDays) => {
    await setCamRetention.mutateAsync({ groupId, monitorId: camera.monitorId, retentionDays });
  };
  const handleQuality = async (streamQuality) => {
    await setCamQuality.mutateAsync({ groupId, monitorId: camera.monitorId, streamQuality });
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await onDelete(camera);
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  };

  return (
    <div className={`rounded-lg border transition-colors ${
      confirmRemove
        ? 'bg-danger-soft border-danger-line'
        : selected
          ? 'bg-brand-soft/70 border-brand/40'
          : 'bg-surface-sunken hover:bg-surface-muted border-line-subtle'
    }`}>
      {/* Main row */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {/* Multi-select checkbox */}
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggleSelect?.(camera.monitorId)}
          onClick={(e) => e.stopPropagation()}
          title="Select for bulk retention"
          className="w-4 h-4 rounded accent-brand cursor-pointer shrink-0"
        />
        {/* Icon */}
        <div className={`w-7 h-7 rounded-md border flex items-center justify-center shrink-0 ${
          isOffline ? 'bg-danger-soft border-danger-line' : 'bg-surface border-line'
        }`}>
          <Camera className={`w-3.5 h-3.5 ${isOffline ? 'text-danger' : 'text-fg-subtle'}`} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-body font-medium text-fg truncate">{camera.name}</p>
          <p className="text-small text-fg-subtle truncate">
            Ch {camera.channel} · {camera.path || `/Streaming/Channels/${camera.channel}01`}
          </p>
          {/* "No stream" message for offline cameras */}
          {isOffline && (
            <p className="text-small text-danger mt-0.5 flex items-center gap-1">
              <WifiOff className="w-3 h-3 shrink-0" />
              No camera or stream found on this channel
            </p>
          )}
        </div>

        {/* Retention override + status badge + delete */}
        <div className="flex items-center gap-1.5 shrink-0 ml-1">
          <QualitySelect
            value={camera.streamQuality}
            inheritedQuality={groupQuality ?? 'auto'}
            allowInherit
            inheritLabel="Inherit"
            onSave={handleQuality}
          />
          <RetentionEditor
            value={camera.retentionDays}
            inheritedDays={groupRetention ?? 30}
            allowInherit
            inheritLabel="Inherit"
            onSave={handleRetention}
          />
          <StatusBadge status={camera.status} size="sm" />
          {!confirmRemove ? (
            <button
              onClick={() => setConfirmRemove(true)}
              title="Remove this camera channel"
              className="p-1 rounded text-fg-disabled hover:text-danger hover:bg-danger-soft transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Inline confirm strip */}
      {confirmRemove && (
        <div className="flex items-center justify-between px-3 pb-2.5 gap-2">
          <p className="text-small text-danger-ink font-medium flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Remove &ldquo;{camera.name}&rdquo; permanently?
          </p>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setConfirmRemove(false)}
              className="text-small px-2.5 py-1 rounded-lg border border-line text-fg-secondary hover:bg-surface-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleRemove}
              disabled={removing}
              className="text-small px-2.5 py-1 rounded-lg bg-danger hover:bg-danger text-white transition-colors flex items-center gap-1 disabled:opacity-60"
            >
              {removing
                ? <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                : <Trash2 className="w-3 h-3" />
              }
              {removing ? 'Removing…' : 'Yes, remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Device Group Card ────────────────────────────────────────────────────────
function GroupCard({ group, onDelete, onSync, onEdit, onNotify }) {
  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const deleteCamMut = useDeleteGroupCamera();
  const setGroupRetentionMut = useSetGroupRetention();
  const bulkRetentionMut = useSetCamerasRetentionBulk();
  const setGroupQualityMut = useSetGroupQuality();
  const bulkQualityMut = useSetCamerasQualityBulk();
  const [selected, setSelected] = useState(() => new Set());

  const toggleSelect = (monitorId) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(monitorId) ? next.delete(monitorId) : next.add(monitorId);
    return next;
  });

  const handleBulkRetention = async (retentionDays) => {
    const monitorIds = [...selected];
    if (!monitorIds.length) return;
    await bulkRetentionMut.mutateAsync({ groupId: group.id, monitorIds, retentionDays });
    onNotify?.({
      type: 'success',
      message: `Retention ${retentionDays == null ? 'reset to inherit' : `set to ${retentionDays} days`} for ${monitorIds.length} camera${monitorIds.length > 1 ? 's' : ''}.`,
    });
    setSelected(new Set());
  };

  const handleBulkQuality = async (streamQuality) => {
    const monitorIds = [...selected];
    if (!monitorIds.length) return;
    await bulkQualityMut.mutateAsync({ groupId: group.id, monitorIds, streamQuality });
    onNotify?.({
      type: 'success',
      message: `Quality ${streamQuality == null ? 'reset to inherit' : `set to ${streamQuality}`} for ${monitorIds.length} camera${monitorIds.length > 1 ? 's' : ''}.`,
    });
    setSelected(new Set());
  };

  const handleGroupQuality = async (streamQuality) => {
    await setGroupQualityMut.mutateAsync({ groupId: group.id, streamQuality });
    onNotify?.({
      type: 'success',
      message: streamQuality == null
        ? `${group.name}: quality reset to inherit.`
        : `${group.name}: default quality set to ${streamQuality}.`,
    });
  };

  const handleCameraDelete = async (camera) => {
    await deleteCamMut.mutateAsync({ groupId: group.id, monitorId: camera.monitorId });
    onNotify?.({ type: 'success', message: `Channel "${camera.name}" removed from ${group.name}.` });
  };

  const handleGroupRetention = async (retentionDays) => {
    await setGroupRetentionMut.mutateAsync({ groupId: group.id, retentionDays });
    onNotify?.({
      type: 'success',
      message: retentionDays == null
        ? `${group.name}: retention reset to inherit.`
        : `${group.name}: default retention set to ${retentionDays} days.`,
    });
  };

  const cameras    = group.cameras || [];
  const total      = cameras.length;
  const online     = cameras.filter(c => c.status === 'online').length;
  const offline    = cameras.filter(c => c.status === 'offline').length;
  const pct        = total > 0 ? Math.round((online / total) * 100) : 0;
  const deviceMeta = DEVICE_TYPES.find(d => d.value === group.deviceType);

  const handleSync = async (e) => {
    e.stopPropagation();
    setSyncing(true);
    try { await onSync(group.id); }
    finally { setSyncing(false); }
  };

  return (
    <Card className="border border-line shadow-sm hover:shadow-md transition-shadow bg-surface overflow-hidden">
      <CardContent className="p-0">
        {/* ── Card Header Row ── */}
        <div
          className="flex items-center gap-3 sm:gap-4 p-4 cursor-pointer select-none group"
          onClick={() => setExpanded(v => !v)}
        >
          {/* Expand toggle */}
          <div className="text-fg-subtle group-hover:text-fg-secondary transition-colors shrink-0">
            {expanded
              ? <ChevronDown className="w-4 h-4" />
              : <ChevronRight className="w-4 h-4" />
            }
          </div>

          {/* CCTV Icon */}
          <div className="w-10 h-10 rounded-xl bg-brand-soft flex items-center justify-center shrink-0">
            <Cctv className="w-5 h-5 text-brand" />
          </div>

          {/* Device info */}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-0.5">
              <h3 className="text-body font-semibold text-fg truncate max-w-50 sm:max-w-none">
                {group.name}
              </h3>
              <StatusBadge status={group.status} size="sm" className="shrink-0" />
              {deviceMeta && (
                <span className="text-small text-fg-subtle bg-surface-muted px-2 py-0.5 rounded-full capitalize">
                  {deviceMeta.label}
                </span>
              )}
            </div>

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-small text-fg-muted">
              <span className="flex items-center gap-1">
                <Wifi className="w-3 h-3" />
                {group.host}:{group.port}
              </span>
              {group.location && (
                <span className="flex items-center gap-1 truncate max-w-35">
                  <MapPin className="w-3 h-3 shrink-0" />
                  {group.location}
                </span>
              )}
              {total > 0 && (
                <span>
                  <span className="font-medium text-success-ink">{online}</span>
                  <span className="text-fg-subtle">/{total}</span>
                  <span className="ml-1">online</span>
                  {offline > 0 && (
                    <span className="ml-1 text-danger">· {offline} offline</span>
                  )}
                </span>
              )}
            </div>

            {/* Mini progress bar (only when expanded or > 0 cameras) */}
            {total > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-1 bg-surface-muted rounded-full overflow-hidden max-w-30">
                  <div
                    className={`h-full rounded-full transition-all ${
                      pct === 100 ? 'bg-success' : pct > 0 ? 'bg-brand' : 'bg-danger'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-small text-fg-subtle">{pct}%</span>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div
            className="flex items-center gap-1.5 shrink-0"
            onClick={e => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(group)}
              title="Edit device"
              className="h-8 w-8 p-0 text-fg-subtle hover:text-fg-secondary hover:bg-surface-muted"
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
              title="Refresh camera status"
              className="h-8 w-8 p-0 text-fg-subtle hover:text-fg-secondary hover:bg-surface-muted"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(group)}
              title="Delete device"
              className="h-8 w-8 p-0 text-fg-subtle hover:text-danger-ink hover:bg-danger-soft"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* ── Expanded Camera List ── */}
        {expanded && (
          <div className="border-t border-line-subtle bg-surface-sunken/60">
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {total > 0 && (
                    <input
                      type="checkbox"
                      checked={selected.size === total}
                      ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < total; }}
                      onChange={() => setSelected(selected.size === total ? new Set() : new Set(cameras.map((c) => c.monitorId)))}
                      title="Select all channels"
                      className="w-4 h-4 rounded accent-brand cursor-pointer"
                    />
                  )}
                  <p className="text-small font-semibold text-fg-muted uppercase tracking-wider">
                    Camera Channels ({total})
                  </p>
                </div>
                {total > 0 && (
                  <span className="text-small text-fg-subtle">
                    {online} online · {offline} offline · {total - online - offline} unknown
                  </span>
                )}
              </div>

              {/* Location/group default recording retention. Per-camera values
                  (in each row) override this; blank inherits site/global. */}
              {/* Group defaults — retention + stream quality. Each channel can
                  override below. */}
              <div className="mb-3 px-3 py-2.5 rounded-xl bg-gradient-to-r from-brand-soft/40 via-surface to-info-soft/30 border border-line/70 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-surface border border-brand-line flex items-center justify-center shrink-0">
                      <HardDrive className="w-3.5 h-3.5 text-brand" />
                    </div>
                    <span className="text-small font-semibold text-fg-secondary">Recording retention</span>
                  </div>
                  <RetentionEditor
                    value={group.retentionDays}
                    inheritedDays={30}
                    allowInherit
                    inheritLabel="Default"
                    onSave={handleGroupRetention}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg bg-surface border border-info-line flex items-center justify-center shrink-0">
                      <Gauge className="w-3.5 h-3.5 text-info" />
                    </div>
                    <span className="text-small font-semibold text-fg-secondary">Stream quality</span>
                  </div>
                  <QualitySelect
                    value={group.streamQuality}
                    inheritedQuality="auto"
                    allowInherit
                    inheritLabel="Default"
                    onSave={handleGroupQuality}
                  />
                </div>
              </div>

              {/* Bulk action bar — appears when one or more channels are selected */}
              {selected.size > 0 && (
                <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-xl bg-brand/10 border border-brand/30">
                  <div className="flex items-center gap-2 text-small">
                    <span className="font-semibold text-brand">{selected.size} selected</span>
                    <button onClick={() => setSelected(new Set())} className="text-fg-muted hover:text-fg-secondary">Clear</button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="hidden sm:inline text-small text-fg-muted">Apply to selected:</span>
                    <BulkQualitySelect
                      count={selected.size}
                      disabled={bulkQualityMut.isPending}
                      onApply={handleBulkQuality}
                    />
                    <BulkRetentionSelect
                      count={selected.size}
                      disabled={bulkRetentionMut.isPending}
                      onApply={handleBulkRetention}
                    />
                  </div>
                </div>
              )}

              {total === 0 ? (
                <div className="flex flex-col items-center py-8 text-center">
                  <Camera className="w-8 h-8 text-fg-disabled mb-2" />
                  <p className="text-body font-medium text-fg-muted">No cameras in this group</p>
                  <p className="text-small text-fg-subtle mt-1">
                    Sync the device to auto-discover camera channels.
                  </p>
                </div>
              ) : (
                /* Scrollable camera list — handles any number of cameras */
                <div className="space-y-1.5 max-h-75 overflow-y-auto pr-0.5">
                  {[...cameras]
                    .sort((a, b) => (a.channel || 0) - (b.channel || 0))
                    .map(cam => (
                      <CameraRow
                        key={cam.id}
                        camera={cam}
                        groupId={group.id}
                        groupRetention={group.retentionDays}
                        groupQuality={group.streamQuality}
                        selected={selected.has(cam.monitorId)}
                        onToggleSelect={toggleSelect}
                        onDelete={handleCameraDelete}
                      />
                    ))
                  }
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Add Device Wizard ────────────────────────────────────────────────────────
function AddGroupWizard({ onCreated, onClose }) {
  const createMut = useCreateGroup();
  const [step, setStep]   = useState(1);
  const [form, setForm]   = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const [showPass, setShowPass] = useState(false);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const selectedDevice = DEVICE_TYPES.find(d => d.value === form.deviceType);
  const channelCount   = parseInt(form.totalChannels) || 0;

  const canNext1   = form.name.trim() && form.host.trim();
  const canNext2   = form.username.trim() && form.password.trim();
  const canSubmit  = channelCount > 0 && channelCount <= 64;

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      const group = await createMut.mutateAsync({
        name:          form.name.trim(),
        host:          form.host.trim(),
        port:          parseInt(form.port) || 554,
        httpPort:      parseInt(form.httpPort) || 80,
        username:      form.username.trim(),
        password:      form.password,
        deviceType:    form.deviceType,
        totalChannels: channelCount,
        location:      form.location.trim(),
      });
      onCreated(group);
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to create device. Please check details and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-w-lg max-h-[calc(var(--app-vh)*0.9)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="text-heading font-semibold text-fg">
          Connect Camera Device
        </DialogTitle>
        <p className="text-body text-fg-muted mt-0.5">
          Add an NVR, DVR or IP device and all camera channels in one step.
        </p>
      </DialogHeader>

      {/* Step indicator */}
      <div className="flex items-center mt-3 mb-4">
        <StepDot step={1} current={step} label="Device" />
        <StepConnector done={step > 1} />
        <StepDot step={2} current={step} label="Credentials" />
        <StepConnector done={step > 2} />
        <StepDot step={3} current={step} label="Channels" />
      </div>

      {/* ── Step 1 ── */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">
              Device / Site Name <span className="text-danger">*</span>
            </label>
            <Input
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder='e.g. "Office NVR", "Warehouse Gate"'
              autoFocus
            />
            <p className="text-small text-fg-subtle mt-1">
              A label to identify this device in your dashboard.
            </p>
          </div>

          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">Device Type</label>
            <div className="grid grid-cols-2 gap-2">
              {DEVICE_TYPES.map(d => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => set('deviceType', d.value)}
                  className={`p-3 rounded-xl border-2 text-left transition-all
                    ${form.deviceType === d.value
                      ? 'border-brand bg-brand-soft'
                      : 'border-line hover:border-line-strong bg-surface'
                    }`}
                >
                  <p className="font-semibold text-body text-fg">{d.label}</p>
                  <p className="text-small text-fg-subtle mt-0.5 truncate">{d.hint}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-body font-medium text-fg-secondary mb-1.5">
                IP Address <span className="text-danger">*</span>
              </label>
              <Input
                value={form.host}
                onChange={e => set('host', e.target.value)}
                placeholder="192.168.1.50 or 103.61.254.67"
              />
            </div>
            <div>
              <label className="block text-body font-medium text-fg-secondary mb-1.5">RTSP Port</label>
              <Input
                value={form.port}
                onChange={e => set('port', e.target.value)}
                placeholder="554"
              />
            </div>
          </div>

          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">Location <span className="text-fg-subtle font-normal">(optional)</span></label>
            <Input
              value={form.location}
              onChange={e => set('location', e.target.value)}
              placeholder="e.g. 3rd Floor, Block B"
            />
          </div>
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 bg-brand-soft border border-brand-line rounded-xl p-3">
            <Cctv className="w-5 h-5 text-brand shrink-0" />
            <div>
              <p className="text-body font-semibold text-brand-ink">{form.name}</p>
              <p className="text-small text-brand-ink mt-0.5">
                {form.host}:{form.port} · {form.deviceType}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">
              Username <span className="text-danger">*</span>
            </label>
            <Input
              value={form.username}
              onChange={e => set('username', e.target.value)}
              placeholder="admin"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">
              Password <span className="text-danger">*</span>
            </label>
            <div className="relative">
              <Input
                type={showPass ? 'text' : 'password'}
                value={form.password}
                onChange={e => set('password', e.target.value)}
                placeholder="Camera / NVR password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPass(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-body font-medium text-fg-secondary mb-1.5">
              HTTP Port <span className="text-fg-subtle font-normal">(web interface)</span>
            </label>
            <Input
              value={form.httpPort}
              onChange={e => set('httpPort', e.target.value)}
              placeholder="80"
            />
            <p className="text-small text-fg-subtle mt-1">
              Used for the device's web interface — usually 80 or 8080.
            </p>
          </div>
        </div>
      )}

      {/* ── Step 3 ── */}
      {step === 3 && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="bg-surface-sunken border border-line rounded-xl divide-y divide-line-subtle text-body overflow-hidden">
            {[
              ['Device',   form.name],
              ['IP',       `${form.host}:${form.port}`],
              ['Type',     <span className="capitalize">{form.deviceType}</span>],
              ['Location', form.location || <span className="text-fg-subtle">—</span>],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between px-3 py-2">
                <span className="text-fg-muted">{k}</span>
                <span className="font-medium text-fg">{v}</span>
              </div>
            ))}
          </div>

          {/* Channel count picker */}
          <div>
            <label className="block text-body font-medium text-fg-secondary mb-2">
              How many camera channels does this device have?
            </label>
            <div className="grid grid-cols-5 gap-2 mb-3">
              {[1, 4, 8, 16, 32].map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => set('totalChannels', String(n))}
                  className={`h-10 rounded-xl border-2 text-body font-semibold transition-all
                    ${channelCount === n
                      ? 'border-brand bg-brand text-white'
                      : 'border-line text-fg-secondary hover:border-line-strong bg-surface'
                    }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <Input
              type="number"
              min="1"
              max="64"
              value={form.totalChannels}
              onChange={e => set('totalChannels', e.target.value)}
              placeholder="Custom (1–64)"
            />
            {channelCount > 64 && (
              <p className="text-small text-danger mt-1 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> Maximum 64 channels allowed.
              </p>
            )}
            {channelCount <= 0 && form.totalChannels !== '' && (
              <p className="text-small text-danger mt-1 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> Enter at least 1 channel.
              </p>
            )}
            {selectedDevice && channelCount > 0 && channelCount <= 64 && (
              <p className="text-small text-fg-subtle mt-1">{selectedDevice.hint}</p>
            )}
          </div>

          {/* Preview */}
          {channelCount > 0 && channelCount <= 16 && (
            <div className="border border-line rounded-xl overflow-hidden">
              <p className="text-small font-semibold text-fg-muted px-3 py-2 bg-surface-sunken border-b border-line-subtle uppercase tracking-wider">
                Cameras to be created ({channelCount})
              </p>
              <div className="max-h-40 overflow-y-auto divide-y divide-line-subtle">
                {Array.from({ length: channelCount }, (_, i) => i + 1).map(ch => (
                  <div key={ch} className="flex items-center justify-between px-3 py-1.5 text-small hover:bg-surface-sunken">
                    <span className="text-fg-secondary font-medium">
                      {form.name} — Camera {String(ch).padStart(2, '0')}
                    </span>
                    <span className="text-fg-subtle">Ch {ch}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {channelCount > 16 && channelCount <= 64 && (
            <div className="bg-info-soft border border-info-line rounded-xl p-3 text-small text-info-ink flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                <strong>{channelCount} cameras</strong> will be auto-provisioned. Preview hidden for large channel counts.
              </span>
            </div>
          )}

          {error && (
            <div className="bg-danger-soft border border-danger-line rounded-xl p-3 text-body text-danger-ink flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              {error}
            </div>
          )}
        </div>
      )}

      <DialogFooter className="flex-row gap-2 mt-4">
        {step > 1 && (
          <Button
            variant="outline"
            onClick={() => setStep(s => s - 1)}
            className="flex-1 sm:flex-none"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        )}
        <Button
          variant="outline"
          onClick={onClose}
          className="flex-1 sm:flex-none"
        >
          Cancel
        </Button>
        {step < 3 ? (
          <Button
            onClick={() => setStep(s => s + 1)}
            disabled={step === 1 ? !canNext1 : !canNext2}
            className="bg-brand hover:bg-brand-hover text-white flex-1 sm:flex-none"
          >
            Next <ArrowRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button
            onClick={handleCreate}
            disabled={saving || !canSubmit}
            className="bg-brand hover:bg-brand-hover text-white flex-1 sm:flex-none"
          >
            {saving
              ? <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Creating…
                </span>
              : <span className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Create {channelCount} Camera{channelCount !== 1 ? 's' : ''}
                </span>
            }
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

// ─── Skeleton Loader ──────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 animate-pulse">
      <div className="flex items-center gap-4">
        <div className="w-4 h-4 rounded bg-line shrink-0" />
        <div className="w-10 h-10 rounded-xl bg-line shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-line rounded w-1/3" />
          <div className="h-3 bg-surface-muted rounded w-1/2" />
        </div>
        <div className="flex gap-1.5">
          <div className="w-8 h-8 rounded-lg bg-surface-muted" />
          <div className="w-8 h-8 rounded-lg bg-surface-muted" />
          <div className="w-8 h-8 rounded-lg bg-surface-muted" />
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function NoDevicesState({ onAdd, onNavigate }) {
  return (
    <SetupEmptyState
      illustration="device"
      title="No devices connected"
      description="Connect an NVR, DVR or IP camera device. Its camera channels are found and provisioned automatically."
      action={<Button onClick={onAdd}><Plus /> Add device</Button>}
      secondary={onNavigate ? (
        <Button variant="outline" onClick={() => onNavigate('cameras')}>Add a single camera</Button>
      ) : null}
      steps={[
        { title: 'Add a device',     detail: 'Enter the recorder address and login details.' },
        { title: 'Review channels',  detail: 'Camera channels are discovered automatically.' },
        { title: 'Enable AI',        detail: 'Choose which cameras run AI detection.' },
      ]}
    />
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function CameraGroups({ onNavigate }) {
  const { data: groups = [], isLoading, isError, error: fetchError, refetch } = useGroups({ refetchInterval: 30_000 });
  const deleteGroupMut = useDeleteGroup();
  const syncGroupMut   = useSyncGroup();

  const [wizardOpen,  setWizardOpen]  = useState(false);
  const [editTarget,  setEditTarget]  = useState(null);   // group being edited
  const [deleteTarget, setDeleteTarget] = useState(null); // group pending deletion
  const [search,      setSearch]      = useState('');
  const [brandFilter, setBrandFilter] = useState('all');
  const [notification, setNotification] = useState(null);

  // Auto-dismiss notification after 4 s
  useEffect(() => {
    if (!notification) return;
    const t = setTimeout(() => setNotification(null), 4000);
    return () => clearTimeout(t);
  }, [notification]);

  const notify = (note) => setNotification(note);

  // Filtered groups
  const q = search.trim().toLowerCase();
  const filtered = groups.filter(g => {
    if (brandFilter !== 'all' && (g.deviceType || 'hikvision') !== brandFilter) return false;
    if (!q) return true;
    return g.name.toLowerCase().includes(q)
      || g.host.toLowerCase().includes(q)
      || (g.location || '').toLowerCase().includes(q);
  });
  const hasFilters = Boolean(q) || brandFilter !== 'all';

  // What needs attention: a device that is not online, or channels that are
  // offline on one that is. Clicking an item narrows the list to that device.
  const attention = groups.flatMap(g => {
    const offline = (g.cameras || []).filter(c => c.status === 'offline').length;
    const focus = () => { setBrandFilter('all'); setSearch(g.name); };
    if (g.status && g.status !== 'online') {
      return [{ key: `${g.id}-status`, label: `${g.name} is ${g.status === 'offline' ? 'unreachable' : g.status}`, onClick: focus }];
    }
    if (offline > 0) {
      return [{ key: `${g.id}-offline`, label: `${offline} channel${offline === 1 ? '' : 's'} offline on ${g.name}`, onClick: focus }];
    }
    return [];
  });

  const handleCreated = () => {
    setWizardOpen(false);
    notify({ type: 'success', message: 'Device connected and cameras provisioned successfully.' });
  };

  // ConfirmDialog owns the busy/error state itself — a thrown error keeps the
  // dialog open with the message shown inline, so it doesn't need a duplicate
  // toast here.
  const handleDelete = async () => {
    await deleteGroupMut.mutateAsync(deleteTarget.id);
    notify({ type: 'success', message: `"${deleteTarget.name}" and all its cameras have been deleted.` });
  };

  const handleSync = async (groupId) => {
    try {
      await syncGroupMut.mutateAsync(groupId);
      notify({ type: 'success', message: 'Camera statuses refreshed.' });
    } catch {
      notify({ type: 'error', message: 'Sync failed. Check device connectivity.' });
    }
  };

  return (
    <div className="w-full space-y-4">
      {/* No heading here — Camera Setup's tab strip names the section.
          The page opens on its toolbar: search + brand filter, then Refresh
          and the primary action, in the same place as on every other tab. */}
      <PageToolbar
        actions={(
          <>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className={isLoading ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Button onClick={() => setWizardOpen(true)}>
              <Plus /> Add device
            </Button>
          </>
        )}
      >
        <div className="relative w-full shrink-0 sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, IP or location…"
            aria-label="Search devices"
            className="rounded-lg bg-surface pl-9 pr-8 transition-all duration-300 hover:border-brand/40 focus:border-brand focus:ring-[3px] focus:ring-brand/20"
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
        <Select value={brandFilter} onValueChange={setBrandFilter}>
          <SelectTrigger className="w-40 bg-surface" aria-label="Filter by brand"><SelectValue placeholder="Brand" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All brands</SelectItem>
            {DEVICE_TYPES.map(d => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </PageToolbar>

      {notification && <Notification note={notification} onDismiss={() => setNotification(null)} />}

      {/* Error and empty are mutually exclusive — a failed fetch used to still
          fall through to "No devices connected" underneath the error banner,
          which reads as though the account has genuinely never had a device
          connected. An error stops here; it never reaches the empty state. */}
      {isEmptyPreview() ? (
        <NoDevicesState onAdd={() => setWizardOpen(true)} onNavigate={onNavigate} />
      ) : isError ? (
        <SetupErrorState
          title="Couldn't load devices"
          description={fetchError?.message || 'Could not reach the server. Check your connection and try again.'}
          onRetry={refetch}
        />
      ) : isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
      ) : groups.length === 0 ? (
        <NoDevicesState onAdd={() => setWizardOpen(true)} onNavigate={onNavigate} />
      ) : (
        <>
          {/* What needs attention, if anything. Device count lives in the tab
              strip; each row below carries its own online/total. */}
          <PageAttention items={attention} />

          {/* ── Device list ── */}
          {filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No devices match"
              description="Try a different name or IP, or clear the filters."
              action={hasFilters ? (
                <Button variant="outline" size="sm" onClick={() => { setSearch(''); setBrandFilter('all'); }}>
                  Clear filters
                </Button>
              ) : null}
            />
          ) : (
            <div className="space-y-3">
              {filtered.map(group => (
                <GroupCard
                  key={group.id}
                  group={group}
                  onDelete={setDeleteTarget}
                  onSync={handleSync}
                  onEdit={setEditTarget}
                  onNotify={notify}
                />
              ))}
              {hasFilters && (
                <p className="text-small text-fg-subtle text-center pt-1">
                  Showing {filtered.length} of {groups.length} devices
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Add Device Wizard ── */}
      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <AddGroupWizard
          onCreated={handleCreated}
          onClose={() => setWizardOpen(false)}
        />
      </Dialog>

      {/* ── Edit Device Dialog ── */}
      <EditGroupDialog
        group={editTarget}
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => setEditTarget(null)}
        onNotify={notify}
      />

      {/* ── Delete Confirmation ── */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title="Delete device"
        description={deleteTarget ? <>Delete <b>{deleteTarget.name}</b>? All camera channels under this device will be permanently removed. This cannot be undone.</> : null}
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  );
}
