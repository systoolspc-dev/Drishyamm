// The AI service answers 404 "investigation index is not enabled" on every
// /investigate route while INVESTIGATE_INDEX_ENABLED is off. Every proxy that
// talks to those routes checks this FIRST, so "the index is off" is never
// mistaken for "not found" ("no one at that spot", "nothing to transcribe").
const AppError = require('./AppError');

const INDEX_OFF = 'The investigation tools aren’t running on this server yet: the search index is switched off. '
  + 'Ask Drishyam support to turn it on; people are indexed from then on.';

/** Is this axios error the AI saying its investigation index is switched off? */
function isIndexOff(err) {
  const r = err && err.response;
  if (!r || r.status !== 404) return false;
  const detail = r.data && (r.data.detail || r.data.error);
  return typeof detail === 'string' && /investigation index is not enabled/i.test(detail);
}

/** The user-facing error for it (a 503 whose fixed text errorHandler shows). */
const indexOffError = () => AppError.public(INDEX_OFF, 503);

module.exports = { INDEX_OFF, isIndexOff, indexOffError };
