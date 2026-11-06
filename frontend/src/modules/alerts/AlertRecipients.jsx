import { useCallback, useEffect, useState } from 'react';
import {
  X, Mail, Plus, Trash2, Send, Loader2, CheckCircle2, AlertTriangle, UserPlus,
} from 'lucide-react';
import api from '@/core/services/api';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import { CardHeading } from '@/core/ui/typography';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';
import { ErrorState } from '@/core/ui/states';
import { toast } from '@/core/store/toastStore';
import { useAuthStore } from '@/core/store/authStore';

/**
 * AlertRecipients — manage the email addresses that receive security alerts.
 * Per recipient: a PRIORITY (minSeverity) and WHICH alert types it gets
 * (eventTypes; empty = all). Backed by /api/notifications/emails.
 * Works as a modal (default) or inline (embedded, e.g. in Settings, where the
 * page supplies the section heading).
 */
const CATEGORIES = [
  { key: 'watchlist', label: 'Watchlist' },
  { key: 'unknown',   label: 'Unknown person' },
  { key: 'intrusion', label: 'Zone intrusion' },
  { key: 'weapon',    label: 'Weapon' },
  { key: 'fire',      label: 'Fire / smoke' },
  { key: 'crowd',     label: 'Crowd' },
];
const ALL_KEYS = CATEGORIES.map((c) => c.key);
const catActive = (types, key) => !Array.isArray(types) || types.length === 0 || types.includes(key);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const errMessage = (err, fallback) => err?.response?.data?.message || err?.message || fallback;

const SELECT_CLASS =
  'rounded-md border border-line bg-surface text-fg shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-line-focus focus-visible:ring-[3px] focus-visible:ring-brand/25';

function SeverityOptions() {
  return (
    <>
      <option value="warning">Warning and above</option>
      <option value="critical">Critical only</option>
    </>
  );
}

