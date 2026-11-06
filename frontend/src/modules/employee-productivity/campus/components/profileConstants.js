// Chart tokens moved to `@/core/ui/chart-theme` -- they are the app's chart
// theme, not a campus one. Re-exported here so existing imports keep working.
// The tone maps below are genuinely profile-page specific and stay.
export { AXIS, GRID, TIP } from '@/core/ui/chart-theme';

export const TONE_DOT = { ok: 'bg-success', info: 'bg-info', warn: 'bg-warning', alert: 'bg-danger' };
export const SEV_BAR = { high: 'bg-danger', medium: 'bg-warning', low: 'bg-line-strong' };
