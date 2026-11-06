import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, BellRing, Clock, Coffee, Flag, Gauge, Hourglass, LayoutGrid,
  ListOrdered, LogIn, MapPin, PauseCircle, Smartphone, Timer, UsersRound,
} from 'lucide-react';
import { useActivityParams } from './useCaseStore';
import { useModuleData } from './useModuleData';
import { useActivitySite, useActivitySites } from './siteStore';
import { toMinutes } from './shifts';
import {
  summarizeDay, policyLimits, mockDaySegments, formatMin, ACTIVITY,
  arrivalEvent, incidentFlag, resolveTimeframe,
} from './break-idle';
import { LiveStatusBadge, PolicyStatusBadge, BreakIdleLog } from './BreakIdle';
import { TimeframeBar, RetentionBanner } from './TimeframeBar';
import CameraPreviewModal from './dashboard/CameraPreviewModal';
import { eventPreviewSource } from './dashboard/cameraStreams';
import KpiBand from './kpi-card';
import {
  BREAK_WARN_MIN, COUNTER_WARN_MIN, coachingFlags, scoreBand, scoreBar, scoreCls,
} from './scorecard';

// Employee Detail — the staff profile, reached from the dashboard's Employee
// Status rows and the Breaks & Idle page. Frontend-only: dummy data from
// ./pages-data.js. Future backend: /activity/employees/:id/breaks?from&to.
//
// One vertical flow, top to bottom, space-y-6 between sections:
//   header   who · role · zone · shift · live status · shift policy status,
//            and the global timeframe [Today | 7D | 30D | Custom] with the
//            plan's retention limit under it
//   banner   only when the range reaches before the retention cutoff
//   stats    clock-in, then active / break / idle and flagged incidents for
//            the selected period
//   log      the activity log — clock-ins, breaks, idle and camera alerts in
//            one table. Incidents are NOT a second list: flagged rows carry a
//            severity badge and the "Flagged Only" tab narrows to them
//   heatmap  30-day presence, full width, with its colour key
// No policy banner: the header badge says whether today is compliant; the
// thresholds are one hover away in the log's toolbar.

// Deterministic 30-day presence heatmap intensity (0–3) — stands in for
// employees/:id/heatmap → [{ day, hour, inside_min }].
function heat(id, d, h) {
  let x = 0;
  for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) & 0xffff;
  const v = (x + d * 7 + h * 13) % 10;
  if ((d + x) % 7 === 3 && h < 2) return 0;          // a late morning now and then
  return v < 2 ? 1 : v < 6 ? 2 : 3;
}
const HEAT_CLS = ['bg-surface-muted', 'bg-brand/25', 'bg-brand/55', 'bg-brand/90'];
const HEAT_KEY = ['None', 'Low', 'Medium', 'High'];

// Feed alerts that are incidents in their own right. Every other feed type
// (break start/end, entry/exit, clock-in) is already a row of the log, so it
// is dropped rather than listed twice.
const FEED_INCIDENT = {
  'counter-unattended': { type: 'unattended', compliance: 'flagged' },
  'phone-usage':        { type: 'phone',      compliance: 'over' },
};

// "10:41" + "26m" style late string → minutes.
const lateMinutes = (lateBy) => parseInt(String(lateBy || '').replace(/\D/g, ''), 10) || 0;

