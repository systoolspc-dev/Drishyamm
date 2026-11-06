// Me — operator profile and app settings, grouped into labelled sections
// (Appearance · Notifications · Streaming · Connection · About). Rows are
// icon chip · label · value · chevron only where tappable. The Status row runs
// a REAL connection test against the server. The Appearance section owns the
// app-wide theme choice — it writes to settingsStore, which ThemeProvider
// watches, so the whole app re-colours from this one control. Version is read
// from app.json via expo-constants so the page can never show a stale number —
// bump app.json's "version" each release wave.
//
// SCOPE NOTE: Edit Profile, Change Password and Language are deliberately
// absent. The backend (src/lib/api.js) exposes no endpoint for the first two
// and the app has no localisation layer for the third — shipping rows that
// open a dead end would be worse than not shipping them.
import { useState } from 'react';
import { View, StyleSheet, Alert, ScrollView, Pressable, Switch } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useAuth } from '../lib/authStore';
import { useSettings } from '../lib/settingsStore';
import { useAlarm } from '../lib/alarmStore';
import { useFavorites } from '../lib/favoritesStore';
import { logout, pingServer } from '../lib/api';
import { Card, Avatar, Badge, Button, Txt, SegmentedControl, haptic } from '../components/ui';
import { notify } from '../components/toast';
import { radius, spacing, useTheme, useStyles } from '../theme';

const APP_VERSION = Constants.expoConfig?.version || '0.0.0';

const QUALITY_OPTIONS = [
  { key: 'auto', label: 'Auto' },
  { key: 'main', label: 'HD' },
  { key: 'sub',  label: 'SD' },
];

// 'system' last: the two explicit choices read as the primary decision, with
// "follow the device" as the deferral.
const THEME_OPTIONS = [
  { key: 'light',  label: 'Light', icon: 'sunny-outline' },
  { key: 'dark',   label: 'Dark',  icon: 'moon-outline' },
  { key: 'system', label: 'Auto',  icon: 'phone-portrait-outline' },
];

export default function ProfileScreen() {
  const { colors, isDark, preference, setPreference } = useTheme();
  const styles = useStyles(makeStyles);
  const { user, serverUrl, clearSession } = useAuth();
  const insets = useSafeAreaInsets();
  const [test, setTest] = useState('idle'); // idle | busy | ok | fail

  const quality = useSettings((s) => s.quality);
  const setQuality = useSettings((s) => s.setQuality);
  const buzz = useSettings((s) => s.buzz);
  const setBuzz = useSettings((s) => s.setBuzz);
  const favCount = useFavorites((s) => s.ids.length);

  const onTest = async () => {
    haptic.light();
    setTest('busy');
    try { setTest((await pingServer()) ? 'ok' : 'fail'); }
    catch { setTest('fail'); }
  };

  const onLogout = () => {
    Alert.alert('Sign out', 'Sign out of Drishyam on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => { await logout(); notify.success('Signed out'); await clearSession(); } },
    ]);
  };

  const testValue = { idle: 'Tap to test', busy: 'Checking…', ok: 'Connected', fail: 'Unreachable' }[test];
  const testTint  = test === 'ok' ? colors.okInk : test === 'fail' ? colors.criticalInk : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}
        showsVerticalScrollIndicator={false}
      >
        {/* identity hero */}
        <View style={styles.hero}>
          <Avatar name={user?.name || user?.email} size={72} />
          {/* Role sits BESIDE the name, not stranded under the email. It
              qualifies who this person is, so it belongs on the same line as
              their name — three centred rows in a column read as three separate
              facts, and the badge looked detached from all of them. */}
          <View style={styles.heroName}>
            <Txt t="h1" numberOfLines={1} style={{ flexShrink: 1 }}>{user?.name || 'Operator'}</Txt>
            {!!user?.role && (
              <Badge
                label={String(user.role).toUpperCase()}
                fg={colors.primaryInk} bg={colors.primarySoft}
                style={{ alignSelf: 'center' }}
              />
            )}
          </View>
          {!!user?.email && <Txt t="sub" c={colors.sub} numberOfLines={1}>{user.email}</Txt>}
        </View>

        {/* ── Appearance ─────────────────────────────────────────────────── */}
        <SectionLabel>Appearance</SectionLabel>
        <Card variant="flat" padding="none" style={styles.group}>
          <StackRow
            icon="color-palette-outline"
            label="Theme"
            hint={preference === 'system'
              ? `Following your device · currently ${isDark ? 'dark' : 'light'}`
              : 'Applies across the whole app'}
            last
          >
            <SegmentedControl
              options={THEME_OPTIONS}
              value={preference}
              onChange={setPreference}
              accessibilityLabel="App theme"
            />
          </StackRow>
        </Card>

        {/* ── Notifications ──────────────────────────────────────────────── */}
        <SectionLabel>Notifications</SectionLabel>
        <Card variant="flat" padding="none" style={styles.group}>
          <ToggleRow
            icon="notifications-outline"
            label="Alert buzz"
            hint="Buzz + beep when a new alarm arrives"
            value={buzz}
            onValueChange={(v) => { haptic.select(); setBuzz(v); }}
          />
          {/* try it — rings continuously until STOP, exactly like a real threat */}
          <Row
            icon="flash-outline"
            label="Test alert"
            value="Rings until stopped"
            onPress={() => useAlarm.getState().ring({ title: 'Test alert', body: 'This is how threats ring — tap STOP', threat: true })}
            last
          />
        </Card>

        {/* ── Streaming ──────────────────────────────────────────────────── */}
        <SectionLabel>Streaming</SectionLabel>
        <Card variant="flat" padding="none" style={styles.group}>
          <StackRow
            icon="videocam-outline"
            label="Stream quality"
            hint={quality === 'auto' ? 'HD on Wi-Fi, SD on cellular' : 'Applies to every camera'}
          >
            <SegmentedControl
              options={QUALITY_OPTIONS}
              value={quality}
              onChange={setQuality}
              accessibilityLabel="Stream quality"
            />
          </StackRow>
          <Row icon="heart-outline" label="Favourite cameras" value={favCount ? `${favCount} saved` : 'None yet'} last />
        </Card>

        {/* ── Connection ─────────────────────────────────────────────────── */}
        <SectionLabel>Connection</SectionLabel>
        <Card variant="flat" padding="none" style={styles.group}>
          <Row icon="server-outline" label="Server" value={serverUrl?.replace(/^https?:\/\//, '') || '—'} />
          <Row icon="pulse-outline" label="Status" value={testValue} valueColor={testTint} onPress={test === 'busy' ? undefined : onTest} last />
        </Card>

        {/* ── About ──────────────────────────────────────────────────────── */}
        <SectionLabel>About</SectionLabel>
        <Card variant="flat" padding="none" style={styles.group}>
          <Row icon="shield-checkmark-outline" label="Security" value="Encrypted sign-in" />
          <Row icon="cube-outline" label="Version" value={`v${APP_VERSION}`} />
          <Row icon="information-circle-outline" label="Drishyam VMS" value="Video Management System" last />
        </Card>

        <Button title="Sign out" variant="destructive" icon="log-out-outline" onPress={onLogout} style={{ marginTop: spacing.xl }} />
        <Txt t="caption" c={colors.faint} style={{ textAlign: 'center', marginTop: spacing.lg }}>
          Drishyam VMS · Mobile · v{APP_VERSION}
        </Txt>
      </ScrollView>
    </View>
  );
}

