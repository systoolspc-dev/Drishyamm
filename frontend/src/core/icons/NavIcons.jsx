import { cn } from '@/core/lib/utils';

// Drishyam's own navigation icons.
//
// Drawn on lucide's 24px grid with round caps/joins, so they sit beside the
// lucide glyphs still used elsewhere without looking like a second family, and
// they take the same props (`className`, `strokeWidth`), so a nav row can swap
// one for the other.
//
// Every icon is up to three layers:
//   tint    → the main surface (a screen, a shield, a bell). Invisible in the
//             "line" style; a soft wash of the icon's colour in "duotone".
//   line    → the outline, stroked in currentColor.
//   accent  → the part that MEANS something: the scan corners around a face,
//             the playhead and progress on a timeline, the plate on a car, the
//             clock on a log. Never decoration — if an icon has no such part it
//             has no accent. Stroked and/or filled per shape (a child sets
//             fill="none" or stroke="none"); painted in the brand colour in
//             "duotone", in currentColor in "line".
//
// Tint opacity and accent colour come from `--di-tint` / `--di-accent`, which
// index.css sets per style under `[data-icons]`. Nothing here knows which style
// is active, so the same component serves both.

function createIcon(displayName, { tint, line, accent }) {
  function Icon({ className, strokeWidth = 1.85, ...props }) {
    const stroke = { strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' };
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden="true"
        focusable="false"
        className={cn('drishyam-icon', className)}
        {...props}
      >
        {tint ? <g className="di-tint">{tint}</g> : null}
        <g fill="none" stroke="currentColor" {...stroke}>{line}</g>
        {accent ? <g className="di-accent" {...stroke}>{accent}</g> : null}
      </svg>
    );
  }
  Icon.displayName = displayName;
  return Icon;
}

// ── Overview ────────────────────────────────────────────────────────────────

// A house; the accent is its door.
export const NavHome = createIcon('NavHome', {
  tint: <path d="M5.5 9.1 12 3.8l6.5 5.3v9.4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z" />,
  line: (
    <>
      <path d="M3.25 10.75 10.73 4.6a2 2 0 0 1 2.54 0l7.48 6.15" />
      <path d="M5.5 9v9.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9" />
    </>
  ),
  accent: <path d="M10 20.5v-3.75a2 2 0 0 1 4 0v3.75z" />,
});

// ── Operations ──────────────────────────────────────────────────────────────

// A camera with its lens; the accent is the plus — adding and configuring.
export const NavCameraSetup = createIcon('NavCameraSetup', {
  tint: <rect x="2.5" y="4.5" width="12.5" height="9.5" rx="2.25" />,
  line: (
    <>
      <rect x="2.5" y="4.5" width="12.5" height="9.5" rx="2.25" />
      <circle cx="8.75" cy="9.25" r="2.25" />
      <path d="m15 7.75 3.85-1.85a.8.8 0 0 1 1.15.72v5.26a.8.8 0 0 1-1.15.72L15 10.75" />
    </>
  ),
  accent: <path fill="none" d="M18.25 15.5v5.5M15.5 18.25H21" />,
});

// A panel reading a heartbeat; the accent is the trace.
export const NavHealth = createIcon('NavHealth', {
  tint: <rect x="3" y="4" width="18" height="16" rx="3.5" />,
  line: <rect x="3" y="4" width="18" height="16" rx="3.5" />,
  accent: <path fill="none" d="M6.5 12h2.25l1.75-3.75 3 7.5 1.75-3.75h2.25" />,
});

// A screen on a stand; the accent is what it is doing — playing.
export const NavLiveView = createIcon('NavLiveView', {
  tint: <rect x="2.5" y="3.75" width="19" height="12.75" rx="2.5" />,
  line: (
    <>
      <rect x="2.5" y="3.75" width="19" height="12.75" rx="2.5" />
      <path d="M8.5 20.25h7M12 16.5v3.75" />
    </>
  ),
  accent: <path d="M10.25 8v4.5l3.75-2.25z" />,
});

// A wall of four screens; the accent is the tile in focus.
export const NavMonitorWall = createIcon('NavMonitorWall', {
  line: (
    <>
      <rect x="13" y="4" width="8" height="7" rx="1.75" />
      <rect x="3" y="13" width="8" height="7" rx="1.75" />
      <rect x="13" y="13" width="8" height="7" rx="1.75" />
    </>
  ),
  accent: <rect x="3" y="4" width="8" height="7" rx="1.75" />,
});

