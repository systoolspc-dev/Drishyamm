// Sites — every recorder/site the account can see, from GET /api/groups.
//
// Reached from Menu → Sites. It is a STACK screen, like Cameras and Profile, so
// it carries a back button and NOT the floating tab bar — the tab bar belongs
// to the four tab roots and nothing here creates a second one.
//
// Search and the status filter are CLIENT-SIDE over the already-cached groups
// query: /api/groups takes no search or filter parameter, and adding a network
// round-trip per keystroke to re-fetch a list the app already holds would be
// slower and no more correct.
import { useMemo, useState, useCallback } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { listGroups } from '../lib/api';
import { siteStats, siteStatus, siteTotals, matchesSite } from '../lib/sites';
import {
  Txt, Button, EmptyState, SearchField, StatCard, ScreenHeader,
  BottomSheet, SheetAction, Skeleton, haptic,
} from '../components/ui';
import { radius, spacing, fonts, useTheme, useStyles } from '../theme';

// tint is a palette KEY — StatCard resolves `${tint}Soft` / `${tint}Ink`.
const SUMMARY = [
  { key: 'total',       label: 'Total Sites', icon: 'business-outline',          tint: 'info' },
  { key: 'online',      label: 'Online',      icon: 'checkmark-circle-outline',  tint: 'ok' },
  { key: 'offline',     label: 'Offline',     icon: 'close-circle-outline',      tint: 'critical' },
  { key: 'maintenance', label: 'Maintenance', icon: 'construct-outline',         tint: 'warn' },
];

const FILTERS = [
  { key: 'all',         label: 'All sites',   icon: 'albums-outline',           hint: 'Every site on the account' },
  { key: 'online',      label: 'Online',      icon: 'checkmark-circle-outline', hint: 'At least one camera streaming' },
  { key: 'offline',     label: 'Offline',     icon: 'close-circle-outline',     hint: 'No camera currently streaming' },
  { key: 'maintenance', label: 'Maintenance', icon: 'construct-outline',        hint: 'Reported by the server' },
];

// Creating a site is a WEB CONSOLE action: there is no create route in the
// mobile API (src/lib/api.js wraps every endpoint the app has). The button
// stays, because the design calls for it and a missing control is its own kind
// of confusion — but it says why rather than pretending to work.
const ADD_SITE_REASON =
  'Sites are provisioned on the Drishyam web console. The mobile API has no '
  + 'site-creation route, so this app can read sites but not add them.';

export default function SitesScreen({ navigation }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sheet, setSheet] = useState(null); // 'filter' | 'add'
  const [manual, setManual] = useState(false);

  // Same query key as every other screen — Sites costs no extra request.
  const { data: groups = [], isLoading, error, refetch } = useQuery({
    queryKey: ['groups'], queryFn: listGroups, refetchInterval: 15_000,
  });

  // Totals describe the WHOLE account, not the filtered view: a summary that
  // changed every time you typed in the search box would stop being a summary.
  const totals = useMemo(() => siteTotals(groups), [groups]);

  const sites = useMemo(() => groups
    .filter((g) => matchesSite(g, q))
    .filter((g) => filter === 'all' || siteStatus(g).key === filter),
  [groups, q, filter]);

  const onRefresh = useCallback(async () => {
    setManual(true);
    try { await refetch(); } finally { setManual(false); }
  }, [refetch]);

  const openSite = useCallback((group) => {
    haptic.light();
    // groupId only — Site Details reads the site itself out of the shared
    // groups cache, so the route never carries a stale copy of the data.
    navigation.navigate('SiteDetails', { groupId: group.id, name: group.name });
  }, [navigation]);

  const filtered = !!q.trim() || filter !== 'all';
  const activeFilter = FILTERS.find((f) => f.key === filter) || FILTERS[0];
  const statCols = width >= 700 ? 4 : 2;

  const header = (
    <>
      <View style={styles.searchRow}>
        <View style={{ flex: 1 }}>
          <SearchField value={q} onChangeText={setQ} placeholder="Search sites…" />
        </View>
        <Pressable
          onPress={() => { haptic.light(); setSheet('filter'); }}
          accessibilityRole="button"
          accessibilityLabel={`Filter sites: ${activeFilter.label}. Tap to change`}
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
              icon={s.icon}
              tint={s.tint}
              value={isLoading ? '—' : String(totals[s.key])}
              label={s.label}
              loading={isLoading}
              accessibilityLabel={`${totals[s.key]} ${s.label}`}
            />
          </View>
        ))}
      </View>

      <View style={styles.listHead}>
        <Txt t="title" style={{ flex: 1 }}>All Sites</Txt>
        <Txt t="caption" c={colors.faint}>
          {isLoading ? '' : `${sites.length}${filtered ? ` of ${groups.length}` : ''}`}
        </Txt>
      </View>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScreenHeader
        title="Sites"
        subtitle={isLoading ? 'Loading…' : `${groups.length} ${groups.length === 1 ? 'Site' : 'Sites'}`}
        onBack={() => navigation.goBack()}
        right={
          <Pressable
            onPress={() => { haptic.light(); setSheet('add'); }}
            accessibilityRole="button"
            accessibilityLabel="Add site"
            style={({ pressed }) => [styles.addBtn, pressed && { backgroundColor: colors.primaryDk }]}
          >
            <Ionicons name="add" size={16} color={colors.onPrimary} />
            <Txt t="caption" c={colors.onPrimary} style={{ fontFamily: fonts.semi }}>Add Site</Txt>
          </Pressable>
        }
      />

      {isLoading ? (
        <View style={styles.page}>
          {header}
          {[0, 1, 2].map((i) => <SiteCardSkeleton key={i} />)}
        </View>
      ) : (
        <FlatList
          data={sites}
          keyExtractor={(g) => String(g.id)}
          ListHeaderComponent={header}
          contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + spacing.xxl }]}
          refreshControl={
            <RefreshControl refreshing={manual} onRefresh={onRefresh} tintColor={colors.primaryInk} colors={[colors.primaryInk]} />
          }
          renderItem={({ item }) => <SiteCard group={item} onPress={openSite} />}
          ListEmptyComponent={
            error ? (
              <EmptyState
                icon="cloud-offline-outline"
                title="Unable to load sites"
                subtitle="Check your connection and try again."
                action="Try Again"
                onAction={() => refetch()}
              />
            ) : filtered ? (
              <EmptyState
                icon="search-outline"
                title="No sites match"
                subtitle="Nothing here matches the current search or filter."
                action="Clear filters"
                onAction={() => { haptic.light(); setQ(''); setFilter('all'); }}
              />
            ) : (
              <EmptyState
                icon="business-outline"
                title="No sites yet"
                subtitle="Add your first site to start managing cameras."
                action="Add Site"
                onAction={() => { haptic.light(); setSheet('add'); }}
              />
            )
          }
        />
      )}

      <BottomSheet visible={sheet === 'filter'} onClose={() => setSheet(null)} title="Filter sites">
        {FILTERS.map((f) => (
          <SheetAction
            key={f.key}
            icon={f.key === filter ? 'checkmark-circle' : f.icon}
            label={f.label}
            hint={f.hint}
            onPress={() => { setFilter(f.key); setSheet(null); }}
          />
        ))}
      </BottomSheet>

      <BottomSheet
        visible={sheet === 'add'}
        onClose={() => setSheet(null)}
        title="Add site"
        footer={<Button title="Close" variant="secondary" onPress={() => setSheet(null)} style={{ marginTop: spacing.sm }} />}
      >
        <View style={styles.reason}>
          <Ionicons name="information-circle-outline" size={19} color={colors.primaryInk} />
          <Txt t="sub" c={colors.sub} style={{ flex: 1 }}>{ADD_SITE_REASON}</Txt>
        </View>
      </BottomSheet>
    </View>
  );
}

