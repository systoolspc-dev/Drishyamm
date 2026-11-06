import { useRef, useState } from 'react';
import { Workflow, Plus, Trash2, Save, RotateCcw, Zap } from 'lucide-react';
import Panel from '../Panel';
import { FIELDS, ACTIONS, SEVERITIES } from '../../rules-data';

const fieldDef = (id) => FIELDS.find((f) => f.id === id) || FIELDS[0];
const actionDef = (id) => ACTIONS.find((a) => a.id === id) || ACTIONS[0];

// A sensible default value for a field's value input.
const defaultValue = (def) =>
  def.type === 'select' ? def.options[0].id : def.type === 'time' ? '21:00' : '20';

// Human labels for the live preview / saved summary.
const valueLabel = (def, value) => {
  if (def.type === 'select') return (def.options.find((o) => o.id === value) || {}).label || value;
  if (def.type === 'number') return `${value} ${def.suffix}`.trim();
  return value;
};

const selectCls = 'rounded-lg border border-line bg-surface px-2 py-1.5 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none';

// Leading badge — IF / THEN (accent) for the first row, AND (slate) after.
function Badge({ kind }) {
  const accent = kind === 'IF' || kind === 'THEN';
  return (
    <span className={`inline-flex w-14 shrink-0 justify-center rounded-md px-2 py-1 text-micro font-bold uppercase tracking-wide ${
      accent ? 'bg-brand/10 text-brand-ink ring-1 ring-brand/25' : 'bg-surface-muted text-fg-muted'
    }`}>{kind}</span>
  );
}

