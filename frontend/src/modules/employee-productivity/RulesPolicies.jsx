import { useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Scale, CheckCircle2, X, Info, Plus } from 'lucide-react';

import { useActivityParams } from './useCaseStore';
import { rulesFor, describeRule, SEVERITIES, RULE_STATUS, SEVERITY_TEXT } from './rules/rules-data';
import RuleCards from './rules/RuleCards';
import RuleDrawer from './rules/RuleDrawer';
import RulesTable from './rules/RulesTable';

// ─────────────────────────────────────────────────────────────────────────────
// Rules & Policies — store/office module (retail + corporate).
//
// The enterprise rule engine for the shop-floor / office verticals. Same
// data-driven engine campus uses; the condition/action vocabulary comes from
// rulesFor(useCase). FRONTEND-ONLY. Campus has its own rules page.
//
// Layout: below `lg` the page scrolls naturally and the sections stack. From
// `lg` up it is held to the viewport (--app-vh, never raw 100vh — see the
// app-zoom note in index.css): header, toast and cards keep their height and
// the rules table takes the rest, scrolling under a pinned header.
//
// Rules are created and edited in a right-hand drawer (RuleDrawer), opened
// from "Create New Rule" or by clicking a row — the builder no longer takes a
// fixed slice of the page from the table.
// ─────────────────────────────────────────────────────────────────────────────

export default function RulesPolicies() {
  const { useCase, label } = useActivityParams();
  // Remount on vertical switch so the rules state re-seeds cleanly.
  return <RulesEngine key={useCase} data={rulesFor(useCase)} label={label} />;
}

// Hover or click opens; the short close delay lets the pointer cross into the
// content without it closing (same pattern as PolicyRulesButton).
function EngineInfo({ label }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(null);
  const hoverOpen = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hoverClose = () => { closeTimer.current = setTimeout(() => setOpen(false), 120); };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="About the rules & policies engine"
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          className="inline-flex h-11 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 text-caption font-semibold text-fg-muted transition hover:border-brand/40 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=open]:border-brand/40 data-[state=open]:text-brand-ink lg:h-7"
        >
          <Info className="h-3.5 w-3.5" /> Rules &amp; Policies Engine
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          className="z-50 w-80 max-w-[calc(var(--app-vw)-2rem)] rounded-xl border border-line bg-surface p-3 text-left shadow-lg outline-none"
        >
          <p className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Enterprise rule engine</p>
          <p className="mt-1.5 text-small leading-relaxed text-fg-muted">
            Configure automated IF/THEN logic triggers driving real-time {label} alerts, manager
            notifications, and security logs across all connected store cameras and zones.
          </p>
          <PopoverPrimitive.Arrow className="fill-surface" width={10} height={5} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function RulesEngine({ data, label }) {
  const uid = useRef(100);
  const [rules, setRules] = useState(data.rules);
  const [toast, setToast] = useState(null);
  // Drawer: open flag + target ('new' or the rule being edited). The target is
  // kept while the drawer slides shut, so the form doesn't blank mid-animation.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState('new');

  const openNew = () => { setEditing('new'); setDrawerOpen(true); };
  const openEdit = (rule) => { setEditing(rule); setDrawerOpen(true); };
  const close = () => setDrawerOpen(false);

  const handleSave = (draft) => {
    const text = describeRule(data, draft);
    if (editing !== 'new') {
      setRules((prev) => prev.map((r) => (r.id === editing.id ? { ...r, ...draft, ...text, updated: 'Just now' } : r)));
      setToast(`Rule "${draft.name}" updated.`);
    } else {
      const id = `r${++uid.current}`;
      setRules((prev) => [{ ...draft, ...text, id, status: 'pending', triggers: 0, updated: 'Just now' }, ...prev]);
      setToast(`Rule "${draft.name}" saved — pending review.`);
    }
    close();
  };

  const handleToggle = (id) => setRules((prev) => prev.map((r) => (
    r.id === id ? { ...r, status: r.status === 'active' ? 'disabled' : 'active' } : r
  )));

  return (
    <div className="flex min-h-[calc(var(--app-vh)-var(--topbar-h))] w-full flex-col gap-3 bg-surface-sunken/60 page-inset md:gap-4 lg:h-[calc(var(--app-vh)-var(--topbar-h))] lg:min-h-0 lg:overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
          <Scale className="h-5 w-5" strokeWidth={2} />
        </span>
        <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Rules &amp; Policies</h1>
        <EngineInfo label={label} />
        <button
          type="button"
          onClick={openNew}
          className="ml-auto inline-flex h-11 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-9"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} /> Create New Rule
        </button>
      </div>

      {toast && (
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-success-line bg-success-soft px-3 py-2 text-small text-success-ink">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="flex-1">{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <RuleCards cards={data.cards} className="shrink-0" />
      <RulesTable
        rules={rules}
        onToggle={handleToggle}
        onEdit={openEdit}
        statusMeta={RULE_STATUS}
        severityText={SEVERITY_TEXT}
        className="lg:min-h-0 lg:flex-1"
      />

      <RuleDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        rule={editing === 'new' ? null : editing}
        fields={data.fields}
        actions={data.actions}
        severities={SEVERITIES}
        scopes={data.scopes}
        onSave={handleSave}
      />
    </div>
  );
}
