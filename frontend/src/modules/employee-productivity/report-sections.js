// ─────────────────────────────────────────────────────────────────────────────
// Report catalog — what the Reports hub can export, as data.
//
// Each domain report is a SECTION: { id, title, kpis, tables }, built from one
// context object the page assembles (scope + datasets). The same sections feed
// the catalog cards' quick exports, the page's KPI tiles, and the Federated
// Site Report, which is simply several sections under one header — so a number
// cannot read differently in the bundle than in the single-domain file.
//
// Pure (no React, no DOM, no '@/' imports) so `npm test` can check it. The
// writers in scorecard-export.js turn a section into PDF / CSV / XLSX.
//
// ctx: { site, storeLabel, storeCode, from, to, shiftLabel, generatedBy,
//        policy, rows (scorecard, best first), showImpact, healthScore,
//        zones: { hours, coverage, live, incidents } | null,
//        alerts: event-log alerts [{ ts, type, subject, camera, detail, severity }],
//        asOf: 'YYYY-MM-DD' — the day the alert log covers }
// ─────────────────────────────────────────────────────────────────────────────

import { BREAK_WARN_MIN, COACHING_BELOW, coachingFlags, scoreBand } from './scorecard.js';

// Zone coverage bands — the Zone Coverage page's own (80 / 50).
export const COVERAGE_HEAT = { good: 80, warn: 50 };
// Compliance targets for the health scorecard. PLACEHOLDERS: the policy config
// (Rules & Policies) has thresholds per event, not site-level SLAs; move these
// there once it does, and read them from params like the other rules.
const TARGET = { onTime: 90, breakCompliance: 90, phonePerHead: 1, coverage: 90, coverageHours: 90 };

