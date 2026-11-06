import { Workflow, Plus, Trash2, Save, RotateCcw, Zap } from 'lucide-react';
import RulePanel from './RulePanel';
import { fieldDefOf, actionDefOf } from './rules-data';
import { useRuleDraft } from './useRuleDraft';

const selectCls = 'min-w-0 rounded-lg border border-line bg-surface px-3 py-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none';

function Badge({ kind }) {
  const accent = kind === 'IF' || kind === 'THEN';
  return (
    <span className={`inline-flex w-14 shrink-0 justify-center rounded-md px-2 py-1 text-micro font-bold uppercase tracking-wide ${
      accent ? 'bg-brand/10 text-brand-ink ring-1 ring-brand/25' : 'bg-surface-muted text-fg-muted'
    }`}>{kind}</span>
  );
}

// Inline, data-driven IF … AND … THEN builder card (the school page). `fields`,
// `actions`, `severities` supply the vocabulary. Retail / corporate edit rules
// in RuleDrawer instead; both share their state through useRuleDraft.
export default function RuleBuilder({ fields, actions, severities, onSave, className = '' }) {
  const d = useRuleDraft({ fields, actions, severities });
  const { name, setName, conditions, setField, patchCondition, removeCondition, addCondition, patchAction, removeAction, addAction, reset, condText, actText } = d;
  const ruleActions = d.actions;
  const fieldDef = (id) => fieldDefOf(fields, id);

  // Same shape the page has always received: the table's text columns.
  const save = () => {
    const rule = d.toRule();
    onSave?.({
      name: rule.name,
      summary: condText.join(' · '),
      action: actionDefOf(actions, rule.actions[0].action).label,
      severity: rule.actions[0].severity,
    });
  };

  const rowCls = 'flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 lg:flex-nowrap';
  const addCls = 'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-2.5 py-1 text-caption font-semibold text-fg-muted transition hover:border-brand/40 hover:text-brand-ink';

  return (
    <RulePanel
      icon={Workflow}
      title="Rule Builder"
      right={<span className="text-caption text-fg-subtle">IF … THEN …</span>}
      className={className}
      bodyClassName="scrollbar-thin min-h-0 space-y-2 overflow-y-auto p-3"
    >
      {/* Name + save/reset on one line */}
      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
        <label htmlFor="rule-name" className="sr-only">Rule name</label>
        <input
          id="rule-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rule name — e.g. After-hours server-room access"
          className="min-w-0 flex-1 basis-full rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg focus:border-brand focus:outline-none sm:basis-auto"
        />
        <button onClick={save} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover">
          <Save className="h-3.5 w-3.5" /> Save Rule
        </button>
        <button onClick={reset} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary transition hover:text-fg">
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </button>
      </div>

      {/* IF / AND conditions */}
      <div className="space-y-1.5">
        {conditions.map((c, i) => {
          const def = fieldDef(c.field);
          return (
            <div key={c.id} className={`${rowCls} bg-surface-sunken`}>
              <Badge kind={i === 0 ? 'IF' : 'AND'} />
              <select value={c.field} onChange={(e) => setField(c.id, e.target.value)} className={selectCls}>
                {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <select value={c.operator} onChange={(e) => patchCondition(c.id, { operator: e.target.value })} className={`${selectCls} w-16 shrink-0 text-center`}>
                {def.operators.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              {def.type === 'select' ? (
                <select value={c.value} onChange={(e) => patchCondition(c.id, { value: e.target.value })} className={selectCls}>
                  {def.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              ) : def.type === 'time' ? (
                <input type="time" value={c.value} onChange={(e) => patchCondition(c.id, { value: e.target.value })} className={selectCls} />
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <input type="number" value={c.value} onChange={(e) => patchCondition(c.id, { value: e.target.value })} className={`${selectCls} w-20`} />
                  <span className="text-caption text-fg-subtle">{def.suffix}</span>
                </span>
              )}
              <button onClick={() => removeCondition(c.id)} disabled={conditions.length === 1} title="Remove condition" className="ml-auto shrink-0 rounded-md p-1.5 text-fg-subtle transition hover:bg-surface hover:text-danger disabled:opacity-30">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* THEN actions */}
      <div className="space-y-1.5">
        {ruleActions.map((a, i) => {
          return (
            <div key={a.id} className={`${rowCls} bg-brand/[0.05] ring-1 ring-brand/15`}>
              <Badge kind={i === 0 ? 'THEN' : 'AND'} />
              <select value={a.action} onChange={(e) => patchAction(a.id, { action: e.target.value })} className={selectCls}>
                {actions.map((ac) => <option key={ac.id} value={ac.id}>{ac.label}</option>)}
              </select>
              <select value={a.severity} onChange={(e) => patchAction(a.id, { severity: e.target.value })} className={selectCls}>
                {severities.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={() => removeAction(a.id)} disabled={ruleActions.length === 1} title="Remove action" className="ml-auto shrink-0 rounded-md p-1.5 text-fg-subtle transition hover:bg-surface hover:text-danger disabled:opacity-30">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Add buttons + one-line live preview bar (full text in the tooltip) */}
      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
        <button onClick={addCondition} className={addCls}><Plus className="h-3.5 w-3.5" /> AND condition</button>
        <button onClick={addAction} className={addCls}><Plus className="h-3.5 w-3.5" /> THEN action</button>
        <div
          title={`${condText.join(' AND ')} → ${actText.join(', ')}`}
          className="flex min-w-0 basis-full items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-caption text-slate-100 lg:flex-1 lg:basis-auto"
        >
          <Zap className="h-3 w-3 shrink-0 text-brand" />
          <p className="min-w-0 lg:truncate">
            <span className="font-bold text-brand">IF </span>{condText.join(' AND ')}
            <span className="font-bold text-brand"> THEN </span><span className="text-success">{actText.join(' · ')}</span>
          </p>
        </div>
      </div>
    </RulePanel>
  );
}
