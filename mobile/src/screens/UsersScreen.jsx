// Users & Roles — every account on the tenant, from GET /api/admin/users.
//
// ADMIN ONLY, and gated in three independent places so a non-admin can never
// reach it by accident OR on purpose: Menu hides the route, this screen renders
// an access notice instead of a list, and the server itself throws 403 from
// adminAuth. The server gate is the one that actually protects the data — the
// other two exist so the app never shows a control it cannot honour.
//
// Search, filters and the Roles tab are all CLIENT-SIDE over the single list
// response: /admin/users takes no query parameters and returns every user in
// one call, so a request per keystroke would be slower and no more correct.
import { useMemo, useState, useCallback } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { listUsers } from '../lib/api';
import { useAuth } from '../lib/authStore';
import { roleStyle, statusStyle, userTotals, roleBuckets, matchesUser } from '../lib/users';
import {
  Txt, Button, EmptyState, SearchField, StatCard, ScreenHeader, Avatar,
  SegmentedControl, BottomSheet, SheetAction, Skeleton, haptic,
} from '../components/ui';
import { radius, spacing, fonts, useTheme, useStyles } from '../theme';

const SUMMARY = [
  { key: 'total',    label: 'Total Users', icon: 'people-outline',           tint: 'primary' },
  { key: 'active',   label: 'Active',      icon: 'checkmark-circle-outline', tint: 'ok' },
  { key: 'roles',    label: 'Roles',       icon: 'key-outline',              tint: 'info' },
  { key: 'inactive', label: 'Inactive',    icon: 'pause-circle-outline',     tint: 'critical' },
];

const FILTERS = [
  { key: 'all',       label: 'All users',  icon: 'people-outline',           hint: 'Every account' },
  { key: 'active',    label: 'Active',     icon: 'checkmark-circle-outline', hint: 'Accounts that can sign in' },
  { key: 'suspended', label: 'Suspended',  icon: 'pause-circle-outline',     hint: 'Accounts that cannot sign in' },
  { key: 'admin',     label: 'Admins',     icon: 'shield-checkmark-outline', hint: 'Full administrative access' },
];

const TABS = [{ key: 'users', label: 'All Users' }, { key: 'roles', label: 'All Roles' }];

// No POST /admin/users exists — the admin router exposes list, read and
// toggle-status and nothing else. The button stays because the design calls
// for it, but it says why instead of opening a form that could not submit.
const ADD_USER_REASON =
  'Accounts are created on the Drishyam web console. The admin API exposes only '
  + 'reading users and enabling or suspending them — there is no create-user route '
  + 'for this app to call.';

