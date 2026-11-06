// Drishyam mobile — palette → complete theme.
//
// Everything colour-dependent is DERIVED here, so a new palette automatically
// gets a matching type scale, elevation ramp, severity map and press states.
// Themes are built once and cached by mode: `getTheme('dark') === getTheme('dark')`,
// which is what lets useStyles() cache stylesheets and lets consumers rely on
// referential stability in useMemo deps.

import { palettes } from './palettes';
import { fonts, cardScale } from './tokens';

export const THEME_MODES = Object.keys(palettes); // ['light', 'dark']

// Type scale — role -> {fontFamily,fontSize,lineHeight,letterSpacing,color}.
// Metrics are identical in every theme; only ink changes. Callers keep using
// t="body" / t="caption" and get the right colour for free.
//
// The scale is deliberately small. If a screen needs a size that isn't here,
// that's a signal the scale is wrong — fix it here rather than passing
// `style={{ fontSize }}`, which silently forks the scale per screen.
function buildType(c) {
  return {
    display:   { fontFamily: fonts.bold, fontSize: 28, lineHeight: 34, letterSpacing: -0.3, color: c.text },
    h1:        { fontFamily: fonts.bold, fontSize: 24, lineHeight: 32, letterSpacing: -0.2, color: c.text },
    h2:        { fontFamily: fonts.semi, fontSize: 20, lineHeight: 28, letterSpacing: -0.2, color: c.text },
    // Screen/section titles.
    title:     { fontFamily: fonts.semi, fontSize: 17, lineHeight: 24, letterSpacing: -0.1, color: c.text },
    // Row- and card-level titles. Exists so screens stop writing
    // `t="title" fontSize:15` inline — that override was forking the scale in
    // four places.
    titleSm:   { fontFamily: fonts.semi, fontSize: 15, lineHeight: 20, letterSpacing: 0,    color: c.text },
    statValue: { fontFamily: fonts.bold, fontSize: 24, lineHeight: 28, letterSpacing: -0.2, color: c.text, fontVariant: ['tabular-nums'] },
    // Compact stat, for 4-up tiles where statValue (24) would wrap on small phones.
    statSm:    { fontFamily: fonts.bold, fontSize: 18, lineHeight: 22, letterSpacing: -0.2, color: c.text, fontVariant: ['tabular-nums'] },
    body:      { fontFamily: fonts.reg,  fontSize: 15, lineHeight: 22, letterSpacing: 0,    color: c.text },
    bodyMed:   { fontFamily: fonts.med,  fontSize: 15, lineHeight: 20, letterSpacing: 0,    color: c.text },
    sub:       { fontFamily: fonts.reg,  fontSize: 13, lineHeight: 18, letterSpacing: 0,    color: c.sub },
    caption:   { fontFamily: fonts.med,  fontSize: 12, lineHeight: 16, letterSpacing: 0.2,  color: c.sub, fontVariant: ['tabular-nums'] },
    label:     { fontFamily: fonts.semi, fontSize: 11, lineHeight: 14, letterSpacing: 0.6,  color: c.sub, textTransform: 'uppercase' },
    badge:     { fontFamily: fonts.bold, fontSize: 11, lineHeight: 14, letterSpacing: 0.5 },
  };
}

// Text that sits ON a video frame is its own family: it never follows the
// theme (the ground is always dark video) and it needs its own weights to stay
// legible over moving footage. CameraCard and LiveTile had byte-identical
// copies of these four styles — this is the single source.
function buildOnVideo(c) {
  return {
    title:   { fontFamily: fonts.semi, fontSize: 13.5, lineHeight: 18, color: c.onVideo },
    titleSm: { fontFamily: fonts.semi, fontSize: 12,   lineHeight: 16, color: c.onVideo },
    meta:    { fontFamily: fonts.reg,  fontSize: 11.5, lineHeight: 15, color: 'rgba(255,255,255,0.70)' },
    overlay: { fontFamily: fonts.reg,  fontSize: 12,   lineHeight: 16, color: 'rgba(255,255,255,0.70)', textAlign: 'center' },
    pill:    { fontFamily: fonts.bold, fontSize: 11,   lineHeight: 14, color: c.onVideo, letterSpacing: 0.5 },
  };
}

