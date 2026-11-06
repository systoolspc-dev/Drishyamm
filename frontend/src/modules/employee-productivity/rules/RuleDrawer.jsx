import { Workflow, Plus, Trash2, Save, RotateCcw, X, Zap } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetClose } from '@/core/ui/sheet';
import { fieldDefOf } from './rules-data';
import { useRuleDraft } from './useRuleDraft';

// ─────────────────────────────────────────────────────────────────────────────
// Rule Builder drawer — create a rule, or edit one opened from the table.
//
// A right-hand Sheet (Radix Dialog underneath: Esc, outside click, focus trap
// and scroll lock come with it). Full width on phones, 480px from sm, 540px
// from md. Header and footer stay put; only the form between them scrolls.
//
//   header   Rule Builder | Edit Rule · one-line purpose · close
//   body     name · IF conditions (+ AND) · THEN actions (+ THEN) · scope ·
//            live preview of the rule as pills
//   footer   Reset · Cancel · Save Rule
//
// `rule` is the structured rule being edited (null for a new one). The form
// is keyed on it by the caller, so opening another rule starts a fresh draft.
// ─────────────────────────────────────────────────────────────────────────────

export default function RuleDrawer({ open, onOpenChange, rule, fields, actions, severities, scopes, onSave }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-background/80 backdrop-blur-sm"
        className="w-full max-w-none gap-0 border-line bg-surface shadow-2xl sm:w-[480px] md:w-[540px]"
      >
        {/* Radix unmounts the content once closed, so each opening starts a
            fresh draft; the key covers switching rules while open. */}
        <RuleForm
          key={rule?.id || 'new'}
          rule={rule}
          fields={fields}
          actions={actions}
          severities={severities}
          scopes={scopes}
          onSave={onSave}
        />
      </SheetContent>
    </Sheet>
  );
}

