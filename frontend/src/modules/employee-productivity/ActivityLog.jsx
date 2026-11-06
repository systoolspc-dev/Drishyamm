import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { useActivityParams } from './useCaseStore';
import { useModuleData } from './useModuleData';
import { toMinutes } from './shifts';
import {
  summarizeDay, policyLimits, mockDaySegments, shiftIsoDate, resolveTimeframe,
  retentionCutoff, arrivalEvent, ACTIVITY,
} from './break-idle';
import { BreakIdleLog } from './BreakIdle';
import CameraPreviewModal from './dashboard/CameraPreviewModal';
import { eventPreviewSource, phonePreviewSource } from './dashboard/cameraStreams';

// ─────────────────────────────────────────────────────────────────────────────
// /activity-monitoring/activity-log — ONE log for the whole module.
//
// WHY IT EXISTS. Breaks & Idle and Phone Usage were two sidebar rows rendering
// the same thing: a full-height table of events, newest first, with a policy
// popover, one Filter button and a camera preview per row. They differed only
// in which event type they filtered to — so the sidebar carried a row per
// event type, and a manager asking "what happened on the floor today" had to
// visit two pages and merge them by eye.
//
// These events are not destinations. They are the INPUTS the staff score is
// computed from (score = 0.4·onTime + 0.3·hoursVsShift + 0.2·breakCompliance
// + 0.1·(1−phoneRate), see Performance.jsx). The derived numbers belong in
// Analytics; the raw events belong in a log. Zone Coverage already worked this
// way — it keeps the live post status and sends its incident history to a log
// rather than listing it (ZoneCoverage.jsx). This page finishes that pattern
// for breaks, idle, phone and clock-ins.
//
// WHY NOT THE GLOBAL /event-logs. That log spans the whole product — faces,
// vehicles, perimeter, system health — and carries its own site scope and
// retention. This one is scoped to the module: the vertical's shift roster,
// its policy limits, its retention window, and an Employee column that opens
// the staff dossier. The dashboard and Zone Coverage still deep-link out to
// the global log for the product-wide view (eventLogHref).
//
// The old URLs redirect in pre-filtered (App.jsx): …/breaks → ?type=breaks,
// …/phone → ?type=phone. An unrecognised ?type= widens to All rather than
// emptying the table, matching the Event Log's URL contract.
//
// Frontend-only: today's rows come from DAY_TIMELINES / PHONE_EVENTS / FEED,
// earlier days from the deterministic mock history. Future backend:
// GET /activity/events?store&from&to&type.
// ─────────────────────────────────────────────────────────────────────────────

// Feed alerts that are staff events in their own right. break-start/end,
// entry/exit and clock-in are already rows of the log (from the day's segments
// and arrivalEvent), so they are dropped rather than listed twice. queue-alert
// and low-activity carry no employee — they are zone events, and stay on the
// dashboard and in the global Event Log.
const FEED_INCIDENT = {
  'counter-unattended': { type: 'unattended', compliance: 'flagged' },
};

