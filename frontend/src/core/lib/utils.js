import { clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge only recognises the stock font-size scale (xs/sm/base/lg/xl/
// 2xl…) as "font-size" — anything else under a `text-` prefix falls through to
// the text-COLOR group instead, whose validator matches any string. Our type
// scale (src/index.css `@theme`) names sizes semantically (`text-body`,
// `text-caption`, …), so without this, twMerge silently classed them as
// colors: `cn('text-fg-muted text-body', 'text-primary-foreground')` would
// drop one of `text-body`/`text-primary-foreground` depending on argument
// order alone, since both "looked like" the same color slot to it. That's
// exactly what made the avatar initials render in the wrong color — the size
// and color utilities were fighting over one slot instead of coexisting.
const TEXT_SIZE_TOKENS = [
  'display', 'title', 'section', 'heading', 'body',
  'small', 'caption', 'micro', 'nav', 'nav-lg', 'control', 'metric', 'metric-sm',
];

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: TEXT_SIZE_TOKENS,
    },
  },
});

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * Resolve a camera's saved stream-quality preference into a player quality.
 *
 * `dflt` is the VIEW's bandwidth default and applies only when the camera has
 * no explicit preference. Multi-camera views (grids, walls) must pass 'low' so
 * tiles pull the sub-stream — a main-stream tile is roughly 8x the bitrate of a
 * sub-stream one, and a wall multiplies that by the tile count. Single-camera
 * views pass 'high'.
 */
export function playerQuality(camera, dflt) {
  switch (camera?.streamQuality) {
    case 'sub':  return 'low';
    case 'main': return 'high';
    case 'auto': return 'auto';
    default:     return dflt;   // unset → inherit the view's bandwidth default
  }
}
