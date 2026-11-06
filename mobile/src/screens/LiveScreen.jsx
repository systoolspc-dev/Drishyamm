// Live — the second tab. One HERO player with a grid of previews under it,
// scoped by All Cameras / Favourites, and a pinned action bar for the hero.
//
// INTERACTION: tapping a grid tile PROMOTES it to hero; the hero's own expand
// button opens the full player. Promotion is deliberately not a navigation — an
// operator scanning a site shouldn't collect a back-stack entry per glance.
//
// CONCURRENCY: 1 hero + LIVE_TAB_TILES previews, budgeted against
// MAX_CONCURRENT_STREAMS (see lib/config.js). The grid EXCLUDES whichever
// camera is currently hero, so no camera is ever pulled twice, and promoting
// mounts/unmounts exactly two tiles rather than re-keying the whole grid.
// Everything is focus-gated: leave the tab and every pull is released.
//
// ACTION BAR — what is real and what is not:
//   Snapshot  REAL. expo-video's generateThumbnailsAsync grabs the current
//             frame off the hero player (shared up via playerRef rather than
//             standing up a second player for the same camera).
//   PTZ       DISABLED. No PTZ route exists (src/lib/api.js). A pan/tilt pad
//   Talk      DISABLED. No audio backchannel. Both say so when tapped rather
//             than pretending — on a security console a control that looks live
//             and does nothing is a safety problem, not a UX one.
//   More      REAL. Everything the hero can actually do today.
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { View, ScrollView, RefreshControl, StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { listGroups } from '../lib/api';
import { LIVE_TAB_TILES } from '../lib/config';
import { useFavorites } from '../lib/favoritesStore';
import { logError, log } from '../lib/log';
import LiveTile from '../components/LiveTile';
import {
  Txt, SegmentedControl, EmptyState, CameraTileSkeleton, IconButton,
  BottomSheet, SheetAction, Button, haptic,
} from '../components/ui';
import { radius, spacing, tabBarClearance, useTheme, useStyles } from '../theme';

const CONNECT_STAGGER = 350;
const WIDE = 700;

const SCOPES = [
  { key: 'all',       label: 'All Cameras' },
  { key: 'favorites', label: 'Favorites' },
];

export default function LiveScreen({ navigation }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const focused = useIsFocused();
  const [scope, setScope] = useState('all');
  const [heroId, setHeroId] = useState(null);
  const [manual, setManual] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [shot, setShot] = useState(null);      // { thumb, name } | { error, name }
  const [shooting, setShooting] = useState(false);

  const heroPlayer = useRef(null);
  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);

  const { data: groups = [], isLoading, error, refetch } = useQuery({
    queryKey: ['groups'], queryFn: listGroups, refetchInterval: 20_000,
  });

  // Online first — the hero should default to something that can actually play.
  const cameras = useMemo(() => {
    const all = groups.flatMap((g) => (g.cameras || []).map((c) => ({ ...c, groupName: g.name })));
    const scoped = scope === 'favorites' ? all.filter((c) => favIds.includes(c.monitorId)) : all;
    return [...scoped].sort((a, b) => (b.status === 'online') - (a.status === 'online'));
  }, [groups, scope, favIds]);

  // Keep the hero valid: if the current one leaves the scope (filter change,
  // camera removed), fall back to the first available rather than showing a
  // blank player.
  const hero = useMemo(
    () => cameras.find((c) => c.monitorId === heroId) || cameras[0] || null,
    [cameras, heroId]
  );
  useEffect(() => {
    if (hero && hero.monitorId !== heroId) setHeroId(hero.monitorId);
  }, [hero, heroId]);

  const grid = useMemo(
    () => cameras.filter((c) => c.monitorId !== hero?.monitorId).slice(0, LIVE_TAB_TILES),
    [cameras, hero]
  );

  const cols = width >= WIDE ? 3 : 2;
  const heroFav = hero ? favIds.includes(hero.monitorId) : false;

  const onRefresh = useCallback(async () => {
    setManual(true);
    try { await refetch(); } finally { setManual(false); }
  }, [refetch]);

  const openFull = useCallback((cam) => {
    navigation.navigate('LiveView', { monitorId: cam.monitorId, name: cam.name, location: cam.groupName });
  }, [navigation]);

  const promote = useCallback((cam) => { haptic.select(); setHeroId(cam.monitorId); }, []);

  // Grab the frame the hero is showing right now. Live HLS has no seekable
  // timeline, so we ask for the CURRENT time rather than a fixed offset — and
  // the docs don't promise this works on a live source, so failure is a normal
  // outcome that gets reported, not swallowed.
  const takeSnapshot = useCallback(async () => {
    const player = heroPlayer.current;
    if (!player || !hero) return;
    haptic.medium();
    setShooting(true);
    try {
      const at = typeof player.currentTime === 'number' ? player.currentTime : 0;
      const [thumb] = await player.generateThumbnailsAsync([at], { maxWidth: 1280 });
      if (!thumb) throw new Error('The player returned no frame.');
      log('snapshot', `captured ${hero.name}`, { width: thumb.width, height: thumb.height });
      setShot({ thumb, name: hero.name });
    } catch (e) {
      logError('snapshot', `${hero.name}: could not capture a frame`, e);
      setShot({ error: e?.message || 'Could not capture a frame.', name: hero.name });
    } finally {
      setShooting(false);
    }
  }, [hero]);

  const notAvailable = (what, why) => () => {
    haptic.light();
    setShot({ error: why, name: what });
  };

  const heroActions = hero ? [
    { key: 'expand', icon: 'scan-outline', label: `Open ${hero.name} full screen`, onPress: () => openFull(hero) },
    { key: 'fav', icon: heroFav ? 'heart' : 'heart-outline', active: heroFav, label: heroFav ? 'Remove from favourites' : 'Add to favourites', onPress: () => { haptic.select(); toggleFav(hero.monitorId); } },
    { key: 'play', icon: 'film-outline', label: 'Open recordings', onPress: () => navigation.navigate('Playback', { monitorId: hero.monitorId, name: hero.name }) },
  ] : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* header — menu · title · layout */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton
          icon="menu"
          variant="plain"
          onPress={() => { haptic.light(); navigation.navigate('Menu'); }}
          accessibilityLabel="Open menu"
        />
        <Txt t="title" style={styles.headerTitle} numberOfLines={1}>Live View</Txt>
        <IconButton
          icon="grid-outline"
          variant="plain"
          onPress={() => { haptic.light(); navigation.navigate('LiveWall'); }}
          accessibilityLabel="Open Live Wall"
        />
      </View>

      <View style={styles.scopeRow}>
        <SegmentedControl
          options={SCOPES}
          value={scope}
          onChange={setScope}
          variant="filled"
          accessibilityLabel="Camera scope"
          style={{ flex: 1 }}
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={manual} onRefresh={onRefresh}
            tintColor={colors.primaryInk} colors={[colors.primaryInk]}
          />
        }
      >
        {isLoading ? (
          <>
            <View style={{ marginBottom: spacing.md }}><CameraTileSkeleton /></View>
            <View style={styles.grid}>
              {Array.from({ length: cols }).map((_, i) => (
                <View key={i} style={[styles.gridCell, { width: `${100 / cols}%` }]}><CameraTileSkeleton /></View>
              ))}
            </View>
          </>
        ) : hero ? (
          <>
            <View style={styles.hero}>
              <LiveTile
                camera={hero}
                live={focused}
                variant="hero"
                actions={heroActions}
                playerRef={heroPlayer}
                aspect={4 / 3}
                onPress={() => openFull(hero)}
              />
            </View>

            {grid.length ? (
              <View style={styles.grid}>
                {grid.map((cam, i) => (
                  <View key={cam.monitorId} style={[styles.gridCell, { width: `${100 / cols}%` }]}>
                    <LiveTile
                      camera={cam}
                      live={focused}
                      delay={(i + 1) * CONNECT_STAGGER}
                      variant="overview"
                      onPress={() => promote(cam)}
                    />
                  </View>
                ))}
              </View>
            ) : null}

            {cameras.length > grid.length + 1 ? (
              <Txt t="caption" c={colors.faint} style={styles.hint}>
                Showing {grid.length + 1} of {cameras.length} · the recorder only serves a few
                streams at once, so use the Live Wall to page through the rest.
              </Txt>
            ) : null}
          </>
        ) : (
          <EmptyState
            icon={error ? 'cloud-offline-outline' : scope === 'favorites' ? 'heart-outline' : 'videocam-off-outline'}
            title={error ? 'Can’t reach your server' : scope === 'favorites' ? 'No favourites yet' : 'No cameras'}
            subtitle={
              error ? 'Check your connection and try again.'
                : scope === 'favorites' ? 'Tap the heart on any camera to pin it here.'
                : 'Cameras added on the server show up here.'
            }
            action={error ? 'Retry' : scope === 'favorites' ? 'Show all cameras' : undefined}
            onAction={() => { if (error) return refetch(); setScope('all'); }}
          />
        )}
      </ScrollView>

      {/* Action bar for the hero. A sibling BELOW the ScrollView rather than an
          absolute overlay, so the scroll area shrinks to fit it automatically;
          the margin lifts it clear of the floating tab bar. */}
      {hero ? (
        <View style={[styles.actionBar, { marginBottom: tabBarClearance + insets.bottom - spacing.md }]}>
          <Action
            icon="move-outline" label="PTZ" disabled
            onPress={notAvailable('PTZ', 'This camera’s pan/tilt/zoom isn’t wired to the app yet — use the web console.')}
          />
          <Action
            icon="mic-outline" label="Talk" disabled
            onPress={notAvailable('Talk', 'Two-way audio needs a backchannel the server doesn’t expose yet.')}
          />
          <Action icon="camera-outline" label="Snapshot" busy={shooting} onPress={takeSnapshot} />
          <Action icon="ellipsis-horizontal" label="More" onPress={() => { haptic.light(); setMoreOpen(true); }} />
        </View>
      ) : null}

      {/* snapshot result — or an honest reason there isn't one */}
      <BottomSheet
        visible={!!shot}
        onClose={() => setShot(null)}
        title={shot?.error ? shot.name : `Snapshot · ${shot?.name ?? ''}`}
        footer={<Button title="Close" variant="secondary" onPress={() => setShot(null)} style={{ marginTop: spacing.sm }} />}
      >
        {shot?.thumb ? (
          <>
            <Image source={shot.thumb} style={styles.shot} contentFit="cover" transition={120} />
            <Txt t="caption" c={colors.faint} style={{ textAlign: 'center', marginTop: spacing.sm }}>
              Captured from the live stream. Saving to the gallery needs a media-library
              permission the app doesn’t request yet.
            </Txt>
          </>
        ) : (
          <View style={styles.shotError}>
            <Ionicons name="information-circle-outline" size={22} color={colors.sub} />
            <Txt t="sub" c={colors.sub} style={{ flex: 1 }}>{shot?.error}</Txt>
          </View>
        )}
      </BottomSheet>

      {/* everything the hero can actually do today */}
      <BottomSheet visible={moreOpen} onClose={() => setMoreOpen(false)} title={hero?.name || 'Camera'}>
        <SheetAction
          icon="expand-outline" label="Open full player"
          hint="Controls, quality and camera switching"
          onPress={() => { setMoreOpen(false); if (hero) openFull(hero); }}
        />
        <SheetAction
          icon="film-outline" label="Recordings"
          hint="Browse this camera’s clips by day"
          onPress={() => { setMoreOpen(false); if (hero) navigation.navigate('Playback', { monitorId: hero.monitorId, name: hero.name }); }}
        />
        <SheetAction
          icon={heroFav ? 'heart' : 'heart-outline'}
          label={heroFav ? 'Remove from favourites' : 'Add to favourites'}
          hint="Favourites are saved on this device"
          onPress={() => { if (hero) toggleFav(hero.monitorId); setMoreOpen(false); }}
        />
        <SheetAction
          icon="grid-outline" label="Live Wall"
          hint="Every camera on one screen"
          onPress={() => { setMoreOpen(false); navigation.navigate('LiveWall'); }}
        />
      </BottomSheet>
    </View>
  );
}