export const ALERT_LABEL = {
  late_arrival: 'Late arrival',
  phone_use: 'Phone use',
  counter_unattended: 'Counter unattended',
  queue_exceeded: 'Queue limit exceeded',
  low_activity: 'Low staff activity',
  break_overstay: 'Break overstay',
};
const alertLabel = (type) => ALERT_LABEL[type] || String(type || 'Alert').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n) => `${Math.round(n)}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "HH:MM" in IST for an epoch-seconds timestamp.
function istTime(ts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ts * 1000));
}

// ── Derived figures, shared by several sections ─────────────────────────────
export function zoneStats(zones) {
  if (!zones) return null;
  const perZone = zones.coverage.map((z) => ({ ...z, avg: avg(z.hours) }));
  const cells = zones.coverage.flatMap((z) => z.hours);
  const lowest = perZone.reduce((a, b) => (b.avg < a.avg ? b : a), perZone[0]);
  const busiest = zones.live.reduce((a, b) => (b.occupancy / b.capacity > a.occupancy / a.capacity ? b : a), zones.live[0]);
  return {
    perZone,
    coverage: avg(cells),
    hoursMet: cells.length ? (cells.filter((c) => c >= COVERAGE_HEAT.good).length / cells.length) * 100 : 0,
    lowest,
    busiest,
    busiestPct: busiest ? (busiest.occupancy / busiest.capacity) * 100 : 0,
    openIncidents: zones.incidents.filter((i) => i.active).length,
  };
}

export function teamStats(rows) {
  const needsCoaching = rows.filter((r) => r.score < COACHING_BELOW);
  return {
    avgScore: Math.round(avg(rows.map((r) => r.score))),
    best: rows[0],
    needsCoaching,
    onTime: avg(rows.map((r) => r.onTime)),
    breakCompliance: rows.length ? (rows.filter((r) => r.breakMin <= BREAK_WARN_MIN).length / rows.length) * 100 : 100,
    phonePerHead: rows.length ? rows.reduce((a, r) => a + r.phone, 0) / rows.length : 0,
    phoneTotal: rows.reduce((a, r) => a + r.phone, 0),
  };
}

// ── 1 · Employee Productivity & Scorecard ───────────────────────────────────
export function scorecardKpis(ctx) {
  const t = teamStats(ctx.rows);
  return [
    { label: `${ctx.site} Operational Health`, value: `${ctx.healthScore}%`, note: 'Overall shift compliance & floor coverage' },
    { label: 'Team Average Score', value: `${t.avgScore} / 100`, note: 'Overall productivity benchmark' },
    { label: 'Top Performer', value: t.best?.name ?? '—', note: t.best ? `${t.best.role} · score ${t.best.score}` : '' },
    {
      label: `Needs Coaching (<${COACHING_BELOW})`,
      value: plural(t.needsCoaching.length, 'Employee'),
      // A count, not names: a list stops fitting past a handful of people, and
      // who they are is in the matrix (Status = Needs coaching).
      note: t.needsCoaching.length ? `Scored below ${COACHING_BELOW} — see the matrix` : 'Everyone at or above target',
    },
  ];
}

function scorecardTable(ctx) {
  const columns = [
    'Employee', 'Role', 'Days Worked', 'On-Time %', 'Avg Hours', 'Break Time (min)', 'Phone Incidents',
    ...(ctx.showImpact ? ['Counter Unattended (min)', 'Queue Breaches'] : []),
    'Score', 'Status',
  ];
  const rows = ctx.rows.map((r) => [
    r.name, r.role, r.days, `${r.onTime}%`, r.avgH, r.breakMin, r.phone,
    ...(ctx.showImpact ? [r.impact?.counterMin ?? 0, r.impact?.queueBreaches ?? 0] : []),
    r.score, scoreBand(r.score),
  ]);
  return { id: 'scorecard', title: 'Employee performance & incident matrix', sheet: 'Employee Scorecard', columns, rows };
}

function employeesSection(ctx) {
  return { id: 'employees', title: `Employee Productivity & ${ctx.site} Health Summary`, kpis: scorecardKpis(ctx), tables: [scorecardTable(ctx)] };
}

// ── 2 · Zone Occupancy & Traffic ────────────────────────────────────────────
function zoneIncidentTable(ctx) {
  return {
    id: 'zone-incidents',
    title: 'Zone & counter incidents',
    sheet: 'Zone Incidents',
    columns: ['Zone', 'Incident', 'Started (IST)', 'Duration', 'Status'],
    rows: ctx.zones.incidents.map((i) => [i.zone, i.type, i.from, i.duration, i.active ? 'Active' : 'Resolved']),
  };
}

function zonesSection(ctx) {
  if (!ctx.zones) return null;
  const z = zoneStats(ctx.zones);
  return {
    id: 'zones',
    title: 'Zone Occupancy & Coverage Report',
    kpis: [
      { label: 'Avg Staffed Coverage', value: pct(z.coverage), note: `Across ${plural(z.perZone.length, 'zone')}, ${ctx.zones.hours[0]}–${ctx.zones.hours.at(-1)}` },
      { label: 'Lowest-Covered Zone', value: z.lowest.zone, note: `${pct(z.lowest.avg)} average staffed` },
      { label: 'Busiest Zone Now', value: z.busiest.zone, note: `${z.busiest.occupancy} of ${z.busiest.capacity} capacity (${pct(z.busiestPct)})` },
      { label: 'Open Zone Incidents', value: String(z.openIncidents), note: z.openIncidents ? 'Unattended or low activity right now' : 'All zones attended' },
    ],
    tables: [
      {
        id: 'coverage-heatmap',
        title: 'Hourly staffed coverage heatmap',
        sheet: 'Coverage Heatmap',
        heat: COVERAGE_HEAT,
        columns: ['Zone', 'Type', ...ctx.zones.hours, 'Average'],
        rows: z.perZone.map((r) => [r.zone, r.kind === 'counter' ? 'Counter' : 'Zone', ...r.hours.map(pct), pct(r.avg)]),
      },
      {
        id: 'occupancy',
        title: 'Occupancy vs capacity (latest)',
        sheet: 'Occupancy',
        columns: ['Zone', 'Camera', 'Occupancy', 'Capacity', 'Utilisation', 'Staff on Post', 'Required', 'Unattended Since'],
        rows: ctx.zones.live.map((r) => [
          r.zone, r.camera, r.occupancy, r.capacity, pct((r.occupancy / r.capacity) * 100),
          r.staff.length ? r.staff.join(', ') : '—', r.required, r.unattendedSince || '—',
        ]),
      },
      zoneIncidentTable(ctx),
    ],
  };
}

// ── 3 · Policy Violations & Alerts Audit ────────────────────────────────────
function violationsSection(ctx) {
  const alerts = ctx.alerts;
  const count = (types) => alerts.filter((a) => types.includes(a.type)).length;
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const [, m, d] = ctx.asOf.split('-');
  const day = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${Number(d)}`;
  return {
    id: 'violations',
    title: 'Policy Violations & Alerts Audit Log',
    kpis: [
      { label: 'Policy Alerts', value: String(alerts.length), note: `Raised on ${day}` },
      { label: 'Critical', value: String(critical), note: critical ? 'Needed immediate action' : 'None raised' },
      { label: 'Phone Use', value: String(count(['phone_use'])), note: 'Phone-in-hand detections on the floor' },
      ctx.showImpact
        ? { label: 'Counter / Queue Breaches', value: String(count(['counter_unattended', 'queue_exceeded'])), note: 'Unattended tills and queues over limit' }
        : { label: 'Late Arrivals', value: String(count(['late_arrival'])), note: 'Clock-ins past the grace cutoff' },
    ],
    tables: [
      {
        id: 'alert-log',
        title: `Policy alert audit log - ${day}`,
        sheet: 'Alert Audit Log',
        columns: ['Time (IST)', 'Alert', 'Employee', 'Camera', 'Detail', 'Severity'],
        rows: [...alerts].sort((a, b) => a.ts - b.ts).map((a) => [
          istTime(a.ts), alertLabel(a.type), a.subject || '—', a.camera || '—', a.detail,
          a.severity === 'critical' ? 'Critical' : 'Warning',
        ]),
      },
      ...(ctx.zones ? [zoneIncidentTable(ctx)] : []),
    ],
  };
}