function RuleForm({ rule, fields, actions, severities, scopes, onSave }) {
  const d = useRuleDraft({ fields, actions, severities, scopes, initial: rule });
  const editing = Boolean(rule);
  const named = d.name.trim().length > 0;

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
          <Workflow className="h-4.5 w-4.5" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <SheetTitle className="text-base font-bold tracking-tight text-fg">{editing ? 'Edit Rule' : 'Rule Builder'}</SheetTitle>
          <SheetDescription className="mt-1 text-small text-fg-muted">Configure IF/THEN logic triggers for automated alerts</SheetDescription>
        </div>
        <SheetClose
          aria-label="Close"
          className="-mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-fg-subtle transition hover:bg-surface-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-8 lg:w-8"
        >
          <X className="h-4 w-4" />
        </SheetClose>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="scrollbar-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <Field label="Rule name" htmlFor="rule-name">
          <input
            id="rule-name"
            value={d.name}
            onChange={(e) => d.setName(e.target.value)}
            placeholder="e.g. After-hours server-room access"
            autoComplete="off"
            className={`${inputCls} font-semibold text-fg`}
          />
        </Field>

        {/* IF */}
        <Section kind="IF" title="Conditions" hint="All conditions must match">
          {d.conditions.map((c, i) => {
            const def = fieldDefOf(fields, c.field);
            return (
              <Row key={c.id} tag={i === 0 ? 'IF' : 'AND'} onRemove={() => d.removeCondition(c.id)} canRemove={d.conditions.length > 1} tone="neutral">
                <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)]">
                  <Select label="Parameter" value={c.field} onChange={(v) => d.setField(c.id, v)}>
                    {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </Select>
                  <Select label="Operator" value={c.operator} onChange={(v) => d.patchCondition(c.id, { operator: v })}>
                    {def.operators.map((op) => <option key={op} value={op}>{op}</option>)}
                  </Select>
                  <div className="col-span-2 sm:col-span-1">
                    <MiniLabel>Value</MiniLabel>
                    {def.type === 'select' ? (
                      <select value={c.value} onChange={(e) => d.patchCondition(c.id, { value: e.target.value })} aria-label="Value" className={inputCls}>
                        {def.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                    ) : def.type === 'time' ? (
                      <input type="time" value={c.value} onChange={(e) => d.patchCondition(c.id, { value: e.target.value })} aria-label="Value" className={inputCls} />
                    ) : (
                      <div className="relative">
                        <input type="number" min="0" value={c.value} onChange={(e) => d.patchCondition(c.id, { value: e.target.value })} aria-label="Value" className={`${inputCls} pr-14`} />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-caption text-fg-subtle">{def.suffix}</span>
                      </div>
                    )}
                  </div>
                </div>
              </Row>
            );
          })}
          <AddButton onClick={d.addCondition}>Add AND condition</AddButton>
        </Section>

        {/* THEN */}
        <Section kind="THEN" title="Actions" hint="Run in order when the rule fires">
          {d.actions.map((a, i) => (
            <Row key={a.id} tag={i === 0 ? 'THEN' : 'AND'} onRemove={() => d.removeAction(a.id)} canRemove={d.actions.length > 1} tone="brand">
              <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
                <Select label="Action" value={a.action} onChange={(v) => d.patchAction(a.id, { action: v })}>
                  {actions.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </Select>
                <Select label="Severity" value={a.severity} onChange={(v) => d.patchAction(a.id, { severity: v })}>
                  {severities.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </div>
            </Row>
          ))}
          <AddButton onClick={d.addAction}>Add THEN action</AddButton>
        </Section>

        {scopes?.length > 0 && (
          <Field label="Scope" htmlFor="rule-scope">
            <select id="rule-scope" value={d.scope} onChange={(e) => d.setScope(e.target.value)} className={inputCls}>
              {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        )}

        {/* Live preview, as the rule will read */}
        <div className="rounded-xl border border-line bg-surface-sunken p-3.5">
          <p className="mb-2 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-fg-subtle">
            <Zap className="h-3 w-3 text-brand" /> Preview
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-caption">
            <Pill tone="keyword">IF</Pill>
            {d.condText.map((t, i) => (
              <span key={`c${i}`} className="contents">
                {i > 0 && <span className="font-bold text-fg-subtle">AND</span>}
                <Pill>{t}</Pill>
              </span>
            ))}
            <Pill tone="keyword">THEN</Pill>
            {d.actText.map((t, i) => (
              <span key={`a${i}`} className="contents">
                {i > 0 && <span className="font-bold text-fg-subtle">AND</span>}
                <Pill tone="action">{t}</Pill>
              </span>
            ))}
          </div>
          {d.scope && <p className="mt-2 text-caption text-fg-muted">Applies to <span className="font-semibold text-fg-secondary">{d.scope}</span></p>}
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-5 py-3">
        <button type="button" onClick={d.reset} className={`${btnCls} text-fg-muted hover:text-fg`} title={editing ? 'Undo changes to this rule' : 'Start over'}>
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </button>
        <span className="flex-1" />
        <SheetClose className={`${btnCls} border border-line bg-surface text-fg-secondary hover:border-line-strong hover:text-fg`}>
          Cancel
        </SheetClose>
        <button
          type="button"
          onClick={() => onSave(d.toRule())}
          disabled={!named}
          title={named ? undefined : 'Name the rule to save it'}
          className={`${btnCls} bg-brand text-white shadow-sm hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <Save className="h-3.5 w-3.5" /> Save Rule
        </button>
      </div>
    </>
  );
}

function Section({ kind, title, hint, children }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="rounded-md bg-brand/10 px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-brand-ink ring-1 ring-brand/25">{kind}</span>
        <h3 className="text-small font-bold text-fg">{title}</h3>
        <span className="text-caption text-fg-subtle">{hint}</span>
      </div>
      {children}
    </section>
  );
}

function Row({ tag, tone, canRemove, onRemove, children }) {
  return (
    <div className={`rounded-lg p-2.5 ${tone === 'brand' ? 'bg-brand/[0.05] ring-1 ring-brand/15' : 'bg-surface-sunken ring-1 ring-line-subtle'}`}>
      <div className="mb-1.5 flex items-center">
        <span className="text-micro font-bold uppercase tracking-wide text-fg-muted">{tag}</span>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Remove"
          title="Remove"
          className="ml-auto grid h-9 w-9 place-items-center rounded-md text-fg-subtle transition hover:bg-surface hover:text-danger disabled:opacity-30 lg:h-7 lg:w-7"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}

function Field({ label, htmlFor, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-micro font-semibold uppercase tracking-wide text-fg-subtle">{label}</label>
      {children}
    </div>
  );
}

function MiniLabel({ children }) {
  return <span className="mb-1 block text-[10px] font-semibold text-fg-subtle">{children}</span>;
}

function Select({ label, value, onChange, children }) {
  return (
    <div className="min-w-0">
      <MiniLabel>{label}</MiniLabel>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={inputCls}>
        {children}
      </select>
    </div>
  );
}

function AddButton({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 text-caption font-semibold text-fg-muted transition hover:border-brand/40 hover:text-brand-ink lg:h-8"
    >
      <Plus className="h-3.5 w-3.5" /> {children}
    </button>
  );
}

function Pill({ tone, children }) {
  const cls = tone === 'keyword'
    ? 'bg-brand text-white font-bold'
    : tone === 'action'
      ? 'bg-success-soft text-success-ink ring-1 ring-success-line font-semibold'
      : 'bg-surface text-fg-secondary ring-1 ring-line font-medium';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 ${cls}`}>{children}</span>;
}

const inputCls = 'h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-small text-fg-secondary outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20 lg:h-9';
const btnCls = 'inline-flex h-11 items-center gap-1.5 rounded-lg px-3.5 text-small font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-9';
