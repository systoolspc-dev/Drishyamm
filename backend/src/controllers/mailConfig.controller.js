/**
 * mailConfig.controller.js — platform-admin SMTP settings (Admin dashboard).
 *
 * Singleton row (id=1). The password is never returned to the client (only a
 * `hasPassword` flag). Saving without a password keeps the stored one.
 */
const asyncHandler = require('../middleware/asyncHandler');
const { MailConfig } = require('../models');
const emailService = require('../services/email.service');

// Preset hosts so the admin only picks a provider + enters credentials.
const PRESETS = {
  gmail:   { host: 'smtp.gmail.com',    port: 465, secure: true },
  webmail: { host: '103.148.165.139',   port: 465, secure: true }, // drishyam.io cPanel (IP; DNS mail.* not published)
};

function present(row) {
  if (!row) return { enabled: false, provider: 'custom', host: '', port: 465, secure: true, username: '', fromName: 'Drishyam Alerts', fromEmail: '', hasPassword: false };
  return {
    enabled: row.enabled,
    provider: row.provider,
    host: row.host || '',
    port: row.port || 465,
    secure: row.secure,
    username: row.username || '',
    fromName: row.fromName || 'Drishyam Alerts',
    fromEmail: row.fromEmail || '',
    hasPassword: !!row.getDataValue('password'),
    updatedAt: row.updatedAt,
  };
}

// GET /api/admin/mail-config
const get = asyncHandler(async (req, res) => {
  const row = await MailConfig.findByPk(1);
  res.json({ success: true, config: present(row), presets: PRESETS });
});

// PUT /api/admin/mail-config
const save = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const provider = ['gmail', 'webmail', 'custom'].includes(b.provider) ? b.provider : 'custom';
  const preset = PRESETS[provider] || {};
  const patch = {
    id: 1,
    provider,
    host: (b.host || preset.host || '').trim(),
    port: Number(b.port || preset.port || 465),
    secure: typeof b.secure === 'boolean' ? b.secure : (preset.secure ?? true),
    username: (b.username || '').trim() || null,
    fromName: (b.fromName || 'Drishyam Alerts').trim(),
    fromEmail: (b.fromEmail || b.username || '').trim() || null,
    enabled: !!b.enabled,
  };
  // Only overwrite the password when a non-empty one is supplied.
  if (b.password) patch.password = b.password;

  let row = await MailConfig.findByPk(1);
  if (row) await row.update(patch);
  else row = await MailConfig.create(patch);

  emailService.resetTransporter(); // pick up new settings on next send
  res.json({ success: true, config: present(row) });
});

// POST /api/admin/mail-config/test  { to }
const test = asyncHandler(async (req, res) => {
  const to = String(req.body?.to || req.user?.email || '').trim();
  if (!to) return res.status(400).json({ success: false, message: 'Provide a "to" address.' });

  const row = await MailConfig.findByPk(1);
  if (!row || !row.host) {
    return res.status(400).json({ success: false, message: 'Save SMTP settings first.' });
  }
  try {
    // Send with the SAVED config so a bad password/host surfaces immediately.
    await emailService.sendWithConfig(
      {
        host: row.host, port: row.port, secure: row.secure,
        username: row.username, password: row.password, // getter decrypts
        fromName: row.fromName, fromEmail: row.fromEmail || row.username,
      },
      to,
      {
        subject: '✅ Drishyam SMTP test',
        text: 'Your Drishyam email settings are working. Alerts will be delivered.',
        html: '<div style="font-family:Arial,sans-serif;padding:24px;"><h2 style="color:#F7983A;">SMTP is working ✅</h2><p>Your Drishyam email settings are correct. Security alerts will now be delivered by email.</p></div>',
      },
    );
    res.json({ success: true, message: `Test email sent to ${to}.` });
  } catch (e) {
    res.status(502).json({ success: false, message: `Send failed: ${e.message}` });
  }
});

module.exports = { get, save, test };