export default function RuleBuilder({ onSave }) {
  const uid = useRef(10);
  const next = () => ++uid.current;

  const [name, setName] = useState('Loitering in CSE corridors');
  const [conditions, setConditions] = useState([
    { id: 1, field: 'department', operator: '=', value: 'cse' },
    { id: 2, field: 'activity', operator: '=', value: 'loitering' },
    { id: 3, field: 'duration', operator: '>', value: '20' },
  ]);
  const [actions, setActions] = useState([{ id: 1, action: 'generate_alert', severity: 'High' }]);

  // ── condition ops ──
  const addCondition = () => setConditions((c) => [...c, { id: next(), field: 'activity', operator: '=', value: 'gathering' }]);
  const removeCondition = (id) => setConditions((c) => (c.length > 1 ? c.filter((x) => x.id !== id) : c));
  const setField = (id, field) => {
    const def = fieldDef(field);
    setConditions((c) => c.map((x) => (x.id === id ? { ...x, field, operator: def.operators[0], value: defaultValue(def) } : x)));
  };
  const patchCondition = (id, patch) => setConditions((c) => c.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  // ── action ops ──
  const addAction = () => setActions((a) => [...a, { id: next(), action: 'notify_security', severity: 'Medium' }]);
  const removeAction = (id) => setActions((a) => (a.length > 1 ? a.filter((x) => x.id !== id) : a));
  const patchAction = (id, patch) => setActions((a) => a.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  // ── preview / save ──
  const condText = conditions.map((c) => {
    const def = fieldDef(c.field);
    return `${def.label} ${c.operator} ${valueLabel(def, c.value)}`;
  });
  const actText = actions.map((a) => {
    const def = actionDef(a.action);
    return def.hasSeverity ? `${def.label} (${a.severity})` : def.label;
  });

  const reset = () => {
    setName('');
    setConditions([{ id: next(), field: 'activity', operator: '=', value: 'loitering' }]);
    setActions([{ id: next(), action: 'generate_alert', severity: 'High' }]);
  };

  const save = () => {
    const primary = actions[0] ? actionDef(actions[0].action) : null;
    onSave?.({
      name: name.trim() || 'Untitled rule',
      summary: condText.join(' · '),
      action: primary ? primary.label : 'Log Event',
      severity: actions[0]?.severity || 'Medium',
    });
  };

  return (
    <Panel icon={Workflow} title="Rule Builder" right={<span className="text-caption text-fg-subtle">IF … THEN …</span>} bodyClass="p-4">
      {/* Rule name */}
      <div className="mb-4">
        <label className="mb-1 block text-micro font-semibold uppercase tracking-wide text-fg-subtle">Rule name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Loitering in CSE corridors"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-body font-semibold text-fg focus:border-brand focus:outline-none"
        />
      </div>

      {/* IF / AND conditions */}
      <div className="space-y-2">
        {conditions.map((c, i) => {
          const def = fieldDef(c.field);
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-sunken p-2">
              <Badge kind={i === 0 ? 'IF' : 'AND'} />
              <select value={c.field} onChange={(e) => setField(c.id, e.target.value)} className={selectCls}>
                {FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <select value={c.operator} onChange={(e) => patchCondition(c.id, { operator: e.target.value })} className={`${selectCls} w-16 text-center`}>
                {def.operators.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>

              {/* value input by type */}
              {def.type === 'select' ? (
                <select value={c.value} onChange={(e) => patchCondition(c.id, { value: e.target.value })} className={selectCls}>
                  {def.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              ) : def.type === 'time' ? (
                <input type="time" value={c.value} onChange={(e) => patchCondition(c.id, { value: e.target.value })} className={selectCls} />
              ) : (
                <span className="inline-flex items-center gap-1">
                  <input type="number" value={c.value} onChange={(e) => patchCondition(c.id, { value: e.target.value })} className={`${selectCls} w-20`} />
                  <span className="text-caption text-fg-subtle">{def.suffix}</span>
                </span>
              )}

              <button
                onClick={() => removeCondition(c.id)}
                disabled={conditions.length === 1}
                title="Remove condition"
                className="ml-auto rounded-md p-1.5 text-fg-subtle transition hover:bg-surface hover:text-danger disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        <button onClick={addCondition} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-caption font-semibold text-fg-muted transition hover:border-brand/40 hover:text-brand-ink">
          <Plus className="h-3.5 w-3.5" /> AND condition
        </button>
      </div>

      {/* THEN actions */}
      <div className="mt-4 space-y-2">
        {actions.map((a, i) => {
          const def = actionDef(a.action);
          return (
            <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-brand/[0.05] p-2 ring-1 ring-brand/15">
              <Badge kind={i === 0 ? 'THEN' : 'AND'} />
              <select value={a.action} onChange={(e) => patchAction(a.id, { action: e.target.value })} className={selectCls}>
                {ACTIONS.map((ac) => <option key={ac.id} value={ac.id}>{ac.label}</option>)}
              </select>
              {def.hasSeverity && (
                <select value={a.severity} onChange={(e) => patchAction(a.id, { severity: e.target.value })} className={selectCls}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              <button
                onClick={() => removeAction(a.id)}
                disabled={actions.length === 1}
                title="Remove action"
                className="ml-auto rounded-md p-1.5 text-fg-subtle transition hover:bg-surface hover:text-danger disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        <button onClick={addAction} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-caption font-semibold text-fg-muted transition hover:border-brand/40 hover:text-brand-ink">
          <Plus className="h-3.5 w-3.5" /> add action
        </button>
      </div>

      {/* Live preview */}
      <div className="mt-4 rounded-xl border border-line bg-slate-900 p-3 text-caption leading-relaxed text-slate-100">
        <p className="mb-1 flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-fg-subtle"><Zap className="h-3 w-3 text-brand" /> Preview</p>
        <p>
          <span className="font-bold text-brand">IF </span>
          {condText.join(' ')}
          {condText.length > 1 && ''}
        </p>
        <p className="mt-0.5">
          <span className="font-bold text-brand">THEN </span>
          <span className="text-success">{actText.join(' · ')}</span>
        </p>
        {/* readable AND-joined form */}
        <p className="mt-1 text-micro text-fg-subtle">{condText.join(' AND ')} → {actText.join(', ')}</p>
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center gap-2">
        <button onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover">
          <Save className="h-4 w-4" /> Save Rule
        </button>
        <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary transition hover:text-fg">
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </button>
      </div>
    </Panel>
  );
}
