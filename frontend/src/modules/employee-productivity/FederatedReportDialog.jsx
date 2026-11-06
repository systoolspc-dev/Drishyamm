import { useState } from 'react';
import { Check, Download, Loader2, Mail } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/core/ui/dialog';
import { toast } from '@/core/store/toastStore';
import { REPORT_SERVICES } from './report-services';
import { SECTION_ORDER, sectionAvailable } from './report-sections';
import { FEDERATED_FORMATS, generateFederated, openEmailDraft } from './report-bundle';
import { formatRange } from './scorecard-export';

// Federated Site Report — one consolidated bundle of the catalog's sections for
// an executive / audit reader. Three choices, nothing else: what goes in, what
// format, how it arrives. Scope (site, period, shift) comes from the page
// header, so the bundle and the screen can never disagree on what they cover.

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const parseRecipients = (s) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const DELIVERY = [
  { id: 'download', label: 'Download', icon: Download },
  { id: 'email', label: 'Email', icon: Mail },
];

// Executive summary first, as the bundle prints it.
const SERVICES = SECTION_ORDER.map((id) => REPORT_SERVICES.find((s) => s.id === id));

function Row({ label, children }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[6rem_1fr] sm:items-start">
      <p className="pt-1.5 text-caption font-semibold text-fg-muted">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Segmented({ label, options, value, onChange }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-full rounded-lg border border-line bg-surface-sunken p-0.5 sm:w-auto">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3.5 text-small font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:flex-none ${
            value === o.id ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {o.icon && <o.icon className="h-3.5 w-3.5" />} {o.label}
        </button>
      ))}
    </div>
  );
}

export default function FederatedReportDialog({ open, onOpenChange, ctx, defaultEmail = '' }) {
  const available = SERVICES.filter((s) => sectionAvailable(ctx, s.id)).map((s) => s.id);
  const [sections, setSections] = useState(available);
  const [format, setFormat] = useState('pdf');
  const [delivery, setDelivery] = useState('download');
  const [recipients, setRecipients] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);

  // Picked AND still offered — a vertical switch can take zones away.
  const picked = sections.filter((id) => available.includes(id));
  const emails = parseRecipients(recipients);
  const badEmail = emails.find((e) => !EMAIL_RE.test(e));
  const emailError = delivery === 'email' && (!emails.length ? 'Add at least one recipient.' : badEmail ? `"${badEmail}" is not a valid email address.` : null);
  const canGenerate = picked.length > 0 && !emailError && !busy;

  const toggle = (id) => setSections((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function generate() {
    if (!canGenerate) return;
    setBusy(true);
    try {
      const out = await generateFederated(ctx, { sections: picked, format });
      if (delivery === 'email') {
        openEmailDraft({ recipients: emails, ctx, ...out });
        toast.success('Report downloaded — email draft opened', `Attach ${out.filename} to the draft before sending.`, { ttl: 8_000 });
      } else {
        toast.success('Federated Site Report ready', out.filename);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not generate the report', err?.message || 'Unexpected error while building the file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[calc(var(--app-vh)-2rem)] flex-col gap-0 overflow-hidden border-line bg-surface p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-5 pb-1 pt-5 text-left">
          <DialogTitle className="pr-6 text-heading font-bold text-fg">Federated Site Report</DialogTitle>
          <DialogDescription className="text-caption text-fg-muted">
            {ctx.storeLabel} · {formatRange(ctx.from, ctx.to)} · {ctx.shiftLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <Row label="Include">
            <div className="space-y-0.5">
              {SERVICES.map((s) => {
                const enabled = available.includes(s.id);
                const on = enabled && picked.includes(s.id);
                return (
                  <label
                    key={s.id}
                    title={enabled ? s.description : s.unavailable}
                    className={`flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-small ${enabled ? 'cursor-pointer text-fg hover:bg-surface-sunken' : 'cursor-not-allowed text-fg-subtle'}`}
                  >
                    <input type="checkbox" className="peer sr-only" checked={on} disabled={!enabled} onChange={() => toggle(s.id)} />
                    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 ${on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface'}`}>
                      {on && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    {s.title(ctx.site)}
                  </label>
                );
              })}
            </div>
            {!picked.length && <p className="mt-1 px-1.5 text-micro text-danger-ink">Pick at least one section.</p>}
          </Row>

          <Row label="Format">
            <Segmented label="Format" options={FEDERATED_FORMATS} value={format} onChange={setFormat} />
          </Row>

          <Row label="Delivery">
            <Segmented label="Delivery" options={DELIVERY} value={delivery} onChange={setDelivery} />
            {delivery === 'email' && (
              <div className="mt-2">
                <input
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  aria-label="Recipients"
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="manager@company.com, audit@company.com"
                  aria-invalid={!!emailError}
                  aria-describedby="fsr-recipients-help"
                  className={`h-9 w-full rounded-lg border bg-surface px-2.5 text-small text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${emailError ? 'border-danger-line' : 'border-line focus:border-brand'}`}
                />
                <p id="fsr-recipients-help" className={`mt-1 text-micro ${emailError ? 'text-danger-ink' : 'text-fg-subtle'}`}>
                  {emailError || 'The file downloads and a draft opens in your mail app — attach it and send.'}
                </p>
              </div>
            )}
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
            onClick={generate}
            disabled={!canGenerate}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : delivery === 'email' ? <Mail className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
