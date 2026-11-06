import { useState, useMemo } from 'react';
import {
  Cloud, Server, Cctv, BellRing, ScanFace, Route, Footprints, Car,
  ShieldAlert, Flame, FlameKindling, Users, Mic, Plug, Headset,
  CalendarDays, Check, ChevronDown, Sparkles, Lock, RefreshCw,
  Wallet, ShieldCheck, Plus, Minus, Info, Phone, BadgeCheck,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════════════════
   PRICING FRAMEWORK  ·  all numbers are first-draft placeholders (₹, India)
   Everything a customer is charged for lives here — edit freely, the page
   re-prices itself. No technical terms are ever shown to the customer.
   ════════════════════════════════════════════════════════════════════════ */

// How they take it: rent it (Cloud) or own it (On-premise).
const DEPLOY = {
  cloud: {
    label: 'Pay monthly',
    tag: 'We host it for you',
    icon: Cloud,
    blurb: 'Nothing to buy. A predictable monthly fee, cancel anytime.',
    baseRate: 300,      // ₹ / camera / month — "Watch & Record"
    setupPerCam: 500,   // one-time, gets you live
  },
  onprem: {
    label: 'Own it',
    tag: 'Lives on your site',
    icon: Server,
    blurb: 'Buy the equipment once. Lower monthly fee, and it keeps working even if the internet drops.',
    baseRate: 150,
    setupPerCam: 500,
  },
};

// On-premise equipment — one-time, sized to how many cameras you run.
function hardwareCost(cams) {
  if (cams <= 50) return 400000;
  if (cams <= 250) return 900000;
  if (cams <= 1000) return 2800000;
  if (cams <= 2000) return 5000000;
  return 5000000 + (cams - 2000) * 2000;
}

// ── THE LOGIC BEHIND EVERY SMART-FEATURE PRICE ──────────────────────────────
// A feature's price is NOT picked by hand. It's driven by how much computing
// work that feature asks of each camera every month — its "effort". Recognising
// a face on every frame is heavy work; watching for someone crossing a line is
// light. We measure effort the SAME way the engineering team sizes the servers:
// compute-hours per camera per month (these match the admin calculator's
// GPU_FACTORS — e.g. face recognition ≈ 6.0, behaviour ≈ 3.0, plate ≈ 3.8).
//
//        feature price /cam/mo  =  effort  ×  PRICE_PER_UNIT
//
// Change PRICE_PER_UNIT and EVERY feature reprices consistently. On-premise is
// cheaper per unit because the customer already OWNS the computing hardware —
// they pay for the software, not for rented compute.
const PRICE_PER_UNIT = { cloud: 66, onprem: 42 };   // ₹ per compute-unit /cam/mo
const round10 = (n) => Math.round(n / 10) * 10;
function featureRate(f, mode) {
  if (f.flat) return f.flat[mode];          // not compute-driven (e.g. audio)
  return round10(f.effort * PRICE_PER_UNIT[mode]);
}
// Plain-language "why it costs what it costs" — no jargon for the customer.
function effortLabel(f) {
  if (f.flat) return 'Light';
  if (f.effort >= 5) return 'Heavy';
  if (f.effort >= 3.5) return 'Standard';
  return 'Light';
}

// Every smart capability the product offers, in plain words + why you pay.
// `effort` = compute-hours/camera/month → feeds featureRate() above.
const FEATURE_GROUPS = [
  {
    group: 'Keep people safe',
    features: [
      { id: 'weapon', name: 'Weapon Detection', icon: ShieldAlert, accent: '#ef4444',
        why: 'Spot a visible weapon and raise the alarm in seconds.', effort: 4.5 },
      { id: 'fight', name: 'Fight & Aggression', icon: Flame, accent: '#f97316',
        why: 'Catch fights and aggressive behaviour as they break out.', effort: 3.8 },
      { id: 'fire', name: 'Fire & Smoke', icon: FlameKindling, accent: '#dc2626',
        why: 'Detect fire and smoke early — before the alarms even trip.', effort: 3.8 },
      { id: 'crowd', name: 'Crowd Safety', icon: Users, accent: '#6366f1',
        why: 'Get warned when an area becomes dangerously crowded.', effort: 3.0 },
    ],
  },
  {
    group: 'Find & follow people',
    features: [
      { id: 'find_people', name: 'Find People', icon: ScanFace, accent: '#ec4899',
        why: 'Recognise faces and instantly find a specific person across every camera.', effort: 6.0 },
      { id: 'journey', name: 'Trace a Journey', icon: Route, accent: '#8b5cf6',
        why: 'See exactly where a person went, camera to camera, as one stitched video.', effort: 5.3 },
      { id: 'footfall', name: 'People Counting', icon: Footprints, accent: '#14b8a6',
        why: 'Count who comes and goes — footfall, queues and busy hours.', effort: 2.2 },
    ],
  },
  {
    group: 'Watch areas & vehicles',
    features: [
      { id: 'alerts', name: 'Smart Alerts', icon: BellRing, accent: '#f59e0b',
        why: 'Cameras tell you the moment something is wrong — someone enters a no-go area, lingers, or crosses a line.', effort: 3.0 },
      { id: 'vehicles', name: 'Vehicles & Number Plates', icon: Car, accent: '#0ea5e9',
        why: 'Read number plates and search by vehicle across all cameras.', effort: 3.8 },
    ],
  },
  {
    group: 'Extras',
    features: [
      { id: 'audio', name: 'Two-Way Audio', icon: Mic, accent: '#16a34a',
        why: 'Speak through your cameras to warn or guide people.', flat: { cloud: 80, onprem: 50 } },
    ],
  },
];
const ALL_FEATURES = FEATURE_GROUPS.flatMap(g => g.features);

// A whole-account extra, not per-camera (integration/platform fee, not compute).
const FLAT_ADDON = {
  id: 'api', name: 'Connect Your Own Systems', icon: Plug, accent: '#64748b',
  why: 'Plug Drishyam into the apps and dashboards you already use.', flat: { cloud: 2000, onprem: 1500 },
};

// How far back you can look. Cloud = we store it; On-prem = your own storage.
const RETENTION = [
  { days: 7, label: '1 week', rate: 0 },
  { days: 30, label: '1 month', rate: 100 },
  { days: 60, label: '2 months', rate: 200 },
  { days: 90, label: '3 months', rate: 300 },
  { days: 180, label: '6 months', rate: 600 },
  { days: 365, label: '1 year', rate: 1200 },
];

// How fast we answer when you need us.
const SUPPORT = [
  { id: 'standard', name: 'Standard', why: 'Email & chat, next business day.', uplift: 0 },
  { id: 'priority', name: 'Priority', why: 'Phone support, faster response.', uplift: 0.15 },
  { id: 'critical', name: '24×7 Critical', why: 'Round-the-clock, 1-hour response on emergencies.', uplift: 0.30 },
];

// How long you need it. Longer commitment = lower price (the flexibility trade).
const DURATION = [
  { id: 'event', name: 'Just an event', sub: 'Pay by the day', kind: 'daily' },
  { id: 'monthly', name: 'Monthly', sub: 'Cancel anytime', mult: 1.0, months: 1, save: 0 },
  { id: '1y', name: '1 Year', sub: 'Save 15%', mult: 0.85, months: 12, save: 0.15 },
  { id: '2y', name: '2 Years', sub: 'Save 22%', mult: 0.78, months: 24, save: 0.22 },
  { id: '3y', name: '3 Years', sub: 'Save 28%', mult: 0.72, months: 36, save: 0.28 },
];
const EVENT_PREMIUM = 4;        // short-term flexibility costs ~4× the daily-equivalent
const PAUSED_RATE = { cloud: 80, onprem: 40 }; // ₹/cam/mo while seasonally paused
const SITE_FEE = { cloud: 4000, onprem: 2500 }; // ₹/mo per extra location
const GST = 0.18;

const CAMERA_PRESETS = [10, 25, 50, 100, 250, 500, 1000, 2000];

/* ─────────────────────────── helpers ─────────────────────────── */
const inr = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const dailyOf = (monthly) => Math.round((monthly / 30) * EVENT_PREMIUM);

const DEFAULT_STATE = {
  mode: 'cloud',
  cameras: 50,
  sites: 1,
  retentionDays: 30,
  support: 'standard',
  duration: 'monthly',
  eventDays: 2,
  seasonal: false,
  activeMonths: 6,
  spreadSetup: false,
  apiOn: false,
  // per-feature: { on, allCams, cams }
  features: Object.fromEntries(ALL_FEATURES.map(f => [f.id, { on: false, allCams: true, cams: 0 }])),
};

/* The single source of truth for the price. Pure function so we can also
   compute the *other* deployment for the side-by-side compare. */
function compute(state, mode) {
  const d = DEPLOY[mode];
  const cams = Math.max(0, state.cameras || 0);
  const appliedOf = (f) => {
    const st = state.features[f.id];
    if (!st?.on) return 0;
    return st.allCams ? cams : Math.min(st.cams || 0, cams);
  };

  const isEvent = state.duration === 'event';
  const lines = [];

  // ── Base: every camera is watched & recorded ──
  const baseUnit = isEvent ? dailyOf(d.baseRate) : d.baseRate;
  const baseRecurring = cams * d.baseRate;
  lines.push({
    label: 'Watch & Record',
    why: 'Every camera watched around the clock, with footage ready to play back.',
    detail: `${cams.toLocaleString('en-IN')} cameras × ${inr(baseUnit)}${isEvent ? ' /day' : ' /mo'}`,
    monthly: baseRecurring,
    daily: cams * dailyOf(d.baseRate),
  });

  // ── Smart features ──
  for (const f of ALL_FEATURES) {
    const n = appliedOf(f);
    if (n <= 0) continue;
    const unit = featureRate(f, mode);
    lines.push({
      label: f.name, why: f.why, accent: f.accent,
      detail: `${n.toLocaleString('en-IN')} ${n === 1 ? 'camera' : 'cameras'} × ${inr(isEvent ? dailyOf(unit) : unit)}${isEvent ? ' /day' : ' /mo'}`,
      monthly: n * unit,
      daily: n * dailyOf(unit),
    });
  }

  // ── Whole-account extra ──
  if (state.apiOn && !isEvent) {
    lines.push({
      label: FLAT_ADDON.name, why: FLAT_ADDON.why, accent: FLAT_ADDON.accent,
      detail: `flat ${inr(featureRate(FLAT_ADDON, mode))} /mo`, monthly: featureRate(FLAT_ADDON, mode), daily: 0,
    });
  }

  // ── Footage memory (cloud stores it; on-prem uses your own storage) ──
  const retention = RETENTION.find(r => r.days === state.retentionDays) || RETENTION[1];
  if (mode === 'cloud' && retention.rate > 0 && !isEvent) {
    lines.push({
      label: `Keep footage ${retention.label}`,
      why: 'Every second saved and ready until you choose to let it go.',
      detail: `${cams.toLocaleString('en-IN')} cameras × ${inr(retention.rate)} /mo`,
      monthly: cams * retention.rate, daily: 0,
    });
  }

  // ── Extra locations ──
  const extraSites = Math.max(0, (state.sites || 1) - 1);
  if (extraSites > 0 && !isEvent) {
    lines.push({
      label: `${extraSites} more ${extraSites === 1 ? 'location' : 'locations'}`,
      why: 'Every building managed together, under one login.',
      detail: `${extraSites} × ${inr(SITE_FEE[mode])} /mo`,
      monthly: extraSites * SITE_FEE[mode], daily: 0,
    });
  }

  // ── Sum recurring, then support, then commitment discount ──
  const preSupport = lines.reduce((s, l) => s + l.monthly, 0);
  const support = SUPPORT.find(s => s.id === state.support) || SUPPORT[0];
  const supportAmt = preSupport * support.uplift;
  const monthlyRecurring = preSupport + supportAmt;

  const dur = DURATION.find(x => x.id === state.duration) || DURATION[1];
  const effectiveMonthly = monthlyRecurring * (dur.mult ?? 1);
  const monthlySavings = monthlyRecurring - effectiveMonthly;

  // ── One-time ──
  const setup = cams * (isEvent ? Math.round(d.setupPerCam * 0.6) : d.setupPerCam);
  const hardware = mode === 'onprem' ? hardwareCost(cams) : 0;
  const oneTime = setup + hardware;

  // ── Event total (pay by the day) ──
  const dailyTotal = lines.reduce((s, l) => s + (l.daily || 0), 0);
  const eventTotal = dailyTotal * (state.eventDays || 1);

  // ── Seasonal (pause in quiet months) — yearly view only ──
  let seasonalAnnual = null;
  if (state.seasonal && !isEvent) {
    const active = Math.min(12, Math.max(1, state.activeMonths || 6));
    const paused = 12 - active;
    seasonalAnnual = active * effectiveMonthly + paused * cams * PAUSED_RATE[mode];
  }

  return {
    mode, lines, support, dur,
    monthlyRecurring, effectiveMonthly, monthlySavings,
    dailyTotal, eventTotal,
    setup, hardware, oneTime,
    seasonalAnnual,
    retention,
  };
}

/* ════════════════════════════════ PAGE ════════════════════════════════ */
export default function Pricing() {
  const [s, setS] = useState(DEFAULT_STATE);
  const set = (patch) => setS(p => ({ ...p, ...patch }));
  const setFeature = (id, patch) =>
    setS(p => ({ ...p, features: { ...p.features, [id]: { ...p.features[id], ...patch } } }));
  const reset = () => setS(DEFAULT_STATE);

  const q = useMemo(() => compute(s, s.mode), [s]);
  const other = useMemo(() => compute(s, s.mode === 'cloud' ? 'onprem' : 'cloud'), [s]);
  const isEvent = s.duration === 'event';

  const enabledCount = ALL_FEATURES.filter(f => s.features[f.id]?.on).length + (s.apiOn ? 1 : 0);

  // "What you get" — base always, plus whatever smarts are switched on.
  const whatYouGet = [
    'See every camera live, from your phone or desktop',
    'Everything recorded, around the clock',
    'Jump to any moment and save the clip',
    'Your whole site on one screen',
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-background">
      {/* ───────────── Hero ───────────── */}
      <div className="border-b border-line bg-gradient-to-br from-muted/60 via-background to-primary/5">
        <div className="max-w-[1200px] mx-auto px-6 py-10">
          <span className="inline-flex items-center gap-1.5 text-small font-semibold text-primary bg-primary/10 px-3 py-1 rounded-full">
            <Wallet className="w-3.5 h-3.5" /> Simple, honest pricing
          </span>
          <h1 className="text-display text-fg mt-4 leading-tight">
            Pay for what watches your campus —<br className="hidden sm:block" /> nothing you can’t see.
          </h1>
          <p className="text-heading text-fg-muted mt-3 max-w-2xl leading-relaxed">
            Move the controls below and your price updates instantly. Start with recording,
            switch on only the smart features you want, and choose how long you need it for.
          </p>
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 items-start">
        {/* ════════ LEFT: the builder ════════ */}
        <div className="flex flex-col gap-5">

          {/* STEP 1 — How you'd like to pay */}
          <Card step={1} title="How would you like to pay?"
                meta={s.mode === 'cloud' ? 'Monthly' : 'Own it'}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(DEPLOY).map(([key, d]) => {
                const active = s.mode === key;
                const Icon = d.icon;
                return (
                  <button key={key} onClick={() => set({ mode: key })}
                    className={`text-left rounded-xl border-2 p-4 transition-all ${active
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : 'border-line bg-surface hover:border-primary/40'}`}>
                    <div className="flex items-center gap-2.5">
                      <span className={`grid place-items-center w-9 h-9 rounded-lg ${active ? 'bg-primary text-primary-foreground' : 'bg-surface-muted text-fg-muted'}`}>
                        <Icon className="w-5 h-5" />
                      </span>
                      <div>
                        <div className="text-body font-bold text-fg">{d.label}</div>
                        <div className="text-caption text-fg-muted">{d.tag}</div>
                      </div>
                      {active && <Check className="w-4 h-4 text-primary ml-auto" />}
                    </div>
                    <p className="text-small text-fg-muted mt-2.5 leading-relaxed">{d.blurb}</p>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* STEP 2 — How many cameras */}
          <Card step={2} title="How many cameras?" meta={`${s.cameras.toLocaleString('en-IN')} cameras`}>
            <div className="flex items-center gap-3">
              <Stepper value={s.cameras} onChange={(v) => set({ cameras: v })} min={1} max={100000} />
              <input type="range" min="1" max="2000" value={Math.min(s.cameras, 2000)}
                onChange={(e) => set({ cameras: Number(e.target.value) })}
                className="flex-1 accent-primary" />
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {CAMERA_PRESETS.map(p => (
                <Pill key={p} active={s.cameras === p} onClick={() => set({ cameras: p })}>
                  {p.toLocaleString('en-IN')}
                </Pill>
              ))}
            </div>
            <Hint icon={Info}>You don’t need new cameras — Drishyam works with the ones you already have.</Hint>
          </Card>

          {/* STEP 3 — Switch on the smart features */}
          <Card step={3} title="What should your cameras do?"
                meta={`${enabledCount} switched on`}>
            <p className="text-small text-fg-muted -mt-1 mb-3">
              Recording is always included. Switch on only the smarts you want — and put each
              on <strong className="text-fg">all your cameras or just a few</strong>.
              Heavier features (like recognising faces) cost a little more, simply because
              they ask your cameras to do more work.
            </p>

            {FEATURE_GROUPS.map(group => (
              <div key={group.group} className="mb-4 last:mb-0">
                <div className="text-caption font-semibold uppercase tracking-wider text-fg-muted mb-2">{group.group}</div>
                <div className="flex flex-col gap-2">
                  {group.features.map(f => (
                    <FeatureRow key={f.id} f={f} mode={s.mode} cameras={s.cameras}
                      state={s.features[f.id]}
                      onToggle={() => setFeature(f.id, { on: !s.features[f.id].on, allCams: true })}
                      onCoverage={(patch) => setFeature(f.id, patch)} isEvent={isEvent} />
                  ))}
                </div>
              </div>
            ))}

            {/* whole-account extra */}
            {!isEvent && (
              <label className="flex items-center gap-3 rounded-lg border border-line p-3 cursor-pointer hover:border-primary/40 transition-colors">
                <span className="grid place-items-center w-9 h-9 rounded-lg shrink-0" style={{ background: FLAT_ADDON.accent + '1a', color: FLAT_ADDON.accent }}>
                  <Plug className="w-5 h-5" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-body font-semibold text-fg">{FLAT_ADDON.name}</span>
                  <span className="block text-caption text-fg-muted">{FLAT_ADDON.why}</span>
                </span>
                <Switch on={s.apiOn} onClick={() => set({ apiOn: !s.apiOn })} />
              </label>
            )}
          </Card>

          {/* STEP 4 — How far back (hidden in event mode for cloud only matters) */}
          <Card step={4} title="How far back do you want to look?"
                meta={RETENTION.find(r => r.days === s.retentionDays)?.label}>
            <div className="flex flex-wrap gap-1.5">
              {RETENTION.map(r => (
                <Pill key={r.days} active={s.retentionDays === r.days} onClick={() => set({ retentionDays: r.days })}>
                  {r.label}
                </Pill>
              ))}
            </div>
            <Hint icon={s.mode === 'onprem' ? Server : Info}>
              {s.mode === 'onprem'
                ? 'On your own equipment, footage is stored on-site — we size the storage for you, no monthly fee.'
                : 'We keep every second safe and instantly searchable until your chosen time.'}
            </Hint>
          </Card>

          {/* STEP 5 — How long do you need it */}
          <Card step={5} title="How long do you need it?"
                meta={DURATION.find(d => d.id === s.duration)?.name}>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {DURATION.map(d => {
                const active = s.duration === d.id;
                return (
                  <button key={d.id} onClick={() => set({ duration: d.id })}
                    className={`rounded-lg border-2 p-3 text-center transition-all ${active
                      ? 'border-primary bg-primary/5' : 'border-line bg-surface hover:border-primary/40'}`}>
                    <div className="text-body font-bold text-fg">{d.name}</div>
                    <div className={`text-micro mt-0.5 font-medium ${d.save ? 'text-success-ink' : 'text-fg-muted'}`}>{d.sub}</div>
                  </button>
                );
              })}
            </div>

            {/* Event: how many days */}
            {isEvent && (
              <div className="mt-3 rounded-lg bg-surface-muted/50 border border-line p-3">
                <div className="flex items-center gap-2 text-small font-semibold text-fg mb-2">
                  <CalendarDays className="w-4 h-4 text-primary" /> How many days?
                </div>
                <div className="flex items-center gap-3">
                  <Stepper value={s.eventDays} onChange={(v) => set({ eventDays: v })} min={1} max={60} />
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 7, 14, 30].map(d => (
                      <Pill key={d} active={s.eventDays === d} onClick={() => set({ eventDays: d })}>
                        {d === 1 ? '1 day' : d === 7 ? '1 wk' : d === 14 ? '2 wk' : d === 30 ? '1 mo' : `${d} days`}
                      </Pill>
                    ))}
                  </div>
                </div>
                <Hint icon={Info}>Perfect for a festival, exam, sports day, election or VIP visit — switch on extra eyes for just those days, then off.</Hint>
              </div>
            )}

            {/* Seasonal pause */}
            {!isEvent && (
              <div className="mt-3">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <Switch on={s.seasonal} onClick={() => set({ seasonal: !s.seasonal })} />
                  <span className="text-body font-medium text-fg">My site is busy only part of the year</span>
                </label>
                {s.seasonal && (
                  <div className="mt-3 rounded-lg bg-surface-muted/50 border border-line p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-small font-semibold text-fg">Busy months per year</span>
                      <span className="text-body font-bold text-primary">{s.activeMonths} of 12</span>
                    </div>
                    <input type="range" min="1" max="11" value={s.activeMonths}
                      onChange={(e) => set({ activeMonths: Number(e.target.value) })}
                      className="w-full accent-primary" />
                    <Hint icon={Info}>In quiet months we pause the smarts and keep your footage safe — you pay only a small holding fee.</Hint>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* STEP 6 — Locations + support + setup */}
          <Card step={6} title="A few finishing touches"
                meta={SUPPORT.find(x => x.id === s.support)?.name}>
            <Label>How many buildings / locations?</Label>
            <div className="flex items-center gap-3 mt-1.5 mb-4">
              <Stepper value={s.sites} onChange={(v) => set({ sites: v })} min={1} max={500} />
              <span className="text-small text-fg-muted">First location included</span>
            </div>

            <Label>How fast should we answer?</Label>
            <div className="grid grid-cols-3 gap-2 mt-1.5 mb-4">
              {SUPPORT.map(opt => {
                const active = s.support === opt.id;
                return (
                  <button key={opt.id} onClick={() => set({ support: opt.id })}
                    className={`text-left rounded-lg border-2 p-2.5 transition-all ${active
                      ? 'border-primary bg-primary/5' : 'border-line bg-surface hover:border-primary/40'}`}>
                    <div className="flex items-center gap-1.5">
                      <Headset className={`w-3.5 h-3.5 ${active ? 'text-primary' : 'text-fg-muted'}`} />
                      <span className="text-small font-bold text-fg">{opt.name}</span>
                    </div>
                    <div className="text-micro text-fg-muted mt-1 leading-snug">{opt.why}</div>
                  </button>
                );
              })}
            </div>

            {!isEvent && q.setup > 0 && (
              <label className="flex items-center gap-2.5 cursor-pointer rounded-lg border border-line p-3">
                <Switch on={s.spreadSetup} onClick={() => set({ spreadSetup: !s.spreadSetup })} />
                <span className="text-body font-medium text-fg">Spread the one-time setup over 3 months</span>
              </label>
            )}
          </Card>
        </div>

        {/* ════════ RIGHT: live total ════════ */}
        <aside className="lg:sticky lg:top-4 flex flex-col gap-4">
          {/* Hero total */}
          <div className="rounded-2xl bg-[#0b0b0d] text-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-small font-medium text-white/60">
                {isEvent ? 'Total for your event' : 'Your monthly price'}
              </span>
              <button onClick={reset} title="Start over"
                className="text-white/50 hover:text-white transition-colors">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Intentionally above --text-display: this is the calculator's one
                hero price figure, the single most important number on the page. */}
            <div className="text-[40px] font-bold tracking-[-0.02em] leading-none mt-2">
              {isEvent ? inr(q.eventTotal) : inr(q.effectiveMonthly)}
              {!isEvent && <span className="text-heading font-medium text-white/50"> /mo</span>}
            </div>

            <div className="text-small text-white/55 mt-1.5">
              {isEvent
                ? `${inr(q.dailyTotal)} a day × ${s.eventDays} ${s.eventDays === 1 ? 'day' : 'days'}`
                : s.seasonal && q.seasonalAnnual != null
                  ? `≈ ${inr(q.seasonalAnnual / 12)}/mo averaged over the year (you pause the quiet months)`
                  : q.dur.months > 1
                    ? `billed as ${inr(q.effectiveMonthly * q.dur.months)} for ${q.dur.months} months`
                    : 'billed monthly · cancel anytime'}
            </div>

            {!isEvent && q.monthlySavings > 0 && (
              <div className="inline-flex items-center gap-1.5 mt-3 text-caption font-semibold text-success bg-success/10 px-2.5 py-1 rounded-full">
                <Sparkles className="w-3 h-3" /> You save {inr(q.monthlySavings * q.dur.months)} over {q.dur.months} months
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-white/10">
              <div>
                <div className="text-micro uppercase tracking-wider text-white/40">One-time setup</div>
                <div className="text-heading font-bold mt-0.5">
                  {q.setup > 0 ? (s.spreadSetup && !isEvent ? `${inr(q.setup / 3)}×3` : inr(q.setup)) : '—'}
                </div>
              </div>
              <div>
                <div className="text-micro uppercase tracking-wider text-white/40">
                  {s.mode === 'onprem' ? 'Equipment (own it)' : 'To get started'}
                </div>
                <div className="text-heading font-bold mt-0.5">
                  {s.mode === 'onprem' ? inr(q.hardware) : inr(q.setup)}
                </div>
              </div>
            </div>
          </div>

          {/* Compare the other way to pay */}
          {!isEvent && (
            <div className="rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center gap-1.5 text-caption font-semibold text-fg-muted mb-1.5">
                <Info className="w-3.5 h-3.5" />
                {s.mode === 'cloud' ? 'Prefer to own it?' : 'Prefer to pay monthly?'}
              </div>
              <p className="text-small text-fg leading-relaxed">
                {s.mode === 'cloud'
                  ? <>Owning the equipment costs <strong>{inr(other.oneTime)}</strong> upfront, then just <strong>{inr(other.effectiveMonthly)}/mo</strong> — cheaper over time.</>
                  : <>Paying monthly needs <strong>{inr(other.setup)}</strong> to start, then <strong>{inr(other.effectiveMonthly)}/mo</strong> — lowest upfront.</>}
              </p>
              <button onClick={() => set({ mode: s.mode === 'cloud' ? 'onprem' : 'cloud' })}
                className="text-small font-semibold text-primary mt-2 hover:underline">
                Switch to {s.mode === 'cloud' ? 'owning it' : 'paying monthly'} →
              </button>
            </div>
          )}

          {/* Breakdown */}
          <div className="rounded-xl border border-line bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-line text-body font-bold text-fg">
              What you’re paying for
            </div>
            <div className="divide-y divide-line">
              {q.lines.map((l, i) => (
                <div key={i} className="px-4 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-body font-semibold text-fg">{l.label}</span>
                    <span className="text-body font-bold text-fg whitespace-nowrap tabular-nums">
                      {isEvent ? inr(l.daily) + '/day' : inr(l.monthly)}
                    </span>
                  </div>
                  <p className="text-caption text-fg-muted mt-0.5 leading-snug">{l.why}</p>
                  <p className="text-micro text-fg-muted/70 mt-0.5">{l.detail}</p>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 bg-surface-muted/40 border-t border-line space-y-1">
              {!isEvent && q.support.uplift > 0 && (
                <Row label={`${q.support.name} support (+${Math.round(q.support.uplift * 100)}%)`}
                     value={inr(q.monthlyRecurring - q.monthlyRecurring / (1 + q.support.uplift))} />
              )}
              {!isEvent && q.dur.months > 1 && (
                <Row label={`${q.dur.name} discount`} value={'− ' + inr(q.monthlySavings)} good />
              )}
              <Row label={isEvent ? 'Per day' : 'Monthly price'}
                   value={isEvent ? inr(q.dailyTotal) : inr(q.effectiveMonthly)} bold />
              <Row label={`GST (${Math.round(GST * 100)}%)`}
                   value={inr((isEvent ? q.eventTotal : q.effectiveMonthly) * GST)} muted />
              <Row label={isEvent ? 'Event total incl. GST' : 'Total incl. GST / mo'}
                   value={inr((isEvent ? q.eventTotal : q.effectiveMonthly) * (1 + GST))} bold big />
            </div>
          </div>

          {/* CTAs */}
          <div className="flex flex-col gap-2">
            <button className="w-full rounded-xl bg-primary text-primary-foreground font-semibold py-3 text-body hover:opacity-90 transition-opacity inline-flex items-center justify-center gap-2">
              <BadgeCheck className="w-4 h-4" /> Get my exact quote
            </button>
            <button className="w-full rounded-xl border border-line bg-surface text-fg font-semibold py-3 text-body hover:bg-surface-muted transition-colors inline-flex items-center justify-center gap-2">
              <Phone className="w-4 h-4" /> Talk to us
            </button>
            <p className="text-caption text-fg-muted text-center">
              Or start a <strong className="text-fg">free 14-day trial</strong> on up to 5 cameras — no card needed.
            </p>
          </div>
        </aside>
      </div>

      {/* ───────────── What you get ───────────── */}
      <div className="border-t border-line bg-surface-muted/30">
        <div className="max-w-[1200px] mx-auto px-6 py-10">
          <h2 className="text-section text-fg mb-1">Every plan already includes</h2>
          <p className="text-body text-fg-muted mb-5">This is everything a control room used to do — now on your phone. The smart features just let your cameras think for themselves.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {whatYouGet.map((t, i) => (
              <div key={i} className="flex items-start gap-2.5 rounded-xl border border-line bg-surface p-4">
                <Check className="w-4 h-4 text-success-ink mt-0.5 shrink-0" />
                <span className="text-body text-fg leading-snug">{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ───────────── Reassurance strip ───────────── */}
      <div className="max-w-[1200px] mx-auto px-6 py-8">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { icon: Wallet, t: 'No hidden fees', s: 'The price you see is the price you pay.' },
            { icon: RefreshCw, t: 'Cancel anytime', s: 'On monthly plans, leave whenever you like.' },
            { icon: Lock, t: 'Your data stays yours', s: 'Encrypted, never sold, deleted on request.' },
            { icon: Cctv, t: 'Use your cameras', s: 'Works with the cameras you already own.' },
            { icon: ShieldCheck, t: 'GST shown upfront', s: 'No surprises on the invoice.' },
          ].map((r, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-4">
              <r.icon className="w-5 h-5 text-primary mb-2" />
              <div className="text-body font-bold text-fg">{r.t}</div>
              <div className="text-caption text-fg-muted mt-0.5 leading-snug">{r.s}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ───────────── FAQ (every question a buyer asks) ───────────── */}
      <div className="border-t border-line bg-surface-muted/30">
        <div className="max-w-[820px] mx-auto px-6 py-12">
          <h2 className="text-section text-fg text-center mb-8">Questions people ask before they pay</h2>
          <div className="flex flex-col gap-2.5">
            {FAQ.map((f, i) => <Faq key={i} q={f.q} a={f.a} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════ small building blocks ════════════════════════ */

function Card({ step, title, meta, children }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3 mb-4">
        <span className="grid place-items-center w-7 h-7 rounded-full bg-primary/10 text-primary text-body font-bold shrink-0">{step}</span>
        <h3 className="text-heading font-bold text-fg flex-1">{title}</h3>
        {meta && <span className="text-small font-semibold text-fg-muted bg-surface-muted px-2.5 py-1 rounded-full">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function FeatureRow({ f, mode, cameras, state, onToggle, onCoverage, isEvent }) {
  const Icon = f.icon;
  const on = state.on;
  const unit = featureRate(f, mode);
  const applied = state.allCams ? cameras : Math.min(state.cams || 0, cameras);
  const workload = effortLabel(f);
  const workloadColor = workload === 'Heavy' ? '#dc2626' : workload === 'Standard' ? '#d97706' : '#16a34a';
  return (
    <div className={`rounded-lg border p-3 transition-colors ${on ? 'bg-primary/[0.03]' : 'border-line'}`}
         style={on ? { borderColor: f.accent + '66' } : undefined}>
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-9 h-9 rounded-lg shrink-0"
              style={{ background: f.accent + (on ? '24' : '14'), color: f.accent }}>
          <Icon className="w-5 h-5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold text-fg">{f.name}</span>
            <span className="text-micro font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                  style={{ color: workloadColor, background: workloadColor + '1a' }}
                  title="How much work this asks of each camera — heavier work costs a little more.">
              {workload}
            </span>
          </div>
          <div className="text-caption text-fg-muted leading-snug">{f.why}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-small font-bold text-fg tabular-nums">
            {inr(isEvent ? dailyOf(unit) : unit)}
          </div>
          <div className="text-micro text-fg-muted">{isEvent ? 'per cam/day' : 'per cam/mo'}</div>
        </div>
        <Switch on={on} onClick={onToggle} />
      </div>

      {on && (
        <div className="flex items-center gap-2 mt-3 pl-12 flex-wrap">
          <span className="text-caption text-fg-muted">Put this on</span>
          <button onClick={() => onCoverage({ allCams: true })}
            className={`text-caption font-semibold px-2.5 py-1 rounded-full border transition-colors ${state.allCams ? 'border-primary bg-primary/10 text-primary' : 'border-line text-fg-muted hover:border-primary/40'}`}>
            All {cameras.toLocaleString('en-IN')} cameras
          </button>
          <button onClick={() => onCoverage({ allCams: false, cams: state.cams || Math.min(10, cameras) })}
            className={`text-caption font-semibold px-2.5 py-1 rounded-full border transition-colors ${!state.allCams ? 'border-primary bg-primary/10 text-primary' : 'border-line text-fg-muted hover:border-primary/40'}`}>
            Just some
          </button>
          {!state.allCams && (
            <span className="inline-flex items-center gap-1.5">
              <Stepper small value={Math.min(state.cams || 0, cameras)} min={0} max={cameras}
                onChange={(v) => onCoverage({ cams: v })} />
              <span className="text-caption text-fg-muted">of {cameras.toLocaleString('en-IN')}</span>
            </span>
          )}
          {on && !isEvent && (
            <span className="text-caption font-semibold text-fg ml-auto tabular-nums">
              = {inr(applied * unit)}/mo
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Switch({ on, onClick }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation?.(); onClick(); }}
      className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${on ? 'bg-primary' : 'bg-muted-foreground/30'}`}
      role="switch" aria-checked={on}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-surface shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

function Stepper({ value, onChange, min = 0, max = 100000, small }) {
  const pad = small ? 'w-7 h-7' : 'w-9 h-9';
  const inputW = small ? 'w-12' : 'w-20';
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(Math.min(max, value + 1));
  return (
    <div className="inline-flex items-center rounded-lg border border-line overflow-hidden">
      <button onClick={dec} className={`${pad} grid place-items-center hover:bg-surface-muted text-fg-muted transition-colors`}>
        <Minus className="w-3.5 h-3.5" />
      </button>
      <input type="number" value={value} min={min} max={max}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
        className={`${inputW} text-center text-body font-bold text-fg bg-transparent outline-none tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`} />
      <button onClick={inc} className={`${pad} grid place-items-center hover:bg-surface-muted text-fg-muted transition-colors`}>
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function Pill({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`text-small font-semibold px-3 py-1.5 rounded-full border transition-colors tabular-nums ${active
        ? 'border-primary bg-primary/10 text-primary'
        : 'border-line text-fg-muted hover:border-primary/40'}`}>
      {children}
    </button>
  );
}

function Label({ children }) {
  return <div className="text-caption font-semibold uppercase tracking-wider text-fg-muted">{children}</div>;
}

function Hint({ icon: Icon, children }) {
  return (
    <div className="flex items-start gap-1.5 mt-3 text-caption text-fg-muted leading-snug">
      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary/70" />
      <span>{children}</span>
    </div>
  );
}

function Row({ label, value, bold, big, good, muted }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`${big ? 'text-body' : 'text-small'} ${bold ? 'font-bold text-fg' : muted ? 'text-fg-muted' : good ? 'text-success-ink font-medium' : 'text-fg-muted'}`}>{label}</span>
      <span className={`tabular-nums ${big ? 'text-heading' : 'text-body'} ${bold ? 'font-bold text-fg' : good ? 'text-success-ink font-semibold' : 'font-medium text-fg'}`}>{value}</span>
    </div>
  );
}

function Faq({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-4 px-4 py-3.5 text-left">
        <span className="text-body font-semibold text-fg">{q}</span>
        <ChevronDown className={`w-4 h-4 text-fg-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <p className="px-4 pb-4 text-body text-fg-muted leading-relaxed">{a}</p>}
    </div>
  );
}

const FAQ = [
  { q: 'Can I pay for just a couple of days?', a: 'Yes. Pick “Just an event” at the top and choose how many days you need — perfect for a festival, exam, sports day, election or VIP visit. You switch on extra eyes for those days and pay only for them.' },
  { q: 'What if my site is busy only part of the year?', a: 'Turn on “My site is busy only part of the year” and tell us how many months. In the quiet months we pause the smart features and safely keep your footage, so you pay only a small holding fee.' },
  { q: 'Do I have to put smart features on every camera?', a: 'No — and you usually shouldn’t. For each feature you can choose “All cameras” or “Just some”, so face recognition can sit only on your gates while corridors simply record. You only pay for what each camera does.' },
  { q: 'What happens to my footage if I stop paying?', a: 'It’s always yours. You can export your footage at any time, and when you ask us to delete it, we delete it.' },
  { q: 'Can I cancel anytime?', a: 'On the monthly plan, yes — leave whenever you like. Longer plans (1–3 years) are cheaper because you commit for that time and we lock your price.' },
  { q: 'Do I need to buy new cameras?', a: 'No. Drishyam works with the cameras you already have. The only equipment cost is if you choose to own the on-site system instead of paying monthly.' },
  { q: 'What if the internet or power goes down?', a: 'If you choose “Own it”, the system lives on your site and keeps recording and watching even with no internet. Cloud needs a connection but never asks you to manage any equipment.' },
  { q: 'Who can see my data — is it private?', a: 'Your footage and any face data are encrypted, never sold, and only your team can see them. You can delete any of it on request. This matters most on a campus, so we treat it that way by default.' },
  { q: 'Does every alert cost extra?', a: 'No. Alerts are unlimited. Whatever you switch on runs as much as you need — you’ll never get a surprise bill.' },
  { q: 'Can I add more cameras later?', a: 'Anytime. Add or remove cameras whenever you like and we only charge for the days you actually use them.' },
  { q: 'Is there a setup fee?', a: 'Yes, a one-time fee to connect your cameras and train your team. If you’d prefer, you can spread it over three months.' },
  { q: 'Cloud or own it — which is cheaper?', a: 'Paying monthly (Cloud) is cheapest to start and needs no equipment. Owning it costs more upfront but works out cheaper over a few years and keeps everything on your site. The calculator shows you both so you can compare.' },
];
