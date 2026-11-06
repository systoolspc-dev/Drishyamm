/**
 * CreateReportDialog.jsx — what "Create Report" opens.
 *
 * Type → period → scope → what to include. Deliberately four short steps on
 * one surface rather than a wizard: every one of them has a sensible default,
 * so the fast path is open-and-generate.
 *
 * There is no scheduling control here yet. The column exists in the database,
 * but nothing sends a recurring report, and an option that quietly does
 * nothing is worse than an option that is missing.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/core/ui/dialog';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import { cn } from '@/core/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import { siteService } from '@/core/services/site';
import { cameraGroupService } from '@/core/services/cameraGroup';
import { reportService } from '@/core/services/reports';
import { PERIODS, REPORT_TYPES, typeMeta } from './report-vocabulary';

const STEP = 'mb-1.5 text-micro text-fg-subtle';

function Pick({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-lg border px-3 py-1.5 text-small font-semibold transition',
            o.value === value
              ? 'border-brand bg-brand-soft text-brand-ink'
              : 'border-line bg-surface text-fg-secondary hover:bg-surface-sunken',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <span>
        <span className="text-body text-fg">{label}</span>
        {hint && <span className="ml-1.5 text-caption text-fg-subtle">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 cursor-pointer rounded border-line accent-brand"
      />
    </label>
  );
}

export default function CreateReportDialog({ open, onOpenChange, initialType = 'ai_events', onCreated }) {
  const [type, setType] = useState(initialType);
  const [days, setDays] = useState(7);
  const [siteId, setSiteId] = useState('all');
  const [groupId, setGroupId] = useState('all');
  const [name, setName] = useState('');
  const [include, setInclude] = useState({ incidents: true, watchlist: true });
  const [sites, setSites] = useState([]);
  const [groups, setGroups] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (open) setType(initialType); }, [open, initialType]);

  useEffect(() => {
    if (!open) return;
    // Scope pickers are a nicety — a failure here must not block generating a
    // report over everything, which is the default anyway.
    siteService.list()
      .then((r) => setSites(r?.sites || r?.data || (Array.isArray(r) ? r : [])))
      .catch(() => setSites([]));
    cameraGroupService.getGroups()
      .then((r) => setGroups(Array.isArray(r) ? r : (r?.groups || [])))
      .catch(() => setGroups([]));
  }, [open]);

  const visibleGroups = siteId === 'all' ? groups : groups.filter((g) => g.siteId === siteId);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await reportService.create({
        type,
        days,
        name: name.trim() || undefined,
        scope: { siteId, groupId },
        include,
      });
      onOpenChange(false);
      onCreated?.(res.report);
    } catch (e) {
      setError(e?.response?.data?.message || 'Could not generate that report.');
    } finally {
      setBusy(false);
    }
  };

  const meta = typeMeta(type);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(var(--app-vh)*0.9)] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Create Report</DialogTitle>
          <DialogDescription>{meta.blurb} Generated now and kept in your library.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className={STEP}>1 · Report type</p>
            <Pick
              value={type}
              onChange={setType}
              options={REPORT_TYPES.map((t) => ({ value: t.type, label: t.label.replace(' Report', '') }))}
            />
          </div>

          <div>
            <p className={STEP}>2 · Period</p>
            <Pick
              value={days}
              onChange={setDays}
              options={PERIODS.map((p) => ({ value: p.days, label: p.label }))}
            />
            <p className="mt-1.5 text-caption text-fg-subtle">
              Days run midnight to midnight in the site's own timezone.
            </p>
          </div>

          <div>
            <p className={STEP}>3 · Scope</p>
            <div className="flex flex-wrap gap-2">
              <Select value={siteId} onValueChange={(v) => { setSiteId(v); setGroupId('all'); }}>
                <SelectTrigger className="h-9 min-w-[160px] flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sites</SelectItem>
                  {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger className="h-9 min-w-[160px] flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All camera groups</SelectItem>
                  {visibleGroups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <p className={STEP}>4 · Include</p>
            <Toggle
              label="Incidents with camera, time and duration"
              checked={include.incidents}
              onChange={(v) => setInclude((s) => ({ ...s, incidents: v }))}
            />
            <Toggle
              label="People seen from your face gallery"
              checked={include.watchlist}
              onChange={(v) => setInclude((s) => ({ ...s, watchlist: v }))}
            />
          </div>

          <div>
            <p className={STEP}>Name (optional)</p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${meta.label} · last ${days} days`}
              maxLength={160}
            />
          </div>

          {error && (
            <p className="rounded-lg border border-danger-line bg-danger-soft p-2.5 text-small text-danger-ink">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Generate report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
