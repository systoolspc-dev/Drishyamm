import { cn } from '@/core/lib/utils';
import { ErrorState } from '@/core/ui/states';

/**
 * Empty and error cards for the Camera Setup tabs (Sites, Devices, Cameras,
 * AI Detection). One component so the four tabs cannot drift apart.
 *
 * The empty card is only for a request that SUCCEEDED with nothing in it —
 * a failed request gets SetupErrorState. Showing "No devices" after a
 * failure would tell the operator they have none when we could not ask.
 *
 * The "What's next?" row is a preview of where the action leads, not a
 * wizard: nothing in it is clickable and the tabs stay free to use.
 */
export function SetupEmptyState({ illustration = 'site', title, description, action, secondary, steps }) {
  const Art = ILLUSTRATIONS[illustration] || SiteArt;
  return (
    <section className="rounded-xl border border-line bg-surface shadow-sm" aria-label={title}>
      <div className="flex flex-col items-center px-6 pb-10 pt-12 text-center">
        <Art />
        <h2 className="mt-5 text-heading text-fg">{title}</h2>
        {description ? (
          <p className="mt-1.5 max-w-[48ch] text-small text-fg-muted">{description}</p>
        ) : null}
        {action || secondary ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {action}
            {secondary}
          </div>
        ) : null}
      </div>

      {steps?.length ? (
        <div className="border-t border-line-subtle px-6 py-6 sm:px-10">
          <h3 className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">What's next?</h3>
          <ol className="mt-4 grid gap-5 sm:grid-cols-3 sm:gap-4">
            {steps.map((step, i) => (
              <li key={step.title} className="min-w-0">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'grid h-7 w-7 shrink-0 place-items-center rounded-full border text-caption font-semibold tabular-nums',
                      i === 0
                        ? 'border-brand-line bg-brand-soft text-brand-ink'
                        : 'border-line bg-surface text-fg-muted',
                    )}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {i < steps.length - 1 ? (
                    <span className="hidden h-px flex-1 bg-line sm:block" aria-hidden />
                  ) : null}
                </div>
                <p className="mt-2.5 text-body font-semibold text-fg">{step.title}</p>
                <p className="mt-0.5 text-small text-fg-muted">{step.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

/** The shared ErrorState, framed in the same card as the empty state. */
export function SetupErrorState(props) {
  return (
    <section className="rounded-xl border border-line bg-surface shadow-sm">
      <ErrorState className="py-16" {...props} />
    </section>
  );
}

/* ─────────────────────────── illustrations ───────────────────────────
   Neutral line work on theme tokens so they follow light/dark; brand
   orange is kept to one small accent per drawing. */

const STROKE = { stroke: 'var(--line-strong)', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' };

function Frame({ children }) {
  return (
    <svg width="160" height="112" viewBox="0 0 160 112" fill="none" aria-hidden>
      <circle cx="80" cy="60" r="48" fill="var(--surface-sunken)" />
      <line x1="28" y1="92" x2="132" y2="92" {...STROKE} />
      {children}
    </svg>
  );
}

/** Building with a wall-mounted camera. */
function SiteArt() {
  return (
    <Frame>
      <rect x="52" y="38" width="44" height="54" rx="3" fill="var(--surface)" {...STROKE} />
      <rect x="48" y="33" width="52" height="7" rx="2" fill="var(--surface)" {...STROKE} />
      {[48, 60, 72].map((y) => (
        <g key={y} fill="var(--line)">
          <rect x="59" y={y} width="9" height="6" rx="1" />
          <rect x="80" y={y} width="9" height="6" rx="1" />
        </g>
      ))}
      <rect x="69" y="79" width="10" height="13" rx="1" fill="var(--line)" />
      <path d="M96 48h6v-4" {...STROKE} />
      <g transform="rotate(22 102 42)">
        <polygon points="124,42 150,30 150,54" fill="var(--brand)" opacity="0.1" />
        <rect x="102" y="37" width="20" height="10" rx="2.5" fill="var(--surface)" stroke="var(--brand)" strokeWidth="1.5" />
        <circle cx="122" cy="42" r="2.5" fill="var(--brand)" />
      </g>
    </Frame>
  );
}

/** Recorder (NVR) with two cameras cabled into it. */
function DeviceArt() {
  return (
    <Frame>
      {/* cables */}
      <path d="M58 40v10q0 6 6 6h4v6" {...STROKE} strokeDasharray="3 3" />
      <path d="M102 40v10q0 6-6 6h-4v6" {...STROKE} strokeDasharray="3 3" />
      {/* cameras */}
      {[50, 94].map((x) => (
        <g key={x}>
          <rect x={x} y="28" width="16" height="10" rx="2.5" fill="var(--surface)" {...STROKE} />
          <circle cx={x + 12} cy="33" r="2" fill="var(--line)" />
        </g>
      ))}
      {/* recorder */}
      <rect x="40" y="62" width="80" height="24" rx="3" fill="var(--surface)" {...STROKE} />
      <circle cx="50" cy="74" r="2.5" fill="var(--brand)" />
      <circle cx="58" cy="74" r="2" fill="var(--line)" />
      <circle cx="65" cy="74" r="2" fill="var(--line)" />
      {[92, 98, 104, 110].map((x) => (
        <line key={x} x1={x} y1="68" x2={x} y2="80" stroke="var(--line)" strokeWidth="1.5" strokeLinecap="round" />
      ))}
      <rect x="46" y="86" width="8" height="4" rx="1" fill="var(--line)" />
      <rect x="106" y="86" width="8" height="4" rx="1" fill="var(--line)" />
    </Frame>
  );
}

/** Bullet camera on a wall bracket. */
function CameraArt() {
  return (
    <Frame>
      <rect x="34" y="36" width="7" height="30" rx="2" fill="var(--surface)" {...STROKE} />
      <path d="M41 51h10v-4" {...STROKE} />
      <g transform="rotate(14 51 44)">
        <polygon points="104,46 136,32 136,60" fill="var(--brand)" opacity="0.1" />
        <rect x="48" y="30" width="54" height="8" rx="3" fill="var(--surface)" {...STROKE} />
        <rect x="51" y="36" width="50" height="20" rx="5" fill="var(--surface)" {...STROKE} />
        <circle cx="100" cy="46" r="6" fill="var(--surface)" stroke="var(--brand)" strokeWidth="1.5" />
        <circle cx="100" cy="46" r="2.5" fill="var(--brand)" />
        <circle cx="60" cy="46" r="1.8" fill="var(--line)" />
      </g>
    </Frame>
  );
}

/** Camera viewport with a detection box around a face. */
function AiArt() {
  return (
    <Frame>
      <rect x="42" y="24" width="76" height="60" rx="6" fill="var(--surface)" {...STROKE} />
      <circle cx="80" cy="49" r="9" fill="var(--line)" />
      <path d="M64 76c2-9 8-13 16-13s14 4 16 13" fill="var(--line)" />
      <path
        d="M66 42v-6h6M88 36h6v6M94 62v6h-6M72 68h-6v-6"
        stroke="var(--brand)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="50" cy="32" r="2" fill="var(--brand)" />
    </Frame>
  );
}

const ILLUSTRATIONS = { site: SiteArt, device: DeviceArt, camera: CameraArt, ai: AiArt };