// One control in the bottom bar. `disabled` still takes a press — it opens the
// reason instead of doing nothing, which is the whole point.
function Action({ icon, label, onPress, disabled, busy }) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={disabled ? `${label}, not available` : label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.muted }]}
    >
      <Ionicons
        name={busy ? 'hourglass-outline' : icon}
        size={20}
        color={disabled ? colors.faint : colors.text}
      />
      <Txt t="caption" c={disabled ? colors.faint : colors.sub}>{label}</Txt>
    </Pressable>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingBottom: spacing.md,
  },
  headerTitle: { flex: 1, textAlign: 'center' },
  scopeRow: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.md },

  hero: { marginBottom: spacing.md },
  // negative gutter + per-cell padding: percentage widths and `gap` fight each
  // other, overflowing the row and wrapping a cell early
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs, rowGap: spacing.md },
  gridCell: { paddingHorizontal: spacing.xs },
  hint: { textAlign: 'center', marginTop: spacing.md, paddingHorizontal: spacing.lg },

  actionBar: {
    flexDirection: 'row', gap: spacing.sm,
    marginHorizontal: spacing.lg,
  },
  action: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3,
    minHeight: 64, borderRadius: radius.lg,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },

  shot: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md, backgroundColor: colors.video },
  shotError: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
});
