// Live Wall — VMS-style wall: one screen = one fixed grid page, swipe (or use
// the pager) to move between pages. A 4/8 switcher picks the page density:
//   8 → 2×4 portrait / 4×2 landscape · 4 → 2×2 (bigger tiles, NVR-safer).
// Tiles stretch to share the screen equally (no scroll) and letterbox the
// video so nothing is cropped. Only the CURRENT page of the FOCUSED screen
// streams (low-res sub, staggered connects) — swiping away or pushing a
// single camera on top releases every pull.
import { useMemo, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Pressable, FlatList, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { listGroups } from '../lib/api';
import { WALL_LIVE_TILES } from '../lib/config';
import LiveTile from '../components/LiveTile';
import { EmptyState, ScreenHeader, SegmentedControl, haptic } from '../components/ui';
import { radius, spacing, useTheme, useStyles } from '../theme';

const CONNECT_STAGGER = 350; // ms between tile connects — protects the NVR

// Page density. Keys are NUMBERS — SegmentedControl compares with ===, and the
// value it round-trips is fed straight back into the grid maths.
const DENSITY_OPTIONS = [
  { key: 4, label: '4', icon: 'grid-outline' },
  { key: 8, label: '8', icon: 'apps-outline' },
];

export default function LiveWallScreen({ route, navigation }) {
  const { groupId, groupName } = route.params || {}; // set → wall shows one NVR only
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const wide = width > height || width >= 700;
  const [perPage, setPerPage] = useState(WALL_LIVE_TILES);
  const cols = perPage === 4 ? 2 : wide ? 4 : 2;
  const rowsPerPage = Math.ceil(perPage / cols);
  const [page, setPage] = useState(0);
  const listRef = useRef(null);

  const { data: groups = [], isLoading, error, refetch } = useQuery({
    queryKey: ['groups'], queryFn: listGroups, refetchInterval: 20_000,
  });

  const cameras = useMemo(() => {
    const source = groupId != null ? groups.filter((g) => g.id === groupId) : groups;
    const all = source.flatMap((g) => (g.cameras || []).map((c) => ({ ...c, groupName: g.name })));
    return all.sort((a, b) => (b.status === 'online') - (a.status === 'online'));
  }, [groups, groupId]);

  const pages = useMemo(() => {
    const out = [];
    for (let i = 0; i < cameras.length; i += perPage) out.push(cameras.slice(i, i + perPage));
    return out;
  }, [cameras, perPage]);
  const pageCount = Math.max(1, pages.length);
  const current = Math.min(page, pageCount - 1);

  const goTo = (i) => {
    const next = Math.min(Math.max(0, i), pageCount - 1);
    if (next === current) return;
    haptic.select();
    listRef.current?.scrollToIndex({ index: next, animated: true });
    setPage(next);
  };

  const onMomentumEnd = (e) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== current) { haptic.select(); setPage(i); }
  };

  const switchLayout = (n) => {
    if (n === perPage) return;
    setPerPage(n);
    setPage(0); // grid geometry changes — restart from the first page
  };

  // one swipeable page = a fixed rows×cols grid; empty slots keep tile sizes
  // identical on partial pages so the wall never looks ragged
  const renderPage = useCallback(({ item: cams, index: pi }) => (
    <View style={[styles.page, { width }]}>
      {Array.from({ length: rowsPerPage }).map((_, ri) => {
        const row = cams.slice(ri * cols, ri * cols + cols);
        return (
          <View style={styles.row} key={ri}>
            {row.map((cam, ci) => (
              <LiveTile
                key={cam.monitorId}
                camera={cam}
                fill
                live={focused && pi === current}
                delay={(ri * cols + ci) * CONNECT_STAGGER}
                onPress={() => navigation.navigate('LiveView', { monitorId: cam.monitorId, name: cam.name, location: cam.groupName })}
              />
            ))}
            {row.length < cols && Array.from({ length: cols - row.length }).map((_, i) => <View key={`sp${i}`} style={{ flex: 1 }} />)}
          </View>
        );
      })}
    </View>
  ), [width, rowsPerPage, cols, focused, current, navigation]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* header — back · title · density switcher */}
      <ScreenHeader
        title={groupName || 'Live Wall'}
        onBack={() => navigation.goBack()}
        subtitle={`${cameras.length} cameras${pageCount > 1 ? ` · page ${current + 1} of ${pageCount}` : ''}`}
        right={
          <SegmentedControl
            options={DENSITY_OPTIONS}
            value={perPage}
            onChange={switchLayout}
            accessibilityLabel="Cameras per page"
          />
        }
      />

      {/* wall */}
      {isLoading ? (
        <View style={styles.pageLoading}>
          {Array.from({ length: rowsPerPage }).map((_, ri) => (
            <View style={styles.row} key={ri}>
              {Array.from({ length: cols }).map((_, i) => <View key={i} style={styles.skel} />)}
            </View>
          ))}
        </View>
      ) : cameras.length ? (
        <FlatList
          ref={listRef}
          key={`${cols}x${rowsPerPage}-${Math.round(width)}`}
          data={pages}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(_, i) => String(i)}
          renderItem={renderPage}
          onMomentumScrollEnd={onMomentumEnd}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialScrollIndex={current}
          style={{ flex: 1 }}
        />
      ) : (
        <EmptyState
          icon={error ? 'cloud-offline-outline' : 'videocam-off-outline'}
          title={error ? 'Can’t reach your server' : 'No cameras'}
          subtitle={error ? 'Check your connection and try again.' : 'Add cameras on the server to see them here.'}
          action={error ? 'Retry' : undefined} onAction={() => refetch()}
        />
      )}

      {/* pager — swipe works too */}
      {pageCount > 1 ? (
        <View style={[styles.pager, { paddingBottom: insets.bottom + spacing.sm }]}>
          <Pressable onPress={() => goTo(current - 1)} disabled={current === 0} style={[styles.pageBtn, current === 0 && { opacity: 0.4 }]} accessibilityLabel="Previous page">
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </Pressable>
          <View style={styles.dots}>
            {pages.map((_, i) => (
              <Pressable key={i} onPress={() => goTo(i)} hitSlop={8} accessibilityLabel={`Page ${i + 1}`}>
                <View style={[styles.pageDot, i === current && styles.pageDotOn]} />
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => goTo(current + 1)} disabled={current >= pageCount - 1} style={[styles.pageBtn, current >= pageCount - 1 && { opacity: 0.4 }]} accessibilityLabel="Next page">
            <Ionicons name="chevron-forward" size={20} color={colors.text} />
          </Pressable>
        </View>
      ) : (
        <View style={{ height: insets.bottom }} />
      )}
    </View>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  // pages ride a horizontal FlatList: height comes from '100%' of the list
  // (flex:1 would fight the explicit width on the main axis), while the
  // loading skeleton sits in the normal column flow and uses flex:1.
  page: { height: '100%', padding: spacing.sm, gap: spacing.sm },
  pageLoading: { flex: 1, padding: spacing.sm, gap: spacing.sm },
  row: { flex: 1, flexDirection: 'row', gap: spacing.sm },
  skel: { flex: 1, backgroundColor: colors.skeleton, borderRadius: radius.sm },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingTop: spacing.sm, paddingHorizontal: spacing.lg, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  pageBtn: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  dots: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' },
  pageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.mutedAlt },
  pageDotOn: { width: 18, backgroundColor: colors.primary },
});
