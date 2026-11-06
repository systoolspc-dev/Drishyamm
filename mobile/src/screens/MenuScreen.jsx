// Menu — the fifth tab, and the parent for everything that isn't a primary
// destination. Profile lives behind this rather than owning a tab slot.
//
// EVERY ROW IN THE DESIGN IS RENDERED, but a row whose destination does not
// exist yet carries a "Soon" chip instead of a chevron and explains itself when
// tapped. Six of the thirteen are live today; the rest need a screen or an
// endpoint (see docs/phase-1-plan.md, Sprint 3). Showing the full information
// architecture is useful — it is the product map — but a row that looks
// identical to a working one and opens a blank page is not.
import { useMemo, useState } from 'react';
import { View, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/authStore';
import { useFavorites } from '../lib/favoritesStore';
import { logout, listAiEvents } from '../lib/api';
import { Card, Avatar, Txt, Button, BottomSheet, IconButton, haptic } from '../components/ui';
import { notify } from '../components/toast';
import { radius, spacing, tabBarClearance, useTheme, useStyles } from '../theme';

const APP_VERSION = Constants.expoConfig?.version || '0.0.0';
const FRESH_WINDOW_MS = 60 * 60 * 1000;

// `soon` carries the REASON, not just a flag — the row shows it on tap, so the
// answer to "why can't I?" lives next to the thing that can't.
const SECTIONS = [
  {
    label: 'Monitoring',
    items: [
      { key: 'sites',    icon: 'business-outline',    label: 'Sites', hint: 'Every recorder and its cameras', to: 'Sites' },
      { key: 'cameras',  icon: 'videocam-outline',    label: 'Cameras', hint: 'Browse every camera by site', to: 'Cameras' },
      { key: 'ai',       icon: 'analytics-outline',   label: 'AI Analytics',
        soon: 'The analytics dashboards are web-only today. Detections themselves are in Alerts.' },
      { key: 'rec',      icon: 'film-outline',        label: 'Recorded Videos', hint: 'Pick a camera to browse its clips', to: 'Cameras', params: { pick: 'playback' } },
      { key: 'map',      icon: 'map-outline',         label: 'Map View',
        soon: 'The server doesn’t return coordinates for sites yet, so there is nothing to plot.' },
      { key: 'live',     icon: 'play-circle-outline', label: 'Live View', hint: 'Hero player and camera grid', to: 'Live' },
    ],
  },
  {
    label: 'Management',
    items: [
      { key: 'reports',  icon: 'bar-chart-outline',   label: 'Reports',
        soon: 'Reporting isn’t exposed to the mobile API yet.' },
      // adminOnly: the server gates /admin/* on the admin role (403 otherwise),
      // so a non-admin sees the row LOCKED rather than opening a screen that
      // could only ever show a refusal.
      { key: 'users',    icon: 'people-outline',      label: 'Users & Roles', hint: 'Accounts, roles and access', to: 'Users', adminOnly: true },
      { key: 'settings', icon: 'settings-outline',    label: 'Settings', hint: 'Appearance, notifications, streaming', to: 'Profile' },
    ],
  },
  {
    label: 'Support',
    items: [
      { key: 'help',     icon: 'help-circle-outline', label: 'Help & Support',
        soon: 'No in-app help centre yet — contact your Drishyam administrator.' },
      { key: 'about',    icon: 'information-circle-outline', label: 'About Drishyam', hint: `Version ${APP_VERSION}`, sheet: 'about' },
      { key: 'news',     icon: 'sparkles-outline',    label: 'What’s New',
        soon: 'Release notes aren’t published to the app yet.' },
    ],
  },
];

export default function MenuScreen({ navigation }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { user, clearSession } = useAuth();
  const favCount = useFavorites((s) => s.ids.length);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [soon, setSoon] = useState(null); // { label, reason }

  // shared cache with Home/Alerts — free, and keeps the bell honest
  const { data: events = [] } = useQuery({
    queryKey: ['ai-events'], queryFn: () => listAiEvents({ limit: 100 }), staleTime: 30_000,
  });
  const freshCount = useMemo(
    () => events.filter((e) => e.ts && Date.now() - new Date(e.ts).getTime() < FRESH_WINDOW_MS).length,
    [events]
  );

  // The design shows "Last login: …". The session payload carries only
  // name/email/role, so this uses the field ONLY if the backend actually sends
  // one and otherwise states something true about the session instead of
  // inventing a timestamp.
  const lastLogin = user?.lastLogin || user?.lastLoginAt || user?.last_login;
  const secureSub = lastLogin
    ? `Last login: ${new Date(lastLogin).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'Encrypted sign-in · stored in the device keystore';

  const onLogout = () => {
    Alert.alert('Sign out', 'Sign out of Drishyam on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => { await logout(); notify.success('Signed out'); await clearSession(); } },
    ]);
  };

  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';

  // An admin-only row for a non-admin becomes a locked row carrying its reason,
  // so Row keeps ONE notion of "you can't open this" instead of two.
  const resolve = (item) => (item.adminOnly && !isAdmin
    ? { ...item, to: undefined, locked: 'Only administrators can view or manage accounts. Your role does not permit it.' }
    : item);

  const press = (item) => {
    if (item.locked) { haptic.light(); setSoon({ label: item.label, reason: item.locked }); return; }
    if (item.soon) { haptic.light(); setSoon({ label: item.label, reason: item.soon }); return; }
    haptic.light();
    if (item.sheet === 'about') { setAboutOpen(true); return; }
    if (item.to) navigation.navigate(item.to, item.params);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Txt t="h1" style={{ flex: 1 }}>Menu</Txt>
        <View>
          <IconButton
            icon="notifications-outline" variant="tinted"
            onPress={() => navigation.navigate('Alerts')}
            accessibilityLabel={freshCount ? `Alerts, ${freshCount} in the last hour` : 'Alerts'}
          />
          {freshCount > 0 && (
            <View style={styles.bellDot} pointerEvents="none">
              <Txt t="badge" c={colors.onVideo} style={styles.bellDotText}>
                {freshCount > 9 ? '9+' : freshCount}
              </Txt>
            </View>
          )}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: tabBarClearance + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* identity */}
        <Card variant="flat" padding="none" onPress={() => navigation.navigate('Profile')} style={styles.profileCard}>
          <Avatar name={user?.name || user?.email} size={48} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt t="titleSm" numberOfLines={1}>{user?.name || 'Operator'}</Txt>
            <Txt t="caption" c={colors.sub} numberOfLines={1}>{user?.email || 'Signed in'}</Txt>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.faint} />
        </Card>

        {/* security */}
        <Pressable
          onPress={() => { haptic.light(); navigation.navigate('Profile'); }}
          accessibilityRole="button"
          accessibilityLabel={`Your account is secure. ${secureSub}`}
          style={({ pressed }) => [styles.secure, pressed && { opacity: 0.75 }]}
        >
          <View style={styles.secureIcon}><Ionicons name="shield-checkmark" size={17} color={colors.okInk} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt t="bodyMed" c={colors.okInk} numberOfLines={1}>Your Account is Secure</Txt>
            <Txt t="caption" c={colors.sub} numberOfLines={1}>{secureSub}</Txt>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.okInk} />
        </Pressable>

        {SECTIONS.map((section) => (
          <View key={section.label}>
            <Txt t="label" c={colors.sub} style={styles.sectionLabel}>{section.label}</Txt>
            {section.items.map((raw) => {
              const item = resolve(raw);
              return (
                <Row
                  key={item.key}
                  item={item}
                  hint={item.key === 'cameras' && favCount ? `${favCount} favourite${favCount === 1 ? '' : 's'}` : item.hint}
                  onPress={() => press(item)}
                />
              );
            })}
          </View>
        ))}

        <Txt t="label" c={colors.sub} style={styles.sectionLabel}>Account</Txt>
        <Pressable
          onPress={onLogout}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          style={({ pressed }) => [styles.logout, pressed && { opacity: 0.75 }]}
        >
          <View style={styles.logoutIcon}><Ionicons name="power" size={17} color={colors.criticalInk} /></View>
          <Txt t="bodyMed" c={colors.criticalInk} style={{ flex: 1 }}>Logout</Txt>
        </Pressable>

        <Txt t="caption" c={colors.faint} style={styles.version}>v{APP_VERSION}</Txt>
      </ScrollView>

      {/* why a row isn't live yet */}
      <BottomSheet
        visible={!!soon}
        onClose={() => setSoon(null)}
        title={soon?.label}
        footer={<Button title="Close" variant="secondary" onPress={() => setSoon(null)} style={{ marginTop: spacing.sm }} />}
      >
        <View style={styles.soonBody}>
          <Ionicons name="time-outline" size={22} color={colors.sub} />
          <Txt t="sub" c={colors.sub} style={{ flex: 1 }}>{soon?.reason}</Txt>
        </View>
      </BottomSheet>

      <BottomSheet visible={aboutOpen} onClose={() => setAboutOpen(false)} title="About Drishyam">
        <View style={styles.aboutHead}>
          <View style={styles.aboutMark}><Ionicons name="eye" size={22} color={colors.primaryInk} /></View>
          <View style={{ flex: 1 }}>
            <Txt t="titleSm">Drishyam VMS</Txt>
            <Txt t="caption" c={colors.sub}>Vision. Intelligence. Security.</Txt>
          </View>
        </View>
        <AboutRow label="Version" value={`v${APP_VERSION}`} />
        <AboutRow label="Sign-in" value="Encrypted (Keychain / Keystore)" />
        <AboutRow label="Platform" value="Video Management System" last />
      </BottomSheet>
    </View>
  );
}

function Row({ item, hint, onPress }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  // Two different reasons a row can't be opened, and they must not be worded
  // the same: `soon` is "not built yet", `locked` is "not yours to open".
  const locked = !!item.locked;
  const unavailable = !!item.soon || locked;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      accessibilityRole="button"
      accessibilityLabel={
        locked ? `${item.label}, administrator access required`
          : unavailable ? `${item.label}, not available yet`
          : (hint ? `${item.label}. ${hint}` : item.label)
      }
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.muted }]}
    >
      <View style={styles.rowIcon}>
        <Ionicons name={item.icon} size={18} color={unavailable ? colors.faint : colors.primaryInk} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="bodyMed" c={unavailable ? colors.sub : undefined} numberOfLines={1}>{item.label}</Txt>
        {hint ? <Txt t="caption" c={colors.faint} numberOfLines={1}>{hint}</Txt> : null}
      </View>
      {locked ? (
        <View style={styles.soonChip}>
          <Ionicons name="lock-closed" size={10} color={colors.sub} />
          <Txt t="badge" c={colors.sub}>ADMIN</Txt>
        </View>
      ) : unavailable ? (
        <View style={styles.soonChip}><Txt t="badge" c={colors.sub}>SOON</Txt></View>
      ) : (
        <Ionicons name="chevron-forward" size={16} color={colors.faint} />
      )}
    </Pressable>
  );
}

function AboutRow({ label, value, last }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.aboutRow, !last && styles.rowBorder]}>
      <Txt t="sub">{label}</Txt>
      <Txt t="sub" c={colors.sub} numberOfLines={1} style={{ marginLeft: 'auto', flexShrink: 1 }}>{value}</Txt>
    </View>
  );
}

const makeStyles = ({ colors, isDark }) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  bellDot: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, paddingHorizontal: 4,
    borderRadius: 9, backgroundColor: colors.alarm,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.bg,
  },
  bellDotText: { fontSize: 9, lineHeight: 12 },

  profileCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },

  secure: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.okSoft, borderRadius: radius.lg,
    borderWidth: 1, borderColor: isDark ? 'rgba(62,216,140,0.35)' : '#CFEBDC',
    padding: spacing.md, marginTop: spacing.md,
  },
  secureIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },

  sectionLabel: { marginTop: spacing.xl, marginBottom: spacing.sm, marginLeft: spacing.xs },

  // Each row is its own card, as in the design — a stack of separate surfaces
  // reads as a list of destinations rather than one grouped setting block.
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.md, minHeight: 60, marginBottom: spacing.sm,
  },
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  // row layout: the locked variant carries a padlock beside its label
  soonChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.muted, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3,
  },

  logout: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.critSoft, borderRadius: radius.lg,
    borderWidth: 1, borderColor: isDark ? 'rgba(255,107,96,0.35)' : '#F8D3D0',
    paddingHorizontal: spacing.md, minHeight: 60,
  },
  logoutIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },

  version: { textAlign: 'center', marginTop: spacing.lg },

  soonBody: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.sm },
  aboutHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingBottom: spacing.md },
  aboutMark: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  aboutRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
});