// A frame over a timeline; the accent is the progress so far and the playhead.
export const NavPlayback = createIcon('NavPlayback', {
  tint: <rect x="3" y="3.5" width="18" height="12" rx="2.5" />,
  line: (
    <>
      <rect x="3" y="3.5" width="18" height="12" rx="2.5" />
      <path d="M13.5 7v5L9.75 9.5z" />
      <path d="M12 20h9" />
    </>
  ),
  accent: (
    <>
      <path fill="none" d="M3 20h4" />
      <circle stroke="none" cx="9.25" cy="20" r="2.4" />
    </>
  ),
});

// A pin standing on the ground; the accent is the place it marks.
export const NavMap = createIcon('NavMap', {
  tint: <path d="M12 2.75A6.25 6.25 0 0 0 5.75 9c0 4.6 6.25 9.75 6.25 9.75S18.25 13.6 18.25 9A6.25 6.25 0 0 0 12 2.75z" />,
  line: (
    <>
      <path d="M12 2.75A6.25 6.25 0 0 0 5.75 9c0 4.6 6.25 9.75 6.25 9.75S18.25 13.6 18.25 9A6.25 6.25 0 0 0 12 2.75z" />
      <path d="M8 17.25c-2.7.35-4.5 1.05-4.5 1.85C3.5 20.2 7.3 21 12 21s8.5-.8 8.5-1.9c0-.8-1.8-1.5-4.5-1.85" />
    </>
  ),
  accent: <circle stroke="none" cx="12" cy="9" r="2.5" />,
});

// ── AI Intelligence ─────────────────────────────────────────────────────────

// A person and a clock: how their time is spent.
export const NavActivity = createIcon('NavActivity', {
  tint: <circle cx="9" cy="7.5" r="3.25" />,
  line: (
    <>
      <circle cx="9" cy="7.5" r="3.25" />
      <path d="M3 20v-.75A5.25 5.25 0 0 1 8.25 14h1.5c.9 0 1.75.23 2.5.63" />
    </>
  ),
  accent: (
    <>
      <circle fill="none" cx="17.25" cy="17" r="3.75" />
      <path fill="none" d="M17.25 15.25V17l1.25 1" />
    </>
  ),
});

// A person; the accent is the scan frame that recognises them.
export const NavFaces = createIcon('NavFaces', {
  tint: <circle cx="12" cy="9.25" r="2.75" />,
  line: (
    <>
      <circle cx="12" cy="9.25" r="2.75" />
      <path d="M6.75 18.25a5.25 5.25 0 0 1 10.5 0" />
    </>
  ),
  accent: (
    <path
      fill="none"
      d="M3.5 8V6a2.5 2.5 0 0 1 2.5-2.5h2M16 3.5h2A2.5 2.5 0 0 1 20.5 6v2M20.5 16v2a2.5 2.5 0 0 1-2.5 2.5h-2M8 20.5H6A2.5 2.5 0 0 1 3.5 18v-2"
    />
  ),
});

// A lens; the accent is the person it has found.
export const NavFindTrack = createIcon('NavFindTrack', {
  tint: <circle cx="10.5" cy="10.5" r="6.75" />,
  line: (
    <>
      <circle cx="10.5" cy="10.5" r="6.75" />
      <path d="m15.5 15.5 5.25 5.25" />
    </>
  ),
  accent: (
    <>
      <circle stroke="none" cx="10.5" cy="8.6" r="1.9" />
      <path fill="none" d="M7.6 14a3.4 3.4 0 0 1 5.8 0" />
    </>
  ),
});

// People over a capacity bar; the accent is how full the space is.
export const NavOccupancy = createIcon('NavOccupancy', {
  tint: <path d="M4.5 15a4.5 4.5 0 0 1 9 0z" />,
  line: (
    <>
      <circle cx="9" cy="6.5" r="2.5" />
      <path d="M4.5 15a4.5 4.5 0 0 1 9 0" />
      <circle cx="16" cy="7.25" r="2" />
      <path d="M15 11.25a3.75 3.75 0 0 1 4.75 3.6" />
      <path d="M3 19.25h18" />
    </>
  ),
  accent: <path fill="none" d="M3 19.25h11" />,
});

