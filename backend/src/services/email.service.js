const nodemailer = require('nodemailer');
const config = require('../config/env');
const logger = require('../config/logger');

/**
 * email.service — transactional + alert email delivery.
 *
 * SMTP settings are resolved in this order:
 *   1. Admin dashboard config (MailConfig row, enabled) — set at runtime by a
 *      platform admin (webmail/cPanel or Gmail). Password is encrypted at rest.
 *   2. Env (EMAIL_HOST/…) — legacy / infra-provided.
 *   3. Dev console fallback — logs instead of sending. In production this throws
 *      so callers (and the admin "Send test" button) report honestly that SMTP
 *      isn't configured, instead of silently pretending to send.
 *
 * The transporter is rebuilt whenever the effective config changes (keyed on
 * host/port/user), so saving new admin settings takes effect on the next send.
 */
let transporter = null;
let cacheKey = null;
let activeFrom = `"Drishyam" <${config.email?.from || 'noreply@smart-cam.local'}>`;

// Load the admin-managed SMTP config (lazy require to avoid load-order cycles).
async function loadDbConfig() {
  try {
    const { MailConfig } = require('../models');
    if (!MailConfig) return null;
    const row = await MailConfig.findByPk(1);
    if (row && row.enabled && row.host) {
      return {
        host: row.host,
        port: row.port || 465,
        secure: row.secure !== false,
        user: row.username || null,
        pass: row.password || null, // getter decrypts
        fromEmail: row.fromEmail || row.username || null,
        fromName: row.fromName || 'Drishyam Alerts',
      };
    }
  } catch (e) {
    logger.warn('mail: db config load failed (using env/dev)', { error: e.message });
  }
  return null;
}

// Resolve the active transporter + from-header. Rebuilds on config change.
async function getActive() {
  const db = await loadDbConfig();
  let key;
  if (db) key = `db:${db.host}:${db.port}:${db.user || ''}`;
  else if (config.email && config.email.host) key = `env:${config.email.host}:${config.email.port}`;
  else key = 'dev';

  if (transporter && cacheKey === key) return { transporter, from: activeFrom };

  if (db) {
    transporter = nodemailer.createTransport({
      host: db.host,
      port: db.port,
      secure: db.secure,
      auth: db.user ? { user: db.user, pass: db.pass } : undefined,
      // cPanel-on-IP often serves a cert that doesn't match the bare IP; still
      // fully TLS-encrypted, just not chain-validated. Fine for outbound relay.
      tls: { rejectUnauthorized: false },
    });
    activeFrom = `"${db.fromName}" <${db.fromEmail}>`;
  } else if (config.email && config.email.host) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: { user: config.email.user, pass: config.email.pass },
    });
    activeFrom = `"Drishyam" <${config.email.from || 'noreply@smart-cam.local'}>`;
  } else {
    transporter = {
      sendMail: async (opts) => {
        logger.info('📧 [DEV EMAIL] (SMTP not configured) would send:');
        logger.info(`  To: ${opts.to} · Subject: ${opts.subject}`);
        if (process.env.NODE_ENV === 'production') {
          throw new Error('SMTP not configured — set it in Admin → Email settings.');
        }
        return { messageId: `dev-${Date.now()}` };
      },
    };
    activeFrom = `"Drishyam" <${config.email?.from || 'noreply@smart-cam.local'}>`;
  }
  cacheKey = key;
  return { transporter, from: activeFrom };
}

// Force the next send to rebuild the transporter (call after saving config).
function resetTransporter() { transporter = null; cacheKey = null; }

async function deliver(mailOptions) {
  const { transporter: tx, from } = await getActive();
  return tx.sendMail({ from, ...mailOptions });
}

