const Joi = require('joi');

// Grid bounds match the wall renderer: 1 × 1 up to 6 × 6. Past 36 tiles a
// 1080p tile is under 320px wide and camera names stop being legible.
const MAX_SIDE = 6;
const MAX_PAGES = 12;
// The rotation choices the setup page offers. Anything faster than 10 s gives
// the recorder no time to settle between pages.
const ROTATE_SECONDS = [10, 15, 30, 60, 120, 300];

const slot = Joi.string().trim().min(1).max(64).allow(null);

// Full layout body for create and replace. The validate middleware strips
// unknown keys, so this must list every field the controller stores.
const layout = Joi.object({
  name:          Joi.string().trim().min(1).max(120).required(),
  cols:          Joi.number().integer().min(1).max(MAX_SIDE).required(),
  rows:          Joi.number().integer().min(1).max(MAX_SIDE).required(),
  pages:         Joi.array().items(Joi.array().items(slot)).min(1).max(MAX_PAGES).required(),
  rotate:        Joi.boolean().default(true),
  rotateSeconds: Joi.number().integer().valid(...ROTATE_SECONDS).default(30),
  skipOffline:   Joi.boolean().default(false),
  focusAudio:    Joi.boolean().default(true),
}).custom((value, helpers) => {
  const size = value.cols * value.rows;
  if (value.pages.some((page) => page.length !== size)) {
    return helpers.message(`Every page needs exactly ${size} slots for a ${value.cols} × ${value.rows} grid.`);
  }
  const ids = value.pages.flat().filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    return helpers.message('A camera can only appear once in a layout.');
  }
  return value;
});

module.exports = { layout, MAX_SIDE, MAX_PAGES, ROTATE_SECONDS };