export default function UsersScreen({ navigation }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const me = useAuth((s) => s.user);
  const isAdmin = String(me?.role || '').toLowerCase() === 'admin';

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('users');
  const [sheet, setSheet] = useState(null); // 'filter' | 'add' | { user }
  const [manual, setManual] = useState(false);

  const { data: users = [], isLoading, error, refetch } = useQuery({
    queryKey: ['admin-users'],
    queryFn: listUsers,
    enabled: isAdmin,          // never fire a request we know will 403
    staleTime: 30_000,
  });

  const totals = useMemo(() => userTotals(users), [users]);
  const roles = useMemo(() => roleBuckets(users), [users]);

  const shown = useMemo(() => users
    .filter((u) => matchesUser(u, q))
    .filter((u) => {
      if (filter === 'all') return true;
      if (filter === 'admin') return String(u.role || '').toLowerCase() === 'admin';
      return statusStyle(u).label.toLowerCase() === filter;  // 'active' | 'suspended'
    }),
  [users, q, filter]);

  const onRefresh = useCallback(async () => {
    setManual(true);
    try { await refetch(); } finally { setManual(false); }
  }, [refetch]);

  const openUser = useCallback((u) => {
    haptic.light();
    navigation.navigate('UserDetails', { userId: u.id, name: u.name });
  }, [navigation]);

  // A non-admin should see WHY, not an empty list that looks like a bug.
  if (!isAdmin) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader title="Users & Roles" onBack={() => navigation.goBack()} />
        <EmptyState
          icon="lock-closed-outline"
          title="Administrator access required"
          subtitle="Only administrators can view or manage accounts. Your role is not permitted to see other users."
          action="Back"
          onAction={() => navigation.goBack()}
        />
      </View>
    );
  }

  const filtered = !!q.trim() || filter !== 'all';
  const activeFilter = FILTERS.find((f) => f.key === filter) || FILTERS[0];
  const statCols = width >= 700 ? 4 : 2;

  const header = (
    <>
      <View style={styles.searchRow}>
        <View style={{ flex: 1 }}>
          <SearchField value={q} onChangeText={setQ} placeholder="Search users by name or roles" />
        </View>
        <Pressable
          onPress={() => { haptic.light(); setSheet('filter'); }}
          accessibilityRole="button"
          accessibilityLabel={`Filter users: ${activeFilter.label}. Tap to change`}
          style={({ pressed }) => [
            styles.filterBtn,
            filter !== 'all' && styles.filterBtnOn,
            pressed && { backgroundColor: colors.mutedAlt },
          ]}
        >
          <Ionicons name="options-outline" size={19} color={filter === 'all' ? colors.sub : colors.primaryInk} />
        </Pressable>
      </View>

      <View style={styles.statGrid}>
        {SUMMARY.map((s) => (
          <View key={s.key} style={[styles.statCell, { width: `${100 / statCols}%` }]}>
            <StatCard
              icon={s.icon} tint={s.tint}
              value={isLoading ? '—' : String(totals[s.key])}
              label={s.label} loading={isLoading}
              accessibilityLabel={`${totals[s.key]} ${s.label}`}
            />
          </View>
        ))}
      </View>

      <SegmentedControl
        options={TABS}
        value={tab}
        onChange={setTab}
        variant="filled"
        style={{ marginTop: spacing.lg }}
        accessibilityLabel="Show users or roles"
      />

      {tab === 'roles' ? (
        <View style={{ marginTop: spacing.lg }}>
          {/* Derived from the users themselves — there is no roles endpoint to
              list from, so this reports the roles actually in use. */}
          {roles.map((r) => (
            <View key={r.key} style={styles.roleCard}>
              <View style={[styles.roleIcon, { backgroundColor: colors[`${r.tint}Soft`] || colors.muted }]}>
                <Ionicons name={r.icon} size={19} color={colors[`${r.tint}Ink`] || colors.primaryInk} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt t="titleSm" numberOfLines={1}>{r.label}</Txt>
                <Txt t="caption" c={colors.sub} numberOfLines={1}>
                  {r.members} {r.members === 1 ? 'member' : 'members'} · {r.active} active
                </Txt>
              </View>
              <View style={[styles.pill, { backgroundColor: colors[`${r.tint}Soft`] || colors.muted }]}>
                <Txt t="badge" c={colors[`${r.tint}Ink`] || colors.primaryInk}>{r.members}</Txt>
              </View>
            </View>
          ))}
          <Txt t="caption" c={colors.faint} style={styles.roleNote}>
            Roles are defined on the server and are read-only here — the API has no
            role-editing route.
          </Txt>
        </View>
      ) : (
        <View style={styles.listHead}>
          <Txt t="title" style={{ flex: 1 }}>All Users</Txt>
          <Txt t="caption" c={colors.faint}>
            {isLoading ? '' : `${shown.length}${filtered ? ` of ${users.length}` : ''}`}
          </Txt>
        </View>
      )}
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScreenHeader
        title="Users & Roles"
        subtitle={isLoading ? 'Loading…' : `${totals.total} ${totals.total === 1 ? 'User' : 'Users'} • ${totals.roles} ${totals.roles === 1 ? 'Role' : 'Roles'}`}
        onBack={() => navigation.goBack()}
        right={
          <Pressable
            onPress={() => { haptic.light(); setSheet('add'); }}
            accessibilityRole="button"
            accessibilityLabel="Add user"
            style={({ pressed }) => [styles.addBtn, pressed && { backgroundColor: colors.primaryDk }]}
          >
            <Ionicons name="add" size={16} color={colors.onPrimary} />
            <Txt t="caption" c={colors.onPrimary} style={{ fontFamily: fonts.semi }}>Add User</Txt>
          </Pressable>
        }
      />

      {isLoading ? (
        <View style={styles.page}>
          {header}
          {[0, 1, 2, 3].map((i) => <UserCardSkeleton key={i} />)}
        </View>
      ) : (
        <FlatList
          data={tab === 'users' ? shown : []}
          keyExtractor={(u) => String(u.id)}
          ListHeaderComponent={header}
          contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + spacing.xxl }]}
          refreshControl={
            <RefreshControl refreshing={manual} onRefresh={onRefresh} tintColor={colors.primaryInk} colors={[colors.primaryInk]} />
          }
          renderItem={({ item }) => (
            <UserCard user={item} onPress={openUser} onMenu={() => { haptic.light(); setSheet({ user: item }); }} />
          )}
          ListEmptyComponent={
            tab === 'roles' ? null
              : error ? (
                <EmptyState
                  icon="cloud-offline-outline"
                  title="Unable to load users"
                  subtitle={error?.response?.status === 403
                    ? 'The server refused this request. Administrator access is required.'
                    : 'Check your connection and try again.'}
                  action="Try Again"
                  onAction={() => refetch()}
                />
              ) : filtered ? (
                <EmptyState
                  icon="search-outline"
                  title="No users found"
                  subtitle="Nothing matches the current search or filter."
                  action="Clear filters"
                  onAction={() => { haptic.light(); setQ(''); setFilter('all'); }}
                />
              ) : (
                <EmptyState
                  icon="people-outline"
                  title="No users found"
                  subtitle="Add a user to start managing access."
                  action="Add User"
                  onAction={() => { haptic.light(); setSheet('add'); }}
                />
              )
          }
        />
      )}

      <BottomSheet visible={sheet === 'filter'} onClose={() => setSheet(null)} title="Filter users">
        {FILTERS.map((f) => (
          <SheetAction
            key={f.key}
            icon={f.key === filter ? 'checkmark-circle' : f.icon}
            label={f.label} hint={f.hint}
            onPress={() => { setFilter(f.key); setSheet(null); }}
          />
        ))}
      </BottomSheet>

      <BottomSheet
        visible={sheet === 'add'}
        onClose={() => setSheet(null)}
        title="Add user"
        footer={<Button title="Close" variant="secondary" onPress={() => setSheet(null)} style={{ marginTop: spacing.sm }} />}
      >
        <View style={styles.reason}>
          <Ionicons name="information-circle-outline" size={19} color={colors.primaryInk} />
          <Txt t="sub" c={colors.sub} style={{ flex: 1 }}>{ADD_USER_REASON}</Txt>
        </View>
      </BottomSheet>

      {/* Per-user menu. Only the two operations the admin API actually has are
          offered; the rest would be theatre. Status changes live on the detail
          screen, where the confirmation can state the consequence in full. */}
      <BottomSheet
        visible={!!sheet && typeof sheet === 'object'}
        onClose={() => setSheet(null)}
        title={sheet?.user?.name || 'User'}
      >
        <SheetAction
          icon="person-circle-outline" label="View Details"
          hint="Account, sites and status"
          onPress={() => { const u = sheet.user; setSheet(null); openUser(u); }}
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

