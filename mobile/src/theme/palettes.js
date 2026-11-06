// Drishyam mobile — colour palettes, one per theme.
//
// Adding a third theme (e.g. a high-contrast accessibility theme) means adding
// ONE object here with the same keys and registering it in createTheme.js.
// Nothing else in the app changes — every screen reads these through useTheme().
//
// Rules that hold across every palette:
//   · Orange is brand/actions only, never a status.
//   · Semantic colours stay clearly off brand-orange so "warning" never reads
//     as "button".
//   · `*Soft` tokens are chip/badge backgrounds and sit UNDER their `*Ink`
//     twin. On dark grounds they are alpha-composited rather than solid, so a
//     badge looks right on bg, surface and card alike without three variants.
//
// TWO-TIER SEMANTICS — the important rule in this file:
//   `warn`     → the VIVID tone. Fills, dots, stripes, icons, borders. Large or
//                decorative, where hue does the work.
//   `warnInk`  → a darkened tone of the same hue, for SMALL TEXT on light
//                grounds (badge labels, link text).
// The vivid brand/status tones are correct as identity colours but are far too
// light to sit as 11–13px text on a near-white chip: #F4A100 on #FEF4E0 is
// 1.93:1, where WCAG AA wants 4.5:1. The ink tones are those same hues solved
// down to >=4.5:1 against their own soft background. On the DARK palette the
// vivid tone already clears 4.5:1 on #1E1E1E, so ink === vivid there and the
// distinction costs nothing.

// ── LIGHT ────────────────────────────────────────────────────────────────────
export const light = {
  // surfaces
  bg:          '#F8F9FB',
  surface:     '#FFFFFF',
  card:        '#FFFFFF',
  muted:       '#F1F3F6',   // input fill, inactive chips
  mutedAlt:    '#E6E9EF',   // pressed state of the above
  scrim:       'rgba(16,20,26,0.55)',
  skeleton:    '#EEF0F4',

  // ink
  text:        '#1E1E1E',
  // Spec value #6F7682 lands at 4.34:1 on this bg — a hair under AA. Darkened
  // by ~4% (visually indistinguishable) to clear 4.5:1 on bg, muted AND surface.
  sub:         '#696F7B',
  // Decorative only: icons, chevrons, input placeholders. 3.16:1 on surface —
  // meets the 3:1 non-text minimum. Never use it for body copy.
  faint:       '#8C919B',
  border:      '#ECECEC',

  // brand
  primary:     '#F7983A',
  primaryInk:  '#9E6125',   // brand text/links on light grounds — 5.01:1 on white
  secondary:   '#FFB15C',   // FILL ONLY — 1.80:1 as text; never put type on it
  primaryDk:   '#E07E1C',   // pressed
  // Warm near-black, not white: #FFFFFF on #F7983A is 2.21:1, which fails AA on
  // the app's single most important control. This is 7.62:1 and reads as an
  // intentional warm ink rather than plain black.
  onPrimary:   '#2A1A05',
  primarySoft: '#FFF3E7',

  // semantic (kept clearly off brand-orange) — vivid tone + text-safe ink
  ok:          '#2FBF71',  okSoft:   '#E6F7EE',  okInk:       '#1F7E4B',
  warn:        '#F4A100',  warnSoft: '#FEF4E0',  warnInk:     '#9A6500',
  // criticalSoft is an ALIAS of critSoft. Components that take a palette KEY
  // (StatCard, SummaryCard) resolve `${tint}Soft`, which for tint='critical'
  // misses the shorter name and silently falls back to grey. Both spellings
  // now work; critSoft stays because existing call sites use it.
  critical:    '#F44336',  critSoft: '#FEECEB',  criticalSoft: '#FEECEB',  criticalInk: '#C8372C',
  // Full-bleed alarm/offline banners carry WHITE text, so their ground must be
  // deep enough for it: white on the vivid #F44336 is only 3.68:1. Same value
  // in both themes — an alarm banner is its own ground, not a surface.
  alarm:       '#C8372C',
  live:        '#F44336',
  // offInk completes the two-tier rule for the neutral tone: the vivid #9AA1AC
  // is decorative-only (2.4:1 on offSoft), so small text on a neutral chip uses
  // this instead. Same value as `sub`, which already clears AA on that ground.
  off:         '#9AA1AC',  offSoft:  '#F0F2F5',  offInk:      '#696F7B',
  info:        '#3B82F6',  infoSoft: '#EAF1FE',  infoInk:     '#306BCA',
  // severity "high" is red-orange so it never collides with brand
  sevHigh:     '#F97316',  sevHighSoft: '#FFEDE0', sevHighInk: '#B15210',

  // Video is its own ground in both themes — a surveillance frame is never
  // "surface", it is the darkest thing on screen so the picture carries.
  video:       '#0B0F14',
  onVideo:     '#FFFFFF',

  // chrome
  ripple:      'rgba(30,30,30,0.08)',
  shadowColor: '#101828',
  brandShadowColor: '#E07E1C',
  switchThumb: '#FFFFFF',
  // Raised surfaces read purely by shadow on a light ground — no border
  // (the kit's "border XOR shadow" rule).
  elevatedBorder: null,
};