function SectionLabel({ children }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return <Txt t="label" c={colors.sub} style={styles.sectionLabel}>{children}</Txt>;
}

function Row({ icon, label, value, valueColor, onPress, last }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const inner = (
    <>
      <View style={styles.rowIcon}><Ionicons name={icon} size={17} color={colors.sub} /></View>
      <Txt t="bodyMed">{label}</Txt>
      <Txt t="sub" c={valueColor || colors.sub} numberOfLines={1} style={{ marginLeft: 'auto', flexShrink: 1 }}>{value}</Txt>
      {onPress ? <Ionicons name="chevron-forward" size={15} color={colors.faint} style={{ marginLeft: 6 }} /> : null}
    </>
  );
  const base = [styles.row, !last && styles.rowBorder];
  if (!onPress) return <View style={base}>{inner}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => [base, pressed && { opacity: 0.6 }]}
    >
      {inner}
    </Pressable>
  );
}

// A row whose control is too wide to sit beside the label — a 3-way segmented
// control squeezed into the trailing slot would truncate "Stream quality" on a
// small phone. The control drops to its own full-width line instead.
function StackRow({ icon, label, hint, children, last }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.stackRow, !last && styles.rowBorder]}>
      <View style={styles.stackHead}>
        <View style={styles.rowIcon}><Ionicons name={icon} size={17} color={colors.sub} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt t="bodyMed">{label}</Txt>
          {hint ? <Txt t="caption" c={colors.faint}>{hint}</Txt> : null}
        </View>
      </View>
      <View style={{ marginTop: spacing.md }}>{children}</View>
    </View>
  );
}

// Row + native switch. Deliberately the stock RN Switch: it is the platform
// control operators already know, it respects reduced-motion, and it never
// looks oversized.
function ToggleRow({ icon, label, hint, value, onValueChange, disabled, last }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.row, !last && styles.rowBorder, disabled && styles.rowDisabled]}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={17} color={colors.sub} /></View>
      <View style={{ flex: 1 }}>
        <Txt t="bodyMed">{label}</Txt>
        {hint ? <Txt t="caption" c={colors.faint}>{hint}</Txt> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: colors.mutedAlt, true: colors.primary }}
        thumbColor={colors.switchThumb}
        // iOS draws its own off-track behind trackColor.false; without this it
        // stays light grey and glares on the dark theme.
        ios_backgroundColor={colors.mutedAlt}
        accessibilityLabel={label}
      />
    </View>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: spacing.lg },
  heroName: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginTop: spacing.md, maxWidth: '100%',
  },
  sectionLabel: { marginTop: spacing.xl, marginBottom: spacing.sm, marginLeft: spacing.xs },
  group: { paddingHorizontal: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowDisabled: { opacity: 0.55 },
  rowIcon: { width: 32, height: 32, borderRadius: radius.sm, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  stackRow: { paddingVertical: spacing.md },
  stackHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
