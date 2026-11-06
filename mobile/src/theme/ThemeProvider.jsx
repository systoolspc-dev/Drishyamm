// Drishyam mobile — theme context, provider and the two hooks every consumer
// uses. Nothing else in the app touches palettes directly.
//
//   const { colors, type, shadow, sevOf, isDark } = useTheme();
//   const styles = useStyles(makeStyles);   // makeStyles = (theme) => StyleSheet.create({...})
//
// WHY a factory instead of inline styles: StyleSheet.create() used to run once
// at module scope, which is exactly why the old build could never be themed.
// useStyles() keeps that "build once" property — sheets are cached per
// (factory, mode) in a WeakMap — while making the sheet a function of the
// active theme. No allocation per render, no prop drilling.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { View, Animated, StyleSheet, useColorScheme } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { useSettings } from '../lib/settingsStore';
import { getTheme } from './createTheme';
import { motion } from './tokens';

// Default = light, so a component rendered outside the provider (or a class
// component reading contextType before mount) still gets a valid theme instead
// of undefined.
export const ThemeContext = createContext(getTheme('light'));

export function useTheme() {
  return useContext(ThemeContext);
}

// factory -> Map<mode, StyleSheet>. WeakMap so a factory from an unmounted
// module can be collected with its sheets.
const sheetCache = new WeakMap();

export function useStyles(factory) {
  const theme = useTheme();
  let byMode = sheetCache.get(factory);
  if (!byMode) {
    byMode = new Map();
    sheetCache.set(factory, byMode);
  }
  let sheet = byMode.get(theme.mode);
  if (!sheet) {
    sheet = factory(theme);
    byMode.set(theme.mode, sheet);
  }
  return sheet;
}

// 'system' resolves against the device; anything else is an explicit user
// choice and wins over the device setting.
function resolveMode(preference, systemScheme) {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemScheme === 'dark' ? 'dark' : 'light';
}

export function ThemeProvider({ children }) {
  const preference   = useSettings((s) => s.theme);
  const setPreference = useSettings((s) => s.setTheme);
  const systemScheme = useColorScheme();

  const target = resolveMode(preference, systemScheme);

  // `mode` deliberately LAGS `target`: the palette is swapped only while the
  // cross-dissolve cover is fully opaque, so the switch is never seen
  // mid-flight. Colours are the only thing changing, so there is no layout
  // pass and nothing can jump.
  const [mode, setMode] = useState(target);
  const [fading, setFading] = useState(false);
  const cover = useRef(new Animated.Value(0)).current;

  // Phase 1 — cover the outgoing UI with the INCOMING background colour.
  useEffect(() => {
    if (target === mode) return;
    setFading(true);
    const anim = Animated.timing(cover, {
      toValue: 1,
      duration: motion.themeCover,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished) setMode(target); });
    return () => anim.stop();
  }, [target, mode, cover]);

  // Phase 2 — the new palette has committed underneath; reveal it. Runs after
  // the commit that changed `mode`, so the tree is already repainted.
  useEffect(() => {
    if (!fading) return;
    const anim = Animated.timing(cover, {
      toValue: 0,
      duration: motion.themeReveal,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished) setFading(false); });
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const theme = getTheme(mode);

  // Android window background (and the iOS root view). Without this the native
  // background stays white and flashes between navigation transitions and on
  // over-scroll, no matter what the JS tree paints.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.colors.bg).catch(() => {});
  }, [theme]);

  const value = useMemo(
    () => ({ ...theme, preference, setPreference, systemScheme }),
    [theme, preference, setPreference, systemScheme]
  );

  // The cover wears the INCOMING background so the reveal dissolves content in
  // over its own ground — no colour shift during the fade-out.
  const coverColor = getTheme(target).colors.bg;

  return (
    <ThemeContext.Provider value={value}>
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        {children}
        {fading ? (
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: coverColor, opacity: cover }]}
          />
        ) : null}
      </View>
    </ThemeContext.Provider>
  );
}

const styles = StyleSheet.create({
  // Above every piece of app chrome, including AlarmBanner (zIndex 200).
  cover: { zIndex: 9999 },
});
