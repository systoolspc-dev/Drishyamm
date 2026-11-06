/**
 * The page's date & time control: a range preset (Today, Last 24h, …, or a
 * custom pair of days), and a shift that narrows every day in the range to
 * its hours. One button, one popover; the button reads back the choice.
 */
import { useState } from 'react';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/core/ui/popover';
import { BRAND_SHEEN, BRAND_SHEEN_ROW } from '@/core/ui/tone';
import { RANGE_PRESETS, SHIFTS, istYmd, rangeLabel } from './breach-model';

// The chosen row holds the brand wash at full strength; the rest pick it up
// under the pointer. Both come from the one definition in core/ui/tone.js, so
// this popover cannot drift from the four Selects standing next to it.
const itemCls = (on) => `flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-small ${
  on
    ? 'bg-linear-to-r from-brand/20 to-brand-active/10 font-semibold text-brand-ink'
    : `text-fg-secondary ${BRAND_SHEEN_ROW}`
}`;
const dateCls = 'h-8 w-full rounded-lg border border-line bg-surface px-2 text-small text-fg-secondary focus:border-brand focus:outline-none';

export default function BreachRangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [today] = useState(() => istYmd(Date.now()));
  const [draft, setDraft] = useState({ from: value.from || today, to: value.to || today });

  const pick = (preset) => {
    if (preset === 'custom') { onChange({ ...value, preset, ...draft }); return; }
    onChange({ ...value, preset });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Date range: ${rangeLabel(value)}`}
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary focus:border-brand focus:outline-none ${BRAND_SHEEN}`}
          type="button"
        >
          <CalendarDays className="h-3.5 w-3.5 text-fg-subtle" />
          <span className="max-w-[14rem] truncate">{rangeLabel(value)}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-70" />
        </button>
      </PopoverTrigger>
      {/* Beneath the trigger, left edges flush, 8px gap — the same anchor the
          four Selects beside it use. */}
      <PopoverContent align="start" className="w-72 border-line bg-surface p-2" side="bottom" sideOffset={8}>
        <p className="px-2 pb-1 text-micro font-bold uppercase tracking-wide text-fg-subtle">Range</p>
        {RANGE_PRESETS.map((p) => (
          <button className={itemCls(value.preset === p.id)} key={p.id} onClick={() => pick(p.id)} type="button">
            {p.label}
            {value.preset === p.id && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
        {value.preset === 'custom' && (
          <div className="mt-1 grid grid-cols-2 gap-2 px-2 pb-1">
            <label className="text-micro font-semibold text-fg-subtle">
              From
              <input
                className={dateCls} max={draft.to || today} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                type="date" value={draft.from}
              />
            </label>
            <label className="text-micro font-semibold text-fg-subtle">
              To
              <input
                className={dateCls} max={today} min={draft.from} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                type="date" value={draft.to}
              />
            </label>
            <button
              className="col-span-2 h-8 rounded-lg bg-brand text-small font-semibold text-white transition hover:bg-brand-hover disabled:opacity-50"
              disabled={!draft.from || !draft.to}
              onClick={() => { onChange({ ...value, preset: 'custom', ...draft }); setOpen(false); }}
              type="button"
            >
              Apply range
            </button>
          </div>
        )}

        <p className="mt-2 border-t border-line-subtle px-2 pb-1 pt-2 text-micro font-bold uppercase tracking-wide text-fg-subtle">
          Shift (IST)
        </p>
        {SHIFTS.map((s) => (
          <button className={itemCls(value.shift === s.id)} key={s.id} onClick={() => onChange({ ...value, shift: s.id })} type="button">
            {s.label}
            {value.shift === s.id && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