// ── 4 · Store Health & Operational Compliance ───────────────────────────────
// Each check is judged on the value it prints, so a row can never read
// "90% · target >= 90% · Missed".
export function complianceChecks(ctx) {
  const t = teamStats(ctx.rows);
  const z = zoneStats(ctx.zones);
  return [
    { metric: 'Team productivity score', actual: `${t.avgScore} / 100`, target: `>= ${COACHING_BELOW}`, met: t.avgScore >= COACHING_BELOW },
    { metric: 'On-time arrival', actual: pct(t.onTime), target: `>= ${TARGET.onTime}%`, met: Math.round(t.onTime) >= TARGET.onTime },
    { metric: `Break compliance (<= ${BREAK_WARN_MIN}m)`, actual: pct(t.breakCompliance), target: `>= ${TARGET.breakCompliance}%`, met: Math.round(t.breakCompliance) >= TARGET.breakCompliance },
    { metric: 'Phone incidents per employee', actual: t.phonePerHead.toFixed(1), target: `<= ${TARGET.phonePerHead.toFixed(1)}`, met: Number(t.phonePerHead.toFixed(1)) <= TARGET.phonePerHead },
    ...(z ? [
      { metric: 'Staffed zone coverage', actual: pct(z.coverage), target: `>= ${TARGET.coverage}%`, met: Math.round(z.coverage) >= TARGET.coverage },
      { metric: `Zone-hours >= ${COVERAGE_HEAT.good}% staffed`, actual: pct(z.hoursMet), target: `>= ${TARGET.coverageHours}%`, met: Math.round(z.hoursMet) >= TARGET.coverageHours },
      { metric: 'Open zone incidents', actual: String(z.openIncidents), target: '0', met: z.openIncidents === 0 },
    ] : []),
  ];
}

function healthSection(ctx) {
  const checks = complianceChecks(ctx);
  const met = checks.filter((c) => c.met).length;
  const z = zoneStats(ctx.zones);
  const t = teamStats(ctx.rows);
  return {
    id: 'health',
    title: `${ctx.site} Health & Operational Compliance`,
    kpis: [
      { label: `${ctx.site} Operational Health`, value: `${ctx.healthScore}%`, note: 'Overall shift compliance & floor coverage' },
      z
        ? { label: 'Staffing Coverage', value: pct(z.coverage), note: `Avg staffed across ${plural(z.perZone.length, 'zone')}` }
        : { label: 'On-Time Arrival', value: pct(t.onTime), note: `Team average, ${plural(ctx.rows.length, 'employee')}` },
      { label: 'SLA Achievement', value: `${met} / ${checks.length}`, note: `Compliance targets met (${pct((met / checks.length) * 100)})` },
      { label: 'Team Average Score', value: `${t.avgScore} / 100`, note: `${plural(t.needsCoaching.length, 'employee')} below ${COACHING_BELOW}` },
    ],
    tables: [{
      id: 'compliance',
      title: 'Operational compliance scorecard',
      sheet: 'Compliance',
      columns: ['Metric', 'Actual', 'Target', 'Status'],
      rows: checks.map((c) => [c.metric, c.actual, c.target, c.met ? 'Met' : 'Missed']),
    }],
  };
}

