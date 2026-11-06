// ─────────────────────────────────────────────────────────────────────────────
// Activity Monitoring Dashboard — DTO / wire-schema contract.
//
// The app is JavaScript (see jsconfig.json); these ambient types are the single
// written contract for the shapes `data.js` (retail) and `../corporate-data.js`
// (office) produce today and the activity-monitor API must produce later.
// Data modules annotate their exports with `@type {import('./dto').X}` so the
// editor type-checks the dummy data against this file.
//
// This schema reflects the KPI consolidation pass: the dashboard carries FOUR
// top-level KPIs (health, present, queue, coverage), and the clarity pass on
// top of it (§16), which fixed each card to a value + a plain-language `badge`
// + ONE aggregate `sub` line. The metrics that used to own a card now live
// where they are actionable:
//   · phone incidents  → EmployeeRow.phoneIncidents  (badge on the roster row)
//   · on-time arrival  → EmployeeRow.lateBy          (status tag on the row)
//   · active alerts    → AttentionAlert[]            (Needs Attention panel)
//   · avg working hours→ removed from realtime; analytical export only
//     (`WEEKLY_REPORT` in pages-data.js / the Reports subpage).
// ─────────────────────────────────────────────────────────────────────────────

/** Accent vocabulary shared by cards, chips and severity bars. */
export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export type TrendDirection = 'up' | 'down' | null;

// ── Header scope ─────────────────────────────────────────────────────────────
/** GET /stores → [{ storeId, name, city }] */
export interface SiteOption {
  id: string;
  label: string;
}

/**
 * A roster shift. NOT part of the dashboard payload: shifts are operator
 * config, read from `moduleParams(useCase, 'employee-productivity').shifts`
 * (src/use-cases/<vertical>/index.js) and resolved against the current clock
 * by ../shifts.js. The roster API will supply the same shape as store.shifts[].
 * `start`/`end` are IST 24h "HH:MM"; an end before its start crosses midnight.
 */
export interface ShiftWindow {
  id: string;
  label: string;
  start: string;
  end: string;
}

// ── SECTION 1 · KPI cards (4 only) ───────────────────────────────────────────
/**
 * `retail` runs all four; `corporate` has no billing counters or customer
 * queue, so it ships health + present + occupancy (the desk analogue of
 * counter coverage). KpiGrid sizes its grid from the count it receives.
 */
export type KpiKey = 'health' | 'present' | 'queue' | 'coverage' | 'occupancy';

/** How the card renders its number — drives the markup branch in KpiGrid. */
export type KpiDisplay =
  | 'score'    // one composite number out of a ceiling → "87 /100"
  | 'ratio'    // part of a whole → "11 / 12 Scheduled"
  | 'measure'; // one measurement with its unit → "3.2 min avg wait"

/**
 * The card's state, in the words a store manager uses — rendered as a pill in
 * the card's top-right corner.
 *
 * It replaced the `'status'` display kind, which made the state the card's
 * headline ("Backed up") and pushed the actual measurement into a footnote.
 * Two things were wrong with that: the state is not the metric, and the state
 * words were system jargon. `text` must therefore be plain language — "High
 * Wait Times", not "Backed up"; "1 Unattended", not "coverage breach" — and it
 * must be an AGGREGATE, never a single named person, counter or camera.
 *
 * `tone` is the badge's own, because a healthy card can still owe the manager a
 * flag: Staff Present is `tone: 'good'` at 11/12 and still badges an amber
 * "2 Pending". Omit it to inherit the card's tone.
 */
export interface KpiBadge {
  text: string;
  tone?: Tone;
}

interface KpiCardBase {
  key: KpiKey;
  label: string;
  display: KpiDisplay;
  /** Overall card state — paints the icon tile. */
  tone: Tone;
  /** Plain-language state pill. Null only if the card has no state to report. */
  badge: KpiBadge | null;
  /**
   * The ONE summary line under the value, and the card's last word.
   *
   * Contract, enforced by review rather than by the type: aggregate only. No
   * employee name ("1 not arrived (Divya)"), no single counter ("Billing 1
   * over limit"), no second sentence of description. Those are granular
   * incident details — they belong in `AttentionAlert[]` or on the page the
   * card links to, both of which can carry a name and an action; a top-level
   * KPI card can carry neither, and stops being readable the moment there are
   * two of anything.
   */
  sub: string;
  /**
   * The same fact as `sub`, split for the card footer: a key on the left and
   * the value on the right, painted by `tone`. Same aggregate-only contract.
   */
  foot?: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' | 'neutral' };
  /** Period-over-period movement, e.g. "+3 vs yesterday". */
  delta: string | null;
  /** Explicit arrow direction; never inferred from the sign in `delta`. */
  trend: TrendDirection;
  // ── dev contract, surfaced in the card's ⓘ tooltip ──
  purpose: string;
  formula: string;
  fields: string[];
}

export interface ScoreKpi extends KpiCardBase {
  display: 'score';
  value: number;
  /** Ceiling suffix, e.g. "/100". */
  unit: string;
}

export interface RatioKpi extends KpiCardBase {
  display: 'ratio';
  value: number;
  total: number;
  /**
   * Caption after the ratio. Name the THING being counted, not just its state
   * — "Counters Active" reads as an answer; a bare "Open" made the manager
   * guess what 2 / 3 was about.
   */
  unit: string;
}