export default function AlertRecipients({ open = true, onClose, embedded = false }) {
  const userEmail = useAuthStore((s) => s.user?.email);
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [email, setEmail]       = useState('');
  const [severity, setSeverity] = useState('warning');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data } = await api.get('/notifications/emails');
      setRows(data?.emails || []);
    } catch (err) {
      // Surface the failure — an empty list here would read as "no recipients".
      setLoadError(errMessage(err, 'The recipient list could not be loaded.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open || embedded) load(); }, [open, embedded, load]);

  const addAddress = async (raw) => {
    setError(null);
    const addr = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) { setError('Enter a valid email address.'); return; }
    setBusy(true);
    try {
      await api.post('/notifications/emails', { email: addr, minSeverity: severity, eventTypes: null });
      setEmail('');
      await load();
      toast.success('Recipient added', `${addr} will now receive alerts.`);
    } catch (err) {
      setError(errMessage(err, 'Could not add that address.'));
    } finally { setBusy(false); }
  };

  const add = (e) => { e.preventDefault(); addAddress(email); };

  const patch = async (id, body) => {
    try { await api.patch(`/notifications/emails/${id}`, body); await load(); }
    catch (err) { toast.error('Update failed', errMessage(err, 'The change was not saved.')); }
  };

  const toggleCat = (row, key) => {
    const cur = new Set(Array.isArray(row.eventTypes) && row.eventTypes.length ? row.eventTypes : ALL_KEYS);
    if (cur.has(key)) cur.delete(key); else cur.add(key);
    const arr = [...cur];
    // empty or all → "all alerts" (null)
    patch(row.id, { eventTypes: (arr.length === 0 || arr.length === ALL_KEYS.length) ? null : arr });
  };

  // Called from ConfirmDialog: throwing keeps the dialog open with the error shown.
  const remove = async (row) => {
    await api.delete(`/notifications/emails/${row.id}`);
    await load();
    toast.success('Recipient removed', `${row.email} will no longer receive alerts.`);
  };

  const sendTest = async (row) => {
    setTestingId(row.id);
    try {
      const { data } = await api.post(`/notifications/emails/${row.id}/test`);
      toast.success('Test email sent', data?.message || `Check the inbox for ${row.email}.`);
    } catch (err) {
      toast.error('Test email failed', errMessage(err, 'Check the email settings.'));
    } finally { setTestingId(null); }
  };

  if (!embedded && !open) return null;

  const canAddSelf = Boolean(userEmail) && !rows.some((r) => r.email?.toLowerCase() === userEmail.toLowerCase());
  const activeCount = rows.filter((r) => !r.disabled).length;

  const panel = (
    <div
      className={embedded
        ? 'rounded-2xl bg-surface ring-1 ring-line flex flex-col'
        : 'w-full max-w-2xl rounded-2xl bg-surface shadow-xl ring-1 ring-line max-h-[calc(var(--app-vh)*0.9)] flex flex-col'}
      onClick={(e) => e.stopPropagation()}
    >
      {/* header — the modal names itself; embedded, the page heading already does */}
      {embedded ? (
        <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-3.5">
          <CardHeading as="h2">Recipients</CardHeading>
          {!loading && !loadError && rows.length > 0 && (
            <span className="text-small font-medium text-fg-subtle">
              {activeCount} of {rows.length} active
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
              <Mail className="h-5 w-5" strokeWidth={2} />
            </div>
            <div>
              <CardHeading as="h2">Email alert recipients</CardHeading>
              <p className="mt-0.5 text-small text-fg-muted">Add any address, choose its priority, and pick which alerts it receives.</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-fg-subtle hover:bg-surface-muted hover:text-fg-secondary">
            <X size={18} />
          </button>
        </div>
      )}

      {/* add form */}
      <form onSubmit={add} className="border-b border-line-subtle px-5 py-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
            placeholder="name@company.com"
            aria-label="Email address"
            className="flex-1"
          />
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            aria-label="Alert level"
            className={`h-9 px-2.5 text-control ${SELECT_CLASS}`}
          >
            <SeverityOptions />
          </select>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add
          </Button>
        </div>
        {error && (
          <p className="mt-2 flex items-center gap-1.5 text-small font-medium text-danger-ink">
            <AlertTriangle size={13} /> {error}
          </p>
        )}
        <p className="mt-2 text-caption text-fg-subtle">New recipients get all alert types by default — narrow them down per address below.</p>
      </form>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-fg-subtle">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : loadError ? (
          <ErrorState title="Couldn't load recipients" description={loadError} onRetry={load} />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="mb-3 rounded-xl bg-surface-muted p-3 text-fg-subtle"><Mail className="h-6 w-6" strokeWidth={1.5} /></div>
            <p className="text-body font-semibold text-fg-secondary">No recipients yet</p>
            <p className="mt-1 max-w-xs text-small text-fg-muted">Add an email above to start receiving watchlist, intrusion and other security alerts.</p>
            {canAddSelf && (
              <Button variant="outline" size="sm" className="mt-4" disabled={busy} onClick={() => addAddress(userEmail)}>
                <UserPlus /> Add my email ({userEmail})
              </Button>
            )}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {rows.map((r) => (
              <li key={r.id} className="rounded-lg border border-line bg-surface p-3">
                {/* top row */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${r.disabled ? 'bg-surface-muted text-fg-subtle' : 'bg-success-soft text-success-ink'}`}>
                    {r.disabled ? <Mail size={16} /> : <CheckCircle2 size={16} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-body font-semibold ${r.disabled ? 'text-fg-subtle' : 'text-fg'}`}>{r.email}</p>
                    {r.disabled && <p className="text-caption text-fg-subtle">Paused — not receiving alerts</p>}
                  </div>
                  <select
                    value={r.minSeverity}
                    onChange={(e) => patch(r.id, { minSeverity: e.target.value })}
                    aria-label={`Alert level for ${r.email}`}
                    className={`h-8 px-2 text-small font-medium text-fg-secondary ${SELECT_CLASS}`}
                  >
                    <SeverityOptions />
                  </select>
                  <Button variant="outline" size="sm" onClick={() => patch(r.id, { disabled: !r.disabled })}>
                    {r.disabled ? 'Resume' : 'Pause'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => sendTest(r)}
                    disabled={testingId === r.id}
                    aria-label={`Send a test email to ${r.email}`}
                    title="Send test email"
                  >
                    {testingId === r.id ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setRemoveTarget(r)}
                    aria-label={`Remove ${r.email}`}
                    title="Remove"
                    className="text-fg-subtle hover:bg-danger-soft hover:text-danger-ink"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                {/* which alerts → this email */}
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-12">
                  <span className="text-micro uppercase text-fg-subtle">Sends:</span>
                  {CATEGORIES.map((c) => {
                    const on = catActive(r.eventTypes, c.key);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleCat(r, c.key)}
                        className={`rounded-full border px-2.5 py-0.5 text-caption font-semibold transition ${
                          on ? 'border-brand-line bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-subtle hover:bg-surface-sunken'
                        }`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(v) => { if (!v) setRemoveTarget(null); }}
        title="Remove recipient"
        description={removeTarget ? <>Stop sending alerts to <b>{removeTarget.email}</b>? You can add it again later.</> : null}
        confirmLabel="Remove"
        onConfirm={() => remove(removeTarget)}
      />
    </div>
  );

  if (embedded) return panel;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      {panel}
    </div>
  );
}
