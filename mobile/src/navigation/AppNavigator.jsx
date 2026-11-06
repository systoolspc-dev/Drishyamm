// Navigation — Login ⇄ MainTabs (Home · Cameras · Alarms · Me) + LiveView.
// Auth state flips the tree. The tab bar is custom: flat surface, hairline top
// border, and a soft "active pill" behind the focused icon (no rounded-corner
// chrome that fights the border/shadow). Haptic tick on tab switch.
//
// Every piece of navigation chrome — container theme, headers, scene
// backgrounds and the tab bar — is derived from the active theme inside the
// component. They used to be module-scope constants, which is why they could
// never follow a theme change. Swapping the `theme` prop on NavigationContainer
// re-colours in place; it does not remount the tree, so navigation state,
// scroll positions and live video players all survive a theme switch.
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Animated } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../lib/authStore';
import { fonts, radius, spacing, useTheme, useStyles } from '../theme';
import { haptic, BottomSheet, SheetAction, Button } from '../components/ui';

import LoginScreen from '../screens/LoginScreen';
import LiveScreen from '../screens/LiveScreen';
import MenuScreen from '../screens/MenuScreen';
import HomeScreen from '../screens/HomeScreen';
import CamerasScreen from '../screens/CamerasScreen';
import SitesScreen from '../screens/SitesScreen';
import SiteDetailsScreen from '../screens/SiteDetailsScreen';
import UsersScreen from '../screens/UsersScreen';
import UserDetailsScreen from '../screens/UserDetailsScreen';
import AlertsScreen from '../screens/AlertsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import LiveViewScreen from '../screens/LiveViewScreen';
import LiveWallScreen from '../screens/LiveWallScreen';
import PlaybackScreen from '../screens/PlaybackScreen';

const Stack = createNativeStackNavigator();
const Tabs  = createBottomTabNavigator();

// global ref so app-level chrome (AlarmBanner) can navigate without props
export const navigationRef = createNavigationContainerRef();

// Internal geometry of the floating bar. The space it hovers over is reserved
// by screens via `tabBarClearance` from the theme tokens — see the note there.
const TAB_BAR_PAD = 6;      // inner padding, also the indicator's left origin
const TAB_PILL_INSET = 4;   // horizontal gap between indicator and slot edge

// The FAB is NOT a route. It renders as a slot inside the custom tab bar, so
// there is no dummy screen to navigate to and no tabPress to preventDefault —
// it just opens a sheet. Four real tabs, five visual slots, FAB at index 2.
const FAB_SLOT = 2;

const TAB_ICONS = {
  Home:   ['home', 'home-outline'],
  Live:   ['videocam', 'videocam-outline'],
  Alerts: ['notifications', 'notifications-outline'],
  Menu:   ['menu', 'menu-outline'],
};

// Visual slot for a tab index, skipping the slot the FAB occupies.
const slotOf = (i) => (i < FAB_SLOT ? i : i + 1);

// Spread the React Navigation base theme so the `fonts` block (required in v7)
// comes along; only the colours are ours. `dark: true` is what makes native
// bits React Navigation owns — the native-stack header, the push/pop
// transition backdrop — render dark instead of light.
function buildNavTheme(theme) {
  const base = theme.isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: theme.isDark,
    colors: {
      ...base.colors,
      primary:      theme.colors.primary,
      background:   theme.colors.bg,
      card:         theme.colors.surface,
      text:         theme.colors.text,
      border:       theme.colors.border,
      notification: theme.colors.critical,
    },
  };
}

function buildHeaderOptions(colors) {
  return {
    headerStyle: { backgroundColor: colors.surface },
    headerTintColor: colors.text,
    headerTitleStyle: { fontFamily: fonts.bold, fontSize: 18, color: colors.text },
    headerShadowVisible: false,
  };
}

