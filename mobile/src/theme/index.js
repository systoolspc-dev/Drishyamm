// Drishyam mobile — design system entry point.
//
// This directory replaces the old single `src/theme.js`. Import paths are
// unchanged (`from '../theme'` resolves here), but the surface is now split:
//
//   COLOUR-FREE  → plain imports, same as before
//                  import { spacing, radius, fonts, motion } from '../theme';
//
//   COLOUR-BOUND → the hook, because it depends on the active theme
//                  const { colors, type, shadow, sevOf, isDark } = useTheme();
//                  const styles = useStyles(makeStyles);
//
// `colors`, `type`, `shadow`, `sevOf` and `press` are intentionally NOT
// exported as static values. A file that still expects them fails loudly at
// import time instead of silently rendering a light-coloured island inside the
// dark theme.

export { spacing, radius, fonts, hit, rowMinHeight, cardScale, motion, tabBarClearance } from './tokens';
export { ThemeProvider, ThemeContext, useTheme, useStyles } from './ThemeProvider';
export { getTheme, THEME_MODES } from './createTheme';
export { palettes, light as lightPalette, dark as darkPalette } from './palettes';
