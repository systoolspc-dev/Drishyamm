// Drishyam mobile — root. Loads Inter (holds splash to avoid flash-of-system-
// font), wires providers, a global offline banner, and the Toast host.
//
// Provider order matters: ThemeProvider sits ABOVE everything that paints, so
// the whole tree — navigation chrome, error boundaries, toasts and the alarm
// banner — re-colours from one context update. It reads the persisted
// appearance preference, which is why the splash is also held until the
// settings store has hydrated: the restored theme must be known before the
// first frame or a dark-mode user gets a white flash on every cold start.
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import Toast from 'react-native-toast-message';
import {
  useFonts,
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
} from '@expo-google-fonts/inter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppNavigator from './src/navigation/AppNavigator';
import { OfflineBanner } from './src/components/ui';
import ErrorBoundary from './src/components/ErrorBoundary';
import AlertWatcher from './src/components/AlertWatcher';
import PushRegistrar from './src/components/PushRegistrar';
import AlarmBanner from './src/components/AlarmBanner';
import { toastConfig } from './src/components/toast';
import { useAuth } from './src/lib/authStore';
import { useSettings } from './src/lib/settingsStore';
import { useFavorites } from './src/lib/favoritesStore';
import { initAlertFx } from './src/lib/alertFx';
import { ThemeProvider, useTheme } from './src/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
  },
});

export default function App() {
  useEffect(() => {
    useAuth.getState().hydrate();
    useSettings.getState().hydrate();
    useFavorites.getState().hydrate();
    initAlertFx();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <Root />
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { colors, statusBarStyle } = useTheme();
  const authHydrated     = useAuth((s) => s.hydrated);
  const settingsHydrated = useSettings((s) => s.hydrated);
  // Favourites gate the splash too — not because they're critical, but because
  // a heart that pops from empty to filled a beat after the grid paints is the
  // same class of flicker the theme gate exists to prevent.
  const favesHydrated    = useFavorites((s) => s.hydrated);

  const [fontsLoaded] = useFonts({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
  });

  const ready = fontsLoaded && authHydrated && settingsHydrated && favesHydrated;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Keep the native splash up until fonts + session + appearance are ready; if
  // this view ever shows (slow storage), it carries the brand, not a bare
  // spinner — and it is already wearing the restored theme.
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <Image source={require('./assets/images/drishyam-logo.svg')} style={{ width: 150, height: 98 }} contentFit="contain" />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      {/* explicit, not "auto": the app theme can deliberately differ from the
          device colour scheme (user picked Light on a dark phone) */}
      <StatusBar style={statusBarStyle} />
      <ErrorBoundary>
        <AppNavigator />
      </ErrorBoundary>
      {/* network banner is non-critical: if the native module is unavailable
          (e.g. some Expo Go builds), drop it silently instead of crashing. */}
      <ErrorBoundary fallback={null}>
        <OfflineBanner />
      </ErrorBoundary>
      {/* foreground alarm buzz — harmless if queries fail; never crashes the app */}
      <ErrorBoundary fallback={null}>
        <AlertWatcher />
      </ErrorBoundary>
      {/* real OS push registration (background/killed delivery) — best-effort */}
      <ErrorBoundary fallback={null}>
        <PushRegistrar />
      </ErrorBoundary>
      {/* ringing-alarm banner — sits above every screen until STOP is tapped */}
      <ErrorBoundary fallback={null}>
        <AlarmBanner />
      </ErrorBoundary>
      <Toast config={toastConfig} />
    </>
  );
}
