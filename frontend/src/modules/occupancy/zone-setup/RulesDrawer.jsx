/**
 * Capacity & rules, as a right-hand drawer over the canvas.
 *
 * It used to be the third column of SetupGrid: 320-380px of accordion beside
 * the picture. That width was wrong for both halves at once -- a whitelist row
 * wrapped twice inside it, and the canvas it took the space from is the one
 * thing on this page that cannot be read smaller. The asymmetry the old layout
 * missed is that the two halves are not consulted at the same RATE: the shape
 * is drawn against the picture continuously, while "max 3 people" needs the
 * room once. So the picture keeps the width, and the rules come over it when
 * they are wanted.
 *
 * The TRIGGER carries the live CapacityBadge and nothing else. It briefly also
 * carried a one-line summary of every rule in force -- the argument being that
 * reading it was the reason not to open the drawer. In practice six clauses
 * ("Max 60 - warn at 90% - 09:00-18:00 - min 4 staff - dwell 4h - Public")
 * made one header button as wide as the rest of the header, to restate text
 * the accordion headers inside already carry verbatim. The badge survived that
 * cut because it is the only thing here that MOVES: config can wait for a
 * click, a live count cannot.
 *
 * NOT a modal, deliberately. `modal={false}`, a transparent overlay, and
 * outside clicks do not dismiss -- because the canvas behind has to stay live
 * and clickable while the rules are open. Flipping it to LIVE to watch a rule
 * being written against the actual building is the whole argument for this
 * page being one screen rather than a wizard, and a scrim over it would take
 * that back in the name of tidiness.
 *
 * Saving stays in the page header. One zone has one Save; a second one in here
 * would make "did my capacity save?" a question with two answers. `Done` only
 * closes, and the draft it wrote is still held by the page.
 *
 * The accordion inside survives the move, despite the drawer being tall enough
 * to flatten it. Three reasons it still earns the click: the collapsed
 * one-line summaries are the only place a rule nobody expected is visible
 * while scanning; `locked` (a new zone with no boundary) is expressed as a
 * disabled section, which needs sections; and Access & identity carries the
 * whole whitelist editor, so opening it by default would push capacity -- the
 * one field every zone needs -- back off the screen this move was meant to
 * win.
 */
import { useState } from 'react';
import {
  ArrowRight, Gauge, PanelRightOpen, ShieldAlert, X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger,
} from '@/core/ui/sheet';
import { CapacityBadge } from './StepBehaviour';
import RuleSections from './RuleSections';
import { StepTitle } from './SetupChrome';

