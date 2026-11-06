/**
 * Platform event types, their feed category, and the plain-English helpers the
 * hooks use to write summaries. Shared by the service, the API filter and the
 * unit tests, so a type can never be in the feed but missing from a filter.
 */

const CATEGORIES = Object.freeze({
  signups: ['account.created'],
  changes: [
    'account.suspended', 'account.reactivated',
    'account.plan_changed', 'account.licences_changed', 'account.features_changed',
    'member.added', 'member.removed', 'password.reset_requested',
    'payment.completed', 'subscription.cancelled',
  ],
  cameras: ['camera.added', 'camera.removed', 'camera.offline', 'camera.recovered', 'nvr.down', 'nvr.recovered'],
  logins: ['account.login', 'account.login_failed'],
  system: ['service.down', 'service.up'],
});

const TYPE_CATEGORY = Object.freeze(Object.fromEntries(
  Object.entries(CATEGORIES).flatMap(([cat, types]) => types.map((t) => [t, cat])),
));

const ALL_TYPES = Object.freeze(Object.keys(TYPE_CATEGORY));

const PLAN_LABEL = { 'Basic VMS': 'Basic VMS', 'AI+VMS': 'AI + VMS' };
const planLabel = (name) => PLAN_LABEL[name] || name || 'no plan';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Lobby", "Lobby and Gate", "Lobby, Gate and 3 more" */
function nameList(names, max = 2) {
  const list = names.filter(Boolean);
  if (!list.length) return '';
  if (list.length <= max) return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

/** Host part of an Origin / Referer header ("https://app.drishyam.ai/x" → "app.drishyam.ai"). */
function hostOf(value) {
  if (!value) return null;
  try { return new URL(String(value)).host || null; } catch { return String(value).slice(0, 120); }
}

module.exports = { CATEGORIES, TYPE_CATEGORY, ALL_TYPES, planLabel, plural, nameList, hostOf };
