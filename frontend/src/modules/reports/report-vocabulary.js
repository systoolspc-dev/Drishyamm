/**
 * report-vocabulary.js — how a report TALKS.
 *
 * The server decides what the numbers are (reports.service.js); this file
 * decides what they are called on screen and which icon carries them. Keeping
 * the two apart is what stopped the old page's CSV and its cards disagreeing.
 *
 * Wording rule: a manager should be able to read any line aloud in a meeting
 * without translating it. "Unrecognised sightings", never "person.unknown".
 */

import {
  Activity, AlertTriangle, Ban, Car, Users, Flame, ScanFace, ShieldAlert,
  UserCheck, UserX, Video, FileBarChart, PlayCircle, SlidersHorizontal, Layers,
} from 'lucide-react';

/** The eight cards on the hub, in the order they appear. */
export const REPORT_TYPES = [
  { type: 'ai_events',       label: 'AI Event Report',          blurb: 'All AI detections with event details.', icon: FileBarChart },
  { type: 'face',            label: 'Face Detection Report',    blurb: 'Recognised and unknown faces.',         icon: ScanFace },
  { type: 'occupancy',       label: 'Crowd & Occupancy Report', blurb: 'People count and crowd density.',       icon: Users },
  { type: 'restricted_area', label: 'Restricted Area Report',   blurb: 'Zone violations and intrusions.',       icon: AlertTriangle },
  { type: 'camera_health',   label: 'Camera Health Report',     blurb: 'Camera status and uptime.',             icon: Video },
  { type: 'recording',       label: 'Recording Report',         blurb: 'Recording availability and storage.',   icon: PlayCircle },
  { type: 'incident',        label: 'Incident Report',          blurb: 'Detailed incident summary.',            icon: Layers },
  { type: 'custom',          label: 'Custom Report',            blurb: 'Create your own report with custom filters.', icon: SlidersHorizontal },
];

export const typeMeta = (type) => REPORT_TYPES.find((t) => t.type === type)
  || { type, label: type, blurb: '', icon: FileBarChart };

/**
 * Icon and tone per detection bucket. Tone is a MEANING (see core/ui/tone.js):
 * danger for things that are wrong, warning for things to watch, neutral for
 * the routine background traffic of a working site.
 */
export const BUCKET_UI = {
  watchlist: { icon: ShieldAlert, tone: 'danger' },
  zone:      { icon: Ban,         tone: 'danger' },
  weapon:    { icon: ShieldAlert, tone: 'danger' },
  fire:      { icon: Flame,       tone: 'danger' },
  crowd:     { icon: Users,       tone: 'warning' },
  camera:    { icon: Video,       tone: 'warning' },
  vehicle:   { icon: Car,         tone: 'neutral' },
  unknown:   { icon: UserX,       tone: 'neutral' },
  known:     { icon: UserCheck,   tone: 'success' },
  other:     { icon: Activity,    tone: 'neutral' },
};

export const bucketUi = (bucket) => BUCKET_UI[bucket] || BUCKET_UI.other;

/** Severity → the three words operators use, and nothing in between. */
export const SEVERITY_UI = {
  critical: { label: 'High',   tone: 'danger' },
  warning:  { label: 'Medium', tone: 'warning' },
  info:     { label: 'Info',   tone: 'neutral' },
};

export const PERIODS = [
  { key: 'today',  label: 'Today',        days: 1 },
  { key: '7d',     label: 'Last 7 days',  days: 7 },
  { key: '30d',    label: 'Last 30 days', days: 30 },
  { key: '90d',    label: 'Last 90 days', days: 90 },
];

export const SCHEDULES = [
  { key: null,      label: 'Generate once' },
  { key: 'daily',   label: 'Every day, 08:00' },
  { key: 'weekly',  label: 'Every Monday, 08:00' },
  { key: 'monthly', label: '1st of the month' },
];

/* ─────────────────────────── formatting ──────────────────────────────── */

export const nf = (n) => Number(n || 0).toLocaleString();

/** Compact date: "16 Sep". With `year`, "16 Sep 2026". */
export function fmtDate(value, { year = false } = {}) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}),
  });
}

/** "Tue 16 Sep, 21:14" — the way an incident is read out. */
export function fmtStamp(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** "16 Sep, 21:14" — the table form: no weekday, no year. */
export function fmtWhen(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** A local calendar day ("2026-09-16") as "16 Sep". Parsed as LOCAL midnight. */
export function fmtDay(day) {
  if (!day) return '—';
  return new Date(`${String(day).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function fmtPeriod(from, to) {
  if (!from || !to) return '';
  const a = new Date(from); const b = new Date(to);
  const sameYear = a.getFullYear() === b.getFullYear();
  return `${fmtDate(a, { year: !sameYear })} – ${fmtDate(b, { year: true })}`;
}

/** Durations as a person says them: "4m 12s", "2h 40m", "3d 4h". */
export function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** How long something has been open, from a timestamp to now. */
export function fmtAge(value) {
  if (!value) return '—';
  return fmtDuration((Date.now() - new Date(value).getTime()) / 1000);
}

/**
 * A change against the previous period, already interpreted.
 *
 * `goodWhenDown` is the whole point: 20% more alerts is bad news, 20% faster
 * response is good news, and an arrow that does not know the difference is
 * decoration. Returns null when there is nothing to compare against — an
 * invented "▲ 100%" on the first week is worse than no arrow at all.
 */
export function delta(now, previous, { goodWhenDown = true } = {}) {
  const a = Number(now); const b = Number(previous);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const pct = Math.round(((a - b) / b) * 100);
  if (pct === 0) return { pct: 0, dir: 'flat', tone: 'neutral', label: 'No change' };
  const up = pct > 0;
  const bad = goodWhenDown ? up : !up;
  return {
    pct: Math.abs(pct),
    dir: up ? 'up' : 'down',
    tone: bad ? 'danger' : 'success',
    label: `${up ? '▲' : '▼'} ${Math.abs(pct)}%`,
  };
}

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