export default function ActivityLog() {
  const { EMPLOYEES, DAY_TIMELINES, PHONE_EVENTS, FEED, NOW_IST, TODAY } = useModuleData();
  const { useCase, params } = useActivityParams();
  const [search, setSearch] = useSearchParams();
  const limits = useMemo(() => policyLimits(params), [params]);
  const violationSec = params.phone?.violationSec ?? 30;
  // Where a phone is fine, per vertical — the copy that used to sit in the
  // Phone Usage page's own policy popover. It rides into the log's Policy
  // popover so the rule stays beside the rows it judges.
  const phonePolicy = useMemo(() => ({
    violationSec,
    escalateAfter: params.phone?.escalateAfter ?? 3,
    allowed: useCase === 'corporate'
      ? 'at desks and in break areas.'
      : 'emergency calls only, at designated stations or break areas.',
  }), [violationSec, params.phone?.escalateAfter, useCase]);

  const [range, setRangeKey] = useState('today');
  // Custom from / to (ISO days). Kept when switching back to a preset, so
  // re-picking Custom restores the last range.
  const [custom, setCustom] = useState(null);
  const setRange = (key, next) => { setRangeKey(key); if (next) setCustom(next); };
  // Date inputs stop at the plan's retention window and today.
  const rangeBounds = useMemo(() => ({
    min: retentionCutoff(TODAY, params.retentionDays ?? 30),
    max: TODAY,
    defaultFrom: shiftIsoDate(TODAY, -6),
  }), [TODAY, params.retentionDays]);
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState(null);
  const closePreview = useCallback(() => setPreview(null), []);

  // Detections and feed alerts carry a name; the roster gives it an id, so the
  // Employee cell can open that person's dossier.
  const idByName = useMemo(() => new Map(EMPLOYEES.map((e) => [e.name, e.id])), [EMPLOYEES]);

  const events = useMemo(() => {
    const shiftOf = (e) => (params.shifts || []).find((s) => s.label === e.shift);
    const now = toMinutes(NOW_IST);
    const onNow = new Set((params.shifts || []).filter((s) => {
      const a = toMinutes(s.start); const b = toMinutes(s.end);
      return b > a ? now >= a && now < b : now >= a || now < b;   // overnight wraps
    }).map((s) => s.label));
    // "Current shift" = the staff rostered on a shift whose window contains
    // now — the same reading Breaks & Idle used, applied to every row type so
    // one filter means one thing across the log.
    const staff = range === 'shift' ? EMPLOYEES.filter((e) => onNow.has(e.shift)) : EMPLOYEES;
    const staffIds = new Set(staff.map((e) => e.id));
    const dates = range === 'custom' && custom
      ? resolveTimeframe({ key: 'custom', ...custom }, TODAY, params.retentionDays ?? 30).dates
      : [range === 'yesterday' ? shiftIsoDate(TODAY, -1) : TODAY];
    const dateSet = new Set(dates);
    const graceMin = Math.round((params.lateGraceSec ?? 900) / 60);

    // ── breaks, idle and clock-ins, from each person's day ────────────────
    const rows = dates.flatMap((date) => staff.flatMap((emp) => {
      const todaySegments = DAY_TIMELINES[emp.id] || [];
      const sh = shiftOf(emp);
      const segments = date === TODAY
        ? todaySegments
        : mockDaySegments({
          empId: emp.id, date, shift: sh, todaySegments,
          fallbackPost: ['Off-floor', '—'].includes(emp.zone) ? 'Floor' : emp.zone,
        });
      const day = summarizeDay({ segments, date, now: date === TODAY ? NOW_IST : undefined, limits });
      const employeeShare = { activeMin: day.activeMin, breakMin: day.breakMin, idleMin: day.idleMin, exceptions: day.exceptions };
      const employeeShift = sh ? `${sh.label} (${sh.start} – ${sh.end} IST)` : emp.shift || null;
      const employeeZone = ['Off-floor', '—'].includes(emp.zone) ? null : emp.zone;
      const meta = {
        employeeId: emp.id, employeeName: emp.name, employeeRole: emp.role,
        employeeShift, employeeZone, employeeShare,
      };
      // The day's clock-in: real for today, the first segment's start for the
      // mock history — the same rule the staff dossier reads it by.
      const lateAgainstShift = (hhmm) => (sh ? Math.max(0, toMinutes(hhmm) - toMinutes(sh.start) - graceMin) : 0);
      const arrival = date === TODAY
        ? (emp.clockIn ? [arrivalEvent({ date, time: emp.clockIn, lateMin: lateMinutes(emp.lateBy) })] : [])
        : (segments.length ? [arrivalEvent({ date, time: segments[0].s, lateMin: lateAgainstShift(segments[0].s) })] : []);

      return [...arrival, ...day.events].map((ev) => ({
        ...ev, id: `${emp.id}-${ev.id}`, ...meta,
      }));
    }));

    // ── phone detections ─────────────────────────────────────────────────
    // One row per detection, carrying its hold time and the threshold it is
    // judged against, so the log can print "48s" and tell a Minor hold from a
    // Policy Violation (incidentFlag) without reaching for the params.
    PHONE_EVENTS.forEach((p) => {
      const empId = idByName.get(p.employee);
      if (!dateSet.has(p.date) || (range === 'shift' && empId && !staffIds.has(empId))) return;
      const over = p.holdSec > violationSec;
      rows.push({
        id: `phone-${p.id}`, date: p.date, type: 'phone', instant: true,
        start: p.time, end: p.time, ongoing: false,
        durationMin: 0, limitMin: 0, overMin: 0,
        // ts is the detection second; the log prints minutes but the clip is
        // pre-buffered to the exact second (phonePreviewSource).
        ts: p.ts, holdSec: p.holdSec, limitSec: violationSec, confidence: p.confidence,
        compliance: over ? 'over' : 'ok',
        location: p.location, cameraId: p.camera,
        note: `Phone in hand for ${p.holdSec}s in ${p.zone}${over ? ` — past the ${violationSec}s floor limit` : ''}`,
        employeeId: empId, employeeName: p.employee, employeeZone: p.zone,
      });
    });

    // ── camera alerts that are events of their own ───────────────────────
    // Today only: FEED is the live feed. An unattended-counter alert inside an
    // idle stretch IS that stretch, so it flags the existing row instead of
    // adding a second one for the same minutes.
    if (dateSet.has(TODAY)) {
      FEED.filter((f) => FEED_INCIDENT[f.type] && f.employee).forEach((f) => {
        const empId = idByName.get(f.employee);
        if (range === 'shift' && empId && !staffIds.has(empId)) return;
        const kind = FEED_INCIDENT[f.type];
        const t = toMinutes(f.time);
        const i = rows.findIndex((r) => r.employeeName === f.employee && r.date === TODAY && r.type === 'idle'
          && toMinutes(r.start) <= t && (r.ongoing || toMinutes(r.end) >= t));
        if (i >= 0) { rows[i] = { ...rows[i], unattended: true, note: rows[i].note || f.text }; return; }
        rows.push({
          id: `feed-${f.id}`, date: TODAY, type: kind.type, instant: true,
          start: f.time, end: f.time, ongoing: false,
          durationMin: 0, limitMin: 0, overMin: 0, compliance: kind.compliance,
          location: f.zone, cameraId: f.camera, note: f.text,
          employeeId: empId, employeeName: f.employee, employeeZone: f.zone,
        });
      });
    }

    // newest first — by day, then by start time within the day
    return rows.sort((a, b) => b.date.localeCompare(a.date) || b.start.localeCompare(a.start));
  }, [EMPLOYEES, DAY_TIMELINES, PHONE_EVENTS, FEED, NOW_IST, TODAY, idByName,
    params.shifts, params.retentionDays, params.lateGraceSec, range, custom, limits, violationSec]);

  // A selection the current range no longer contains is simply ignored.
  const selected = selectedId && events.some((e) => e.employeeId === selectedId) ? selectedId : null;

  // ?type= seeds the activity chip (the old Breaks and Phone URLs land here
  // pre-filtered). The address bar mirrors a later change, so a copied URL
  // keeps the view; an unrecognised value widens to All.
  const type = search.get('type') || 'all';
  const setType = useCallback((next) => {
    setSearch((prev) => {
      const q = new URLSearchParams(prev);
      if (!next || next === 'all') q.delete('type'); else q.set('type', next);
      return q;
    }, { replace: true });
  }, [setSearch]);

  const openPreview = (e) => {
    const label = { title: `${ACTIVITY[e.type].label} · ${e.employeeName}`, subtitle: `${e.start}${e.instant ? '' : `–${e.end || 'now'}`} · ${e.location}` };
    // A phone detection carries its second, so its clip seeks exactly there;
    // every other row is a minute-grained segment.
    setPreview(e.type === 'phone' && e.ts
      ? phonePreviewSource({ date: e.date, ts: e.ts, camera: e.cameraId, location: e.location }, label)
      : eventPreviewSource(e, label));
  };

  return (
    // xl+: one screen tall, the log stretched to the bottom and scrolling
    // inside itself. Below xl the page scrolls normally.
    <div className="w-full max-w-full page-inset-x pb-4 pt-3 xl:flex xl:h-[calc(var(--app-vh)-var(--topbar-h))] xl:flex-col xl:overflow-hidden">
      <div className="mb-2.5 flex shrink-0 items-center gap-2.5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
          <ScrollText className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Activity Log</h1>
          <p className="mt-1 truncate text-small text-fg-muted">
            Every break, idle stretch, phone detection and clock-in, checked against policy.
            Select a row to highlight that person&apos;s events. Times IST.
          </p>
        </div>
      </div>

      <div className="xl:min-h-0 xl:flex-1">
        <BreakIdleLog
          events={events}
          limits={limits}
          isRetail={useCase === 'retail'}
          title="Activity Log"
          range={range}
          customRange={custom}
          rangeBounds={rangeBounds}
          onRange={setRange}
          activity={type}
          onActivity={setType}
          phone={phonePolicy}
          subject="the team"
          showEmployee
          fill
          selectedId={selected}
          onSelect={setSelectedId}
          onPreview={openPreview}
        />
      </div>

      {preview && <CameraPreviewModal source={preview} onClose={closePreview} />}
    </div>
  );
}

// "10:41" + "26m" style late string → minutes. Same reading as the dossier's.
function lateMinutes(lateBy) {
  return parseInt(String(lateBy || '').replace(/\D/g, ''), 10) || 0;
}