// Elevation. On a LIGHT ground: tight, low-opacity, cool-tinted — "subtle
// elevation", never a drop shadow you can point at. On a DARK ground the same
// values are invisible, so the ramp goes deeper and blacker and raised
// surfaces additionally pick up a hairline (see Card).
function buildElevation(c, isDark) {
  const sc = c.shadowColor;
  return isDark
    ? {
        1: { shadowColor: sc, shadowOffset: { width: 0, height: 1 },  shadowOpacity: 0.36, shadowRadius: 4,  elevation: 2 },
        2: { shadowColor: sc, shadowOffset: { width: 0, height: 4 },  shadowOpacity: 0.46, shadowRadius: 14, elevation: 6 },
        3: { shadowColor: sc, shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.56, shadowRadius: 26, elevation: 12 },
      }
    : {
        1: { shadowColor: sc, shadowOffset: { width: 0, height: 1 },  shadowOpacity: 0.05, shadowRadius: 3,  elevation: 2 },
        2: { shadowColor: sc, shadowOffset: { width: 0, height: 6 },  shadowOpacity: 0.07, shadowRadius: 16, elevation: 6 },
        3: { shadowColor: sc, shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.10, shadowRadius: 28, elevation: 12 },
      };
}

function createTheme(mode) {
  const colors = palettes[mode];
  const isDark = mode === 'dark';
  const elevation = buildElevation(colors, isDark);

  // Severity → {fg, accent, bg}. "high" is red-orange so it never collides
  // with brand.
  //   fg     — TEXT and icons on `bg` (the ink tier, >=4.5:1 on that soft)
  //   accent — the vivid tone, for decorative stripes/dots where hue does the
  //            work and no type sits on it
  //   bg     — the soft chip background
  // Callers that just spread {fg,bg} into a Badge keep working unchanged; the
  // stripe in Alerts is the one place that wants `accent`.
  const sev = (ink, vivid, soft) => ({ fg: ink, accent: vivid, bg: soft });
  const severity = {
    critical: sev(colors.criticalInk, colors.critical, colors.critSoft),
    high:     sev(colors.sevHighInk,  colors.sevHigh,  colors.sevHighSoft),
    medium:   sev(colors.warnInk,     colors.warn,     colors.warnSoft),
    low:      sev(colors.infoInk,     colors.info,     colors.infoSoft),
  };

  return {
    mode,
    isDark,
    colors,
    type: buildType(colors),
    onVideo: buildOnVideo(colors),

    severity,
    sevOf: (s) => severity[String(s || '').toLowerCase()] || severity.low,

    elevation,
    shadow: (l = 1) => elevation[l] || elevation[1],
    // The tab bar floats clear of the screen edge, so its shadow is cast in
    // every direction rather than upward only.
    tabBarShadow: isDark
      ? { shadowColor: colors.shadowColor, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.44, shadowRadius: 18, elevation: 12 }
      : { shadowColor: colors.shadowColor, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.10, shadowRadius: 20, elevation: 12 },
    brandShadow: isDark
      ? { shadowColor: colors.brandShadowColor, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.40, shadowRadius: 10, elevation: 3 }
      : { shadowColor: colors.brandShadowColor, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 14, elevation: 3 },

    press: {
      filledBg: colors.primaryDk,
      tintBg:   colors.mutedAlt,
      ripple:   colors.ripple,
      cardScale,
    },

    // StatusBar text colour: dark ink on a light theme, light ink on a dark
    // one. Explicit rather than expo-status-bar's "auto", because the app
    // theme can deliberately differ from the device colour scheme.
    statusBarStyle: isDark ? 'light' : 'dark',
  };
}

const cache = new Map();

export function getTheme(mode) {
  const key = palettes[mode] ? mode : 'light';
  if (!cache.has(key)) cache.set(key, createTheme(key));
  return cache.get(key);
}
