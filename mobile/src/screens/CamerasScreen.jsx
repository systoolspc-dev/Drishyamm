// Cameras — grouped device grid. Responsive columns (2 phone / 3 wide),
// search, FILTERS (all · online · offline · favourites), skeleton on load,
// retry on error. ONLINE tiles play LIVE (sub-stream, staggered, focus-gated);
// the rest stay quiet cards.
//
// EVERY online camera streams here: GRID_LIVE_TILES is uncapped by product
// decision, knowingly above the recorder's ~6-7-pull ceiling (see lib/config.js
// for what that costs and how to revert). Connects are still STAGGERED 350ms
// apart so 16 tiles never hit the recorder as a herd, and the whole screen is
// focus-gated so it holds nothing while you're on another tab — neither of
// those reduces the number of live tiles, they only stop it failing harder.
// If the budget is ever dialled back below the camera count, the slots ration
// themselves to the viewport instead (see `liveIds`).
//
// Favourites are device-local (see lib/favoritesStore) — the backend has no
// favourites endpoint, and a star that silently forgets itself is worse than
// no star at all.
import { useMemo, useState, useCallback, useRef } from 'react';
import { View, SectionList, RefreshControl, StyleSheet, ScrollView, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { listGroups } from '../lib/api';
import { GRID_LIVE_TILES } from '../lib/config';
import { useFavorites } from '../lib/favoritesStore';
import CameraCard from '../components/CameraCard';
import LiveTile from '../components/LiveTile';
import { EmptyState, Badge, SearchField, Chip, Txt, CameraTileSkeleton, haptic } from '../components/ui';
import { radius, spacing, useTheme, useStyles } from '../theme';

const FILTERS = [
  { key: 'all',      label: 'All',        icon: 'grid-outline' },
  { key: 'online',   label: 'Online',     icon: 'radio-button-on-outline' },
  { key: 'offline',  label: 'Offline',    icon: 'videocam-off-outline' },
  { key: 'favorite', label: 'Favourites', icon: 'heart-outline' },
];

// The live slots follow the VIEWPORT. `minimumViewTime` keeps a fast scroll
// from firing a connect/teardown at the recorder for every row it flies past;
// 40% visible is enough to count, so a half-shown row still earns a stream.
const VIEWABILITY = { itemVisiblePercentThreshold: 40, minimumViewTime: 250 };

export default function CamerasScreen({ navigation, route }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // Picker mode. Menu → "Recorded videos" has no camera to open yet, so it
  // sends you here and tapping a tile goes to Playback instead of Live.
  const pickMode = route?.params?.pick;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [manual, setManual] = useState(false);
  const { width } = useWindowDimensions();
  const cols = width >= 700 ? 3 : 2;
  const focused = useIsFocused(); // live tiles stream ONLY while this tab is on top

  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);

  const { data: groups = [], isLoading, refetch, error } = useQuery({
    queryKey: ['groups'], queryFn: listGroups, refetchInterval: 15_000,
  });

  const toRows = useCallback((arr) => {
    const rows = [];
    for (let i = 0; i < arr.length; i += cols) rows.push(arr.slice(i, i + cols));
    return rows;
  }, [cols]);

  // Counts for the filter chips come from the UNFILTERED set, so the chip row
  // always tells you what's there rather than what survived the current filter.
  const totals = useMemo(() => {
    const all = groups.flatMap((g) => g.cameras || []);
    return {
      all: all.length,
      online: all.filter((c) => c.status === 'online').length,
      offline: all.filter((c) => c.status !== 'online').length,
      favorite: all.filter((c) => favIds.includes(c.monitorId)).length,
    };
  }, [groups, favIds]);

  // Which camera rows are on screen right now. Held as a plain id list so the
  // live-slot allocation below can respect scroll ORDER, not just membership.
  const [visibleIds, setVisibleIds] = useState([]);
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    const ids = [];
    for (const v of viewableItems) {
      if (!Array.isArray(v.item)) continue;   // rows are arrays of cameras
      for (const c of v.item) if (c?.monitorId != null) ids.push(c.monitorId);
    }
    // Same set → same array, so scrolling within one row doesn't re-render.
    setVisibleIds((prev) =>
      prev.length === ids.length && prev.every((x, i) => x === ids[i]) ? prev : ids);
  }).current;

  // Filtering is now separate from live-slot allocation: the slots depend on
  // scroll position, and recomputing the search/filter pass on every scroll
  // would be wasted work.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groups.map((g) => {
      let cams = (g.cameras || []).map((c) => ({ ...c, groupName: g.name }));
      if (needle) cams = cams.filter((c) => (c.name || '').toLowerCase().includes(needle));
      if (filter === 'online')   cams = cams.filter((c) => c.status === 'online');
      if (filter === 'offline')  cams = cams.filter((c) => c.status !== 'online');
      if (filter === 'favorite') cams = cams.filter((c) => favIds.includes(c.monitorId));
      return { group: g, cams };
    }).filter((s) => s.cams.length > 0);
  }, [groups, q, filter, favIds]);

  // Which tiles stream. Rationing only engages when the budget is actually
  // SCARCE, which is what makes GRID_LIVE_TILES a single honest dial:
  //
  //   · budget >= online cameras  → every online camera streams. This is the
  //     current setting (GRID_LIVE_TILES is Infinity, by product decision) and
  //     it knowingly exceeds the recorder's ceiling — see lib/config.js.
  //   · budget <  online cameras  → the slots follow the VIEWPORT, so they go
  //     to the tiles you are actually looking at and hand off as you scroll.
  //     They used to go to the first few cameras in list order, so scrolling
  //     past row two left you staring at dark placeholders while off-screen
  //     tiles held every slot.
  //
  // Dialling GRID_LIVE_TILES back to 6 restores the second branch with no other
  // change anywhere.
  const liveIds = useMemo(() => {
    const online = filtered.flatMap((s) => s.cams).filter((c) => c.status === 'online');
    if (online.length <= GRID_LIVE_TILES) return new Set(online.map((c) => c.monitorId));

    const onlineIds = new Set(online.map((c) => c.monitorId));
    const onScreen = visibleIds.filter((id) => onlineIds.has(id));
    // Before the list has reported viewability (first paint), fall back to
    // document order so the top of the page isn't blank for a beat.
    const ordered = onScreen.length ? onScreen : online.map((c) => c.monitorId);
    return new Set(ordered.slice(0, GRID_LIVE_TILES));
  }, [filtered, visibleIds]);

  const sections = useMemo(() => {
    let order = 0;
    return filtered.map(({ group: g, cams }) => {
      const withLive = cams.map((c) => {
        const isLive = liveIds.has(c.monitorId);
        return { ...c, isLive, delay: isLive ? order++ * 350 : 0 };
      });
      return {
        key: String(g.id), title: g.name, host: g.host,
        count: withLive.length, online: withLive.filter((c) => c.status === 'online').length,
        data: toRows(withLive),
      };
    });
  }, [filtered, liveIds, toRows]);

  const onRefresh = useCallback(async () => { setManual(true); try { await refetch(); } finally { setManual(false); } }, [refetch]);

  const openLive = useCallback((cam) =>
    navigation.navigate('LiveView', { monitorId: cam.monitorId, name: cam.name, location: cam.groupName }), [navigation]);
  const openPlayback = useCallback((cam) =>
    navigation.navigate('Playback', { monitorId: cam.monitorId, name: cam.name }), [navigation]);

  const Row = ({ item: row }) => (
    <View style={[styles.row, { marginBottom: spacing.md }]}>
      {row.map((cam) => {
        // Identical prop set for both — whether a camera got a live slot is an
        // internal budget decision (GRID_LIVE_TILES) and must never change which
        // actions the operator is offered.
        const shared = {
          camera: cam,
          favorite: favIds.includes(cam.monitorId),
          onToggleFavorite: () => toggleFav(cam.monitorId),
          onPlayback: () => openPlayback(cam),
          onPress: () => (pickMode === 'playback' ? openPlayback(cam) : openLive(cam)),
        };
        return cam.isLive
          ? <LiveTile key={cam.monitorId} {...shared} live={focused} delay={cam.delay} />
          : <CameraCard key={cam.monitorId} {...shared} />;
      })}
      {row.length < cols && Array.from({ length: cols - row.length }).map((_, i) => <View key={`sp${i}`} style={{ flex: 1 }} />)}
    </View>
  );

  const emptyCopy = () => {
    if (error) return { icon: 'cloud-offline-outline', title: 'Can’t reach your server', subtitle: 'Check your connection and try again.' };
    if (q) return { icon: 'search-outline', title: 'No matches', subtitle: `Nothing matches “${q}”.` };
    if (filter === 'favorite') return { icon: 'heart-outline', title: 'No favourites yet', subtitle: 'Tap the heart on any camera to pin it here.' };
    if (filter === 'offline') return { icon: 'shield-checkmark-outline', title: 'Everything is online', subtitle: 'No offline cameras right now.' };
    if (filter === 'online') return { icon: 'videocam-off-outline', title: 'Nothing streaming', subtitle: 'No cameras are online right now.' };
    return { icon: 'videocam-off-outline', title: 'No cameras yet', subtitle: 'Cameras added on the server show up here.' };
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.toolbar}>
        {pickMode === 'playback' ? (
          <View style={styles.pickBanner} accessibilityLiveRegion="polite">
            <Ionicons name="film-outline" size={15} color={colors.primaryInk} />
            <Txt t="caption" c={colors.primaryInk} style={{ flex: 1 }}>
              Choose a camera to browse its recordings
            </Txt>
          </View>
        ) : null}
        <SearchField value={q} onChangeText={setQ} placeholder="Search cameras…" />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
          keyboardShouldPersistTaps="handled"
        >
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              icon={f.icon}
              count={totals[f.key]}
              selected={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </ScrollView>
      </View>

      {isLoading ? (
        <View style={{ paddingHorizontal: spacing.lg }}>
          {[0, 1].map((r) => (
            <View key={r} style={[styles.row, { marginBottom: spacing.md, marginTop: r === 0 ? spacing.md : 0 }]}>
              {Array.from({ length: cols }).map((_, i) => <CameraTileSkeleton key={i} />)}
            </View>
          ))}
        </View>
      ) : (
        <SectionList
          sections={sections}
          // Must survive a NON-ROW argument. With onViewableItemsChanged set,
          // VirtualizedSectionList._convertViewable runs every viewable token
          // through keyExtractor — including section headers and footers, whose
          // "item" is the section object, not a row array. Calling .map on that
          // is the "undefined is not a function" crash.
          keyExtractor={(row, i) =>
            (Array.isArray(row) ? row.map((c) => c.monitorId).join('-') : String(row?.key ?? '')) || String(i)}
          refreshControl={<RefreshControl refreshing={manual} onRefresh={onRefresh} tintColor={colors.primaryInk} colors={[colors.primaryInk]} />}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY}
          renderSectionHeader={({ section }) => (
            <View style={styles.header}>
              <View style={styles.groupIcon}><MaterialCommunityIcons name="cctv" size={17} color={colors.primaryInk} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Txt t="titleSm" numberOfLines={1}>{section.title}</Txt>
                <Txt t="caption" c={colors.faint} numberOfLines={1}>{section.host}</Txt>
              </View>
              <Badge
                label={`${section.online}/${section.count} online`} dot
                fg={section.online ? colors.okInk : colors.sub}
                bg={section.online ? colors.okSoft : colors.muted}
              />
            </View>
          )}
          renderItem={Row}
          ListEmptyComponent={
            <EmptyState
              {...emptyCopy()}
              action={error ? 'Retry' : (q || filter !== 'all') ? 'Clear filters' : undefined}
              onAction={() => { if (error) return refetch(); haptic.light(); setQ(''); setFilter('all'); }}
            />
          }
        />
      )}
    </View>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  toolbar: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  pickBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.primarySoft, borderRadius: radius.md, padding: spacing.md,
  },
  // negative margin lets the chip row bleed to the screen edge while its first
  // chip still lines up with the search field above it
  chipRow: { gap: spacing.sm, paddingRight: spacing.lg, paddingBottom: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg, marginBottom: spacing.md },
  groupIcon: { width: 34, height: 34, borderRadius: radius.chip, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
});
