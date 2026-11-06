// Drishyam mobile — COLOUR-FREE design tokens.
//
// Everything in here is identical in every theme, so it stays a plain module
// import and never needs the context. Only colour-bearing tokens (colours,
// type, shadows, severity) are theme-derived — those live in palettes.js and
// are reached through useTheme(). Splitting the two is what keeps theming
// cheap: geometry, spacing and font families never re-render.

// ── Spacing ──────────────────────────────────────────────────────────────────
// 8-point grid with a 4-point sub-grid, the same arrangement Material 3 uses
// (8dp layout grid, 4dp for dense controls). Layout-level rhythm — page
// padding, section gaps, card padding — lands on 8/16/24/32/40. The 4 and 12
// half-steps exist only for INSIDE controls, where an 8pt minimum would make
// icon↔label pairs float apart.
//
// `xl`/`xxl` grew (20→24, 24→32) to buy the extra breathing room the design
// brief asks for; every value is now a multiple of 4.
export const spacing = {
  xs:    4,   // half-step — icon↔label, badge internals
  sm:    8,
  md:   12,   // half-step — dense row gaps
  lg:   16,   // default page/card padding
  xl:   24,
  xxl:  32,
  xxxl: 40,
};

// ── Radius ───────────────────────────────────────────────────────────────────
// Three sizes carry almost everything: controls (md), cards (lg), chips (sm).
// Buttons and inputs share `md` so they read as one family; cards sit at 18,
// inside the 16–20 band the brief specifies.
export const radius = {
  xs:     8,   // thumbnails, tight tiles
  sm:    12,   // chips, icon tiles, small surfaces
  md:    14,   // BUTTONS + INPUTS — one control radius, no exceptions
  lg:    18,   // CARDS
  xl:    24,   // hero/feature surfaces
  sheet: 20,   // bottom sheets (top corners only)
  pill: 999,
  chip:  12,   // alias of `sm` — kept so call sites still read intently
};

// Inter families (loaded in App.jsx). Weight is carried by fontFamily, NEVER
// fontWeight (Android drops custom fonts at fontWeight >= 600 and falls back to
// Roboto — the #1 "looks unprofessional" tell).
export const fonts = {
  reg:  'Inter_400Regular',
  med:  'Inter_500Medium',
  semi: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
};

// Minimum touch target. Anything interactive smaller than this needs hitSlop
// to make up the difference.
export const hit = 44;
export const rowMinHeight = 56;

// The bottom tab bar FLOATS over the scene rather than sitting in the layout,
// so it reserves no space of its own. Every scrolling surface inside the tab
// navigator must add this to its bottom content padding (on top of the safe
// area) or its last row hides under the bar. Lives here — not in AppNavigator —
// because screens importing from the navigator that imports them would be a
// require cycle.
export const tabBarClearance = 92;

// Card press scale lives here (geometry, not colour); the colour half of
// `press` is built per-theme in createTheme.js.
export const cardScale = 0.98;

export const motion = {
  chromeFade: 200,
  autoHide: 3000,
  spinnerDebounce: 200,
  watchdog: 15000,
  // Theme cross-dissolve. The cover fades IN over the outgoing UI, the palette
  // swaps while the screen is fully covered, then the new UI is revealed. Kept
  // short enough to read as a dip, never as a load.
  themeCover: 150,
  themeReveal: 220,
};