export interface MeasureKpi extends KpiCardBase {
  display: 'measure';
  /** The measurement itself — this is the card's headline number. */
  value: number;
  /** Its unit, spelled out: "min avg wait". */
  unit: string;
}

export type KpiCard = ScoreKpi | RatioKpi | MeasureKpi;

// ── SECTION 2 · Needs Attention (primary alert feed) ─────────────────────────
export type AlertSeverity = 'high' | 'medium' | 'low';

/**
 * Which subsystem raised it. The panel groups/filters on this so one feed can
 * carry coverage breaches, queue-threshold trips, staff-policy alerts and
 * infrastructure (camera/stream) warnings without losing legibility.
 */
export type AlertSource = 'coverage' | 'queue' | 'staff' | 'system';

/** GET /activity/alerts?store&date&acknowledged=false */
export interface AttentionAlert {
  id: string;
  /** Maps to the panel's icon table; unknown types fall back to a warning glyph. */
  type: string;
  source: AlertSource;
  severity: AlertSeverity;
  title: string;
  /** Null when the alert is about a place or a device, not a person. */
  employee: string | null;
  location: string;
  /** "—" when no camera is attributable (e.g. an off-floor break). */
  camera: string;
  /** Human-readable magnitude: "6m 20s", "7 waiting", "24m of 10m". */
  duration: string;
  /** IST wall-clock start, "HH:MM". */
  since: string;

  // ── Camera preview (CameraPreviewModal) ──
  /** Null when `camera` is "—"; the preview button is hidden. */
  cameraId: string | null;
  /** "CAM-05 · Billing 1". */
  cameraName: string | null;
  /** Display form of the start, "14:35 IST". */
  timestamp: string;
  /** Event start with offset, "2026-09-25T14:35:00+05:30"; drives the playback deep link. */
  startTimeISO: string;
  /** Pre-buffered event clip around the start time (MP4 or HLS). */
  clipUrl: string | null;
  /** Camera's live HLS playlist. */
  liveStreamUrl: string | null;
}

// ── SECTION 3 · Employee status roster ───────────────────────────────────────
export type EmployeeStatusKey = 'onfloor' | 'break' | 'away' | 'late' | 'notarrived';

/** Badge styling per status — one source so roster and feed agree. */
export interface StatusMeta {
  label: string;
  /** Tailwind classes for the badge pill. */
  cls: string;
  /** Hex dot colour (also used by charts). */
  dot: string;
}

export type StatusMetaMap = Record<EmployeeStatusKey, StatusMeta>;

/** GET /activity/employees?store&date&shift */
export interface EmployeeRow {
  id: string;
  name: string;
  role: string;
  /** Current zone label, or "—" when not on site. */
  zone: string;
  shift: string;
  status: EmployeeStatusKey;
  /** IST "HH:MM", null when never sighted today. */
  clockIn: string | null;
  /** On-site time so far, breaks excluded: "4h 42m" or "—". */
  worked: string;

  // ── relocated from the KPI row ──
  /**
   * Was the "On-Time Attendance" KPI. Minutes past `policy.lateAfter` as a
   * display string ("26m"); null when on time or not yet arrived. Renders as a
   * "Late 26m" tag beside the status badge.
   * Backend: derived from `clock_in_ts` vs `policy.lateAfter`.
   */
  lateBy: string | null;
  /**
   * Was the "Phone Incidents Today" KPI. Count of phone-in-hand detections held
   * past `policy.phone.holdSec`; renders as a flag badge when > 0.
   * Backend: count(events where type = phone-use and employeeId = this).
   */
  phoneIncidents: number;
}

// ── SECTION 4 · Recent activity feed ─────────────────────────────────────────
export type FeedStatus = 'ok' | 'info' | 'warn' | 'alert';

/** GET /activity/events?store&date&limit — trimmed Event Log stream. */
export interface FeedEvent {
  id: string;
  /** IST "HH:MM". */
  time: string;
  type: string;
  employee: string | null;
  camera: string;
  zone: string;
  status: FeedStatus;
  text: string;
}

// ── SECTION 5 · Analytics (collapsed by default) ─────────────────────────────
/** GET /activity/trends?store&date → one row per hour bucket. */
export interface TrendBucket {
  /** Bucket label, IST "HH:MM". */
  h: string;
  present: number;
  expected: number;
  coverage: number;
  /** Retail only — footfall line-cross count. */
  traffic?: number;
  /** Retail only — avg queue wait, minutes. */
  wait?: number;
}

// ── Module data bundle ───────────────────────────────────────────────────────
/** What `useModuleData()` hands every dashboard widget. */
export interface ActivityModuleData {
  STORES: SiteOption[];
  /** The dummy clock, IST "HH:MM" — the API's "as of" timestamp later. */
  NOW_IST: string;
  /** The dummy date, "YYYY-MM-DD" — used for export filenames. */
  TODAY: string;
  KPIS: KpiCard[];
  ATTENTION: AttentionAlert[];
  EMPLOYEES: EmployeeRow[];
  FEED: FeedEvent[];
  TRENDS: TrendBucket[];
  STATUS_META: StatusMetaMap;
}
