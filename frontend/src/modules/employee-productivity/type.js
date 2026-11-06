// Activity Monitoring type hierarchy — one scale for every page in the module
// (Activity Monitoring, Employee Scorecard / Performance, Event Logs, Retail
// Analytics).
//
//   L1  24px bold      page title             (text-2xl)
//   L2  18px semibold  section / card heading (text-lg)
//   L3  14px semibold  primary entity — employee name, alert title, a table's primary cell (text-sm)
//   L4  14px           other table values
//   L5  12px           secondary subtext — role, timestamp, department, subtitle;
//                      column headers (uppercase)                               (text-xs)
//   Badges             12px — severity bold/uppercase/rounded-md,
//                      state medium/rounded-full
//
// Each level is a step down from the one above it, so a row can never read
// louder than the heading of the card it sits in. Pages use these tokens (or
// the equivalent classes) instead of picking a size per component.
//
// Colours are theme tokens, not gray-*: text-fg is the gray-900 role and
// text-fg-muted the gray-500 role, and both flip in dark mode.
//
// Plain .js so components can import it without breaking Fast Refresh.

export const T = {
  pageTitle: 'text-2xl font-bold leading-tight tracking-tight text-fg',          // L1
  pageSub:   'mt-1 text-xs font-normal text-fg-muted',                           // under L1
  section:   'text-lg font-semibold text-fg',                                    // L2

  itemTitle: 'text-sm font-semibold leading-snug text-fg',                       // L3
  itemMeta:  'text-xs font-normal text-fg-muted',                                // L5
  itemDetail:'text-xs font-normal text-fg-muted',                                // L5

  th:        'text-xs font-semibold uppercase tracking-wider text-fg-muted',     // L5, header
  tdPrimary: 'text-sm font-semibold text-fg',                                    // L3
  td:        'text-sm text-fg-secondary',                                        // L4
  tdSub:     'text-xs font-normal text-fg-muted',                                // L5

  // Priority / severity (HIGH, MEDIUM, LOW) — pair with a soft fill + ink colour.
  severityBadge: 'px-2 py-0.5 text-xs font-bold uppercase rounded-md',
  // Presence state (On Floor, Break, Away) — pair with STATUS_META[...].cls.
  stateBadge:    'px-2.5 py-0.5 text-xs font-medium rounded-full',
  badge:     'text-xs font-medium',                                              // other chips
};

// Column header cell — the ONE header look for every Activity Monitoring table
// (Employee Scorecard, Event Logs, Retail Analytics, Live Zone Status), so
// moving between them never changes the header. Pick by column content: text
// columns `left`, numbers `right`, compact counts/badges `center` — and align
// the column's <td>s the same way. Browsers center <th> by default and
// preflight does not reset it, so the alignment is always explicit.
//
// Theme tokens rather than gray-*: they flip in dark mode. The underline is an
// inset shadow, not border-b, because a sticky <th> in a border-collapse
// table drops its border as soon as it sticks. The fill is solid for the same
// reason — rows scroll underneath a sticky header.
// Body cells pair with it at px-4 so header text sits over the cell text.
const TH_BASE = `h-11 whitespace-nowrap bg-surface-sunken px-4 py-3 align-middle ${T.th} shadow-[inset_0_-1px_0_var(--line)]`;
export const TH = {
  left:   `${TH_BASE} text-left`,
  right:  `${TH_BASE} text-right`,
  center: `${TH_BASE} text-center`,
};
// For a header that stays put while its table scrolls.
export const TH_STICKY = 'sticky top-0 z-10';
