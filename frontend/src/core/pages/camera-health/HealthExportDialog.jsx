import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, Download, FileJson, FileText, Loader2, Mail, Sheet as SheetIcon, UserPlus,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/core/ui/dialog';
import api from '@/core/services/api';
import { toast } from '@/core/store/toastStore';
import { useAuthStore } from '@/core/store/authStore';
import {
  EXPORT_FORMATS, buildHealthReport, downloadHealthReport, emailHealthReport,
} from './health-export';

/**
 * Camera Status export — what format, and where it goes.
 *
 * A modal rather than a format dropdown because the second question (who
 * receives it) only exists once the first is answered, and a menu cannot ask
 * it. The recipient list is the account's configured alert addresses, the same
 * ones Settings manages, so an operator sending the morning status report
 * ticks a name instead of retyping an address they can get wrong.
 */

const FORMAT_ICON = { pdf: FileText, csv: SheetIcon, json: FileJson };

const DELIVERY = [
  { id: 'download', label: 'Download', icon: Download },
  { id: 'email', label: 'Email', icon: Mail },
];

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const parseAddresses = (s) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

function Row({ label, children }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[5.5rem_1fr] sm:items-start">
      <p className="pt-1.5 text-caption font-semibold text-fg-muted">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex w-full rounded-lg border border-line bg-surface-sunken p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-small font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            value === o.id ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {o.icon ? <o.icon className="h-3.5 w-3.5" /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tick({ on, children, onToggle, hint }) {
  return (
    <label
      title={hint}
      className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-small text-fg hover:bg-surface-sunken"
    >
      <input type="checkbox" className="peer sr-only" checked={on} onChange={onToggle} />
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 ${
          on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface'
        }`}
      >
        {on ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </label>
  );
}

export default function HealthExportDialog({
  open, onOpenChange, rows = [], total = 0, columns = [], filters = [], scopeLabel = 'All cameras',
}) {
  const user = useAuthStore((s) => s.user);
  const [format, setFormat] = useState('pdf');
  const [delivery, setDelivery] = useState('download');
  const [picked, setPicked] = useState(() => new Set());
  const [extra, setExtra] = useState('');
  const [configured, setConfigured] = useState([]);
  // 'idle' | 'loading' | 'ready' | 'error' — a state machine rather than a
  // "have we got rows?" test, because an account with no recipients
  // configured yet is a legitimate READY answer. Deriving "not loaded" from an
  // empty list would re-fire the fetch on every render.
  const [listState, setListState] = useState('idle');
  const [listError, setListError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The account's alert recipients, fetched only when the operator asks to
  // email — the download path is the common one and must not wait on a
  // request it will never use.
  const loadRecipients = useCallback(async () => {
    setListState('loading');
    setListError(null);
    try {
      const { data } = await api.get('/notifications/emails');
      setConfigured((data?.emails || []).map((r) => r.email).filter(Boolean));
      setListState('ready');
    } catch (err) {
      // Said out loud: an empty list here would read as "nobody is configured".
      setListError(err?.response?.data?.message || 'The recipient list could not be loaded.');
      setListState('error');
    }
  }, []);

  useEffect(() => {
    if (open && delivery === 'email' && listState === 'idle') loadRecipients();
  }, [open, delivery, listState, loadRecipients]);

  // Own address last and only if it is not already configured, so the common
  // case — "send it to me" — is one tick rather than a typed address.
  const options = useMemo(() => {
    const list = configured.map((email) => ({ email, mine: false }));
    if (user?.email && !configured.includes(user.email)) list.push({ email: user.email, mine: true });
    return list;
  }, [configured, user]);

  const typed = parseAddresses(extra);
  const badAddress = typed.find((a) => !EMAIL_RE.test(a));
  const recipients = [...new Set([...picked, ...typed.filter((a) => EMAIL_RE.test(a))])];

  const emailError = delivery !== 'email' ? null
    : badAddress ? `“${badAddress}” is not a valid email address.`
      : !recipients.length ? 'Pick a recipient or type an address.'
        : null;

  const canSubmit = rows.length > 0 && !emailError && !busy;
  const formatMeta = EXPORT_FORMATS.find((f) => f.id === format);

  const toggle = (email) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const report = buildHealthReport({
        rows,
        columnIds: columns,
        total,
        scopeLabel,
        filters,
        generatedBy: user?.name || user?.email || 'Drishyam user',
      });

      if (delivery === 'download') {
        const { filename } = await downloadHealthReport(report, format);
        toast.success('Camera Status report ready', filename);
      } else {
        const { via, filename } = await emailHealthReport(report, format, recipients);
        if (via === 'server') {
          toast.success(
            `Report sent to ${recipients.length} ${recipients.length === 1 ? 'recipient' : 'recipients'}`,
            recipients.join(', '),
          );
        } else {
          // No mail route on this deployment — the operator still has the file
          // and an addressed draft, but they have to attach it themselves.
          toast.info('Report downloaded — email draft opened', `Attach ${filename} to the draft before sending.`, { ttl: 8_000 });
        }
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(
        delivery === 'email' ? 'Could not send the report' : 'Could not build the report',
        err?.response?.data?.message || err?.message || 'Unexpected error while building the file.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[calc(var(--app-vh)-2rem)] flex-col gap-0 overflow-hidden border-line bg-surface p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-5 pb-1 pt-5 text-left">
          <DialogTitle className="pr-6 text-heading font-bold text-fg">Export camera status</DialogTitle>
          <DialogDescription className="text-caption text-fg-muted">
            {scopeLabel} · {rows.length} {rows.length === 1 ? 'camera' : 'cameras'}
            {total > rows.length ? ` of ${total}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Row label="Format">
            <Segmented
              label="Format"
              options={EXPORT_FORMATS.map((f) => ({ ...f, icon: FORMAT_ICON[f.id] }))}
              value={format}
              onChange={setFormat}
            />
            <p className="mt-1.5 text-micro leading-relaxed text-fg-subtle">{formatMeta?.hint}</p>
          </Row>

          <Row label="Delivery">
            <Segmented label="Delivery" options={DELIVERY} value={delivery} onChange={setDelivery} />

            {delivery === 'email' ? (
              <div className="mt-2 space-y-2">
                <div className="rounded-lg border border-line bg-surface-sunken/60 p-1.5">
                  <p className="px-1.5 pb-1 text-micro font-semibold uppercase tracking-wider text-fg-subtle">
                    Configured recipients
                  </p>

                  {listState === 'loading' ? (
                    <p className="flex items-center gap-1.5 px-1.5 py-2 text-small text-fg-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading addresses…
                    </p>
                  ) : listState === 'error' ? (
                    <div className="px-1.5 py-1.5">
                      <p className="text-micro text-danger-ink">{listError}</p>
                      <button
                        type="button"
                        onClick={loadRecipients}
                        className="mt-1 text-micro font-semibold text-brand-ink underline-offset-2 hover:underline"
                      >
                        Try again
                      </button>
                    </div>
                  ) : options.length === 0 ? (
                    <p className="px-1.5 py-1.5 text-micro leading-relaxed text-fg-subtle">
                      No addresses are configured yet — add them under Settings › Alert recipients,
                      or type one below.
                    </p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto">
                      {options.map((o) => (
                        <Tick
                          key={o.email}
                          on={picked.has(o.email)}
                          onToggle={() => toggle(o.email)}
                          hint={o.mine ? 'Your own address' : 'Configured alert recipient'}
                        >
                          {o.email}
                          {o.mine ? (
                            <span className="ml-1.5 inline-flex items-center gap-1 text-micro text-fg-subtle">
                              <UserPlus className="h-3 w-3" />
                              you
                            </span>
                          ) : null}
                        </Tick>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <input
                    type="text"
                    inputMode="email"
                    autoComplete="email"
                    aria-label="Other recipients"
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                    placeholder="Other addresses — security@company.com, ops@company.com"
                    aria-invalid={Boolean(emailError)}
                    aria-describedby="che-recipients-help"
                    className={`h-9 w-full rounded-lg border bg-surface px-2.5 text-small text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                      emailError ? 'border-danger-line' : 'border-line focus:border-brand'
                    }`}
                  />
                  <p
                    id="che-recipients-help"
                    className={`mt-1 text-micro leading-relaxed ${emailError ? 'text-danger-ink' : 'text-fg-subtle'}`}
                  >
                    {emailError || `The ${formatMeta?.label} goes straight to ${recipients.length} ${recipients.length === 1 ? 'inbox' : 'inboxes'} — no download needed.`}
                  </p>
                </div>
              </div>
            ) : null}
          </Row>
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary hover:border-line-strong disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" />
              : delivery === 'email' ? <Mail className="h-4 w-4" />
                : <Download className="h-4 w-4" />}
            {busy
              ? (delivery === 'email' ? 'Sending…' : 'Preparing…')
              : (delivery === 'email' ? 'Send report' : `Download ${formatMeta?.label}`)}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