// A shield; the accent is the warning on it.
export const NavSafety = createIcon('NavSafety', {
  tint: <path d="M12 3 19 5.9v5.6c0 4.35-2.95 8.05-7 9.5-4.05-1.45-7-5.15-7-9.5V5.9z" />,
  line: <path d="M12 3 19 5.9v5.6c0 4.35-2.95 8.05-7 9.5-4.05-1.45-7-5.15-7-9.5V5.9z" />,
  accent: (
    <>
      <path fill="none" d="M12 8v4.5" />
      <circle stroke="none" cx="12" cy="15.75" r="1.3" />
    </>
  ),
});

// A car from the front; the accent is the number plate ANPR reads.
export const NavVehicles = createIcon('NavVehicles', {
  tint: <path d="M3.5 13a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v3.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />,
  line: (
    <>
      <path d="M5.5 11 6.9 7.1a2 2 0 0 1 1.88-1.35h6.44A2 2 0 0 1 17.1 7.1L18.5 11" />
      <path d="M3.5 13a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v3.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
      <path d="M6.5 17.5v1.75M17.5 17.5v1.75M5.75 14.25h1.25M17 14.25h1.25" />
    </>
  ),
  accent: <rect fill="none" x="9.5" y="13" width="5" height="2.5" rx=".75" />,
});

// ── Live & Records ──────────────────────────────────────────────────────────

// A running list of events; the accent is the AI spark.
export const NavAiFeed = createIcon('NavAiFeed', {
  line: (
    <>
      <circle fill="currentColor" stroke="none" cx="4.25" cy="7" r="1.25" />
      <circle fill="currentColor" stroke="none" cx="4.25" cy="12" r="1.25" />
      <circle fill="currentColor" stroke="none" cx="4.25" cy="17" r="1.25" />
      <path d="M8 7h4M8 12h12.5M8 17h9" />
    </>
  ),
  accent: <path d="m18 2.75.9 2.35 2.35.9-2.35.9-.9 2.35-.9-2.35L14.75 6l2.35-.9z" />,
});

// A bell; the accent is the unread dot.
export const NavAlerts = createIcon('NavAlerts', {
  tint: <path d="M6.25 10.5a5.75 5.75 0 0 1 11.5 0v4.1c0 .6.2 1.2.55 1.7l.9 1.2a.6.6 0 0 1-.48.95H5.28a.6.6 0 0 1-.48-.95l.9-1.2c.35-.5.55-1.1.55-1.7z" />,
  line: (
    <>
      <path d="M6.25 10.5a5.75 5.75 0 0 1 11.5 0v4.1c0 .6.2 1.2.55 1.7l.9 1.2a.6.6 0 0 1-.48.95H5.28a.6.6 0 0 1-.48-.95l.9-1.2c.35-.5.55-1.1.55-1.7z" />
      <path d="M10.25 21a2 2 0 0 0 3.5 0" />
    </>
  ),
  accent: <circle stroke="none" cx="19" cy="4.5" r="2.4" />,
});

// A log sheet; the accent is the clock that stamps every entry.
export const NavEventLog = createIcon('NavEventLog', {
  line: (
    <>
      <path d="M18.5 10.5V5a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2H11" />
      <path d="M8.75 7.5h6.5M8.75 11h4.5M8.75 14.5h2.5" />
    </>
  ),
  accent: (
    <>
      <circle fill="none" cx="17" cy="17" r="4" />
      <path fill="none" d="M17 15.25V17l1.1 1.1" />
    </>
  ),
});

// Axes; the accent is the trend climbing them.
export const NavReports = createIcon('NavReports', {
  line: <path d="M3.75 3.75V18.5a1.75 1.75 0 0 0 1.75 1.75h14.75" />,
  accent: <path fill="none" d="m7.5 15 3.75-4.25 3.25 2.75 5-6M16.25 7.5h3.25v3.25" />,
});

// Sliders rather than a gear: settings here are levels you tune. The accent is
// the one being adjusted.
export const NavSettings = createIcon('NavSettings', {
  line: (
    <>
      <path d="M4 6.5h7M15 6.5h5M4 12h2M10 12h10M4 17.5h9M17 17.5h3" />
      <circle cx="13" cy="6.5" r="2" />
      <circle cx="15" cy="17.5" r="2" />
    </>
  ),
  accent: <circle cx="8" cy="12" r="2" />,
});
