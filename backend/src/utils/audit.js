const path = require('node:path');
const winston = require('winston');

const logDir = path.resolve(__dirname, '../../logs');

// Dedicated, append-only audit trail — kept SEPARATE from the app logs so it can
// be shipped to a WORM store / SIEM and retained on its own (longer) schedule.
// Every entry is one JSON line: who did what, to whom, from where, and whether
// it succeeded. This is the operational counterpart to the biometric AuditLog
// the vms_face service already keeps in Postgres for DPDP-critical operations.
const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { kind: 'audit', service: 'drishyamvms-api' },
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, 'audit.log'),
      maxsize: 20 * 1024 * 1024, // 20MB
      maxFiles: 20,              // ~400MB of history before oldest is dropped
      tailable: true,
    }),
  ],
});

// In non-production also echo to console so audit events are visible during dev.
if (process.env.NODE_ENV !== 'production') {
  auditLogger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf((i) => `${i.timestamp} [AUDIT] ${i.action || i.message}`)
    ),
  }));
}

// Pull the acting principal + request fingerprint off the Express request.
// Everything is optional — an unauthenticated or malformed request still audits.
function actorFrom(req) {
  const u = (req && req.user) || {};
  return {
    userId: u.id != null ? u.id : (u.userId != null ? u.userId : null),
    email: u.email || null,
    role: u.role || null,
    ip: (req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || null,
    userAgent: (req && req.headers && req.headers['user-agent']) || null,
  };
}

/**
 * Record a sensitive action.
 *
 * Fire-and-forget by design: an audit write must never be able to throw into —
 * or fail — the operation it is recording. Any error here is swallowed.
 *
 * @param {string} action  stable event name, e.g. 'user.status.toggled'
 * @param {object} opts
 * @param {object} [opts.req]         Express request (for actor + fingerprint)
 * @param {string} [opts.targetType]  what was acted on, e.g. 'user'
 * @param {string|number} [opts.targetId]
 * @param {string} [opts.outcome]     'success' | 'failure' (default 'success')
 * @param {object} [opts.meta]        any extra structured detail (no secrets)
 */
function audit(action, opts = {}) {
  try {
    const { req, targetType = null, targetId = null, outcome = 'success', meta = {} } = opts;
    auditLogger.info({
      action,
      actor: actorFrom(req),
      target: { type: targetType, id: targetId != null ? String(targetId) : null },
      outcome,
      ...meta,
    });
  } catch (_) {
    // Auditing must never break the request path.
  }
}

module.exports = { audit, _auditLogger: auditLogger, actorFrom };