// "09:59" → "09:59 AM". The data is 24-hour; the page reads like a clock.
function clock12(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return '—';
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const STAT_ICONS = {
  clockIn: LogIn, active: Activity, break: Coffee, idle: PauseCircle, flagged: BellRing,
};

// ── Performance parameters ──────────────────────────────────────────────────
// The profile is where a person's score is read, so the parameters it is built
// from are read here too, rather than only in the team scorecard's table row.
//
// Two bands, in the order a manager asks the questions:
//   score inputs   the four terms of the formula, each carrying its weight —
//                  score = 0.4·onTime + 0.3·hoursVsShift + 0.2·breakCompliance
//                  + 0.1·(1−phoneRate), ×100 (Performance.jsx)
//   floor impact   what the score does not fold in: minutes their counter sat
//                  unattended, queue breaches on their till, their throughput
//                  and rush-hour presence
//
// Every number is the SAME field the scorecard table and the exported matrix
// read (WEEKLY_REPORT via report-sections.js), so the profile, the table and
// the PDF cannot disagree. Thresholds come from scorecard.js, not from
// literals here, for the same reason.
const PARAM_ICONS = {
  onTime: Clock, hours: Hourglass, break: Coffee, phone: Smartphone,
  counter: LayoutGrid, queue: ListOrdered, rate: Gauge, speed: Timer,
  presence: UsersRound, idle: PauseCircle,
};

// "14.2 bills / hr" reads as the till does; an office counts tasks.
const RATE_UNIT = { bills: 'bills', interactions: 'customers', tasks: 'tasks' };

function PerformanceParameters({ r, isRetail }) {
  const overBreak = Math.max(0, r.breakMin - BREAK_WARN_MIN);
  const counterMin = r.impact?.counterMin ?? 0;
  const queueBreaches = r.impact?.queueBreaches ?? 0;
  const flags = coachingFlags(r);
  const rateUnit = RATE_UNIT[r.unit] || 'tasks';

  const inputs = [
    {
      key: 'onTime', label: 'Punctuality', value: `${r.onTime}%`,
      sub: `on time · ${r.days} ${r.days === 1 ? 'day' : 'days'} worked`,
      badge: { text: '40% of score' }, tone: r.onTime >= 80 ? 'good' : 'warn',
    },
    {
      key: 'hours', label: 'Hours vs Shift', value: r.avgH, sub: 'average per day worked',
      badge: { text: '30% of score' }, tone: 'neutral',
    },
    {
      key: 'break', label: 'Break Compliance', value: `${r.breakMin}m`,
      sub: overBreak ? `${overBreak}m over the ${BREAK_WARN_MIN}m guideline` : `within the ${BREAK_WARN_MIN}m guideline`,
      badge: { text: '20% of score' }, tone: overBreak ? 'bad' : 'good',
    },
    {
      key: 'phone', label: 'Phone Use', value: r.phone,
      sub: r.phone ? 'flagged detections' : 'no detections',
      badge: { text: '10% of score' }, tone: r.phone >= 3 ? 'bad' : r.phone ? 'warn' : 'good',
    },
  ];

  const impact = [
    {
      key: 'counter', label: 'Counter Unattended', value: `${counterMin}m`,
      sub: counterMin ? `past the policy limit` : 'never left unattended',
      tone: counterMin >= COUNTER_WARN_MIN ? 'bad' : counterMin ? 'warn' : 'good',
    },
    {
      key: 'queue', label: 'Queue Breaches', value: queueBreaches,
      sub: isRetail ? 'times their till queue got too long' : 'times their queue got too long',
      tone: queueBreaches >= 3 ? 'bad' : queueBreaches ? 'warn' : 'good',
    },
    {
      key: 'rate', label: isRetail && r.unit === 'bills' ? 'Bills per Hour' : 'Handled per Hour',
      value: r.velocity, sub: `${rateUnit} / hr`, tone: 'neutral',
    },
    {
      key: 'speed', label: 'Avg Checkout Speed', value: r.serviceMin == null ? '—' : `${r.serviceMin}m`,
      sub: r.serviceMin == null ? 'not on a till' : 'per customer', tone: 'neutral',
    },
    {
      key: 'presence', label: isRetail ? 'Rush Hour Presence' : 'Core Hour Presence',
      value: `${r.peakPct}%`, sub: 'on the floor when it matters',
      tone: r.peakPct >= 85 ? 'good' : r.peakPct >= 70 ? 'warn' : 'bad',
    },
    {
      key: 'idle', label: 'Idle Time', value: `${r.idleMin}m`, sub: 'over the scored period',
      tone: r.idleMin > 40 ? 'warn' : 'neutral',
    },
  ];

  return (
    <section className="rounded-xl border border-line bg-surface p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg sm:text-base">Performance Parameters</h2>
          <p className="mt-0.5 text-caption text-fg-subtle">
            What the score is measured from, over the scored week. The full team view and its exports are on{' '}
            <Link to="/activity-monitoring/performance" className="font-semibold text-brand-ink hover:underline">
              Staff Performance
            </Link>.
          </p>
        </div>
        {/* The score itself, as the band it falls in — the same thresholds the
            scorecard colours its Score column by (scorecard.js). */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <p className={`text-metric-sm font-bold leading-none tabular-nums ${scoreCls(r.score)}`}>{r.score}</p>
            <p className="mt-0.5 text-caption text-fg-subtle">score / 100</p>
          </div>
          <div className="w-28">
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`Score ${r.score} of 100`}>
              <div className={`h-full rounded-full ${scoreBar(r.score)}`} style={{ width: `${r.score}%` }} />
            </div>
            <p className={`mt-1 text-caption font-semibold ${scoreCls(r.score)}`}>{scoreBand(r.score)}</p>
          </div>
        </div>
      </div>

      <p className="mt-5 text-micro font-semibold uppercase tracking-wide text-fg-subtle">Score inputs</p>
      <KpiBand className="mt-2" cards={inputs} icons={PARAM_ICONS} />

      <p className="mt-5 text-micro font-semibold uppercase tracking-wide text-fg-subtle">
        Floor impact &amp; throughput
      </p>
      <p className="text-caption text-fg-subtle">Not folded into the score — read beside it.</p>
      <KpiBand className="mt-2" cards={impact} icons={PARAM_ICONS} />

      {/* Why the score reads the way it does, in the scorecard's own words. */}
      {flags.length > 0 && (
        <div className="mt-5 rounded-lg bg-warning-soft px-3 py-2.5 ring-1 ring-warning-line">
          <p className="flex items-center gap-1.5 text-caption font-semibold text-warning-ink">
            <Flag className="h-3.5 w-3.5" /> Coaching flags
          </p>
          <ul className="mt-1.5 space-y-1">
            {flags.map((f) => (
              <li key={f} className="text-caption leading-snug text-warning-ink">· {f}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function EmployeeDetail() {
  const { EMPLOYEES, FEED, DAY_TIMELINES, NOW_IST, TODAY, STORES, WEEKLY_REPORT } = useModuleData();
  const { useCase, params } = useActivityParams();
  // The module-wide site, shown (not chosen) so the profile says which scope
  // the reader came from. Change it on the dashboard or any list page.
  const scopeSites = useActivitySites(STORES);
  const { site: scopeSite } = useActivitySite({ sites: scopeSites });
  const scopeLabel = scopeSite?.label || `All ${(params.headcount?.label?.site || 'Store').toLowerCase()}s`;
  const { id } = useParams();
  const emp = EMPLOYEES.find((e) => e.id === id);
  // Their row in the scored week — the same record the team scorecard and the
  // exports read, looked up by the id the roster and the report share.
  const scored = useMemo(() => (WEEKLY_REPORT || []).find((r) => r.id === id), [WEEKLY_REPORT, id]);

  const [timeframe, setTimeframe] = useState({ key: 'today' });
  const [preview, setPreview] = useState(null);
  const closePreview = useCallback(() => setPreview(null), []);

  const shift = emp && (params.shifts || []).find((s) => s.label === emp.shift);
  const limits = useMemo(() => policyLimits(params), [params]);
  const todaySegments = useMemo(() => (emp ? DAY_TIMELINES[emp.id] || [] : []), [emp, DAY_TIMELINES]);
  // Where this person normally works, for the mock history's idle rows. Their
  // zone right now may be "Off-floor" (on break) or "—" (not arrived), neither
  // of which is a post.
  const usualPost = emp && !['Off-floor', '—'].includes(emp.zone) ? emp.zone : 'Floor';

  // Today drives the live parts of the header (status, compliance badge)
  // whatever range is selected.
  const today = useMemo(
    () => summarizeDay({ segments: todaySegments, date: TODAY, now: NOW_IST, limits }),
    [todaySegments, TODAY, NOW_IST, limits],
  );

  // The selected period, clipped to the plan's retention window.
  const retentionDays = params.retentionDays ?? 30;
  const period = useMemo(() => resolveTimeframe(timeframe, TODAY, retentionDays), [timeframe, TODAY, retentionDays]);

  // Every retained day in the period, summarised once: today is real data
  // (plus its clock-in and camera alerts from the feed), earlier days mock
  // history. Rows: newest day first, chronological within a day.
  const days = useMemo(() => {
    if (!emp) return [];
    const graceMin = Math.round((params.lateGraceSec ?? 900) / 60);
    const lateAgainstShift = (hhmm) => (shift ? Math.max(0, toMinutes(hhmm) - toMinutes(shift.start) - graceMin) : 0);

    return period.dates.map((date) => {
      if (date === TODAY) {
        const rows = [...today.events];
        if (emp.clockIn) rows.push(arrivalEvent({ date, time: emp.clockIn, lateMin: lateMinutes(emp.lateBy) }));
        FEED.filter((f) => f.employee === emp.name && FEED_INCIDENT[f.type]).forEach((f) => {
          const kind = FEED_INCIDENT[f.type];
          // An unattended-counter alert inside an idle stretch IS that stretch — flag it, don't add a row.
          const t = toMinutes(f.time);
          const i = kind.type === 'unattended' ? rows.findIndex((r) => r.type === 'idle'
            && toMinutes(r.start) <= t && (r.ongoing || toMinutes(r.end) >= t)) : -1;
          if (i >= 0) { rows[i] = { ...rows[i], unattended: true, note: rows[i].note || f.text }; return; }
          rows.push({
            id: f.id, date, type: kind.type, instant: true, start: f.time, end: f.time, ongoing: false,
            durationMin: 0, limitMin: 0, overMin: 0, compliance: kind.compliance,
            location: f.zone, cameraId: f.camera, note: f.text,
          });
        });
        return { ...today, events: rows.sort((a, b) => toMinutes(a.start) - toMinutes(b.start)) };
      }
      const segments = mockDaySegments({ empId: emp.id, date, shift, todaySegments, fallbackPost: usualPost });
      const day = summarizeDay({ segments, date, limits });
      const events = segments.length
        ? [arrivalEvent({ date, time: segments[0].s, lateMin: lateAgainstShift(segments[0].s) }), ...day.events]
        : day.events;
      return { ...day, events };
    });
  }, [emp, period.dates, TODAY, today, FEED, shift, todaySegments, usualPost, limits, params.lateGraceSec]);

  const events = useMemo(() => days.flatMap((d) => d.events), [days]);
  const totals = useMemo(() => days.reduce((t, d) => ({
    activeMin: t.activeMin + d.activeMin, breakMin: t.breakMin + d.breakMin, idleMin: t.idleMin + d.idleMin,
  }), { activeMin: 0, breakMin: 0, idleMin: 0 }), [days]);
  const flaggedCount = useMemo(() => events.filter((e) => incidentFlag(e)).length, [events]);

  if (!emp) {
    return (
      <div className="w-full page-inset">
        <div className="rounded-xl border border-line bg-surface p-10 text-center shadow-sm">
          <p className="text-body font-semibold text-fg-secondary">Employee not found</p>
          <Link to="/activity-monitoring" className="mt-1 inline-block text-small font-semibold text-brand-ink hover:underline">← Back to dashboard</Link>
        </div>
      </div>
    );
  }

  const initials = emp.name.split(' ').map((w) => w[0]).join('');
  const firstName = emp.name.split(' ')[0];

  const openPreview = (e) => setPreview(eventPreviewSource(e, {
    title: ACTIVITY[e.type].label,
    subtitle: `${emp.name} · ${e.start}–${e.end || 'now'} · ${e.location}`,
  }));

  return (
    <div className="w-full page-inset-x pb-8 pt-3">
      <Link to="/activity-monitoring" className="mb-3 inline-flex items-center gap-1 text-small font-semibold text-fg-muted hover:text-fg">
        <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
      </Link>

      <div className="space-y-6">
        {/* ── Header · who, where, which shift, live + policy status ───── */}
        <header className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-sm lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand/15 text-heading font-bold text-brand-ink">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">{emp.name}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-muted">
                <span>{emp.role} · {emp.zone}</span>
                <span className="inline-flex items-center gap-1 rounded-md bg-surface-muted px-1.5 py-0.5 text-caption font-semibold text-fg-secondary">
                  <Clock className="h-3 w-3" /> {emp.shift} Shift
                </span>
                <span
                  title="Site scope — change it from the dashboard"
                  className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-caption font-semibold text-brand-ink"
                >
                  <MapPin className="h-3 w-3" /> {scopeLabel}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <LiveStatusBadge status={today.status} />
              <PolicyStatusBadge exceptions={today.exceptions} />
            </div>
          </div>
          <TimeframeBar
            value={timeframe}
            onChange={setTimeframe}
            today={TODAY}
            retentionDays={retentionDays}
            resolved={period}
          />
        </header>

        {period.expired && <RetentionBanner cutoff={period.cutoff} retentionDays={retentionDays} />}

        {/* ── Summary: today's clock-in, then the selected period ────────── */}
        <KpiBand
          cards={[
            {
              key: 'clockIn',
              label: timeframe.key === 'today' ? 'Clock-in' : "Today's Clock-in",
              value: emp.clockIn ? clock12(emp.clockIn) : '—',
              tone: emp.lateBy ? 'warn' : 'good',
              badge: emp.lateBy ? { text: `Late by ${emp.lateBy}` } : null,
            },
            { key: 'active', label: 'Active Time', value: formatMin(totals.activeMin), sub: period.label, tone: 'good' },
            { key: 'break', label: 'Break Time', value: formatMin(totals.breakMin), sub: period.label, tone: 'neutral' },
            { key: 'idle', label: 'Idle Time', value: formatMin(totals.idleMin), sub: period.label, tone: totals.idleMin ? 'warn' : 'neutral' },
            { key: 'flagged', label: 'Flagged Incidents', value: flaggedCount, sub: period.label, tone: flaggedCount ? 'bad' : 'neutral' },
          ]}
          icons={STAT_ICONS}
        />

        {/* ── The parameters the score is built from ───────────────────── */}
        {/* Only for staff the scored week covers: a new joiner has a profile
            and an activity log before they have a scorecard row. */}
        {scored && <PerformanceParameters r={scored} isRetail={useCase === 'retail'} />}

        {/* ── The log — the page's primary content; incidents live here ── */}
        <BreakIdleLog
          title="Activity Log"
          events={events}
          limits={limits}
          isRetail={useCase === 'retail'}
          rangeLabel={period.label}
          subject={firstName}
          onPreview={openPreview}
          roomy
        />

        {/* ── Presence heatmap, full width, key below ─────────────────── */}
        <section className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-fg sm:text-base">Presence Heatmap</h2>
          <p className="mt-0.5 text-caption text-fg-subtle">Last 30 days × store hours — darker means more time on the floor</p>
          <div className="mt-4 overflow-x-auto rounded-lg bg-surface-sunken p-4">
            <div className="grid min-w-[560px] grid-cols-[auto_repeat(30,minmax(9px,1fr))] gap-[3px]">
              {Array.from({ length: 12 }, (_, h) => (
                [
                  <span key={`l${h}`} className="pr-1.5 text-right text-micro tabular-nums leading-[14px] text-fg-subtle">
                    {h % 3 === 0 ? `${10 + h}:00` : ''}
                  </span>,
                  ...Array.from({ length: 30 }, (_, d) => {
                    const v = heat(emp.id, d, h);
                    return (
                      <span
                        key={`${h}-${d}`}
                        className={`h-[14px] w-full min-w-[9px] rounded-[3px] ${HEAT_CLS[v]}`}
                        title={`Day −${30 - d}, ${10 + h}:00 · ${HEAT_KEY[v]} presence`}
                      />
                    );
                  }),
                ]
              ))}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-fg-muted" aria-label="Presence colour key">
            {HEAT_KEY.map((k, v) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={`h-3 w-3 rounded-[3px] ${HEAT_CLS[v]}`} aria-hidden /> {k}
              </span>
            ))}
          </div>
        </section>
      </div>

      {preview && <CameraPreviewModal source={preview} onClose={closePreview} />}
    </div>
  );
}