// Floating tab bar. It detaches from the screen edge and rides on its own
// shadow, which is what gives the app its "premium" read — but the float is
// only safe because every scrolling screen pads its content by TAB_BAR_CLEARANCE
// so nothing can hide underneath it.
//
// The active indicator is a rounded pill that ANIMATES between tabs rather than
// snapping: one shared translateX spring, driven natively, so it costs nothing
// on the JS thread. That is the only motion here — no icon bounce, no scale.
function TabBar({ state, descriptors, navigation, onFabPress }) {
  const { colors, press, brandShadow } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [barW, setBarW] = useState(0);

  const count = state.routes.length;      // 4 real tabs
  const slots = count + 1;                // + the FAB slot
  const slotW = barW ? (barW - TAB_BAR_PAD * 2) / slots : 0;
  const indicator = useRef(new Animated.Value(slotOf(state.index))).current;

  useEffect(() => {
    Animated.spring(indicator, {
      // animate in SLOT space, not tab-index space, so the indicator jumps the
      // FAB gap in one motion instead of pausing under it
      toValue: slotOf(state.index),
      useNativeDriver: true,
      // Critically damped-ish: settles fast, never overshoots into a wobble.
      stiffness: 260, damping: 26, mass: 0.7,
    }).start();
  }, [state.index, indicator]);

  return (
    <View pointerEvents="box-none" style={[styles.tabWrap, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
      <View style={styles.tabBar} onLayout={(e) => setBarW(e.nativeEvent.layout.width)}>
        {slotW > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tabIndicator,
              {
                width: slotW - TAB_PILL_INSET * 2,
                left: TAB_BAR_PAD + TAB_PILL_INSET,
                transform: [{
                  translateX: indicator.interpolate({
                    inputRange: [0, slots - 1],
                    outputRange: [0, slotW * (slots - 1)],
                  }),
                }],
              },
            ]}
          />
        ) : null}

        {/* Build the tabs, then splice the FAB in as its OWN flex slot — it has
            to be a sibling, not a wrapper, or the five slots stop being equal
            and the indicator maths drifts. */}
        {(() => {
          const items = state.routes.map((route, index) => {
            const focused = state.index === index;
            const label = descriptors[route.key].options.title ?? route.name;
            const [on, off] = TAB_ICONS[route.name] || ['ellipse', 'ellipse-outline'];
            const onPress = () => {
              const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !e.defaultPrevented) { haptic.select(); navigation.navigate(route.name); }
            };
            return (
              <Pressable
                key={route.key}
                onPress={onPress}
                android_ripple={{ color: press.ripple, borderless: true, radius: 34 }}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={label}
                style={styles.tabItem}
              >
                <Ionicons name={focused ? on : off} size={21} color={focused ? colors.primaryInk : colors.faint} />
                <Text style={[styles.tabLabel, focused && styles.tabLabelOn]} numberOfLines={1}>{label}</Text>
              </Pressable>
            );
          });
          items.splice(FAB_SLOT, 0, (
            <View key="fab" style={styles.fabSlot} pointerEvents="box-none">
              <Pressable
                onPress={() => { haptic.medium(); onFabPress(); }}
                android_ripple={{ color: 'rgba(255,255,255,0.25)', borderless: true, radius: 24 }}
                accessibilityRole="button"
                accessibilityLabel="Add"
                style={({ pressed }) => [styles.fab, brandShadow, pressed && { backgroundColor: colors.primaryDk }]}
              >
                <Ionicons name="add" size={26} color={colors.onPrimary} />
              </Pressable>
            </View>
          ));
          return items;
        })()}
      </View>
    </View>
  );
}

