/**
 * aiTenant.js — per-organization identity for talking to smart-cam-ai.
 *
 * The AI service is multi-tenant: every Person, face vector (Qdrant), image
 * crop (MinIO) and DetectionEvent is scoped by a `tenant_id`, and the live
 * recognition pipeline picks its gallery from `Camera.tenant_id`. For each VMS
 * organization to have its OWN isolated watchlist, the backend must tell the AI
 * which tenant a request belongs to — it does that by minting a short-lived
 * HS256 JWT (the exact contract smart-cam-ai/core/security.py verifies) whose
 * `tid` claim is the org's tenant.
 *
 * Tenant granularity = per ORGANIZATION: a parent account and every sub-user it
 * created share one tenant. The org root is `user.parentUserId || user.id`, and
 * the tenant UUID is a deterministic UUIDv5 of that root — stable across
 * restarts and token refreshes, and requiring no extra DB column.
 */
const jwt = require('jsonwebtoken');
const { v5: uuidv5 } = require('uuid');

const config = require('../config/env');

// Fixed namespace so uuidv5(orgRoot) is stable forever. Do NOT change this — it
// would re-map every org to a new tenant and orphan their enrolled faces.
const AI_TENANT_NAMESPACE = '6f9a1c2e-1b3d-5e7f-8a9b-0c1d2e3f4a5b';

/** Org root id — parent account for sub-users, else the user's own id. */
function orgRootId(user) {
  return String(user?.parentUserId || user?.id || '');
}

/** Deterministic tenant UUID for this user's organization. */
function aiTenantId(user) {
  const root = orgRootId(user);
  if (!root) return null;
  return uuidv5(`drisyam-org:${root}`, AI_TENANT_NAMESPACE);
}

/**
 * Mint a short-lived JWT the AI will accept, carrying the org tenant in `tid`.
 * Returns null when no shared secret is configured (caller then falls back to
 * the legacy service-token-only headers → AI dev-bypass, i.e. old behaviour).
 */
function mintAiToken(user, { ttlSec = 3600 } = {}) {
  const secret = config.aiJwt?.secret;
  if (!secret || secret.length < 32) return null;
  const tid = aiTenantId(user);
  if (!tid) return null;
  // iat is backdated 2 min: the AI may run on another box whose clock lags
  // ours (office GPU was 34 s behind prod) and it rejects a future iat beyond
  // its 30 s leeway — every face/stranger call then 401s.
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 120;
  return jwt.sign(
    {
      iss: config.aiJwt.issuer,
      aud: config.aiJwt.audience,
      sub: String(user.id),
      tid,
      role: user.role === 'admin' ? 'admin' : 'operator',
      scopes: ['persons:write', 'persons:read', 'events:read'],
      iat,
      exp: now + Math.max(60, ttlSec),
    },
    secret,
    { algorithm: 'HS256' },
  );
}

/** Authorization header object (or {} when no token can be minted). */
function aiAuthHeader(user) {
  const tok = mintAiToken(user);
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

module.exports = { aiTenantId, mintAiToken, aiAuthHeader, orgRootId, AI_TENANT_NAMESPACE };
