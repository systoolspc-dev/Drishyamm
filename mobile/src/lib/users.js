// Users & roles — derivation shared by the list and the detail screen so the
// two can never disagree about what a role looks like or what "active" means.
//
// GROUND TRUTH (read from the backend source, not assumed):
//   · ROLES is a two-value enum — 'admin' and 'user'. There is no operator or
//     viewer role, so no badge invents one.
//   · A user's ACCOUNT STATUS is `isActive` → 'active' | 'suspended'. The API
//     carries no online/offline presence at all, so nothing here reports one:
//     account status and presence are different questions and conflating them
//     on a security console is how someone reads "Active" as "signed in now".
//   · There is no permissions endpoint. Role is the whole access model the
//     mobile client can see.

// tint values are palette KEYS, so both themes resolve their own ink/soft pair.
const ROLE_STYLE = {
  admin: { label: 'Admin', tint: 'primary', icon: 'shield-checkmark-outline' },
  user:  { label: 'User',  tint: 'info',    icon: 'person-outline' },
};
const ROLE_FALLBACK = { label: 'Member', tint: 'off', icon: 'person-outline' };

/** Style for a role. Unknown roles get a neutral badge rather than a guess —
 *  if the backend ever grows a third role it shows up honestly instead of
 *  being mislabelled as one of the two we know. */
export function roleStyle(role) {
  const key = String(role || '').toLowerCase();
  return ROLE_STYLE[key] || { ...ROLE_FALLBACK, label: role ? titleCase(role) : ROLE_FALLBACK.label };
}

export const STATUS_STYLE = {
  active:    { label: 'Active',    tint: 'ok' },
  suspended: { label: 'Suspended', tint: 'critical' },
};

/** Account status only. Prefers the server's own `status` string and falls
 *  back to `isActive`, which is what that string is computed from. */
export function statusStyle(user) {
  const raw = String(user?.status || '').toLowerCase();
  if (STATUS_STYLE[raw]) return STATUS_STYLE[raw];
  return user?.isActive === false ? STATUS_STYLE.suspended : STATUS_STYLE.active;
}

const titleCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase();

/** Summary counts for the four cards. Roles is the number of DISTINCT roles
 *  actually present in the data, not the size of the enum — it answers "how
 *  many kinds of access are in use here". */
export function userTotals(users = []) {
  const roles = new Set();
  let active = 0;
  for (const u of users) {
    if (u.role) roles.add(String(u.role).toLowerCase());
    if (u.isActive !== false) active += 1;
  }
  return { total: users.length, active, roles: roles.size, inactive: users.length - active };
}

/** Distinct roles with their member counts — the "Roles" tab. Derived, because
 *  the backend has no roles endpoint to list them from. */
export function roleBuckets(users = []) {
  const by = new Map();
  for (const u of users) {
    const key = String(u.role || '').toLowerCase() || 'unknown';
    if (!by.has(key)) by.set(key, { key, ...roleStyle(u.role), members: 0, active: 0 });
    const b = by.get(key);
    b.members += 1;
    if (u.isActive !== false) b.active += 1;
  }
  return [...by.values()].sort((a, b) => b.members - a.members);
}

/** Client-side search across the fields a user actually has. The admin users
 *  endpoint takes no query parameter and returns the full list in one call, so
 *  filtering here is both correct and cheaper than a request per keystroke. */
export function matchesUser(user, needle) {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return [user?.name, user?.email, user?.role, roleStyle(user?.role).label]
    .some((v) => String(v || '').toLowerCase().includes(n));
}

/**
 * A user's SITES, derived from the cameras GET /admin/users/:id returns — each
 * camera carries `group: { id, name }`, and a group IS a site everywhere else
 * in this app. There is no user→site assignment endpoint; this is the real
 * relationship the data already expresses, not an invented one.
 */
export function sitesForCameras(cameras = []) {
  const by = new Map();
  for (const c of cameras) {
    if (!c?.group?.id) continue;
    if (!by.has(c.group.id)) by.set(c.group.id, { id: c.group.id, name: c.group.name, total: 0, online: 0 });
    const s = by.get(c.group.id);
    s.total += 1;
    if (c.status === 'online') s.online += 1;
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

export const formatJoined = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};