// One site. Everything on it is a real field: name and host come straight from
// the group, the camera tallies are counted from its own cameras array, and the
// status pill follows lib/sites. There is no site image in the API, so the
// thumbnail is a BRANDED PLACEHOLDER rather than stock photography.
function SiteCard({ group, onPress }) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  const status = siteStatus(group);
  const { total, online } = siteStats(group);

  return (
    <Pressable
      onPress={() => onPress(group)}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={`${group.name}, ${status.label}, ${total} ${total === 1 ? 'camera' : 'cameras'}, ${online} online. Open site`}
      style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: press.cardScale }] }]}
    >
      <View style={styles.thumb}>
        <Ionicons name="business" size={22} color={colors.primaryInk} />
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.nameRow}>
          <View style={[styles.dot, { backgroundColor: colors[status.tint] }]} />
          <Txt t="titleSm" numberOfLines={1} style={{ flex: 1 }}>{group.name}</Txt>
        </View>
        {group.host ? (
          <Txt t="caption" c={colors.sub} numberOfLines={1} style={{ marginTop: 2 }}>{group.host}</Txt>
        ) : null}
        <View style={styles.metaRow}>
          <Ionicons name="videocam-outline" size={13} color={colors.faint} />
          <Txt t="caption" c={colors.faint} numberOfLines={1}>
            {total} {total === 1 ? 'Camera' : 'Cameras'}{total ? ` · ${online} online` : ''}
          </Txt>
        </View>
      </View>

      <View style={styles.trail}>
        <View style={[styles.pill, { backgroundColor: colors[`${status.tint}Soft`] }]}>
          <Txt t="badge" c={colors[`${status.tint}Ink`]}>{status.label.toUpperCase()}</Txt>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.faint} />
      </View>
    </Pressable>
  );
}

// Mirrors SiteCard's geometry so the list doesn't jump when data lands.
function SiteCardSkeleton() {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.card, { alignItems: 'center' }]}>
      <Skeleton width={52} height={52} r={radius.md} />
      <View style={{ flex: 1, gap: 7 }}>
        <Skeleton width="55%" height={14} />
        <Skeleton width="40%" height={11} />
        <Skeleton width="48%" height={11} />
      </View>
      <Skeleton width={58} height={20} r={radius.pill} />
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

  // negative gutter + per-cell padding: percentage widths and `gap` fight each
  // other and wrap a cell early
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs, rowGap: spacing.md, marginTop: spacing.lg },
  statCell: { paddingHorizontal: spacing.xs },

  listHead: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xl, marginBottom: spacing.md },

  // border XOR shadow: these ride on a shadow, so no border (bar the dark-mode
  // hairline, where a shadow has nothing to darken)
  card: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: colors.elevatedBorder ? StyleSheet.hairlineWidth : 0,
    borderColor: colors.elevatedBorder || 'transparent',
    padding: spacing.md, marginBottom: spacing.md,
    ...shadow(1),
  },
  thumb: {
    width: 52, height: 52, borderRadius: radius.md,
    backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center',
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  trail: { alignItems: 'flex-end', gap: spacing.sm },
  pill: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },

  reason: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm },
});