function MainTabs() {
  const { colors } = useTheme();
  const [addOpen, setAddOpen] = useState(false);
  const screenOptions = useMemo(() => ({
    ...buildHeaderOptions(colors),
    headerStyle: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, shadowColor: 'transparent' },
    sceneStyle: { backgroundColor: colors.bg },
    // every tab root draws its own header, so the scene owns the safe area
    headerShown: false,
  }), [colors]);

  return (
    <>
      <Tabs.Navigator
        tabBar={(props) => <TabBar {...props} onFabPress={() => setAddOpen(true)} />}
        screenOptions={screenOptions}
      >
        <Tabs.Screen name="Home"   component={HomeScreen} />
        <Tabs.Screen name="Live"   component={LiveScreen} />
        <Tabs.Screen name="Alerts" component={AlertsScreen} />
        <Tabs.Screen name="Menu"   component={MenuScreen} />
      </Tabs.Navigator>

      {/* FAB sheet. Built to take Add Site / Add NVR / Scan QR later without
          changing the interaction — see docs/phase-1-plan.md T1/T5.
          Add Camera is DISABLED and says why: the mobile API exposes no camera
          -creation route (src/lib/api.js), and on a security console a control
          that looks live but does nothing is a safety problem, not a UX one.
          It goes live in Sprint 3, behind the API inventory. */}
      <BottomSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add"
        footer={<Button title="Cancel" variant="secondary" onPress={() => setAddOpen(false)} style={{ marginTop: spacing.sm }} />}
      >
        <SheetAction
          icon="videocam-outline"
          label="Add Camera"
          disabled
          reason="Available once camera provisioning is wired to the app — use the web console for now."
        />
      </BottomSheet>
    </>
  );
}

export default function AppNavigator() {
  const token = useAuth((s) => s.token);
  const theme = useTheme();
  const navTheme = useMemo(() => buildNavTheme(theme), [theme]);
  const screenOptions = useMemo(
    () => ({ ...buildHeaderOptions(theme.colors), contentStyle: { backgroundColor: theme.colors.bg } }),
    [theme.colors]
  );

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      <Stack.Navigator screenOptions={screenOptions}>
        {token ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
            {/* Cameras and Profile moved OUT of the tab bar when the IA went to
                Home · Live · (+) · Alerts · Menu. They keep their route names so
                every existing navigate('Cameras') call site still resolves —
                React Navigation walks up to this stack to find them. */}
            <Stack.Screen name="Cameras" component={CamerasScreen} options={{ title: 'Cameras' }} />
            {/* Sites reached from Menu, same shape as Cameras: a stack screen
                drawing its own ScreenHeader, so it gets a back button and NOT a
                second copy of the tab bar. */}
            <Stack.Screen name="Sites" component={SitesScreen} options={{ headerShown: false }} />
            <Stack.Screen name="SiteDetails" component={SiteDetailsScreen} options={{ headerShown: false }} />
            {/* Admin-only. The screens check the session role AND the server
                enforces it (adminAuth → 403), so registering the routes here
                exposes nothing on its own. */}
            <Stack.Screen name="Users" component={UsersScreen} options={{ headerShown: false }} />
            <Stack.Screen name="UserDetails" component={UserDetailsScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
            {/* immersive player — its own on-frame back/controls */}
            <Stack.Screen name="LiveView" component={LiveViewScreen} options={{ headerShown: false }} />
            <Stack.Screen name="LiveWall" component={LiveWallScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Playback" component={PlaybackScreen} options={{ headerShown: false }} />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const makeStyles = ({ colors, tabBarShadow, isDark }) => StyleSheet.create({
  // Transparent gutter that holds the bar clear of the screen edge. box-none so
  // the empty area beside the bar never eats a touch meant for the screen.
  tabWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: spacing.lg,
    backgroundColor: 'transparent',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: TAB_BAR_PAD,
    // On dark the shadow has nothing to darken, so the bar gets a hairline to
    // separate it from the page — same rule as raised Cards.
    borderWidth: isDark ? StyleSheet.hairlineWidth : 0,
    borderColor: colors.border,
    ...tabBarShadow,
  },
  tabIndicator: {
    position: 'absolute', top: TAB_PILL_INSET, bottom: TAB_PILL_INSET,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySoft,
  },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: spacing.sm, minHeight: 52 },
  // The FAB owns a full slot so the five slots stay equal width. It sits
  // CENTRED IN the bar rather than protruding above it: it used to carry
  // marginTop -20, which in a centred flex slot lifts it ~10pt off the row and
  // left it visibly misaligned with the four tab icons beside it. At 48pt it
  // also stays under the tabItem's 52pt minHeight, so the bar keeps its height
  // instead of growing around the button.
  fabSlot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  fab: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  tabLabel: { fontFamily: fonts.med, fontSize: 11, letterSpacing: 0.2, color: colors.faint },
  tabLabelOn: { fontFamily: fonts.semi, color: colors.primaryInk },
});
