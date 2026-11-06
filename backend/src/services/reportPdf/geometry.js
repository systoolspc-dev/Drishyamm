'use strict';
/**
 * geometry.js — pure helpers shared by the snapshot pipeline and its tests.
 */

/**
 * Re-project a source-frame bbox [x1, y1, x2, y2] into an output image of
 * W × H that holds the source letterboxed (fit: contain, centred). Returns
 * [x, y, w, h] as fractions of the output, or null when the box clearly does
 * not belong to this image (a face crop stored with a full-frame box, say) —
 * a wrong box on evidence is worse than no box.
 */
function mapBox(bbox, iw, ih, W, H) {
  if (!Array.isArray(bbox) || bbox.length < 4 || !iw || !ih) return null;
  let [x1, y1, x2, y2] = bbox.slice(0, 4).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x2 <= 1 && y2 <= 1 && x1 >= 0 && y1 >= 0) { x1 *= iw; x2 *= iw; y1 *= ih; y2 *= ih; }
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  if (x2 > iw * 1.02 || y2 > ih * 1.02 || x1 < -iw * 0.02 || y1 < -ih * 0.02) return null;
  if ((x2 - x1) * (y2 - y1) > 0.9 * iw * ih) return null;
  const s = Math.min(W / iw, H / ih);
  const ox = (W - iw * s) / 2;
  const oy = (H - ih * s) / 2;
  const cx1 = Math.max(0, x1); const cy1 = Math.max(0, y1);
  const cx2 = Math.min(iw, x2); const cy2 = Math.min(ih, y2);
  return [(ox + cx1 * s) / W, (oy + cy1 * s) / H, ((cx2 - cx1) * s) / W, ((cy2 - cy1) * s) / H];
}

module.exports = { mapBox };
