import { X } from 'lucide-react';

/**
 * The filters currently narrowing the log, one chip each, with an × on every
 * chip and a Clear all at the end.
 *
 * WHY IT EXISTS. The controls above are eight dropdowns in a wrapping row, and
 * a dropdown states its value only if you look straight at it. That is fine
 * when you set the filter yourself and forget-ability is the only cost. It is
 * not fine when the page is opened by a LINK — from Zone Coverage, from the
 * dashboard, from a pasted URL — because then nobody chose those filters, the
 * table is already narrowed, and the row count is small for a reason that is
 * three controls away from the eye. Every arrival like that used to look like
 * "the log is nearly empty today".
 *
 * So the chips are not decoration for the dropdowns: they are the answer to
 * "why am I seeing 4 rows", stated once, in words, directly above the table.
 *
 * DERIVED FROM STATE, NOT FROM THE URL. The chips read the page's live filter
 * state, which is also what the table filters on — so a chip cannot disagree
 * with the rows beneath it. Reading the URL instead would have shown only the
 * filters that arrived in the link and missed every one set by hand, which is
 * the same bug in the other direction.
 *
 * Date is deliberately absent. It is always set (there is no "all time"), it
 * is already spelled out in the page header and it has its own preset row, so
 * a chip for it would be a permanent, unclearable piece of furniture.
 */
export default function LogFilterChips({ chips, onClearAll }) {
  if (!chips.length) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5" role="group" aria-label="Active filters">
      <span className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Filtered by</span>

      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex items-center gap-1 rounded-full border border-brand-line bg-brand-soft py-0.5 pl-2.5 pr-1 text-caption font-semibold text-brand-ink"
        >
          {/* The label names the FIELD, so a lone value like "Apparel" or
              "High" cannot be read as the wrong kind of filter. */}
          <span className="text-fg-muted">{chip.label}:</span>
          <span className="max-w-[12rem] truncate">{chip.value}</span>
          <button
            type="button"
            onClick={chip.onClear}
            aria-label={`Remove the ${chip.label} filter`}
            title={`Remove ${chip.label}: ${chip.value}`}
            className="ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-brand-ink/70 transition hover:bg-brand/20 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <X className="h-3 w-3" strokeWidth={2.5} />
          </button>
        </span>
      ))}

      {/* Only worth offering once there is more than one thing to clear —
          with a single chip it would be a second button doing the same job. */}
      {chips.length > 1 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="rounded-full px-2 py-0.5 text-caption font-semibold text-fg-muted underline-offset-2 transition hover:text-brand-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
