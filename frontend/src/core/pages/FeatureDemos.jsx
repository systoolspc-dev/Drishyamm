import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Flame,
  Footprints,
  Maximize2,
  PlayCircle,
  ShieldAlert,
  Target,
  UsersRound,
  Wrench,
  X,
} from 'lucide-react';

// Demo videos live under smart-cam-app/public/demos/<file>.mp4
// Vite serves the `public/` directory as static assets at /<file>, so the
// browser can fetch them directly without any backend route.
//
// Each demo carries two distinct kinds of copy on purpose:
//   summary       → "what is this feature" (the plain-language description)
//   outcomes      → "what you achieve from it" (the value / why it matters)
//   capabilities  → "how it works" (the concrete technical behaviour)
// The card surfaces summary + outcomes; the modal shows everything.
const DEMOS = [
  {
    id: 'human-detection',
    title: 'People Detection & Counting',
    src: '/demos/human-detection.mp4',
    category: 'Crowd & Safety',
    badge: 'Live people count',
    sizeLabel: '272 MB',
    metric: { value: 'Real-time', label: 'live people count' },
    summary:
      'Detects every person in view and keeps a live, running headcount — drawing a box around each individual as they move through the scene.',
    outcomes: [
      'Enforce occupancy limits before a space gets unsafe',
      'Spot crowd build-up and queues the moment they form',
      'Headcount evidence for any moment, on demand',
    ],
    capabilities: [
      'Outlines each person on screen',
      'Live count shown right on the feed',
      'Works on your existing cameras, even in low light',
    ],
    Icon: UsersRound,
    accent: 'sky',
  },
  {
    id: 'footfall',
    title: 'Footfall Counter',
    src: '/demos/footfall.mp4',
    category: 'Retail & Operations',
    badge: 'Entry / exit counting',
    sizeLabel: '125 MB',
    metric: { value: 'In / Out', label: 'entries and exits' },
    summary:
      'A directional line-crossing counter for entries and exits — placed on gates, store entrances, and corridors to measure real foot traffic.',
    outcomes: [
      'Know your true visitor traffic, not a rough guess',
      'Staff and stock to your actual peak hours',
      'Compare entrances, floors, and zones side by side',
    ],
    capabilities: [
      'Counts people in and out separately',
      'Counting line set per entrance',
      'Rolls up to hourly and daily totals',
    ],
    Icon: Footprints,
    accent: 'emerald',
  },
  {
    id: 'fire-detection',
    title: 'Fire Detection',
    src: '/demos/fire-detection.mp4',
    category: 'Critical Safety',
    badge: 'Early fire alert',
    sizeLabel: '69 MB',
    metric: { value: 'Seconds', label: 'earlier than smoke alarms' },
    summary:
      'Watches for open flame and rapid smoke patterns straight from the camera feed — often catching a fire well before a ceiling smoke alarm reacts.',
    outcomes: [
      'Earliest possible warning — react in seconds, not minutes',
      'Covers open and outdoor areas alarms can’t reach',
      'A snapshot goes to responders the instant it triggers',
    ],
    capabilities: [
      'Detects flame and heavy smoke',
      'Raises a critical alert instantly',
      'Escalates to your alert channel',
    ],
    Icon: Flame,
    accent: 'rose',
  },
  {
    id: 'weapon-detection',
    title: 'Weapon Detection',
    src: '/demos/weapon-detection.mp4',
    category: 'Critical Safety',
    badge: 'Weapon alert',
    sizeLabel: '8 MB',
    metric: { value: 'Gun & knife', label: 'threats detected' },
    summary:
      'Spots visible firearms and bladed weapons in a frame and raises a critical alert with a snapshot, so an operator can act before a situation escalates.',
    outcomes: [
      'Early warning the moment a weapon appears on camera',
      'Snapshot evidence attached to every alert',
      'One-tap acknowledge keeps the response loop tight',
    ],
    capabilities: [
      'Spots guns and knives in view',
      'Critical alert with a snapshot',
      'One-tap acknowledge for the operator',
    ],
    Icon: ShieldAlert,
    accent: 'amber',
  },
];

const CATEGORIES = ['All', ...Array.from(new Set(DEMOS.map((demo) => demo.category)))];

