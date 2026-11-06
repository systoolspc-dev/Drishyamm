// User Details — one account, from GET /api/admin/users/:id.
//
// That response carries the user, their cameras (each with its group) and their
// subscription. Everything on this screen comes from those three, and sections
// with no data behind them are ABSENT rather than empty:
//   · no phone number in the API        → no phone row
//   · no last-login / 2FA fields        → no security rows
//   · no permissions endpoint at all    → no Role Permissions section
//   · no readable audit log             → no Recent Activity section
// The backend does write audit entries (utils/audit) but exposes no route to
// read them, so there is nothing this client could honestly display.
//
// The ONE mutating action the admin API supports is PUT
// /admin/users/:id/toggle-status. It is destructive, so it confirms first,
// shows its own progress, and reports what the server actually said.
import { useMemo, useState, useCallback } from 'react';
import { View, ScrollView, StyleSheet, Pressable, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getUserDetail, toggleUserStatus } from '../lib/api';
import { useAuth } from '../lib/authStore';
import { roleStyle, statusStyle, sitesForCameras, formatJoined } from '../lib/users';
import {
  Card, Txt, EmptyState, ScreenHeader, IconButton, Avatar,
  BottomSheet, SheetAction, Skeleton, haptic,
} from '../components/ui';
import { notify } from '../components/toast';
import { radius, spacing, useTheme, useStyles } from '../theme';