// ── Catalog ─────────────────────────────────────────────────────────────────
const BUILDERS = { health: healthSection, employees: employeesSection, zones: zonesSection, violations: violationsSection };
// Federated order: executive summary first, detail after.
export const SECTION_ORDER = ['health', 'employees', 'zones', 'violations'];
const SLUG = { health: 'operational-health', employees: 'employee-productivity', zones: 'zone-occupancy', violations: 'policy-violations-audit' };
const CODE = { health: 'OHC', employees: 'EPS', zones: 'ZOC', violations: 'PVA' };
const SUBTITLE = {
  health: 'Operational health & compliance scorecard',
  zones: 'Zone occupancy & staffed-coverage report',
  violations: 'Policy violations & alerts audit log',
};

export const sectionAvailable = (ctx, id) => id !== 'zones' || !!ctx.zones;

export function buildSection(ctx, id) {
  return BUILDERS[id]?.(ctx) ?? null;
}

// The shared header/scope every payload carries.
const scope = (ctx) => ({
  site: ctx.site, storeLabel: ctx.storeLabel, storeCode: ctx.storeCode, from: ctx.from, to: ctx.to,
  shiftLabel: ctx.shiftLabel, generatedBy: ctx.generatedBy, policy: ctx.policy,
});

/** Input for buildScorecardPayload: one domain report. */
export function sectionPayloadInput(ctx, id) {
  const s = buildSection(ctx, id);
  if (!s) return null;
  // The employee report keeps its original title / ID / filename.
  if (id === 'employees') return { ...scope(ctx), kpis: s.kpis, tables: s.tables };
  return {
    ...scope(ctx), title: s.title, code: CODE[id], slug: `${SLUG[id]}-${ctx.site.toLowerCase()}`, kpis: s.kpis, tables: s.tables,
    labels: {
      subtitle: `Drishyam Activity Monitoring  -  ${SUBTITLE[id]}`,
      rowNoun: id === 'violations' ? 'alerts' : id === 'zones' ? 'zones' : 'checks',
      footer: 'Confidential - for internal management use.',
    },
  };
}

/** Input for buildScorecardPayload: one employee's week. */
export function employeePayloadInput(ctx, row) {
  const rank = ctx.rows.findIndex((r) => r.id === row.id) + 1;
  const flags = coachingFlags(row);
  return {
    ...scope(ctx),
    title: `Employee Scorecard - ${row.name}`,
    code: `EMP-${row.id.toUpperCase()}`,
    slug: `employee-scorecard-${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    kpis: [
      { label: 'Score', value: `${row.score} / 100`, note: scoreBand(row.score) },
      { label: 'Rank', value: `#${rank} of ${ctx.rows.length}`, note: `${row.role}` },
      { label: 'On-Time', value: `${row.onTime}%`, note: `${row.days} days worked` },
      { label: 'Break Time', value: `${row.breakMin}m`, note: row.breakMin > BREAK_WARN_MIN ? `Over the ${BREAK_WARN_MIN}m guideline` : 'Within guideline' },
    ],
    tables: [
      { ...scorecardTable({ ...ctx, rows: [row] }), title: 'Weekly metrics', sheet: 'Metrics' },
      {
        id: 'coaching', title: 'Coaching focus', sheet: 'Coaching',
        columns: ['#', 'Focus area'],
        rows: flags.length ? flags.map((f, i) => [i + 1, f]) : [['-', 'No coaching flags this period']],
      },
    ],
    labels: {
      subtitle: 'Drishyam Activity Monitoring  -  Individual weekly scorecard',
      rowNoun: 'employee',
      footer: 'Confidential - for internal HR / payroll use.',
    },
    countLine: `${row.name} - ${row.role}`,
  };
}

/** Input for buildScorecardPayload: several sections under one header. */
export function federatedPayloadInput(ctx, ids) {
  const picked = SECTION_ORDER.filter((id) => ids.includes(id) && sectionAvailable(ctx, id));
  const sections = picked.map((id) => buildSection(ctx, id));
  // A table two sections share (zone incidents) prints once.
  const seen = new Set();
  const tables = sections.flatMap((s) => s.tables).filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const exec = sections.find((s) => s.id === 'health') || sections[0];
  return {
    ...scope(ctx),
    title: `Federated Site Report - ${ctx.storeLabel}`,
    code: 'FSR',
    slug: `federated-site-report-${ctx.site.toLowerCase()}`,
    kpis: exec?.kpis ?? [],
    tables,
    sections: picked,
    labels: {
      subtitle: 'Drishyam Activity Monitoring  -  Consolidated site audit bundle',
      summary: exec?.id === 'health' ? 'Executive summary & operational health' : `Executive summary - ${exec?.title ?? ''}`,
      footer: 'Confidential - for internal management & audit use.',
    },
    countLine: `${plural(picked.length, 'section')} - ${plural(tables.length, 'table')}`,
  };
}
