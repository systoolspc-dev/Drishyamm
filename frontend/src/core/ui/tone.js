/**
 * Semantic tones — the vocabulary every coloured surface in Drishyam draws on.
 *
 * A tone is a MEANING, not a colour. Components ask for `success` and get
 * whatever green the design system currently says; nothing in the application
 * names a hue directly. The tokens themselves live in src/index.css.
 *
 * Before this file the same state was drawn six different ways — "Online" was
 * `bg-green-100 text-green-700` in Cameras, `text-emerald-500` in Live View and
 * `text-green-600` on the Map. Colour is load-bearing in a security product;
 * an operator has to be able to read state from across a room, and that only
 * works if a colour means exactly one thing everywhere.
 *
 *   brand    Primary action, active navigation, selection, focus. NOT a state.
 *   success  Healthy · online · live · operational · resolved
 *   warning  Degraded · caution · needs attention · pending
 *   danger   Critical · alert · offline device · destructive action
 *   info     Informational · camera & system facts · secondary action
 *   ai       AI / analytics categories. Used sparingly, on purpose.
 *   neutral  Inactive · unknown · disabled · not applicable
 */

/** Every tone, in the four roles a tone can play. */
export const TONES = {
  brand: {
    solid: 'bg-brand text-white',
    soft: 'bg-brand-soft text-brand-ink border-brand-line',
    text: 'text-brand-ink',
    icon: 'text-brand',
    dot: 'bg-brand',
    ring: 'ring-brand-line',
  },
  success: {
    solid: 'bg-success text-white',
    soft: 'bg-success-soft text-success-ink border-success-line',
    text: 'text-success-ink',
    icon: 'text-success',
    dot: 'bg-success',
    ring: 'ring-success-line',
  },
  warning: {
    solid: 'bg-warning text-white',
    soft: 'bg-warning-soft text-warning-ink border-warning-line',
    text: 'text-warning-ink',
    icon: 'text-warning',
    dot: 'bg-warning',
    ring: 'ring-warning-line',
  },
  danger: {
    solid: 'bg-danger text-white',
    soft: 'bg-danger-soft text-danger-ink border-danger-line',
    text: 'text-danger-ink',
    icon: 'text-danger',
    dot: 'bg-danger',
    ring: 'ring-danger-line',
  },
  info: {
    solid: 'bg-info text-white',
    soft: 'bg-info-soft text-info-ink border-info-line',
    text: 'text-info-ink',
    icon: 'text-info',
    dot: 'bg-info',
    ring: 'ring-info-line',
  },
  ai: {
    solid: 'bg-ai text-white',
    soft: 'bg-ai-soft text-ai-ink border-ai-line',
    text: 'text-ai-ink',
    icon: 'text-ai',
    dot: 'bg-ai',
    ring: 'ring-ai-line',
  },
  neutral: {
    solid: 'bg-neutral text-white',
    soft: 'bg-neutral-soft text-neutral-ink border-neutral-line',
    text: 'text-neutral-ink',
    icon: 'text-fg-subtle',
    dot: 'bg-neutral',
    ring: 'ring-neutral-line',
  },
};

/** CSS custom properties, for the few places that need a raw colour value —
 *  canvas painting, Leaflet markers, Recharts series, inline SVG fills. */
export const TONE_VAR = {
  brand: 'var(--brand)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  info: 'var(--info)',
  ai: 'var(--ai)',
  neutral: 'var(--neutral)',
};

/**
 * Device / system state vocabulary. Every spelling the codebase uses for a
 * state maps to exactly one tone, so "Live" on the dashboard and "Live" in
 * Live View can no longer drift apart.
 *
 * `offline` is danger rather than neutral on purpose: in a VMS a camera that
 * stopped streaming is an operational problem, which is the entire premise of
 * the Health page. Where "offline" instead means "not on shift" (the staff
 * roster modules) the module's own map assigns it `neutral` — same tokens,
 * different meaning, deliberately.
 */
export const STATUS_TONE = {
  // Healthy
  live: 'success',
  online: 'success',
  healthy: 'success',
  active: 'success',
  ok: 'success',
  up: 'success',
  connected: 'success',
  streaming: 'success',
  operational: 'success',
  running: 'success',
  enabled: 'success',
  resolved: 'success',
  success: 'success',
  good: 'success',
  normal: 'success',

  // Caution
  degraded: 'warning',
  warning: 'warning',
  warn: 'warning',
  caution: 'warning',
  pending: 'warning',
  connecting: 'warning',
  reconnecting: 'warning',
  stale: 'warning',
  partial: 'warning',
  attention: 'warning',

  // Alert
  offline: 'danger',
  critical: 'danger',
  error: 'danger',
  failed: 'danger',
  down: 'danger',
  alert: 'danger',
  danger: 'danger',
  breach: 'danger',
  disconnected: 'danger',

  // Neutral
  unknown: 'neutral',
  idle: 'neutral',
  inactive: 'neutral',
  disabled: 'neutral',
  paused: 'neutral',
  standby: 'neutral',
  archived: 'neutral',
  na: 'neutral',
};

/** Human label for a state key, when the caller has not supplied one. */
export const STATUS_LABEL = {
  live: 'Live',
  online: 'Online',
  offline: 'Offline',
  healthy: 'Healthy',
  degraded: 'Degraded',
  critical: 'Critical',
  unknown: 'Unknown',
  warning: 'Warning',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  na: 'N/A',
};

/** Resolve any state spelling to its tone. Unrecognised states read neutral. */
export function toneForStatus(status) {
  return STATUS_TONE[String(status || '').toLowerCase().trim()] || 'neutral';
}

/**
 * Tone class strings for a given role.
 *
 *   toneClass('success')          → soft badge classes
 *   toneClass('danger', 'icon')   → icon colour
 *   toneClass('brand', 'solid')   → filled button/dot
 */
export function toneClass(tone, role = 'soft') {
  return (TONES[tone] || TONES.neutral)[role] || '';
}

/**
 * The warm brand sheen — the left-to-right `brand → brand-active` wash a
 * control carries under the pointer, and holds while its menu is open.
 *
 * It started life inline in SelectTrigger, which is why every Select in the
 * app already lights up this way. Everything that sits BESIDE a Select in a
 * filter row — a dropdown built on Button, a popover trigger, a toggle — has
 * to match it or the row reads as two different controls, so the string lives
 * here rather than being retyped per page.
 *
 * Tokens, never hues: `brand` is Drishyam's orange and `brand-active` its
 * deeper press tone, so the wash follows the theme into dark mode. A literal
 * `from-orange-50 to-amber-100` would pin it to one palette in one theme —
 * the drift this file exists to prevent.
 *
 *   BRAND_SHEEN      triggers and buttons — tints the border too
 *   BRAND_SHEEN_ROW  rows inside an open menu — no border to tint
 */
export const BRAND_SHEEN = [
  'transition-all duration-200',
  'hover:border-brand/40 hover:bg-linear-to-r hover:from-brand/15 hover:to-brand-active/5',
  'data-[state=open]:border-brand/50 data-[state=open]:bg-linear-to-r',
  'data-[state=open]:from-brand/20 data-[state=open]:to-brand-active/10',
].join(' ');

export const BRAND_SHEEN_ROW = [
  'transition-all duration-200',
  'hover:bg-linear-to-r hover:from-brand/15 hover:to-brand-active/5 hover:text-brand-ink',
].join(' ');
