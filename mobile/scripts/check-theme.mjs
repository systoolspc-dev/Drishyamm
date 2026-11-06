// Theme guard — run with:  node scripts/check-theme.mjs
//
// Two things it proves, both of which are silent failures otherwise:
//
//   1. PARITY  — a colour token present in one palette but missing in the other
//                renders as `undefined`, which React Native treats as "no
//                colour". You get a transparent badge, not an error.
//   2. CONTRAST — every pairing the components actually render, checked against
//                WCAG AA. It measures the REAL pairs (badge ink on its own soft
//                background, button label on the brand fill), not everything
//                against white, because that is what ships.
//
// Alpha `*Soft` tokens on the dark palette are composited over the surface
// before measuring, since that is how they are seen.
//
// Zero dependencies: palettes.js is pure data, so it is read and evaluated
// rather than imported (the app is CommonJS-resolved, this file is ESM).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/theme/palettes.js'), 'utf8');
const { light, dark } = new Function(
  `${src.replace(/\bexport\s+(const|default)\s+/g, '$1 ')}\nreturn { light, dark };`
)();

// ── colour maths ─────────────────────────────────────────────────────────────
const hexToRgb = (h) => {
  const c = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
};
const flatten = (color, backdrop) => {
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return hexToRgb(color);
  const [r, g, b, a = 1] = m[1].split(',').map(Number);
  const bg = hexToRgb(backdrop);
  return [r, g, b].map((v, i) => v * a + bg[i] * (1 - a));
};
const lum = (rgb) => {
  const f = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
};
const ratio = (fg, bg, backdrop) => {
  const [hi, lo] = [lum(flatten(fg, backdrop)), lum(flatten(bg, backdrop))].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

// ── the pairings the UI genuinely renders ────────────────────────────────────
const pairs = (p) => [
  ['Body text on bg',      p.text,        p.bg,          4.5],
  ['Body text on surface', p.text,        p.surface,     4.5],
  ['Secondary on bg',      p.sub,         p.bg,          4.5],
  ['Secondary on surface', p.sub,         p.surface,     4.5],
  ['Secondary on muted',   p.sub,         p.muted,       4.5],
  ['Link on surface',      p.primaryInk,  p.surface,     4.5],
  ['Link on bg',           p.primaryInk,  p.bg,          4.5],
  ['Button label',         p.onPrimary,   p.primary,     4.5],
  ['Chip selected',        p.primaryInk,  p.primarySoft, 4.5],
  ['Badge ok',             p.okInk,       p.okSoft,      4.5],
  ['Badge warn',           p.warnInk,     p.warnSoft,    4.5],
  ['Badge critical',       p.criticalInk, p.critSoft,    4.5],
  ['Badge info',           p.infoInk,     p.infoSoft,    4.5],
  ['Badge sevHigh',        p.sevHighInk,  p.sevHighSoft, 4.5],
  ['Banner on alarm',      p.onVideo,     p.alarm,       4.5],
  ['Faint icon',           p.faint,       p.surface,     3.0],
];

let failures = 0;

// 1 — parity
const lk = Object.keys(light).sort();
const dk = Object.keys(dark).sort();
const missingDark = lk.filter((k) => !dk.includes(k));
const missingLight = dk.filter((k) => !lk.includes(k));
if (missingDark.length) { console.log(`  x dark is missing: ${missingDark.join(', ')}`); failures++; }
if (missingLight.length) { console.log(`  x light is missing: ${missingLight.join(', ')}`); failures++; }
if (!missingDark.length && !missingLight.length) console.log(`  ok token parity (${lk.length} per theme)`);

for (const [name, p] of [['light', light], ['dark', dark]]) {
  for (const [k, v] of Object.entries(p)) {
    if (k === 'elevatedBorder') continue; // documented null on light
    if (v == null || v === '') { console.log(`  x ${name}.${k} is empty`); failures++; }
  }
}

// 2 — contrast
for (const [name, p, backdrop] of [['LIGHT', light, '#FFFFFF'], ['DARK', dark, '#1E1E1E']]) {
  console.log(`\n${name} — rendered pairings (AA: 4.5 text / 3.0 UI):`);
  for (const [label, fg, bg, min] of pairs(p)) {
    if (fg == null || bg == null) { console.log(`  x ${label.padEnd(20)} token missing`); failures++; continue; }
    const r = ratio(fg, bg, backdrop);
    const ok = r >= min;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok' : 'x '} ${label.padEnd(20)} ${r.toFixed(2)}:1  (need ${min})`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll theme checks passed');
process.exit(failures ? 1 : 0);
