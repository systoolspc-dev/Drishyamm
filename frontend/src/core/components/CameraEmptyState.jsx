import { Link } from 'react-router-dom';
import { ArrowRight, Wrench } from 'lucide-react';
import { Button } from '@/core/ui/button';
import { cn } from '@/core/lib/utils';

/**
 * "There is no camera behind this yet" — as one component, everywhere.
 *
 * The same moment was being drawn a dozen different ways: a 30px lucide glyph
 * over `No cameras are being counted yet`, a bare centred paragraph in a
 * panel, a dashed card with a 16px camera in a tile. Three sizes of type,
 * three icons, and only some of them said what to do next — so an operator who
 * met one of the silent ones had to go and find Camera Setup on their own.
 *
 * It is one illustration, one sentence of explanation and one way forward:
 * Camera Setup. `action` adds the step that is nearer than that (choose which
 * cameras count, draw the zone) in front of it, and Camera Setup then becomes
 * the outline button beside it rather than disappearing — a camera that was
 * never added is the one cause neither of those nearer steps can fix.
 *
 * `size="sm"` is the in-panel variant: the same anatomy at a smaller
 * illustration and body type, for a card that is one of several on a page.
 * `framed={false}` drops the dashed card for a slot that already has a border
 * of its own (a Panel body).
 */
export const CAMERA_SETUP_PATH = '/camera-setup';

export function CameraEmptyState({
  title = 'No cameras have been added',
  description,
  size = 'md',
  action,
  setupLabel = 'Go to Camera Setup',
  showSetup = true,
  framed = true,
  className,
  children,
}) {
  const sm = size === 'sm';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        sm ? 'py-7' : 'py-10',
        framed && 'rounded-xl border border-dashed border-line-strong bg-surface-sunken',
        className,
      )}
    >
      <CameraIllustration className={sm ? 'h-auto w-[140px]' : 'h-auto w-[180px] sm:w-[200px]'} />

      <p className={cn('text-fg', sm ? 'mt-3 text-body font-semibold' : 'mt-5 text-title')}>{title}</p>
      {description ? (
        <p className={cn('mt-1.5 max-w-[48ch] leading-relaxed text-fg-muted', sm ? 'text-small' : 'text-body')}>
          {description}
        </p>
      ) : null}

      {action || showSetup ? (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {showSetup ? (
            <Button asChild size={sm ? 'sm' : 'lg'} variant={action ? 'outline' : 'default'}>
              <Link to={CAMERA_SETUP_PATH}>
                <Wrench />
                {setupLabel}
                <ArrowRight />
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      {children}
    </div>
  );
}

/**
 * Minimal line-art camera: neutral strokes, one brand-orange accent.
 *
 * Tokenised classes rather than literal hues, so the same drawing reads
 * correctly in light and dark without a second copy. It lives here, beside the
 * empty state that is its main caller, and `RequireCameras` imports it — two
 * hand-drawn cameras that drift apart would undo the point of this file.
 */
export function CameraIllustration({ className = 'h-auto w-[180px] sm:w-[200px]' }) {
  return (
    <svg viewBox="0 0 200 140" className={className} fill="none" aria-hidden>
      {/* soft backdrop */}
      <ellipse cx="100" cy="72" rx="86" ry="60" className="fill-brand-soft" />
      {/* ground */}
      <path d="M28 124h144" className="stroke-line" strokeWidth="2" strokeLinecap="round" />

      {/* wall mount + arm */}
      <rect x="54" y="84" width="14" height="26" rx="4" className="fill-surface stroke-fg-subtle" strokeWidth="2" />
      <path d="M68 96h10a6 6 0 0 0 6-6v-6" className="stroke-fg-subtle" strokeWidth="2" strokeLinecap="round" />

      {/* camera body */}
      <g transform="rotate(14 104 62)">
        <rect x="66" y="46" width="72" height="30" rx="10" className="fill-surface stroke-fg-subtle" strokeWidth="2" />
        <rect x="132" y="50" width="16" height="22" rx="6" className="fill-surface stroke-fg-subtle" strokeWidth="2" />
        <circle cx="140" cy="61" r="5" className="fill-surface-muted stroke-fg-subtle" strokeWidth="2" />
        <path d="M78 55h28" className="stroke-line" strokeWidth="2" strokeLinecap="round" />
      </g>

      {/* signal dots */}
      <circle cx="160" cy="40" r="2.5" className="fill-brand" />
      <path d="M156 50c4-3 5-8 3-12" className="stroke-brand" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="2 3" />

      {/* add badge */}
      <circle cx="146" cy="100" r="13" className="fill-brand" />
      <path d="M146 94v12M140 100h12" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
