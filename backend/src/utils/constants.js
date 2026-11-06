// Role-based access control. Four fixed tiers, most→least privileged.
// `user` is kept only as a legacy alias for pre-RBAC accounts (treated as admin
// of their own account) so existing rows don't break.
const ROLES = Object.freeze({
  ADMIN: 'admin',       // account owner: everything incl. user management + settings
  MANAGER: 'manager',   // manage cameras/groups + AI, no user mgmt/billing
  OPERATOR: 'operator', // live + playback + acknowledge alerts, no config
  VIEWER: 'viewer',     // read-only live + playback
  USER: 'user',         // legacy — behaves as admin of its own resources
});

// Capabilities a role grants. UI + route guards check these, not the raw role,
// so adding a capability to a tier never means hunting for role strings.
const CAPABILITIES = Object.freeze({
  VIEW_LIVE:       'view_live',
  VIEW_PLAYBACK:   'view_playback',
  ACK_ALERTS:      'ack_alerts',
  MANAGE_CAMERAS:  'manage_cameras',
  USE_AI:          'use_ai',
  MANAGE_USERS:    'manage_users',
  MANAGE_SETTINGS: 'manage_settings',
});

// Human labels for the capability editor (Settings → Manage Users → Roles).
const CAPABILITY_LABELS = Object.freeze({
  view_live:       'View live cameras',
  view_playback:   'View recorded playback',
  ack_alerts:      'Acknowledge / act on alerts',
  manage_cameras:  'Add / edit cameras & groups',
  use_ai:          'AI modules + configuration',
  manage_users:    'Manage users & roles',
  manage_settings: 'Billing & settings',
});

const C = CAPABILITIES;
const ROLE_CAPABILITIES = Object.freeze({
  [ROLES.ADMIN]:    Object.values(CAPABILITIES),
  [ROLES.USER]:     Object.values(CAPABILITIES), // legacy full access
  [ROLES.MANAGER]:  [C.VIEW_LIVE, C.VIEW_PLAYBACK, C.ACK_ALERTS, C.MANAGE_CAMERAS, C.USE_AI],
  [ROLES.OPERATOR]: [C.VIEW_LIVE, C.VIEW_PLAYBACK, C.ACK_ALERTS],
  [ROLES.VIEWER]:   [C.VIEW_LIVE, C.VIEW_PLAYBACK],
});

// Roles an admin can assign through Manage Users (legacy `user` is not assignable).
const ASSIGNABLE_ROLES = [ROLES.ADMIN, ROLES.MANAGER, ROLES.OPERATOR, ROLES.VIEWER];

function roleCan(role, capability) {
  return (ROLE_CAPABILITIES[role] || []).includes(capability);
}

// A user's effective capabilities: a custom Role (if assigned) overrides the
// built-in tier. Pass a User instance with its `customRole` association loaded.
function resolveCapabilities(user) {
  const custom = user && user.customRole;
  if (custom && Array.isArray(custom.capabilities)) return custom.capabilities;
  return ROLE_CAPABILITIES[user && user.role] || [];
}

function userCan(user, capability) {
  return resolveCapabilities(user).includes(capability);
}

const SUBSCRIPTION_STATUS = Object.freeze({
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
});

const GATEWAY = Object.freeze({
  STRIPE: 'stripe',
  RAZORPAY: 'razorpay',
});

const BILLING_CYCLE = Object.freeze({
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
});

module.exports = {
  ROLES,
  CAPABILITIES,
  CAPABILITY_LABELS,
  ROLE_CAPABILITIES,
  ASSIGNABLE_ROLES,
  roleCan,
  resolveCapabilities,
  userCan,
  SUBSCRIPTION_STATUS,
  PAYMENT_STATUS,
  GATEWAY,
  BILLING_CYCLE,
};
