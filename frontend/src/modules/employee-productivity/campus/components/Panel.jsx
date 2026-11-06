import CorePanel from '@/core/ui/panel';

// The app's panel lives in `@/core/ui/panel`; every Activity Monitoring page
// imports it through this path. The one thing this wrapper adds is the
// module's section-heading type — the same `text-sm → sm:text-base` semibold
// heading the Face Watchlist and the Operations pages use — so a panel title
// reads at the same weight as every other sub-header in Activity Monitoring.
// Other modules import the core panel directly and keep its default title.
const SECTION_TITLE = 'text-sm font-semibold text-fg sm:text-base';

export default function Panel(props) {
  return <CorePanel titleClassName={SECTION_TITLE} {...props} />;
}
