// Home — enterprise AI-surveillance dashboard.
//
// HIERARCHY (top to bottom):
//   greeting (pinned) → banner → current site → summary → search
//   → Live Overview → AI Alerts
//
// The banner is FIRST and outside the search branch: a weapon detection has to
// be visible without scrolling and without clearing the search box.
//
// Current site is a viewing LENS — it narrows the summary tiles, Live Overview,
// the alert list and search to one site. It sits above the search field because
// the tiles under it describe the scope it sets.
//
// Two independent queries (devices, alarms) so they load, fail and retry
// INDEPENDENTLY: a dead alarms endpoint must never blank out cameras that
// fetched perfectly well.
//
// Banner discipline: at most ONE full-width banner is ever on screen. A threat
// outranks a load failure, because a weapon detection matters more than a stale
// list. An earlier build could stack an error bar, a threat banner AND a status
// strip, which buried the thing it was trying to surface.
//
// Typing swaps the whole page for a result view. Search used to filter only the
// Devices section — below the fold on a phone — so it looked broken even though
// it worked.
import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { View, ScrollView, RefreshControl, StyleSheet, Pressable, Animated, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { listGroups, listAiEvents } from '../lib/api';
import { MAX_LIVE_TILES } from '../lib/config';
import { useAuth } from '../lib/authStore';
import { useFavorites } from '../lib/favoritesStore';
import { eventIcon, eventTitle } from '../lib/events';
import { siteStatus } from '../lib/sites';
import { radius, spacing, tabBarClearance, useTheme, useStyles } from '../theme';
import {
  Card, Txt, SectionHeader, Badge, IconButton, Button, EmptyState,
  SearchField, SummaryCard, BottomSheet, SheetAction,
  AlertRowSkeleton, CameraTileSkeleton, haptic,
} from '../components/ui';
import CameraCard from '../components/CameraCard';
import LiveTile from '../components/LiveTile';

// Live Overview shows this many cameras. It equals MAX_LIVE_TILES on purpose —
// every tile in the grid may stream, so this section IS the screen's whole
// stream budget (see MAX_CONCURRENT_STREAMS in lib/config.js).
const OVERVIEW_TILES = MAX_LIVE_TILES;
const RECENT_ALERTS = 4;
const CONNECT_STAGGER = 350;  // ms between live-tile connects — protects the NVR
const THREAT_RE = /weapon|fire|aggression/;
const THREAT_WINDOW_MS = 15 * 60 * 1000; // banner only for events this fresh
const FRESH_WINDOW_MS = 60 * 60 * 1000;  // bell count — "arrived while you were away"
const WIDE = 700;             // px where we treat the device as a tablet


const SCOPES = [
  { key: 'all',     icon: 'search-outline',        label: 'Everything', hint: 'Cameras, sites and AI events' },
  { key: 'cameras', icon: 'videocam-outline',      label: 'Cameras',    hint: 'Camera, site and location names' },
  { key: 'alerts',  icon: 'notifications-outline', label: 'AI events',  hint: 'Detections, plates and people' },
];

const firstName = (u) => String(u?.name || u?.email || 'Operator').trim().split(/[\s@]+/)[0];

function timeAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export default function HomeScreen({ navigation }) {
  const { colors, shadow, sevOf } = useTheme();
  const styles = useStyles(makeStyles);
  const user = useAuth((s) => s.user);
  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const focused = useIsFocused(); // live tiles stream ONLY while Home is on top

  const [manualRefresh, setManualRefresh] = useState(false);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('all');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [downOpen, setDownOpen] = useState(false);
  // null = All Sites. Session-scoped on purpose: it is a viewing lens, not a
  // setting, and a security console should open showing everything by default
  // rather than silently still narrowed from yesterday.
  // THREE states, and the distinction matters:
  //   undefined — not chosen yet; the effect below settles it on the first site
  //   <id>      — that site
  //   null      — "All Sites", but only ever because the operator picked it
  // Both undefined and null scope to everything (`siteId == null`), so the page
  // is correct during the beat before groups arrive.
  const [siteId, setSiteId] = useState(undefined);
  const [siteOpen, setSiteOpen] = useState(false);

  // Responsive: 2 columns on a phone, 3 on a tablet. Everything else rides the
  // 8pt scale, so there are no other breakpoints to keep in sync.
  const wide = width >= WIDE;
  const padH = wide ? spacing.xl : spacing.lg;
  const cols = wide ? 3 : 2;

  const groupsQ = useQuery({ queryKey: ['groups'], queryFn: listGroups, refetchInterval: 15_000 });
  // limit 100 matches Alerts and Live View. All three share the key
  // ['ai-events'], so a different limit here meant whichever screen mounted
  // FIRST decided how much data every other screen saw — and Home's counts were
  // whatever it happened to get.
  const eventsQ = useQuery({ queryKey: ['ai-events'], queryFn: () => listAiEvents({ limit: 100 }), refetchInterval: 20_000 });

  const groups = groupsQ.data || [];
  const events = eventsQ.data || [];

  // groupId rides along so the site scope can filter on an id rather than on a
  // name, which two recorders are free to share.
  const allCameras = useMemo(
    () => groups.flatMap((g) => (g.cameras || []).map((c) => ({ ...c, groupName: g.name, groupId: g.id }))),
    [groups]
  );

  // ── SITE SCOPE ─────────────────────────────────────────────────────────────
  const currentSite = useMemo(() => groups.find((g) => g.id === siteId) || null, [groups, siteId]);

  useEffect(() => {
    // Settle on a REAL site as soon as the list arrives. "Current Site: All
    // Sites" names no site at all, and on an account with one or two recorders
    // it reads as if the picker failed to load.
    if (siteId === undefined && groups.length) { setSiteId(groups[0].id); return; }
    // The chosen site vanished (removed, access revoked). Back to undefined so
    // the branch above re-settles on whatever is still there, rather than
    // silently dropping to All Sites.
    if (siteId != null && !groups.some((g) => g.id === siteId)) setSiteId(undefined);
  }, [groups, siteId]);

  const cameras = useMemo(
    () => (siteId == null ? allCameras : allCameras.filter((c) => c.groupId === siteId)),
    [allCameras, siteId]
  );
  const online = cameras.filter((c) => c.status === 'online').length;
  const downCams = useMemo(() => cameras.filter((c) => c.status !== 'online'), [cameras]);

  // An event belongs to the scope when its camera does. Events name their
  // camera rather than their site, so this matches on id first and falls back
  // to the name — the same rule cameraFor() uses below.
  const scopedEvents = useMemo(() => {
    if (siteId == null) return events;
    const ids = new Set(cameras.map((c) => c.monitorId));
    const names = new Set(cameras.map((c) => String(c.name || '').trim().toLowerCase()));
    return events.filter((e) => ids.has(e.monitorId) || ids.has(e.cameraId)
      || names.has(String(e.cameraName || '').trim().toLowerCase()));
  }, [events, cameras, siteId]);

  // A site counts as active when at least one of its cameras is streaming — a
  // recorder with every channel down is present, not active.
  const activeSites = useMemo(
    () => groups.filter((g) => (g.cameras || []).some((c) => c.status === 'online')).length,
    [groups]
  );

  // The status line under the current site. For ONE site this is exactly what
  // the Sites screen shows for it (lib/sites), so the two can never disagree.
  // For All Sites it rolls the same rule up across the account.
  const siteState = useMemo(() => {
    if (currentSite) {
      const s = siteStatus(currentSite);
      return { tint: s.tint, label: s.label };
    }
    if (!groups.length) return { tint: 'off', label: 'No sites' };
    if (activeSites === groups.length) return { tint: 'ok', label: `All ${groups.length} ${groups.length === 1 ? 'site' : 'sites'} active` };
    if (activeSites) return { tint: 'warn', label: `${activeSites} of ${groups.length} sites active` };
    return { tint: 'off', label: 'No sites active' };
  }, [currentSite, groups.length, activeSites]);

  const todayAlerts = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return scopedEvents.filter((e) => e.ts && new Date(e.ts).getTime() >= start.getTime()).length;
  }, [scopedEvents]);

  // Per-section state. Keeping these separate is the point — see file header.
  const devicesLoading = groupsQ.isLoading;
  const devicesError   = groupsQ.isError;
  const alarmsLoading  = eventsQ.isLoading;
  const alarmsError    = eventsQ.isError;
  const anyError       = devicesError || alarmsError;
  const refetchGroups  = groupsQ.refetch;
  const refetchEvents  = eventsQ.refetch;

  // Live Overview: online first, then the live budget spread across the grid.
  const overview = useMemo(() => {
    const sorted = [...cameras].sort((a, b) => (b.status === 'online') - (a.status === 'online'));
    let budget = MAX_LIVE_TILES;
    let order = 0;
    return sorted.slice(0, OVERVIEW_TILES).map((c) => {
      const isLive = c.status === 'online' && budget > 0;
      if (isLive) budget -= 1;
      return { ...c, isLive, delay: isLive ? order++ * CONNECT_STAGGER : 0 };
    });
  }, [cameras]);

  // Drishyam differentiator: surface the AI. A fresh weapon/fire/aggression (or
  // critical) event becomes a banner at the top of the page.
  //
  // DELIBERATELY NOT SITE-SCOPED — this and the bell below read `events`, not
  // `scopedEvents`. Narrowing the page to one site is a viewing preference; a
  // weapon detected at another site is still a weapon, and hiding it because
  // the operator happened to be looking elsewhere is exactly the failure this
  // banner exists to prevent.
  const recentThreat = useMemo(() => events.find((e) => {
    const fresh = e.ts && Date.now() - new Date(e.ts).getTime() < THREAT_WINDOW_MS;
    return fresh && (THREAT_RE.test(String(e.eventType || '').toLowerCase()) || String(e.severity || '').toLowerCase() === 'critical');
  }), [events]);

  // Bell count. There is no read/unread endpoint, so this deliberately counts
  // RECENT alarms rather than pretending to know what you have seen — the
  // accessibility label says exactly that.
  const freshCount = useMemo(
    () => events.filter((e) => e.ts && Date.now() - new Date(e.ts).getTime() < FRESH_WINDOW_MS).length,
    [events]
  );


  const cameraFor = useCallback((e) => {
    const n = String(e?.cameraName || '').trim().toLowerCase();
    for (const g of groups) {
      for (const c of g.cameras || []) {
        if (c.monitorId === e?.monitorId || c.monitorId === e?.cameraId) return { ...c, groupName: g.name };
        if (n && String(c.name || '').trim().toLowerCase() === n) return { ...c, groupName: g.name };
      }
    }
    return null;
  }, [groups]);

  // ── search ─────────────────────────────────────────────────────────────────
  const needle = q.trim().toLowerCase();
  const camMatches = useMemo(() => {
    if (!needle || scope === 'alerts') return [];
    return cameras.filter((c) =>
      (c.name || '').toLowerCase().includes(needle) ||
      (c.groupName || '').toLowerCase().includes(needle) ||
      (c.location || '').toLowerCase().includes(needle)
    );
  }, [cameras, needle, scope]);

  const eventMatches = useMemo(() => {
    if (!needle || scope === 'cameras') return [];
    return scopedEvents.filter((e) =>
      (e.eventType || '').toLowerCase().includes(needle) ||
      (e.cameraName || '').toLowerCase().includes(needle) ||
      (e.personName || '').toLowerCase().includes(needle) ||
      (e.plateNumber || '').toLowerCase().includes(needle) ||
      (e.description || '').toLowerCase().includes(needle)
    ).slice(0, 20);
  }, [scopedEvents, needle, scope]);

  const resultCount = camMatches.length + eventMatches.length;
  const scopeLabel = SCOPES.find((s) => s.key === scope)?.label ?? 'Everything';

  const onRefresh = useCallback(async () => {
    setManualRefresh(true);
    try { await Promise.all([refetchGroups(), refetchEvents()]); }
    finally { setManualRefresh(false); }
  }, [refetchGroups, refetchEvents]);

  const openCam = useCallback((cam) =>
    navigation.navigate('LiveView', { monitorId: cam.monitorId, name: cam.name, location: cam.groupName }), [navigation]);

  const openAlertCam = (e) => {
    const cam = cameraFor(e);
    if (cam) openCam(cam); else navigation.navigate('Alerts');
  };

  // Header separator, driven off scroll position on the native side. useRef so
  // it survives re-renders — a fresh Animated.Value per render would reset the
  // separator every time one of the polling queries settles.
  const scrollY = useRef(new Animated.Value(0)).current;
  const onScroll = useMemo(
    () => Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true }),
    [scrollY]
  );
  const ruleOpacity = scrollY.interpolate({ inputRange: [0, 12], outputRange: [0, 1], extrapolate: 'clamp' });

  const tileFor = (cam) => {
    const shared = {
      camera: cam,
      favorite: favIds.includes(cam.monitorId),
      onToggleFavorite: () => toggleFav(cam.monitorId),
      onPress: () => openCam(cam),
      onPlayback: () => navigation.navigate('Playback', { monitorId: cam.monitorId, name: cam.name }),
    };
    return cam.isLive
      ? <LiveTile {...shared} live={focused} delay={cam.delay} variant="overview" />
      : <CameraCard {...shared} variant="overview" />;
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* PINNED HEADER — greeting only. A sibling ABOVE the ScrollView rather
          than an absolute overlay, so content never scrolls beneath it and no
          padding has to compensate for its height. */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm, paddingHorizontal: padH }]}>
        <View style={styles.greetRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt t="h2" numberOfLines={1}>Hello, {firstName(user)} 👋</Txt>
            <Txt t="sub" c={colors.sub} numberOfLines={1}>Here’s what’s happening today</Txt>
          </View>
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
        <Animated.View pointerEvents="none" style={[styles.headerRule, { opacity: ruleOpacity }]} />
      </View>

      <Animated.ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: spacing.md,
          paddingHorizontal: padH,
          // the tab bar floats over the scene and reserves no layout space
          paddingBottom: tabBarClearance + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={manualRefresh}
            onRefresh={onRefresh}
            tintColor={colors.primaryInk}
            colors={[colors.primaryInk]}
            progressBackgroundColor={colors.surface}
          />
        }
      >
        {/* ONE banner, by priority: a live threat outranks a load failure. */}
        {!alarmsError && !alarmsLoading && recentThreat ? (
          <Pressable
            onPress={() => { haptic.medium(); openAlertCam(recentThreat); }}
            accessibilityRole="button"
            accessibilityLabel="Critical alert, tap to view"
            style={({ pressed }) => [styles.threatBar, shadow(2), pressed && { opacity: 0.9 }]}
          >
            <View style={styles.threatIcon}><Ionicons name="warning" size={18} color="#fff" /></View>
            <View style={{ flex: 1 }}>
              <Txt t="bodyMed" c="#fff" numberOfLines={1} style={{ textTransform: 'capitalize' }}>
                {String(recentThreat.eventType || 'critical alert').replace(/_/g, ' ')} detected
              </Txt>
              <Txt t="caption" c="rgba(255,255,255,0.88)" numberOfLines={1}>
                {recentThreat.cameraName || 'Unknown camera'} · {timeAgo(recentThreat.ts)} · tap to view
              </Txt>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#fff" />
          </Pressable>
        ) : anyError ? (
          <Pressable
            onPress={onRefresh}
            accessibilityRole="button"
            accessibilityLabel="Retry loading"
            style={({ pressed }) => [styles.errorBar, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="warning-outline" size={18} color={colors.criticalInk} />
            <View style={{ flex: 1 }}>
              <Txt t="bodyMed" c={colors.criticalInk}>
                {devicesError && alarmsError ? 'Can’t reach your server' : devicesError ? 'Devices didn’t load' : 'Alerts didn’t load'}
              </Txt>
              <Txt t="caption" c={colors.criticalInk}>Data may be out of date · tap to retry</Txt>
            </View>
            <Ionicons name="refresh" size={17} color={colors.criticalInk} />
          </Pressable>
        ) : null}

        {/* ── CURRENT SITE ─────────────────────────────────────────────────
            A viewing LENS over the page: picking a site narrows Live Overview,
            the Cameras/AI Alerts tiles, the alert list and search to that site.
            The threat banner and the bell stay account-wide on purpose — see
            the note on `recentThreat`.
            The third line is STATUS, derived by lib/sites the same way the
            Sites screen derives it, so one site can never read Online here and
            Offline there. It is not an address: a group is
            { id, name, host, status, cameras } and carries no address field. */}
        <Pressable
          onPress={() => { haptic.light(); setSiteOpen(true); }}
          accessibilityRole="button"
          accessibilityLabel={`Current site: ${currentSite ? currentSite.name : 'All sites'}, ${siteState.label}. Tap to change`}
          style={({ pressed }) => [styles.siteBar, pressed && { backgroundColor: colors.muted }]}
        >
          <View style={styles.sitePin}>
            <Ionicons name="location" size={19} color={colors.primaryInk} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt t="caption" c={colors.sub}>Current Site</Txt>
            <Txt t="titleSm" numberOfLines={1}>{currentSite ? currentSite.name : 'All Sites'}</Txt>
            <View style={styles.siteStatus}>
              <View style={[styles.siteDot, { backgroundColor: colors[siteState.tint] }]} />
              <Txt t="caption" c={colors.sub} numberOfLines={1}>{siteState.label}</Txt>
            </View>
          </View>
          <Ionicons name="chevron-down" size={18} color={colors.faint} />
        </Pressable>

        {/* ── SUMMARY ───────────────────────────────────────────────────────
            Above the search field, per the design: these three describe the
            current scope, so they belong beside the site that sets it rather
            than below the box you search it with. They stay on screen while
            searching for the same reason. */}
        <View style={styles.summaryRow}>
          <SummaryCard
            icon="videocam-outline" tint="primary" label="Cameras"
            value={devicesLoading ? '—' : String(cameras.length)}
            footLabel={devicesLoading ? ' ' : `${online} online`}
            footState={cameras.length && online === cameras.length ? 'online' : online ? 'warn' : 'off'}
            loading={devicesLoading}
            onPress={() => navigation.navigate('Cameras')}
            accessibilityLabel={`${cameras.length} cameras, ${online} online. Open Cameras`}
          />
          <SummaryCard
            icon="notifications-outline" tint="critical" label="AI Alerts"
            value={alarmsLoading ? '—' : String(scopedEvents.length)}
            footLabel={alarmsLoading ? ' ' : `${todayAlerts} today`}
            footState={todayAlerts ? 'warn' : 'online'}
            loading={alarmsLoading}
            onPress={() => navigation.navigate('Alerts')}
            accessibilityLabel={`${scopedEvents.length} recent alerts, ${todayAlerts} today. Open Alerts`}
          />
          <SummaryCard
            icon="business-outline" tint="info" label="Sites"
            value={devicesLoading ? '—' : String(groups.length)}
            footLabel={devicesLoading ? ' ' : `${activeSites} active`}
            footState={groups.length && activeSites === groups.length ? 'online' : activeSites ? 'warn' : 'off'}
            loading={devicesLoading}
            onPress={() => navigation.navigate('Sites')}
            accessibilityLabel={`${groups.length} sites, ${activeSites} active. Open Sites`}
          />
        </View>

        {/* search + scope filter */}
        <View style={styles.searchRow}>
          <View style={{ flex: 1 }}>
            {/* Placeholder kept short enough to fit the field beside the 48pt
                scope button: "Search cameras, AI events, locations…" overran
                the available width and clipped mid-word. The scope sheet
                already spells out what is being searched. */}
            <SearchField
              value={q}
              onChangeText={setQ}
              placeholder="Search cameras or events…"
            />
          </View>
          <Pressable
            onPress={() => { haptic.light(); setScopeOpen(true); }}
            accessibilityRole="button"
            accessibilityLabel={`Search filter: ${scopeLabel}. Tap to change`}
            style={({ pressed }) => [
              styles.filterBtn,
              scope !== 'all' && styles.filterBtnOn,
              pressed && { backgroundColor: colors.mutedAlt },
            ]}
          >
            <Ionicons name="options-outline" size={19} color={scope === 'all' ? colors.sub : colors.primaryInk} />
          </Pressable>
        </View>

        {needle ? (
          /* ── RESULTS ────────────────────────────────────────────────────
             Results are STATIC CameraCards, never LiveTiles: live tiles would
             re-key on every keystroke and fire a connect/teardown at the
             recorder per character typed. Search is a finder, not a monitor. */
          <>
            <Txt t="label" c={colors.sub} style={styles.resultsLabel}>
              {resultCount} {resultCount === 1 ? 'result' : 'results'} · {scopeLabel}
            </Txt>

            {camMatches.length ? (
              <>
                <Txt t="titleSm" style={styles.resultsGroup}>Cameras</Txt>
                <View style={styles.grid}>
                  {camMatches.map((cam) => (
                    <View key={cam.monitorId} style={[styles.gridCell, { width: `${100 / cols}%` }]}>
                      <CameraCard
                        camera={cam}
                        onPress={() => openCam(cam)}
                        favorite={favIds.includes(cam.monitorId)}
                        onToggleFavorite={() => toggleFav(cam.monitorId)}
                      />
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            {eventMatches.length ? (
              <>
                <Txt t="titleSm" style={styles.resultsGroup}>AI events</Txt>
                {eventMatches.map((e, i) => (
                  <AlertCard key={e.id || `m${i}`} event={e} place={cameraFor(e)?.groupName} onPress={() => openAlertCam(e)} />
                ))}
              </>
            ) : null}

            {resultCount === 0 ? (
              <Card variant="flat" padding="none">
                <EmptyState
                  compact
                  icon="search-outline"
                  title="No matches"
                  subtitle={`Nothing in ${scopeLabel.toLowerCase()} matches “${q.trim()}”.`}
                  action="Clear search"
                  onAction={() => setQ('')}
                />
              </Card>
            ) : null}
          </>
        ) : (
        <>
          {/* ── LIVE OVERVIEW ───────────────────────────────────────────── */}
          <SectionHeader
            title="Live Overview"
            actionLabel={cameras.length ? 'View All' : undefined}
            onAction={() => navigation.navigate('Cameras')}
          />
          {devicesLoading ? (
            <View style={styles.grid}>
              {Array.from({ length: cols }).map((_, i) => (
                <View key={i} style={[styles.gridCell, { width: `${100 / cols}%` }]}><CameraTileSkeleton /></View>
              ))}
            </View>
          ) : devicesError ? (
            <Card variant="flat" padding="none">
              <EmptyState
                compact icon="cloud-offline-outline"
                title="Devices didn’t load"
                subtitle="We couldn’t reach your server. Check your connection and try again."
                action="Retry" onAction={() => refetchGroups()}
              />
            </Card>
          ) : overview.length ? (
            <View style={styles.grid}>
              {overview.map((cam) => (
                <View key={cam.monitorId} style={[styles.gridCell, { width: `${100 / cols}%` }]}>
                  {tileFor(cam)}
                </View>
              ))}
            </View>
          ) : (
            <Card variant="flat" padding="none">
              <EmptyState
                compact icon="videocam-off-outline"
                title="No cameras yet"
                subtitle="Cameras added on the server show up here."
              />
            </Card>
          )}

          {/* ── RECENT AI ALERTS ────────────────────────────────────────── */}
          <SectionHeader
            title="AI Alerts"
            actionLabel={scopedEvents.length ? 'View All' : undefined}
            onAction={() => navigation.navigate('Alerts')}
          />
          {alarmsLoading ? (
            <Card variant="flat" padding="none" style={{ paddingHorizontal: spacing.md }}>
              <AlertRowSkeleton /><AlertRowSkeleton /><AlertRowSkeleton />
            </Card>
          ) : alarmsError ? (
            <Card variant="flat" padding="none">
              <EmptyState
                compact icon="alert-circle-outline"
                title="Alerts didn’t load"
                subtitle="Detections will appear here once the server responds."
                action="Retry" onAction={() => refetchEvents()}
              />
            </Card>
          ) : scopedEvents.length ? (
            scopedEvents.slice(0, RECENT_ALERTS).map((e, i) => (
              <AlertCard key={e.id || i} event={e} place={cameraFor(e)?.groupName} onPress={() => openAlertCam(e)} />
            ))
          ) : (
            <Card variant="flat" padding="none">
              <EmptyState
                compact icon="shield-checkmark-outline"
                title="All clear"
                subtitle="No alerts in the recent window."
              />
            </Card>
          )}

        </>
        )}
      </Animated.ScrollView>

      {/* search scope */}
      <BottomSheet visible={scopeOpen} onClose={() => setScopeOpen(false)} title="Search in">
        {SCOPES.map((s) => (
          <SheetAction
            key={s.key}
            icon={s.key === scope ? 'checkmark-circle' : s.icon}
            label={s.label}
            hint={s.hint}
            onPress={() => { setScope(s.key); setScopeOpen(false); }}
          />
        ))}
      </BottomSheet>

      {/* site picker — every site, with its real camera counts */}
      <BottomSheet visible={siteOpen} onClose={() => setSiteOpen(false)} title="Current site" scrollable>
        {/* Offered only when there is more than one site to combine. On a
            single-recorder account "All Sites" and that site are the same rows
            of data under two names. */}
        {groups.length > 1 ? (
          <SheetAction
            icon={siteId === null ? 'checkmark-circle' : 'albums-outline'}
            label="All Sites"
            hint={`${groups.length} sites · ${allCameras.length} cameras`}
            onPress={() => { setSiteId(null); setSiteOpen(false); }}
          />
        ) : null}
        {groups.map((g) => {
          const cams = g.cameras || [];
          const up = cams.filter((c) => c.status === 'online').length;
          return (
            <SheetAction
              key={g.id}
              icon={siteId === g.id ? 'checkmark-circle' : 'business-outline'}
              label={g.name}
              hint={`${cams.length} ${cams.length === 1 ? 'camera' : 'cameras'} · ${up} online${g.host ? ` · ${g.host}` : ''}`}
              onPress={() => { setSiteId(g.id); setSiteOpen(false); }}
            />
          );
        })}
      </BottomSheet>

      {/* which cameras are down — opened from the Sites card */}
      <BottomSheet
        visible={downOpen}
        onClose={() => setDownOpen(false)}
        title="Offline cameras"
        right={<Badge label={String(downCams.length)} fg={colors.warnInk} bg={colors.warnSoft} />}
        scrollable
        maxHeightRatio={0.5}
        footer={
          <>
            <Txt t="caption" c={colors.faint} style={{ textAlign: 'center', marginTop: spacing.sm }}>
              Offline usually means the recorder isn’t streaming that channel right now.
            </Txt>
            <Button
              title="Open Cameras" variant="secondary"
              onPress={() => { setDownOpen(false); navigation.navigate('Cameras'); }}
              style={{ marginTop: spacing.sm }}
            />
          </>
        }
      >
        {downCams.map((cam, i) => (
          <Pressable
            key={cam.monitorId}
            onPress={() => { haptic.light(); setDownOpen(false); openCam(cam); }}
            accessibilityRole="button"
            accessibilityLabel={`${cam.name}, offline, tap to try live`}
            style={({ pressed }) => [styles.downRow, i < downCams.length - 1 && styles.rowBorder, pressed && { backgroundColor: colors.muted }]}
          >
            <View style={styles.downIcon}><Ionicons name="videocam-off-outline" size={16} color={colors.off} /></View>
            <View style={{ flex: 1 }}>
              <Txt t="bodyMed" numberOfLines={1}>{cam.name}</Txt>
              <Txt t="caption" c={colors.faint} numberOfLines={1}>{cam.groupName}{cam.location ? ` · ${cam.location}` : ''}</Txt>
            </View>
            <Ionicons name="chevron-forward" size={15} color={colors.faint} />
          </Pressable>
        ))}
      </BottomSheet>
    </View>
  );
}

// One AI alert. Severity drives a decorative left stripe (VIVID tone) and the
// badge text (INK tone) — see the two-tier note in theme/palettes.js.
function AlertCard({ event, place, onPress }) {
  const { colors, press, sevOf } = useTheme();
  const styles = useStyles(makeStyles);
  const sv = sevOf(event.severity);
  const title = eventTitle(event.eventType);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={`${title} on ${event.cameraName || 'camera'}${place ? `, ${place}` : ''}, ${event.severity || 'low'} severity. Open live`}
      style={({ pressed }) => [styles.alertCard, pressed && { transform: [{ scale: press.cardScale }] }]}
    >
      <View style={[styles.alertStripe, { backgroundColor: sv.accent }]} />
      <View style={[styles.alertIcon, { backgroundColor: sv.bg }]}>
        <Ionicons name={eventIcon(event.eventType)} size={17} color={sv.fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="titleSm" numberOfLines={1} style={{ textTransform: 'capitalize' }}>{title}</Txt>
        {/* one quiet line: where, then when */}
        <Txt t="caption" c={colors.sub} numberOfLines={1} style={{ marginTop: 2 }}>
          {event.cameraName || place || 'Unknown camera'} • {event.ts ? timeAgo(event.ts) : '—'}
        </Txt>
      </View>
      <Badge label={String(event.severity || 'low').toUpperCase()} dot fg={sv.fg} bg={sv.bg} />
    </Pressable>
  );
}

const makeStyles = ({ colors, isDark }) => StyleSheet.create({
  header: { backgroundColor: colors.bg, paddingBottom: spacing.sm },
  headerRule: { position: 'absolute', left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  greetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  bellDot: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, paddingHorizontal: 4,
    borderRadius: 9, backgroundColor: colors.alarm,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.bg,
  },
  bellDotText: { fontSize: 9, lineHeight: 12 },

  // Current-site bar. Bordered, not raised: it sits directly above the raised
  // summary cards, and two shadow layers stacked read as clutter.
  siteBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: spacing.lg,
  },
  sitePin: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center',
  },
  siteStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  siteDot: { width: 7, height: 7, borderRadius: 3.5 },

  // marginTop, not a marginBottom on summaryRow: the summary now sits directly
  // above this, and the gap belongs to whichever element can be absent. The
  // summary always renders; the spacing rides with the search field.
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginTop: spacing.lg,
  },
  filterBtn: {
    width: 48, height: 48, borderRadius: radius.md,
    backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  filterBtnOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },

  resultsLabel: { marginBottom: spacing.md },
  resultsGroup: { marginBottom: spacing.sm },

  errorBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.critSoft, borderRadius: radius.md, borderWidth: 1, borderColor: isDark ? 'rgba(255,107,96,0.35)' : '#F8D3D0', padding: spacing.md, marginBottom: spacing.lg },
  threatBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.alarm, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.lg },
  threatIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },

  summaryRow: { flexDirection: 'row', gap: spacing.md },

  // Negative gutter + per-cell padding. Percentage widths and `gap` fight each
  // other — 100% plus gaps overflows the row and wraps a cell early.
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs, rowGap: spacing.md, marginBottom: spacing.md },
  gridCell: { paddingHorizontal: spacing.xs },


  alertCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.md, paddingRight: spacing.md, paddingLeft: spacing.lg,
    marginBottom: spacing.sm + 2, overflow: 'hidden',
  },
  alertStripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  alertIcon: { width: 38, height: 38, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },

  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  downRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56, borderRadius: radius.md, paddingHorizontal: spacing.xs },
  downIcon: { width: 34, height: 34, borderRadius: radius.chip, backgroundColor: colors.offSoft, alignItems: 'center', justifyContent: 'center' },
});