const emailService = {
  resetTransporter,

  // Verify an arbitrary SMTP config WITHOUT persisting it — used by the admin
  // "Send test" so a bad host/password fails loudly before it's saved.
  async sendWithConfig(cfg, to, { subject, text, html }) {
    const tx = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port || 465,
      secure: cfg.secure !== false,
      auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
      tls: { rejectUnauthorized: false },
    });
    const from = `"${cfg.fromName || 'Drishyam Alerts'}" <${cfg.fromEmail || cfg.username}>`;
    return tx.sendMail({ from, to, subject, text, html });
  },

  async sendPasswordResetEmail(email, name, resetToken) {
    const resetUrl = `${config.frontendUrl}/reset-password?token=${resetToken}`;
    const mailOptions = {
      to: email,
      subject: 'Reset Your Drishyam Password',
      text: `Hi ${name},\n\nYou requested a password reset.\n\nReset (valid 1 hour): ${resetUrl}\n\nIf you didn't request this, ignore this email.`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:40px 0;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="600" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
<tr><td style="background:linear-gradient(135deg,#F7983A,#e07d1a);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#fff;font-size:24px;">Drishyam</h1></td></tr>
<tr><td style="padding:40px;"><h2 style="margin:0 0 16px;color:#1a1a1a;font-size:20px;">Reset Your Password</h2>
<p style="color:#555;font-size:15px;line-height:1.6;">Hi <strong>${name}</strong>, click below to set a new password.</p>
<div style="text-align:center;margin:32px 0;"><a href="${resetUrl}" style="display:inline-block;background:#F7983A;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;">Reset Password</a></div>
<p style="color:#888;font-size:13px;">This link expires in 1 hour. Or copy: ${resetUrl}</p></td></tr>
</table></td></tr></table></body></html>`,
    };
    try {
      const info = await deliver(mailOptions);
      logger.info(`Password reset email sent to ${email} (${info.messageId})`);
      return true;
    } catch (err) {
      logger.error(`Failed to send password reset email to ${email}: ${err.message}`);
      throw err;
    }
  },

  async sendWelcomeEmail(email, name) {
    const mailOptions = {
      to: email,
      subject: 'Welcome to Drishyam',
      text: `Hi ${name},\n\nWelcome to Drishyam! Your account is ready.`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:40px 0;">
<table width="100%"><tr><td align="center"><table width="600" style="background:#fff;border-radius:12px;overflow:hidden;">
<tr><td style="background:linear-gradient(135deg,#F7983A,#e07d1a);padding:32px 40px;text-align:center;"><h1 style="margin:0;color:#fff;font-size:24px;">Welcome to Drishyam!</h1></td></tr>
<tr><td style="padding:40px;"><p style="color:#555;font-size:15px;">Hi <strong>${name}</strong>, your account is ready.</p></td></tr>
</table></td></tr></table></body></html>`,
    };
    try {
      await deliver(mailOptions);
      return true;
    } catch (err) {
      logger.error(`Failed to send welcome email to ${email}: ${err.message}`);
      return false;
    }
  },

  /**
   * Security-alert email — sent by alertEngine to a user's configured recipients.
   * @param {string} to
   * @param {{title:string, body:string, cameraName?:string, severity?:string, ts?:Date|string, appUrl?:string}} opts
   */
  async sendAlertEmail(to, { title, body, cameraName = null, severity = 'warning', ts = null, appUrl = null, imageBuffer = null }) {
    const accent = severity === 'critical' ? '#ef4444' : '#F7983A';
    const sevLabel = severity === 'critical' ? 'CRITICAL' : 'WARNING';
    let when;
    try {
      // timeZone is required: the server runs in UTC, and 'en-IN' alone only
      // sets the FORMAT — without an explicit zone alerts showed UTC times
      // (e.g. 07:09 for a 12:39 IST event).
      when = `${new Date(ts || Date.now()).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        timeZone: process.env.ALERT_TIMEZONE || 'Asia/Kolkata',
      })} IST`;
    } catch { when = new Date().toISOString(); }
    const link = appUrl || config.frontendUrl || '';
    // Inline the detection snapshot (unknown/watchlist crop) via a CID part so
    // it renders in the email body without an external fetch.
    const attachments = imageBuffer
      ? [{ filename: 'snapshot.jpg', content: imageBuffer, cid: 'snapshot@drishyam', contentType: 'image/jpeg' }]
      : undefined;
    const mailOptions = {
      to,
      subject: title,
      attachments,
      text: `${title}\n\n${body}\n${cameraName ? `Camera: ${cameraName}\n` : ''}Severity: ${sevLabel}\nTime: ${when}\n${imageBuffer ? 'A detection snapshot is attached.\n' : ''}${link ? `\nOpen Drishyam: ${link}\n` : ''}\nYou're receiving this because your address is on a Drishyam alert list.`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
<tr><td style="background:${accent};padding:24px 40px;">
<span style="display:inline-block;background:rgba(255,255,255,.2);color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em;padding:4px 10px;border-radius:999px;">${sevLabel} · DRISHYAM</span>
<h1 style="margin:12px 0 0;color:#fff;font-size:22px;font-weight:700;">${title}</h1></td></tr>
<tr><td style="padding:32px 40px;">
<p style="margin:0 0 20px;color:#1a1a1a;font-size:16px;line-height:1.6;">${body}</p>
${imageBuffer ? `<div style="margin:0 0 20px;text-align:center;"><img src="cid:snapshot@drishyam" alt="Detection snapshot" style="max-width:100%;border-radius:10px;border:1px solid #eee;"/><div style="margin-top:6px;color:#aaa;font-size:11px;">Captured at the moment of detection</div></div>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;">
${cameraName ? `<tr><td style="padding:10px 14px;color:#888;font-size:13px;border-bottom:1px solid #f2f2f2;">Camera</td><td style="padding:10px 14px;color:#1a1a1a;font-size:13px;font-weight:600;border-bottom:1px solid #f2f2f2;text-align:right;">${cameraName}</td></tr>` : ''}
<tr><td style="padding:10px 14px;color:#888;font-size:13px;border-bottom:1px solid #f2f2f2;">Severity</td><td style="padding:10px 14px;color:${accent};font-size:13px;font-weight:700;border-bottom:1px solid #f2f2f2;text-align:right;">${sevLabel}</td></tr>
<tr><td style="padding:10px 14px;color:#888;font-size:13px;">Time</td><td style="padding:10px 14px;color:#1a1a1a;font-size:13px;font-weight:600;text-align:right;">${when}</td></tr>
</table>
${link ? `<div style="text-align:center;margin:28px 0 4px;"><a href="${link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">Open Drishyam</a></div>` : ''}
</td></tr>
<tr><td style="padding:18px 40px;border-top:1px solid #eee;text-align:center;"><p style="margin:0;color:#aaa;font-size:12px;">You're receiving this because your address is on a Drishyam alert list.</p></td></tr>
</table></td></tr></table></body></html>`,
    };
    const info = await deliver(mailOptions);
    logger.info(`Alert email sent to ${to} (${info.messageId})`);
    return true;
  },
};

module.exports = emailService;
