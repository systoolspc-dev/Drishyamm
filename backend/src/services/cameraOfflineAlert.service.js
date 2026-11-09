'use strict';
/**
 * cameraOfflineAlert.service — emails an account's alert recipients when one of
 * its cameras goes offline (and once when it recovers). Wired from the stream
 * supervisor's transition emit loop, fire-and-forget. Debounced per camera so a
 * flapping camera can't spam: at most one "down" email per RESEND_MS, and a
 * "recovered" email only if a "down" was actually sent for that camera.
 *
 * Recipients: alert_emails rows for the camera's owner, not disabled, whose
 * eventTypes gate allows camera events (null/empty = all events).
 *
 * Delivery uses email.service, which needs SMTP configured (Admin → Email
 * settings / MailConfig row, or EMAIL_* env). Without SMTP in dev it logs the
 * send instead — which still proves the wiring end to end.
 */
const { AlertEmail } = require('../models');
const emailService = require('./email.service');
const logger = require('../config/logger');

const RESEND_MS = parseInt(process.env.CAMERA_OFFLINE_ALERT_RESEND_MS || String(15 * 60 * 1000), 10);
const _lastDown = new Map();

function allowsCamera(row) {
  const t = row.eventTypes;
  if (!Array.isArray(t) || t.length === 0) return true;
  return t.includes('camera.offline') || t.includes('camera') || t.includes('camera.health');
}
async function recipientsFor(userId) {
  try {
    const rows = await AlertEmail.findAll({ where: { userId, disabled: false } });
    return rows.filter(allowsCamera);
  } catch (e) { logger.warn('cameraOfflineAlert: recipient lookup failed', { error: e.message }); return []; }
}
async function onOffline({ monitorId, cameraName, userId, reason, at }) {
  if (!userId) return;
  if (Date.now() - (_lastDown.get(monitorId) || 0) < RESEND_MS) return;
  const recips = await recipientsFor(userId);
  if (!recips.length) return;
  _lastDown.set(monitorId, Date.now());
  const name = cameraName || monitorId;
  const title = `Camera offline: ${name}`;
  const body = `${name} went offline${at ? ' at ' + at : ''}.${reason ? ' Reason: ' + reason + '.' : ''}\n\nA follow-up email will be sent when it comes back online.`;
  for (const r of recips) {
    emailService.sendAlertEmail(r.email, { title, body, cameraName: name, severity: 'critical', ts: at })
      .then(() => logger.info('cameraOfflineAlert: offline email sent', { to: r.email, monitorId }))
      .catch((e) => logger.warn('cameraOfflineAlert: offline send failed', { to: r.email, error: e.message }));
  }
}
async function onRecover({ monitorId, cameraName, userId, at }) {
  if (!_lastDown.has(monitorId)) return;
  _lastDown.delete(monitorId);
  if (!userId) return;
  const recips = await recipientsFor(userId);
  if (!recips.length) return;
  const name = cameraName || monitorId;
  for (const r of recips) {
    emailService.sendAlertEmail(r.email, { title: `Camera back online: ${name}`, body: `${name} is streaming again${at ? ' as of ' + at : ''}.`, cameraName: name, severity: 'info', ts: at })
      .catch((e) => logger.warn('cameraOfflineAlert: recover send failed', { to: r.email, error: e.message }));
  }
}
module.exports = { onOffline, onRecover };