// One account. Avatar is INITIALS — the API returns no avatar image, and a
// generated portrait would be inventing a face for a real person.
function UserCard({ user, onPress, onMenu }) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  const role = roleStyle(user.role);
  const status = statusStyle(user);

  return (
    <Pressable
      onPress={() => onPress(user)}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={`${user.name || user.email}, ${role.label}, ${status.label}. Open details`}
      style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: press.cardScale }] }]}
    >
      <Avatar name={user.name || user.email} size={46} />

      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="titleSm" numberOfLines={1}>{user.name || 'Unnamed user'}</Txt>
        {user.email ? (
          <Txt t="caption" c={colors.sub} numberOfLines={1} style={{ marginTop: 1 }}>{user.email}</Txt>
        ) : null}
        <View style={styles.badgeRow}>
          <View style={[styles.pill, { backgroundColor: colors[`${role.tint}Soft`] || colors.muted }]}>
            <Txt t="badge" c={colors[`${role.tint}Ink`] || colors.sub}>{role.label.toUpperCase()}</Txt>
          </View>
          {/* ACCOUNT status — the API carries no online presence, so nothing
              here claims one. */}
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: colors[status.tint] }]} />
            <Txt t="caption" c={colors.sub}>{status.label}</Txt>
          </View>
        </View>
      </View>

      <Pressable
        onPress={onMenu}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${user.name || user.email}`}
        style={({ pressed }) => [styles.menuBtn, pressed && { backgroundColor: colors.muted }]}
      >
        <Ionicons name="ellipsis-vertical" size={16} color={colors.faint} />
      </Pressable>
    </Pressable>
  );
}

function UserCardSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.card, { alignItems: 'center' }]}>
      <Skeleton width={46} height={46} r={23} />
      <View style={{ flex: 1, gap: 7 }}>
        <Skeleton width="50%" height={14} />
        <Skeleton width="70%" height={11} />
        <Skeleton width="40%" height={16} r={radius.pill} />
      </View>
    </View>
  );
}

const makeStyles = ({ colors, shadow }) => StyleSheet.create({
  page: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  filterBtn: {
    width: 48, height: 48, borderRadius: radius.md,
    backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  filterBtnOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primary, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, minHeight: 34,
  },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs, rowGap: spacing.md, marginTop: spacing.lg },
  statCell: { paddingHorizontal: spacing.xs },

  listHead: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xl, marginBottom: spacing.md },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: colors.elevatedBorder ? StyleSheet.hairlineWidth : 0,
    borderColor: colors.elevatedBorder || 'transparent',
    padding: spacing.md, marginBottom: spacing.md,
    ...shadow(1),
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6 },
  pill: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  menuBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  roleCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: colors.elevatedBorder ? StyleSheet.hairlineWidth : 0,
    borderColor: colors.elevatedBorder || 'transparent',
    padding: spacing.md, marginBottom: spacing.md,
    ...shadow(1),
  },
  roleIcon: { width: 42, height: 42, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },
  roleNote: { marginTop: spacing.xs, marginHorizontal: spacing.xs },

  reason: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm },
});
