/**
 * push.service.js — mobile push delivery via Expo's push API.
 *
 * We talk to Expo directly (https://exp.host/--/api/v2/push/send) rather than
 * pulling in expo-server-sdk: it's a single authenticated-by-token HTTPS POST
 * and we already have axios. Sends are best-effort — a push failure must never
 * break the caller (event ingest, alert engine).
 *
 * When Expo reports a token as `DeviceNotRegistered`, we disable it so we stop
 * sending to a phone that uninstalled the app or revoked notifications.
 */
const axios = require('axios');
const logger = require('../config/logger');
const { DeviceToken } = require('../models');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100; // Expo accepts up to 100 messages per request

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Send one batch of Expo messages. Returns the tickets array (same order as
 * `messages`) or [] on transport failure.
 */
async function sendBatch(messages) {
  try {
    const { data } = await axios.post(EXPO_PUSH_URL, messages, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 8000,
    });
    return Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    logger.warn('expo push send failed (non-fatal)', {
      error: err.message, count: messages.length,
    });
    return [];
  }
}

/**
 * Push a notification to every enabled device belonging to `userId`.
 *
 * @param {string} userId
 * @param {{title:string, body:string, data?:object, sound?:string, priority?:string}} msg
 * @returns {Promise<{sent:number, devices:number}>}
 */
async function notifyUser(userId, { title, body, data = {}, sound = 'default', priority = 'high' }) {
  if (!userId) return { sent: 0, devices: 0 };

  let rows = [];
  try {
    rows = await DeviceToken.findAll({ where: { userId, disabled: false } });
  } catch (err) {
    logger.warn('device token lookup failed (non-fatal)', { error: err.message });
    return { sent: 0, devices: 0 };
  }
  if (!rows.length) return { sent: 0, devices: 0 };

  const messages = rows.map((r) => ({
    to: r.token,
    title,
    body,
    data,
    sound,
    priority,
    channelId: 'alerts',
  }));

  let sent = 0;
  const deadTokens = [];
  const batches = chunk(messages, CHUNK);
  const rowBatches = chunk(rows, CHUNK);

  for (let b = 0; b < batches.length; b++) {
    const tickets = await sendBatch(batches[b]);
    tickets.forEach((t, i) => {
      if (t?.status === 'ok') {
        sent++;
      } else if (t?.details?.error === 'DeviceNotRegistered') {
        const row = rowBatches[b][i];
        if (row) deadTokens.push(row.id);
      }
    });
  }

  if (deadTokens.length) {
    DeviceToken.update({ disabled: true }, { where: { id: deadTokens } })
      .catch((err) => logger.warn('failed disabling dead tokens', { error: err.message }));
    logger.info('disabled dead push tokens', { count: deadTokens.length });
  }

  return { sent, devices: rows.length };
}

module.exports = { notifyUser };
