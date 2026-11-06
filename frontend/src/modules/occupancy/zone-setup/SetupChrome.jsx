/**
 * The frame Zone Setup's two modes share: the page header, the numbered step
 * badge, and the note that reports what the last save did.
 *
 * Its own file because zone mode and gate mode both need them, and neither
 * should import from the other.
 */
import { MapPin, Users, X } from 'lucide-react';
import { PageAction, PageHeader } from '@/core/layout/OperationsPage';

/**
 * The outcome of the last save or delete, or why a save was refused.
 * `savedText` is what a clean save says, since a zone and a gate land in
 * different places.
 */
export function ResultNote({ result, flash, savedText }) {
  if (result?.blocked) {
    return (
      <div className="rounded-xl border border-warning-line bg-warning-soft px-3.5 py-2.5 text-body leading-relaxed text-warning-ink" role="alert">
        <p className="font-semibold">Not saved yet:</p>
        <ul className="mt-1 list-disc pl-4">
          {result.blocked.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </div>
    );
  }
  const text = result ? result.error || result.message || savedText : flash;
  if (!text) return null;
  const warn = Boolean(result?.error);
  return (
    <p className={`rounded-xl border px-3.5 py-2.5 text-body leading-relaxed ${
      warn ? 'border-warning-line bg-warning-soft text-warning-ink' : 'border-success-line bg-success-soft text-success-ink'
    }`}
    >
      {text}
    </p>
  );
}

/** The numbered badge that keeps the two halves legible as one ordered task. */
export function StepTitle({ n, text }) {
  return (
    <span className="flex items-center gap-2">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand text-small font-bold text-white">
        {n}
      </span>
      {text}
    </span>
  );
}

export function SetupHeader({ onCancel, right }) {
  return (
    <PageHeader
      actions={
        <>
          <PageAction onClick={onCancel} type="button">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
            Cancel
          </PageAction>
          {right}
        </>
      }
      breadcrumb={[
        { label: 'Footfall & Occupancy', to: '/occupancy', icon: Users },
        { label: 'Zone Setup' },
      ]}
      description="Pick a camera on the left. Draw zones over its view -- a camera can hold several zones, and a zone can span several cameras -- and give each a capacity, with more rules if needed. A camera can also be a gate: place a line across its view, and everyone who crosses it is counted IN or OUT."
      descriptionAs="tooltip"
      icon={MapPin}
      tagline="Cameras, zones, gates and rules — one screen."
      title="Zone Setup & Behavior Configuration"
    />
  );
}

/**
 * The working columns -- rail, picture, and optionally a third pane -- shared
 * by zone mode and gate mode so switching between them never changes the
 * page's shape.
 *
 * From xl up the page fits the viewport: the grid takes the height left under
 * the header and each column scrolls inside itself, so the panel headers sit
 * on one line and the panels end on one line. Below xl there is not room for
 * three columns, and the page scrolls as a whole instead.
 *
 * `right` is OPTIONAL now. Zone mode dropped it: its rules moved into a
 * drawer, and the width they were taking went back to the canvas, which is the
 * one thing on this page that cannot be read smaller. Gate mode still passes
 * one -- a gate has four short fields, they fit a column, and a drawer for
 * them would be ceremony. Same component either way, so the rail and the
 * picture stay put across the switch, which was the point of sharing it.
 *
 * The two-column rail is WIDER than the three-column one (290-330 against
 * 220-250), and it costs the picture nothing. The canvas is height-bound: at
 * 1920x1080 it renders ~1333px inside a ~1594px column, so ~260px each side
 * was dead space that a 16:9 frame could never take without also taking
 * height, and height means scrolling. Spending 70px of it on the rail is free
 * -- it is the column that was actually short of room, with camera names at
 * 15px wrapping to three lines in the old width.
 */
export function SetupGrid({ rail, center, right = null }) {
  return (
    <div className={`grid items-start gap-3 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] xl:min-h-0 xl:flex-1 xl:items-stretch ${
      right ? 'xl:grid-cols-[minmax(220px,250px)_minmax(0,1fr)_minmax(320px,380px)]' : 'xl:grid-cols-[minmax(290px,330px)_minmax(0,1fr)]'
    }`}
    >
      <div className="flex min-w-0 flex-col lg:row-span-2 xl:row-span-1 xl:min-h-0">{rail}</div>
      <div className="flex min-w-0 flex-col xl:min-h-0">{center}</div>
      {right ? (
        <div className="flex min-w-0 flex-col lg:col-start-2 xl:col-start-auto xl:min-h-0">{right}</div>
      ) : null}
    </div>
  );
}

/**
 * The canvas at 16:9, capped so the whole picture fits the column's height
 * on a desktop screen instead of pushing the page into a scroll.
 *
 * The subtraction is everything ABOVE and BELOW the picture, measured rather
 * than guessed, because the cap is what decides how big the feed is:
 *
 *   topbar                     64   --topbar-h
 *   page inset, top            20   PAGE_INSET py-5
 *   page header                44   icon 40 / title 24 + tagline 20
 *   header -> content          20   PAGE_RHYTHM gap-5
 *   panel header               57   py-3 x2 + the canvas-mode switch
 *   panel body pad, top        12   bodyClass p-3
 *   CanvasBar                  42   h-[34px] controls + mb-2
 *   ---- the picture ----
 *   caption row                26   mt-2 + one line
 *   panel body pad, bottom     12
 *   panel border                1
 *   page inset, bottom         20
 *                             ---
 *                             318
 *
 * It was 360, which over-reserved by ~42px and cost ~75px of picture WIDTH at
 * 1080p (the 16:9 multiplier turns every vertical pixel into 1.78 horizontal).
 * 330 keeps ~12px of slack for sub-pixel rounding and a wrapped CanvasBar.
 *
 * Worth knowing before trying to make the feed bigger a different way: at
 * 1920x1080 the centre column is ~1594px wide and this cap yields ~1333px, so
 * the canvas is HEIGHT-bound. The empty space either side is not unused
 * capacity -- a 16:9 picture cannot take width without taking height too, and
 * taking height means scrolling. The only lever that works is trimming the
 * chrome in the table above.
 */
export function CanvasFrame({ children }) {
  return <div className="mx-auto w-full xl:max-w-[calc((var(--app-dvh)-330px)*16/9)]">{children}</div>;
}