// Per-accent palette. `iconBg` is a gradient for the icon chip, `glow` tints
// the card's video frame, the rest are flat tints for chips / dots / text.
const ACCENTS = {
  sky: {
    iconBg: 'bg-gradient-to-br from-info to-info',
    chip: 'bg-info-soft text-info-ink ring-1 ring-inset ring-info-line',
    dot: 'bg-info',
    text: 'text-info-ink',
    ring: 'hover:border-info-line',
    glow: 'from-info/25',
  },
  emerald: {
    iconBg: 'bg-gradient-to-br from-success to-success',
    chip: 'bg-success-soft text-success-ink ring-1 ring-inset ring-success-line',
    dot: 'bg-success',
    text: 'text-success-ink',
    ring: 'hover:border-success-line',
    glow: 'from-success/25',
  },
  rose: {
    iconBg: 'bg-gradient-to-br from-danger to-danger',
    chip: 'bg-danger-soft text-danger-ink ring-1 ring-inset ring-danger-line',
    dot: 'bg-danger',
    text: 'text-danger-ink',
    ring: 'hover:border-danger-line',
    glow: 'from-danger/25',
  },
  amber: {
    iconBg: 'bg-gradient-to-br from-warning to-warning',
    chip: 'bg-warning-soft text-warning-ink ring-1 ring-inset ring-warning-line',
    dot: 'bg-warning',
    text: 'text-warning-ink',
    ring: 'hover:border-warning-line',
    glow: 'from-warning/25',
  },
};

export default function FeatureDemos() {
  const [category, setCategory] = useState('All');
  const [active, setActive] = useState(null);

  const filtered = useMemo(
    () => (category === 'All' ? DEMOS : DEMOS.filter((demo) => demo.category === category)),
    [category],
  );

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] w-full bg-surface-sunken">
      <div className="space-y-4 page-inset">
        {/* ── Header ────────────────────────────────────────────── */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-title text-fg">Feature Demos</h1>
            <p className="mt-0.5 text-body text-fg-muted">
              Sample clips of each AI detector — what it does and what you get from it.
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-small font-semibold text-fg-secondary">
            <PlayCircle className="h-3.5 w-3.5 text-brand" />
            {DEMOS.length} demos · {totalSizeLabel(DEMOS)}
          </span>
        </header>

        {/* ── Category filter ──────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          {CATEGORIES.map((label) => {
            const on = label === category;
            return (
              <button
                className={`rounded-full border px-3.5 py-1.5 text-small font-semibold transition ${
                  on
                    ? 'border-brand-line bg-brand-soft text-brand-ink shadow-sm'
                    : 'border-line bg-surface text-fg-secondary hover:border-line-strong hover:bg-surface-sunken'
                }`}
                key={label}
                onClick={() => setCategory(label)}
                type="button"
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* ── Demo grid (full-width, fills the page) ───────────── */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((demo) => (
            <DemoCard demo={demo} key={demo.id} onOpen={() => setActive(demo)} />
          ))}
        </section>

        {filtered.length === 0 && (
          <div className="grid place-items-center rounded-2xl border border-dashed border-line bg-surface p-10 text-center text-body text-fg-muted">
            No demos in this category yet.
          </div>
        )}
      </div>

      {active && <DemoPlayerModal demo={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function DemoCard({ demo, onOpen }) {
  const videoRef = useRef(null);
  const accent = ACCENTS[demo.accent] || ACCENTS.sky;
  const { Icon } = demo;

  const playPreview = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.play().catch(() => {});
  };

  const pausePreview = () => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  };

  return (
    <article
      className={`group flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg ${accent.ring}`}
    >
      <button
        className="relative aspect-video w-full overflow-hidden bg-slate-950"
        onClick={onOpen}
        onMouseEnter={playPreview}
        onMouseLeave={pausePreview}
        title="Click to play full-screen"
        type="button"
      >
        {/* accent glow behind the frame */}
        <span
          className={`pointer-events-none absolute inset-0 bg-gradient-to-tr ${accent.glow} to-transparent opacity-0 transition group-hover:opacity-100`}
        />
        <video
          className="h-full w-full object-cover opacity-90 transition group-hover:scale-[1.03] group-hover:opacity-100"
          muted
          playsInline
          preload="metadata"
          ref={videoRef}
          src={demo.src}
        />
        <span className="absolute inset-0 grid place-items-center bg-gradient-to-t from-black/55 via-black/10 to-transparent">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-white/15 backdrop-blur-sm transition group-hover:scale-105 group-hover:bg-white/25">
            <PlayCircle className="h-9 w-9 text-white drop-shadow-[0_4px_14px_rgba(0,0,0,0.45)]" strokeWidth={1.5} />
          </span>
        </span>
        <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-micro font-semibold uppercase tracking-wide text-white backdrop-blur">
          <span className={`h-1.5 w-1.5 rounded-full ${accent.dot}`} />
          {demo.category}
        </span>
        <span className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-micro font-semibold text-slate-600 shadow-sm">
          <Maximize2 className="h-3 w-3" />
          {demo.sizeLabel}
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-3.5 p-5">
        <div className="flex items-start gap-3">
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white shadow-sm ${accent.iconBg}`}>
            <Icon className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h2 className="text-heading font-bold leading-tight text-fg">{demo.title}</h2>
            <span className={`mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-micro font-semibold ${accent.chip}`}>
              {demo.badge}
            </span>
          </div>
        </div>

        <p className="text-body leading-6 text-fg-secondary">{demo.summary}</p>

        {/* What you achieve — the value, not the mechanics */}
        <div className="rounded-xl bg-surface-sunken p-3.5">
          <div className="mb-2 flex items-center gap-1.5 text-caption font-bold uppercase tracking-wide text-fg-muted">
            <Target className={`h-3.5 w-3.5 ${accent.text}`} />
            What you achieve
          </div>
          <ul className="space-y-1.5 text-body leading-5 text-fg-secondary">
            {demo.outcomes.map((outcome) => (
              <li className="flex items-start gap-2" key={outcome}>
                <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${accent.text}`} />
                <span>{outcome}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto flex items-center justify-between gap-3 pt-1">
          <div className="min-w-0">
            <div className={`text-body font-bold ${accent.text}`}>{demo.metric.value}</div>
            <div className="truncate text-caption font-medium text-fg-subtle">{demo.metric.label}</div>
          </div>
          <button
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-950 px-3.5 py-2 text-body font-semibold text-white transition hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700"
            onClick={onOpen}
            type="button"
          >
            <PlayCircle className="h-4 w-4" />
            Watch demo
          </button>
        </div>
      </div>
    </article>
  );
}

