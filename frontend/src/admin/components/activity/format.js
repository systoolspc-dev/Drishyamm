/**
 * Live platform activity — what each event type looks like and where it links.
 * Categories match the backend catalog (services/platformEvents/catalog.js).
 */

export const CATEGORIES = [
  { id: 'signups', label: 'Signups' },
  { id: 'changes', label: 'Changes' },
  { id: 'cameras', label: 'Cameras' },
  { id: 'logins', label: 'Logins' },
  { id: 'system', label: 'System' },
]

// Sign-ins are frequent and rarely need anyone: off by default, never in the
// bell, never a toast.
export const DEFAULT_CATEGORIES = ['signups', 'changes', 'cameras', 'system']

const ICON = {
  'account.created': 'person_add',
  'account.login': 'login',
  'account.login_failed': 'lock',
  'account.suspended': 'block',
  'account.reactivated': 'lock_open',
  'account.plan_changed': 'swap_horiz',
  'account.licences_changed': 'tune',
  'account.features_changed': 'toggle_on',
  'member.added': 'group_add',
  'member.removed': 'person_remove',
  'password.reset_requested': 'key',
  'payment.completed': 'payments',
  'subscription.cancelled': 'cancel',
  'camera.added': 'videocam',
  'camera.removed': 'videocam_off',
  'camera.offline': 'videocam_off',
  'camera.recovered': 'videocam',
  'nvr.down': 'dns',
  'nvr.recovered': 'dns',
  'service.down': 'error',
  'service.up': 'check_circle',
}

export const iconFor = (type) => ICON[type] || 'bolt'

// Account hub tab each event opens on.
const TAB = {
  'account.login': 'activity',
  'account.login_failed': 'activity',
  'account.plan_changed': 'licences',
  'account.licences_changed': 'licences',
  'account.features_changed': 'licences',
  'member.added': 'users',
  'member.removed': 'users',
  'password.reset_requested': 'users',
  'payment.completed': 'billing',
  'subscription.cancelled': 'billing',
  'camera.added': 'cameras',
  'camera.removed': 'cameras',
  'camera.offline': 'cameras',
  'camera.recovered': 'cameras',
  'nvr.down': 'cameras',
  'nvr.recovered': 'cameras',
}

export function eventLink(e) {
  if (e.category === 'system') return '/admin/live'
  if (!e.accountId) return '/admin/activity'
  const tab = TAB[e.type]
  return `/admin/customers/${e.accountId}${tab ? `?tab=${tab}` : ''}`
}

/** "who" for the meta line: the account, plus the person when it was not the owner. */
export function whoLine(e) {
  const acct = e.account?.name || null
  const actor = e.actor || {}
  if (actor.kind === 'operator') return acct ? `${acct} · by ${actor.label}` : `by ${actor.label}`
  if (actor.kind === 'member') return acct ? `${acct} · ${actor.label}` : actor.label
  if (actor.kind === 'visitor') return acct || 'Unknown visitor'
  if (actor.kind === 'system') return acct || 'System'
  return acct || actor.label || '—'
}

export const severityTone = (s) => (s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'neutral')

// Toast only what an operator would act on now.
export const TOAST_TYPES = new Set(['account.created', 'account.suspended', 'nvr.down'])
export const TOAST_TITLE = {
  'account.created': 'New account',
  'account.suspended': 'Account suspended',
  'nvr.down': 'NVR down',
}

/** Bell = everything except sign-ins. */
export const inBell = (e) => e.category !== 'logins'

export function readCategories(key, fallback = DEFAULT_CATEGORIES) {
  try {
    const v = JSON.parse(localStorage.getItem(key))
    if (Array.isArray(v)) return v.filter((c) => CATEGORIES.some((x) => x.id === c))
  } catch { /* storage blocked or bad value */ }
  return fallback
}

export function saveCategories(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)) } catch { /* storage blocked */ }
}