export default function RulesDrawer({
  draft, set, access, lockedOut, suggestions, locked = false,
  count = 0, live = false, dirty = false,
  zonesHere, cameraName, isNew, onPickZone,
}) {
  const [open, setOpen] = useState(false);
  const badge = <CapacityBadge count={count} draft={draft} live={live} lockedOut={lockedOut} />;

  return (
    <Sheet modal={false} onOpenChange={setOpen} open={open}>
      {/* The trigger is a labelled DOOR, not a status chip. It carries the
          step number the canvas's "1 Draw" implies a partner for, the words
          in full at every width, and a panel glyph saying where it opens --
          because the one thing a drawer must never be is a thing nobody
          found. Brand-soft rather than a solid brand fill: Save is the page's
          one primary action, and two solid oranges in one header would make
          neither of them the answer to "what do I press". */}
      <SheetTrigger asChild>
        <button
          className={`inline-flex h-9 min-w-0 max-w-full shrink items-center gap-2 rounded-lg border px-2.5 text-small font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
            open
              ? 'border-brand bg-brand-soft text-brand-ink ring-1 ring-brand/30'
              : 'border-brand-line bg-brand-soft text-brand-ink hover:border-brand hover:bg-brand-line'
          }`}
          title="Capacity, schedule, staffing, dwell and access for this zone"
          type="button"
        >
          <StepTitle n={2} text={<span className="shrink-0 whitespace-nowrap">Capacity &amp; rules</span>} />
          {/* The badge stays and the rule summary does not. The summary was
              static configuration that the accordion headers inside repeat
              verbatim, and at six clauses it made a header button as wide as
              the rest of the header put together. The badge is the opposite:
              it moves every second, it is the one thing in here that cannot be
              inferred from the drawer being shut, and it is two glyphs wide. */}
          {badge}
          <PanelRightOpen className="h-4 w-4 shrink-0 opacity-70" strokeWidth={2.25} />
        </button>
      </SheetTrigger>

      <SheetContent
        className="w-[440px] max-w-full gap-0 border-l-2 border-l-brand/30 bg-surface p-0"
        // The canvas is not behind glass. Nothing about this drawer being open
        // should stop the operator pressing Live on the picture next to it.
        onInteractOutside={(e) => e.preventDefault()}
        overlayClassName="pointer-events-none bg-transparent"
        showCloseButton={false}
        side="right"
      >
        <header className="flex shrink-0 items-start gap-2 border-b border-line bg-surface px-4 py-3">
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-heading font-bold text-fg">
              <StepTitle n={2} text="Capacity & rules" />
            </SheetTitle>
            <SheetDescription className="mt-1.5 flex flex-wrap items-center gap-2 text-small leading-relaxed text-fg-subtle">
              {badge}
              <span className="min-w-0">
                {draft.name || 'This zone'} · saved from the page header, not from here.
              </span>
            </SheetDescription>
          </div>
          <SheetClose
            aria-label="Close capacity and rules"
            className="-mr-1 shrink-0 rounded-md p-1 text-fg-muted transition hover:bg-surface-sunken hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X className="h-4 w-4" strokeWidth={2.25} />
          </SheetClose>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
          <ZoneSwitcher
            activeId={draft.id}
            cameraName={cameraName}
            isNew={isNew}
            name={draft.name}
            onPick={onPickZone}
            zones={zonesHere}
          />
          <RuleSections
            access={access}
            draft={draft}
            locked={locked}
            lockedOut={lockedOut}
            set={set}
            suggestions={suggestions}
          />
        </div>

        <footer className="shrink-0 border-t border-line bg-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <SheetClose className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3.5 text-body font-semibold text-fg-secondary transition hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              Done
            </SheetClose>
            <Link
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-1 text-body font-semibold text-brand-ink transition hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              to="/occupancy/breaches"
            >
              <ShieldAlert className="h-3.5 w-3.5" strokeWidth={2.25} />
              View breaches
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
            </Link>
          </div>
          {/* Closing keeps every edit. Saying so is cheaper than the operator
              finding out by closing it once and checking. */}
          <p className="mt-2 flex items-center gap-1.5 text-small leading-relaxed text-fg-subtle">
            <Gauge className="h-3 w-3 shrink-0 text-brand" strokeWidth={2.5} />
            {dirty
              ? 'Unsaved changes are kept when this closes. Save Zone Configuration is in the page header.'
              : 'Closing keeps everything typed here. Saving is in the page header.'}
          </p>
        </footer>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The top of the rules pane: which zone these rules belong to, and the other
 * zones on the same camera, one click away. A zone just added shows up here at
 * once, marked new, so it is plain whose capacity is being typed.
 *
 * It follows the rules into the drawer rather than staying on the page: its
 * whole job is to label the fields under it, and a label that outlives what it
 * labels is just another thing on the canvas.
 */
function ZoneSwitcher({
  zones, activeId, name, isNew, cameraName, onPick,
}) {
  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-2.5 py-2">
      <p className="text-micro font-bold uppercase text-fg-subtle">
        Zones on {cameraName}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {zones.map((z) => {
          const on = z.id === activeId;
          const label = (on ? name : z.name) || 'Unnamed zone';
          return (
            <button
              aria-pressed={on}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-body font-semibold transition ${
                on ? 'border-brand bg-surface text-fg shadow-sm ring-1 ring-brand/30' : 'border-line bg-surface text-fg-muted hover:border-brand/40 hover:text-fg'
              }`}
              key={z.id}
              onClick={() => !on && onPick(z.id)}
              title={on ? 'The rules below are for this zone' : `Switch to ${label}`}
              type="button"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm ring-1 ring-black/20" style={{ background: z.color }} />
              <span className="min-w-0 truncate">{label}</span>
              {on && isNew ? (
                <span className="shrink-0 rounded bg-brand-soft px-1 text-micro font-bold uppercase text-brand-ink">New</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