export default function UserDetailsScreen({ navigation, route }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const userId = route.params?.userId;
  const me = useAuth((s) => s.user);
  const isAdmin = String(me?.role || '').toLowerCase() === 'admin';
  const [moreOpen, setMoreOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-user', userId],
    queryFn: () => getUserDetail(userId),
    enabled: isAdmin && userId != null,
  });

  const user = data?.user || null;
  const cameras = data?.cameras || [];
  const sites = useMemo(() => sitesForCameras(cameras), [cameras]);

  const toggle = useMutation({
    mutationFn: () => toggleUserStatus(userId),
    onSuccess: (updated) => {
      // Refresh both the detail and the list so the row can't disagree with
      // the screen you just changed it from.
      qc.invalidateQueries({ queryKey: ['admin-user', userId] });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      notify.success(updated?.isActive ? 'User reactivated' : 'User deactivated');
    },
    onError: (e) => {
      // The server refuses to suspend another admin. Show ITS message — it is
      // more specific than anything this screen could guess.
      notify.error('Could not change status', e?.response?.data?.message || 'The server rejected the request.');
    },
  });

  const confirmToggle = useCallback(() => {
    if (!user) return;
    haptic.medium();
    setMoreOpen(false);
    const suspending = user.isActive !== false;
    Alert.alert(
      suspending ? 'Deactivate user?' : 'Reactivate user?',
      suspending
        ? `${user.name || user.email} will be signed out and will no longer be able to sign in to Drishyam on any device. Their cameras and recordings are not deleted.`
        : `${user.name || user.email} will be able to sign in to Drishyam again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: suspending ? 'Deactivate' : 'Reactivate',
          style: suspending ? 'destructive' : 'default',
          onPress: () => toggle.mutate(),
        },
      ]
    );
  }, [user, toggle]);

  if (!isAdmin) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader title="User Details" onBack={() => navigation.goBack()} />
        <EmptyState
          icon="lock-closed-outline"
          title="Administrator access required"
          subtitle="Only administrators can view account details."
          action="Back" onAction={() => navigation.goBack()}
        />
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader title={route.params?.name || 'User Details'} onBack={() => navigation.goBack()} />
        <View style={styles.page}>
          <Skeleton width="100%" height={150} r={radius.lg} />
          <Skeleton width="100%" height={190} r={radius.lg} style={{ marginTop: spacing.lg }} />
          <Skeleton width="100%" height={120} r={radius.lg} style={{ marginTop: spacing.lg }} />
        </View>
      </View>
    );
  }

  if (error || !user) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader title={route.params?.name || 'User Details'} onBack={() => navigation.goBack()} />
        <EmptyState
          icon={error ? 'cloud-offline-outline' : 'person-outline'}
          title={error ? 'Unable to load user' : 'User not found'}
          subtitle={error?.response?.status === 403
            ? 'The server refused this request. Administrator access is required.'
            : error ? 'Check your connection and try again.'
            : 'This account no longer exists.'}
          action={error ? 'Try Again' : 'Back'}
          onAction={() => (error ? refetch() : navigation.goBack())}
        />
      </View>
    );
  }

  const role = roleStyle(user.role);
  const status = statusStyle(user);
  const joined = formatJoined(user.joined);
  const suspending = user.isActive !== false;
  // Mirrors the server rule in toggleUserStatus: admins cannot be suspended.
  const selfOrAdmin = String(user.role || '').toLowerCase() === 'admin';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScreenHeader
        title="User Details"
        onBack={() => navigation.goBack()}
        right={
          <IconButton
            icon="ellipsis-horizontal" variant="plain"
            onPress={() => { haptic.light(); setMoreOpen(true); }}
            accessibilityLabel="User actions"
          />
        }
      />

      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + spacing.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {/* PROFILE. Initials, not a portrait — the API has no avatar field and
            a generated face would be inventing a likeness for a real person. */}
        <Card variant="flat" style={styles.profile}>
          <Avatar name={user.name || user.email} size={72} />
          <Txt t="h2" numberOfLines={1} style={{ marginTop: spacing.sm }}>{user.name || 'Unnamed user'}</Txt>
          {user.email ? <Txt t="sub" c={colors.sub} numberOfLines={1}>{user.email}</Txt> : null}
          <View style={styles.profileBadges}>
            <View style={[styles.pill, { backgroundColor: colors[`${role.tint}Soft`] || colors.muted }]}>
              <Ionicons name={role.icon} size={12} color={colors[`${role.tint}Ink`] || colors.sub} />
              <Txt t="badge" c={colors[`${role.tint}Ink`] || colors.sub}>{role.label.toUpperCase()}</Txt>
            </View>
            <View style={[styles.pill, { backgroundColor: colors[`${status.tint}Soft`] || colors.muted }]}>
              <View style={[styles.dot, { backgroundColor: colors[status.tint] }]} />
              <Txt t="badge" c={colors[`${status.tint}Ink`] || colors.sub}>{status.label.toUpperCase()}</Txt>
            </View>
          </View>
        </Card>

        {/* INFORMATION — only fields the response actually contains. */}
        <Txt t="label" c={colors.sub} style={styles.sectionLabel}>User Information</Txt>
        <Card variant="flat" padding="none" style={styles.group}>
          <InfoRow icon="finger-print-outline" label="User ID" value={String(user.id)} />
          <InfoRow icon="key-outline" label="Role" value={role.label} />
          <InfoRow icon="pulse-outline" label="Status" value={status.label} tint={status.tint} />
          {joined ? <InfoRow icon="calendar-outline" label="Joined On" value={joined} /> : null}
          <InfoRow icon="videocam-outline" label="Cameras" value={String(user.cameras ?? cameras.length)} />
          {user.plan ? <InfoRow icon="pricetag-outline" label="Plan" value={user.plan} /> : null}
          <InfoRow
            icon="mail-outline" label="Email Verified"
            value={user.emailVerified ? 'Yes' : 'No'}
            tint={user.emailVerified ? 'ok' : 'warn'}
            last
          />
        </Card>

        {/* ASSIGNED SITES — derived from this user's cameras, each of which
            carries its group. Hidden when they have none. */}
        {sites.length ? (
          <>
            <Txt t="label" c={colors.sub} style={styles.sectionLabel}>Assigned Sites</Txt>
            <Card variant="flat" padding="none" style={styles.group}>
              {sites.map((s, i) => (
                <View key={s.id} style={[styles.row, i < sites.length - 1 && styles.rowBorder]}>
                  <View style={styles.siteThumb}>
                    <Ionicons name="business" size={18} color={colors.primaryInk} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Txt t="bodyMed" numberOfLines={1}>{s.name}</Txt>
                    <Txt t="caption" c={colors.faint} numberOfLines={1}>
                      {s.total} {s.total === 1 ? 'camera' : 'cameras'} · {s.online} online
                    </Txt>
                  </View>
                  <View style={[styles.dot, { backgroundColor: s.online ? colors.ok : colors.off }]} />
                </View>
              ))}
            </Card>
          </>
        ) : null}

        {/* ACTIONS. Exactly one is real. */}
        <Txt t="label" c={colors.sub} style={styles.sectionLabel}>User Actions</Txt>
        <Card variant="flat" padding="none" style={styles.group}>
          <ActionRow
            icon="create-outline" label="Edit User"
            reason="The admin API has no update-user route — profiles are edited on the Drishyam web console."
            onPress={setMoreOpen}
          />
          <ActionRow
            icon="key-outline" label="Reset Password"
            reason="There is no admin password-reset route. Users reset their own password from the sign-in screen."
            onPress={setMoreOpen}
          />
          <ActionRow
            icon={suspending ? 'pause-circle-outline' : 'play-circle-outline'}
            label={suspending ? 'Deactivate User' : 'Reactivate User'}
            destructive={suspending}
            busy={toggle.isPending}
            reason={selfOrAdmin ? 'The server does not allow suspending an administrator account.' : null}
            onPress={selfOrAdmin ? setMoreOpen : confirmToggle}
            last
          />
        </Card>

        <Txt t="caption" c={colors.faint} style={styles.footNote}>
          Permissions and activity history are not exposed by the mobile API, so
          they are not shown here rather than being approximated.
        </Txt>
      </ScrollView>

      <BottomSheet visible={moreOpen} onClose={() => setMoreOpen(false)} title={user.name || 'User'}>
        <SheetAction
          icon={suspending ? 'pause-circle-outline' : 'play-circle-outline'}
          label={suspending ? 'Deactivate User' : 'Reactivate User'}
          hint={suspending ? 'Blocks sign-in on every device' : 'Restores sign-in access'}
          destructive={suspending}
          disabled={selfOrAdmin}
          reason={selfOrAdmin ? 'The server does not allow suspending an administrator account.' : undefined}
          onPress={confirmToggle}
        />
        <SheetAction
          icon="create-outline" label="Edit User" disabled
          reason="The admin API has no update-user route — profiles are edited on the web console."
        />
        <SheetAction
          icon="key-outline" label="Reset Password" disabled
          reason="There is no admin password-reset route. Users reset their own password from the sign-in screen."
        />
      </BottomSheet>
    </View>
  );
}

function InfoRow({ icon, label, value, tint, last }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={17} color={colors.primaryInk} /></View>
      <Txt t="bodyMed" style={{ flex: 1 }} numberOfLines={1}>{label}</Txt>
      <Txt t="sub" c={tint ? colors[`${tint}Ink`] : colors.sub} numberOfLines={1} style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Txt>
    </View>
  );
}

// Unsupported actions stay visible but read as unavailable and say why on tap —
// never inert, never pretending.
function ActionRow({ icon, label, reason, destructive, busy, onPress, last }) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  const blocked = !!reason;
  const tint = destructive ? colors.criticalInk : colors.primaryInk;
  return (
    <Pressable
      onPress={busy ? undefined : () => (blocked ? onPress(true) : onPress())}
      onPressIn={busy ? undefined : haptic.light}
      disabled={busy}
      android_ripple={busy ? undefined : { color: press.ripple }}
      accessibilityRole="button"
      accessibilityState={{ disabled: blocked || busy, busy }}
      accessibilityLabel={blocked ? `${label}. Unavailable on mobile` : label}
      style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && { backgroundColor: colors.muted }]}
    >
      <View style={[styles.rowIcon, blocked && { backgroundColor: colors.muted }]}>
        <Ionicons name={icon} size={17} color={blocked ? colors.faint : tint} />
      </View>
      <Txt
        t="bodyMed"
        c={blocked ? colors.faint : destructive ? colors.criticalInk : undefined}
        style={{ flex: 1 }}
        numberOfLines={1}
      >
        {busy ? 'Working…' : label}
      </Txt>
      {blocked ? (
        <View style={styles.webPill}><Txt t="badge" c={colors.faint}>WEB ONLY</Txt></View>
      ) : (
        <Ionicons name="chevron-forward" size={16} color={colors.faint} />
      )}
    </Pressable>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  page: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },

  profile: { alignItems: 'center', paddingVertical: spacing.xl },
  profileBadges: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },

  sectionLabel: { marginTop: spacing.xl, marginBottom: spacing.sm, marginLeft: spacing.xs },
  group: { paddingHorizontal: spacing.lg },

  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 58, paddingVertical: spacing.sm },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowIcon: {
    width: 36, height: 36, borderRadius: radius.sm,
    backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center',
  },
  siteThumb: {
    width: 38, height: 38, borderRadius: radius.sm,
    backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center',
  },
  webPill: { backgroundColor: colors.muted, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  footNote: { marginTop: spacing.lg, marginHorizontal: spacing.xs, textAlign: 'center' },
});