function DemoPlayerModal({ demo, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const { Icon } = demo;
  const accent = ACCENTS[demo.accent] || ACCENTS.sky;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm" onClick={onClose} role="dialog">
      <div
        className="relative flex max-h-[calc(var(--app-vh)*0.94)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white ${accent.iconBg}`}>
              <Icon className="h-5 w-5" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-heading font-bold text-fg">{demo.title}</h2>
              <p className="truncate text-small text-fg-muted">{demo.category} · {demo.badge}</p>
            </div>
          </div>
          <button
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-muted text-fg-secondary transition hover:bg-line"
            onClick={onClose}
            title="Close (Esc)"
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="bg-black">
            <video
              autoPlay
              className="mx-auto max-h-[calc(var(--app-vh)*0.58)] w-full bg-black object-contain"
              controls
              playsInline
              preload="auto"
              src={demo.src}
            />
          </div>

          <div className="grid gap-5 px-6 py-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <p className="text-body leading-6 text-fg-secondary">{demo.summary}</p>
              <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2">
                <span className={`text-body font-bold ${accent.text}`}>{demo.metric.value}</span>
                <span className="text-small font-medium text-fg-muted">{demo.metric.label}</span>
              </div>
            </div>

            <Section title="How it works" icon={Wrench} accent={accent}>
              {demo.capabilities.map((item) => (
                <li className="flex items-start gap-2" key={item}>
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${accent.dot}`} />
                  <span>{item}</span>
                </li>
              ))}
            </Section>

            <Section title="What you achieve" icon={Target} accent={accent}>
              {demo.outcomes.map((item) => (
                <li className="flex items-start gap-2" key={item}>
                  <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${accent.text}`} />
                  <span>{item}</span>
                </li>
              ))}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon: SectionIcon, accent, children }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-2.5 flex items-center gap-1.5 text-caption font-bold uppercase tracking-wide text-fg-muted">
        <SectionIcon className={`h-3.5 w-3.5 ${accent.text}`} />
        {title}
      </div>
      <ul className="space-y-1.5 text-body leading-5 text-fg-secondary">{children}</ul>
    </div>
  );
}

function totalSizeLabel(items) {
  const totalMb = items.reduce((sum, item) => sum + parseFloat(item.sizeLabel), 0);
  if (totalMb < 1024) return `${Math.round(totalMb)} MB`;
  return `${(totalMb / 1024).toFixed(1)} GB`;
}
