// Zone Headcount — type contract.
//
// Config side (ZoneTypeDef, ZoneConfig, HeadcountParams) is what a vertical
// writes in src/use-cases/<vertical>/index.js → params.headcount.
// Data side (ZoneData) is what GET /headcount/zones returns per zone, and what
// the Live Zone Occupancy table renders. The page is JS; these types document
// the shapes and back editor IntelliSense via JSDoc `import('./dto')`.

/**
 * Behavioural class. Fixed set — see ZONE_KINDS in use-cases/headcount.params.js.
 * The metrics read only this: icon, dwell rule (queue), density rule (corridor),
 * face-recognition expectation (secure / office / meeting).
 */
export type ZoneKind =
  | 'gate' | 'lobby' | 'hall' | 'classroom' | 'lab' | 'work' | 'office'
  | 'meeting' | 'dining' | 'queue' | 'corridor' | 'library' | 'sports'
  | 'leisure' | 'lounge' | 'service' | 'secure' | 'display';

/**
 * One entry in a vertical's zone-type catalog. Open-ended: a vertical names
 * as many types as it likes ("Billing Counter", "Triage", "Loading Dock"), each
 * mapped to one ZoneKind so thresholds and statuses behave identically.
 */
export interface ZoneTypeDef {
  /** Stable id referenced by ZoneConfig.type, e.g. 'billing'. */
  id: string;
  /** Operator-facing label, e.g. 'Billing Counter'. */
  label: string;
  kind: ZoneKind;
}

/** Use-case templates offered at setup (ZONE_TYPE_TEMPLATES). */
export type ZoneTypeTemplate = 'retail' | 'corporate' | 'healthcare' | 'warehouse';

/** A zone as configured — the join between cameras and a named space. */
export interface ZoneConfig {
  id: string;
  /** Zone name shown everywhere, e.g. 'Billing Counter A'. */
  label: string;
  /** A ZoneTypeDef.id from this vertical's catalog. */
  type: string;
  /** region → people inside against a capacity; line → in/out crossings. */
  mode: 'region' | 'line';
  /** Floor / section; matches an entry in HeadcountParams.areas. */
  area: string;
  /** Region zones only. */
  capacity?: number;
  /** Optional floor: fewer than this many people is a breach. */
  minOccupancy?: number;
  /** Cameras whose counts sum into this zone, e.g. ['cam-05']. */
  cameraIds: string[];
}

export interface SiteOption {
  id: string;
  label: string;
}

/** params.headcount — identical keys in every vertical. */
export interface HeadcountParams {
  reconcile: boolean;
  breachPct: number;
  densityPerM2: number;
  dwellAlertSec: number;
  emptyAfterSec: number;
  peakBasis: 'site' | 'zone';
  peakWindowSec: number;
  label: { site: string; area: string; person: string; people: string };
  /** Branch / facility scope; the selector hides when empty. */
  sites: SiteOption[];
  /** First entry is the "all" option. */
  areas: string[];
  /** Empty → ZONE_KINDS double as types. */
  zoneTypes: ZoneTypeDef[];
  zones: ZoneConfig[];
}

/**
 * Raw zone status. The status filter groups these (STATUS_GROUP):
 *   normal   ← ok, empty, flow
 *   warning  ← busy ("Nearing limit")
 *   exceeded ← over ("Over capacity"), under ("Below minimum")
 */
export type ZoneStatus = 'ok' | 'busy' | 'over' | 'under' | 'empty' | 'flow';
export type ZoneStatusGroup = 'normal' | 'warning' | 'exceeded';

/** GET /headcount/zones?site&area&type — one row of the live table. */
export interface ZoneData extends ZoneConfig {
  /** Resolved from the vertical's catalog. */
  kind: ZoneKind;
  typeLabel: string;
  status: ZoneStatus;

  // region zones
  count?: number;
  /** count / capacity × 100; may exceed 100. */
  utilization?: number;
  identified?: number;
  /** count − identified. */
  delta?: number;
  /** Mean time the people currently inside have been there; null when empty or a line zone. */
  avgDwellSec: number | null;
  /** Longest current stay (the person inside the longest); null as above. */
  maxDwellSec: number | null;

  // line zones
  in?: number;
  out?: number;
  inside?: number;
}
