/**
 * How far the AI service's clock is from ours.
 *
 * The AI service can run on another machine (the office GPU node, through the
 * gpu-bridge tunnel), and it checks the time claims of the tokens we mint for
 * it against its own clock. On 2026-10-27 that box had drifted 38 s behind
 * prod, past the AI's 30 s leeway, and every user call to it (footfall, logs,
 * face-learning, journey) came back 401 -- with nothing anywhere saying why.
 *
 * aiLifecycle already polls the AI's /status every 15 s; this reads the HTTP
 * `Date` header off that same response, so measuring costs no extra request.
 * The header has whole-second resolution and the round trip adds a little,
 * which is noise at a threshold of seconds.
 *
 * It logs on the transition only (out of step, then back in step), never per
 * poll, and clears at half the threshold so a reading hovering on the line
 * does not flap.
 */
const logger = require('../config/logger');

const WARN_SEC = Number(process.env.AI_CLOCK_SKEW_WARN_SEC || 10);

let state = { skewSec: null, measuredAt: null, outOfStep: false };

/**
 * Seconds the peer's clock is ahead of ours (negative: behind), or null when
 * the header is missing or unreadable. Measured against the midpoint of the
 * request, the best guess at when the peer stamped it.
 */
function skewFromDateHeader(dateHeader, sentAtMs, receivedAtMs) {
  const peerMs = Date.parse(dateHeader || '');
  if (!Number.isFinite(peerMs) || !Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs)) return null;
  return Math.round((peerMs - (sentAtMs + receivedAtMs) / 2) / 1000);
}

function recordAiClock(dateHeader, sentAtMs, receivedAtMs) {
  const skewSec = skewFromDateHeader(dateHeader, sentAtMs, receivedAtMs);
  if (skewSec === null) return;

  const size = Math.abs(skewSec);
  let { outOfStep } = state;
  if (!outOfStep && size >= WARN_SEC) {
    outOfStep = true;
    logger.warn('aiClock: AI service clock is out of step with the backend', {
      skewSec,
      direction: skewSec < 0 ? 'AI behind' : 'AI ahead',
      thresholdSec: WARN_SEC,
      hint: 'check time sync (w32time / timedatectl) on the AI host; past its JWT leeway every user call to the AI returns 401',
    });
  } else if (outOfStep && size < WARN_SEC / 2) {
    outOfStep = false;
    logger.info('aiClock: AI service clock back in step', { skewSec });
  }
  state = { skewSec, measuredAt: new Date(receivedAtMs).toISOString(), outOfStep };
}

function getAiClockSkew() {
  return { ...state, thresholdSec: WARN_SEC };
}

function _reset() {
  state = { skewSec: null, measuredAt: null, outOfStep: false };
}

module.exports = {
  skewFromDateHeader,
  recordAiClock,
  getAiClockSkew,
  _reset,
};