// ── DARK ─────────────────────────────────────────────────────────────────────
// Calm, professional, enterprise. Deliberately NOT pure black: #121212 keeps
// OLED smear down and lets #1E1E1E surfaces separate without a border.
// Semantic hues are the light values lifted for contrast against #121212 —
// same identity, readable ground.
export const dark = {
  // surfaces
  bg:          '#121212',
  surface:     '#1E1E1E',
  card:        '#1E1E1E',
  muted:       '#252525',
  mutedAlt:    '#303030',
  scrim:       'rgba(0,0,0,0.66)',
  skeleton:    '#2A2A2A',   // muted is too close to bg to pulse visibly

  // ink
  text:        '#FFFFFF',
  sub:         '#B3B3B3',
  faint:       '#8A8A8A',
  border:      '#343434',

  // brand — same orange, so the app is recognisably Drishyam in both themes.
  // primaryDk is the PRESSED state; on a dark ground it has to go darker still
  // or the press reads as a glow.
  primary:     '#F7983A',
  // On this ground the vivid tone is already 7.55:1 on surface, so ink === vivid
  // for every semantic colour. The two-tier split costs nothing in dark mode.
  primaryInk:  '#F7983A',
  secondary:   '#FFB15C',
  primaryDk:   '#D9801F',
  // Same warm ink as light: the button is orange in both themes, so its label
  // must be too — otherwise the primary CTA changes identity between modes.
  onPrimary:   '#2A1A05',
  // Alpha, not a solid: this same token backs the tab pill (on surface), role
  // badges (on card) and section accents (on bg).
  primarySoft: 'rgba(247,152,58,0.16)',

  ok:          '#3ED88C',  okSoft:   'rgba(62,216,140,0.18)',  okInk:       '#3ED88C',
  warn:        '#FFC043',  warnSoft: 'rgba(255,192,67,0.16)',  warnInk:     '#FFC043',
  critical:    '#FF6B60',  critSoft: 'rgba(255,107,96,0.18)',  criticalSoft: 'rgba(255,107,96,0.18)',  criticalInk: '#FF6B60',
  alarm:       '#C8372C',
  live:        '#FF6B60',
  off:         '#6E7681',  offSoft:  'rgba(160,160,160,0.16)',  offInk:      '#B3B3B3',
  info:        '#64B5F6',  infoSoft: 'rgba(100,181,246,0.16)', infoInk:     '#64B5F6',
  sevHigh:     '#FF8A50',  sevHighSoft: 'rgba(255,138,80,0.18)', sevHighInk: '#FF8A50',

  video:       '#000000',
  onVideo:     '#FFFFFF',

  // chrome
  ripple:      'rgba(255,255,255,0.10)',
  shadowColor: '#000000',
  // A brand-orange drop shadow on a dark ground is a neon glow — exactly what
  // this design brief rules out. Black, and let the surface carry the lift.
  brandShadowColor: '#000000',
  switchThumb: '#E8E8E8',
  // Shadows are near-invisible on dark, so raised surfaces get a hairline
  // instead. This is the one place the "border XOR shadow" rule is relaxed,
  // because on this ground the shadow simply isn't doing the job.
  elevatedBorder: '#2E2E2E',
};

export const palettes = { light, dark };
