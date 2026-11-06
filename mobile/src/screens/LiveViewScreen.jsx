// Live view — the full player for ONE camera.
//
// LAYOUT: header (back · name/status · overflow) → rounded player with its
// controls ON the frame → camera switcher → Camera Details → Recent Events.
//
// Controls sit INSIDE the video rather than in a bar beneath it. The frame is
// the only thing on this screen anyone looks at, so the controls belong on it;
// putting them below cost a whole row of chrome and pushed the details card off
// a small screen. State indicators still render in the CENTRE of the frame,
// never over the controls.
//
// Quality follows the GLOBAL setting (Auto = HD on Wi-Fi, SD on cellular) and
// tapping SD/HD here writes back to it — one choice applies to every camera.
//
// Camera switching walks the same flat camera list the Cameras tab builds, and
// swaps route params IN PLACE rather than pushing, so the back stack stays
// one-deep however far the operator pans across the site.
//
// WHAT IS REAL: play/pause, mute, snapshot, quality, fullscreen, switching,
// playback, favourite. NOT REAL and therefore disabled with a stated reason:
// recording (no endpoint) and PTZ (no endpoint) — see src/lib/api.js. On a
// security console a control that looks live and does nothing is a safety
// problem, not a UX one.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNetInfo } from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { startStream, listAiEvents, listGroups, getEventSnapshotUrl } from '../lib/api';
import { useSettings, resolveQuality } from '../lib/settingsStore';
import { useFavorites } from '../lib/favoritesStore';
import { eventIcon, eventTitle } from '../lib/events';
import { logError, log, warn } from '../lib/log';
import { acquireStream, releaseStream } from '../lib/streamBudget';
import { Txt, IconButton, BottomSheet, SheetAction, Button, EmptyState, haptic } from '../components/ui';
import { radius, spacing, fonts, motion, useTheme, useStyles } from '../theme';

const EVENTS_COLLAPSED = 3;
const EVENTS_EXPANDED = 10;

export default function LiveViewScreen({ route, navigation }) {
  const { colors, type, sevOf } = useTheme();
  const styles = useStyles(makeStyles);
  const { monitorId, name } = route.params || {};
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();

  // The player frame gets an EXPLICIT height rather than `width:'100%'` plus
  // `aspectRatio`. Every state indicator on the frame — connecting, buffering,
  // failed, paused — is absolutely positioned with all four insets at 0, and
  // those insets resolve against a box that, with a percentage width feeding an
  // aspect-derived height inside a ScrollView, is not reliably settled yet on
  // Android. The overlay collapsed to zero height and its contents spilled from
  // the TOP of the frame, which is why the spinner sat up by the clock pill
  // instead of in the middle. A concrete number has nothing left to resolve.
  const frameW = winW - spacing.lg * 2;          // ScrollView paddingHorizontal
  const frameH = Math.round((frameW * 3) / 4);   // the 4:3 the design calls for
  const viewRef = useRef(null);
  const [muted, setMuted] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notice, setNotice] = useState(null); // { title, body } | { title, thumb }
  const [shooting, setShooting] = useState(false);

  const favIds = useFavorites((s) => s.ids);
  const toggleFav = useFavorites((s) => s.toggle);
  const isFav = favIds.includes(monitorId);

  // global quality preference — one setting for ALL cameras on this server
  const pref = useSettings((s) => s.quality);
  const setPref = useSettings((s) => s.setQuality);
  const net = useNetInfo();
  const quality = resolveQuality(pref, net.type); // 'main' | 'sub'

  const { data: stream, isLoading, error, refetch } = useQuery({
    queryKey: ['stream', monitorId],
    queryFn: () => startStream(monitorId),
    staleTime: 60_000,
    retry: 1,
  });

  const uri = useMemo(() => {
    if (!stream) return null;
    return quality === 'sub' && stream.hlsSubUrl ? stream.hlsSubUrl : stream.hlsUrl;
  }, [stream, quality]);

  const player = useVideoPlayer(null, (p) => { p.loop = false; p.muted = true; });

  useEffect(() => {
    if (uri && player) {
      acquireStream(monitorId, name || String(monitorId));
      player.replaceAsync(uri)
        .then(() => player.play())
        .catch((e) => logError('stream', `${name}: could not open source`, e));
    }
    // Released on unmount AND whenever the camera is switched in place
    // (setParams changes monitorId without remounting the screen).
    return () => releaseStream(monitorId);
  }, [uri, player, name, monitorId]);
  useEffect(() => { if (player) player.muted = muted; }, [muted, player]);

  const statusEvt  = useEvent(player, 'statusChange', { status: player?.status ?? 'idle' });
  const playingEvt = useEvent(player, 'playingChange', { isPlaying: player?.playing ?? false });
  const status    = statusEvt?.status ?? 'idle';
  const isPlaying = playingEvt?.isPlaying ?? false;

  // expo-video's statusChange carries a PlayerError that nothing used to read.
  useEffect(() => {
    if (statusEvt?.status !== 'error') return;
    warn('stream', `${name}: player error`, { message: statusEvt?.error?.message ?? '(none)', uri });
  }, [statusEvt?.status, statusEvt?.error?.message, name, uri]);

  // ── robustness: debounced spinner, stall auto-retry, 15s watchdog ──────────
  const hasPlayed = useRef(false);
  const autoRetried = useRef(false);
  const [showSpinner, setShowSpinner] = useState(false);
  const [watchdogErr, setWatchdogErr] = useState(false);

  useEffect(() => {
    if (isPlaying) { hasPlayed.current = true; autoRetried.current = false; setWatchdogErr(false); }
  }, [isPlaying]);

  useEffect(() => {
    let spin, dog;
    if (status === 'loading') {
      spin = setTimeout(() => setShowSpinner(true), motion.spinnerDebounce);
      dog  = setTimeout(() => setWatchdogErr(true), motion.watchdog);
      // mid-stream stall → attempt ONE silent reconnect before surfacing error
      if (hasPlayed.current && !autoRetried.current && uri) {
        autoRetried.current = true;
        player.replaceAsync(uri)
          .then(() => player.play())
          .catch((e) => logError('stream', `${name}: silent reconnect failed`, e));
      }
    } else {
      setShowSpinner(false);
    }
    return () => { clearTimeout(spin); clearTimeout(dog); };
  }, [status, uri, player, name]);

  const failed = !!error || status === 'error' || watchdogErr;
  const connecting = !failed && (isLoading || (status === 'loading' && !hasPlayed.current));
  const reconnecting = !failed && status === 'loading' && hasPlayed.current;
  const paused = !failed && status === 'readyToPlay' && !isPlaying;

  const statusLabel = isPlaying ? 'Live' : failed ? 'Offline' : paused ? 'Paused' : reconnecting ? 'Buffering' : 'Connecting';
  const statusTint  = isPlaying ? colors.live : failed ? colors.criticalInk : colors.warnInk;
  const detailStatus = isPlaying ? 'Streaming live' : failed ? 'Offline' : paused ? 'Paused' : reconnecting ? 'Buffering…' : 'Connecting…';

  const onRetry = useCallback(() => {
    haptic.light();
    setWatchdogErr(false);
    autoRetried.current = false;
    hasPlayed.current = false;
    if (uri) {
      player.replaceAsync(uri)
        .then(() => player.play())
        .catch((e) => { logError('stream', `${name}: retry failed, refetching URL`, e); refetch(); });
    } else {
      refetch();
    }
  }, [uri, player, refetch, name]);

  const togglePlay = useCallback(() => {
    haptic.light();
    if (player?.playing) player.pause();
    else player?.play();
  }, [player]);

  const hasSub = !!stream?.hlsSubUrl;
  const setQuality = useCallback((q) => {
    if (q === quality) return;
    if (q === 'sub' && !hasSub) return;
    haptic.select();
    setPref(q); // persists for ALL cameras on this server
  }, [quality, hasSub, setPref]);

  // Grab the frame on screen right now. Live HLS has no seekable timeline, so
  // we ask for the CURRENT time — and the SDK doesn't promise this works on a
  // live source, so failure is a normal outcome that gets reported.
  const takeSnapshot = useCallback(async () => {
    if (!player) return;
    haptic.medium();
    setShooting(true);
    try {
      const at = typeof player.currentTime === 'number' ? player.currentTime : 0;
      const [thumb] = await player.generateThumbnailsAsync([at], { maxWidth: 1280 });
      if (!thumb) throw new Error('The player returned no frame.');
      log('snapshot', `captured ${name}`, { width: thumb.width, height: thumb.height });
      setNotice({ title: `Snapshot · ${name}`, thumb });
    } catch (e) {
      logError('snapshot', `${name}: could not capture a frame`, e);
      setNotice({ title: 'Snapshot', body: e?.message || 'Could not capture a frame from this stream.' });
    } finally {
      setShooting(false);
    }
  }, [player, name]);

  // ── camera switching ───────────────────────────────────────────────────────
  const { data: groups = [] } = useQuery({ queryKey: ['groups'], queryFn: listGroups, staleTime: 60_000 });
  const allCams = useMemo(
    () => groups.flatMap((g) => (g.cameras || []).map((c) => ({ ...c, groupName: g.name }))),
    [groups]
  );
  const camIndex = useMemo(() => allCams.findIndex((c) => c.monitorId === monitorId), [allCams, monitorId]);
  const canSwitch = camIndex >= 0 && allCams.length > 1;

  const goToCam = useCallback((delta) => {
    if (!canSwitch) return;
    const next = allCams[(camIndex + delta + allCams.length) % allCams.length];
    if (!next) return;
    haptic.select();
    navigation.setParams({ monitorId: next.monitorId, name: next.name, location: next.groupName });
  }, [canSwitch, camIndex, allCams, navigation]);

  const openPlayback = () => navigation.navigate('Playback', { monitorId, name });

  // ── recent events from THIS camera (shared cache with the Alerts tab) ───────
  const { data: allEvents = [] } = useQuery({
    queryKey: ['ai-events'],
    queryFn: () => listAiEvents({ limit: 100 }),
    staleTime: 30_000,
  });
  const camEvents = useMemo(() => {
    const n = String(name || '').trim().toLowerCase();
    return allEvents.filter((e) => {
      if (monitorId != null && (e.monitorId === monitorId || e.cameraId === monitorId)) return true;
      const en = String(e.cameraName || '').trim().toLowerCase();
      return !!n && en === n;
    });
  }, [allEvents, name, monitorId]);
  const shownEvents = camEvents.slice(0, showAllEvents ? EVENTS_EXPANDED : EVENTS_COLLAPSED);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* header — the status WORD lives here, never over the video */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <IconButton icon="chevron-back" variant="tinted" onPress={() => navigation.goBack()} accessibilityLabel="Back" />
        <View style={styles.headerMid}>
          <Txt t="title" numberOfLines={1} style={{ textAlign: 'center' }}>{name || 'Camera'}</Txt>
          <View style={styles.headStatus}>
            <View style={[styles.headDot, { backgroundColor: statusTint }]} />
            <Txt t="caption" c={statusTint}>{statusLabel}</Txt>
          </View>
        </View>
        <IconButton
          icon="ellipsis-vertical" variant="tinted"
          onPress={() => { haptic.light(); setMoreOpen(true); }}
          accessibilityLabel="More options"
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── PLAYER ─────────────────────────────────────────────────────── */}
        <View style={[styles.player, { height: frameH }]}>
          <VideoView
            ref={viewRef}
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            nativeControls={false}
            fullscreenOptions={{ enable: true }}
          />

          {/* top overlay row — LIVE badge, clock, fullscreen */}
          <View style={styles.playerTop} pointerEvents="box-none">
            {isPlaying ? (
              <View style={styles.livePill}>
                <View style={styles.liveDot} />
                <Text style={styles.livePillText}>LIVE</Text>
              </View>
            ) : null}
            <ClockPill />
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={() => { haptic.light(); viewRef.current?.enterFullscreen?.(); }}
              accessibilityRole="button"
              accessibilityLabel="Fullscreen"
              style={({ pressed }) => [styles.frameBtn, pressed && styles.frameBtnOn]}
            >
              <Ionicons name="scan-outline" size={18} color="#fff" />
            </Pressable>
          </View>

          {/* state indicators — CENTRE of the frame only, never over controls */}
          {connecting && (
            <View style={[styles.overlay, { height: frameH }]} pointerEvents="none">
              {showSpinner || isLoading ? <ActivityIndicator size="large" color={colors.primary} /> : null}
              {/* Anchored to the bottom, NOT stacked under the spinner: as a
                  second child of a centred column it dragged the spinner above
                  the frame's true midpoint by half its own height plus the gap.
                  The spinner is the thing that has to read as centred. */}
              <Text style={[styles.oSub, styles.oHint]}>first connect can take a few seconds</Text>
            </View>
          )}
          {reconnecting && (
            <View style={[styles.centerFill, { height: frameH }]} pointerEvents="none">
              <View style={styles.bufferPill}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={styles.oSub}>Buffering…</Text>
              </View>
            </View>
          )}
          {failed && (
            <View style={[styles.overlay, { height: frameH }]}>
              <Ionicons name="videocam-off-outline" size={38} color="rgba(255,255,255,0.5)" />
              <Pressable style={styles.retry} onPress={onRetry}>
                <Ionicons name="refresh" size={15} color={colors.onPrimary} />
                <Text style={[type.bodyMed, { color: colors.onPrimary }]}>Retry</Text>
              </Pressable>
            </View>
          )}
          {paused && (
            <View style={[styles.centerFill, { height: frameH }]} pointerEvents="none">
              <View style={styles.pausedBadge}><Ionicons name="pause" size={26} color="#fff" /></View>
            </View>
          )}

          {/* control bar ON the frame */}
          <View style={styles.controls}>
            <FrameAction
              icon={isPlaying ? 'pause' : 'play'}
              label={isPlaying ? 'Pause' : 'Play'}
              onPress={togglePlay}
            />
            <FrameAction
              icon={muted ? 'volume-mute' : 'volume-high'}
              label={muted ? 'Unmute' : 'Mute'}
              onPress={() => { haptic.light(); setMuted((m) => !m); }}
            />
            <FrameAction
              icon={shooting ? 'hourglass-outline' : 'camera-outline'}
              label="Snapshot"
              onPress={takeSnapshot}
            />
            <FrameAction
              icon="radio-button-on"
              label="Record"
              dimmed
              onPress={() => {
                haptic.light();
                setNotice({
                  title: 'Record',
                  body: 'Starting a recording from the app isn’t wired up yet — the server exposes no record endpoint. Use the web console, or browse existing clips under Playback.',
                });
              }}
            />
            <View style={{ flex: 1 }} />
            <View style={styles.qGroup}>
              <QualityPill label="SD" on={quality === 'sub'} disabled={!hasSub} onPress={() => setQuality('sub')} />
              <QualityPill label="HD" on={quality === 'main'} onPress={() => setQuality('main')} />
            </View>
          </View>
        </View>

        {/* ── SWITCHER ───────────────────────────────────────────────────── */}
        <View style={styles.switcher}>
          <Pressable
            onPress={() => goToCam(-1)}
            disabled={!canSwitch}
            accessibilityRole="button"
            accessibilityLabel="Previous camera"
            style={({ pressed }) => [styles.switchBtn, !canSwitch && styles.switchOff, pressed && { backgroundColor: colors.mutedAlt }]}
          >
            <Ionicons name="chevron-back" size={18} color={colors.text} />
          </Pressable>
          <Txt t="caption" c={colors.sub} style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>
            {canSwitch ? `Camera ${camIndex + 1} of ${allCams.length}` : 'Single camera'}
          </Txt>
          <Pressable
            onPress={() => { haptic.light(); openPlayback(); }}
            accessibilityRole="button"
            accessibilityLabel="Open recordings"
            style={({ pressed }) => [styles.pbPill, pressed && { backgroundColor: colors.mutedAlt }]}
          >
            <Ionicons name="calendar-outline" size={15} color={colors.text} />
            <Txt t="caption" style={{ fontFamily: fonts.semi }}>Playback</Txt>
          </Pressable>
          <Pressable
            onPress={() => goToCam(1)}
            disabled={!canSwitch}
            accessibilityRole="button"
            accessibilityLabel="Next camera"
            style={({ pressed }) => [styles.switchBtn, !canSwitch && styles.switchOff, pressed && { backgroundColor: colors.mutedAlt }]}
          >
            <Ionicons name="chevron-forward" size={18} color={colors.text} />
          </Pressable>
        </View>

        {/* ── CAMERA DETAILS ─────────────────────────────────────────────── */}
        <View style={styles.card}>
          <Pressable
            onPress={() => { haptic.select(); setDetailsOpen((o) => !o); }}
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsOpen }}
            style={styles.cardHead}
          >
            <View style={styles.cardIcon}><Ionicons name="videocam" size={17} color={colors.primaryInk} /></View>
            <Txt t="titleSm" style={{ flex: 1 }}>Camera Details</Txt>
            <Ionicons name={detailsOpen ? 'chevron-up' : 'chevron-down'} size={17} color={colors.sub} />
          </Pressable>
          {detailsOpen && (
            <View style={styles.cardBody}>
              <DetailRow icon="pulse-outline" label="Status" value={detailStatus} dot={isPlaying ? colors.ok : failed ? colors.criticalInk : colors.warnInk} />
              <DetailRow icon="location-outline" label="Location" value={route.params?.location || 'No location set'} />
              <DetailRow
                icon="options-outline" label="Quality"
                value={`${quality === 'main' ? 'HD (main stream)' : 'SD (data saver)'}${pref === 'auto' ? ' · Auto' : ''}`}
                last
              />
            </View>
          )}
        </View>

        {/* ── RECENT EVENTS ──────────────────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <View style={styles.cardIcon}><Ionicons name="notifications" size={17} color={colors.primaryInk} /></View>
            <Txt t="titleSm" style={{ flex: 1 }}>Recent Events</Txt>
            {camEvents.length ? (
              <Pressable
                onPress={() => navigation.navigate('Alerts')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="View all alerts"
                style={styles.viewAll}
              >
                <Txt t="caption" c={colors.primaryInk} style={{ fontFamily: fonts.semi }}>View All</Txt>
                <Ionicons name="chevron-forward" size={13} color={colors.primaryInk} />
              </Pressable>
            ) : null}
          </View>
          <View style={styles.cardBody}>
            {shownEvents.length ? (
              <>
                {shownEvents.map((e, i) => (
                  <EventRow
                    key={e.id || i}
                    event={e}
                    last={i === shownEvents.length - 1 && camEvents.length <= EVENTS_COLLAPSED}
                    onPress={openPlayback}
                  />
                ))}
                {camEvents.length > EVENTS_COLLAPSED ? (
                  <Pressable
                    onPress={() => { haptic.light(); setShowAllEvents((v) => !v); }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.showMore, pressed && { backgroundColor: colors.mutedAlt }]}
                  >
                    <Ionicons name={showAllEvents ? 'chevron-up' : 'chevron-down'} size={15} color={colors.sub} />
                    <Txt t="caption" c={colors.sub}>{showAllEvents ? 'Show less' : 'Show More'}</Txt>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <EmptyState
                compact
                icon="shield-checkmark-outline"
                title="No recent events"
                subtitle="Detections from this camera will appear here."
              />
            )}
          </View>
        </View>

        <View style={styles.footNote}>
          <View style={styles.footIcon}><Ionicons name="shield-checkmark" size={14} color={colors.primaryInk} /></View>
          <Txt t="caption" c={colors.sub} style={{ flex: 1 }}>
            One camera streams at a time to keep the recorder responsive.
          </Txt>
        </View>
      </ScrollView>

      {/* overflow */}
      <BottomSheet visible={moreOpen} onClose={() => setMoreOpen(false)} title={name || 'Camera'}>
        <SheetAction
          icon={isFav ? 'heart' : 'heart-outline'}
          label={isFav ? 'Remove from favourites' : 'Add to favourites'}
          hint="Favourites are saved on this device"
          onPress={() => { toggleFav(monitorId); setMoreOpen(false); }}
        />
        <SheetAction icon="refresh" label="Restart stream" hint="Reconnect to the recorder" onPress={() => { setMoreOpen(false); onRetry(); }} />
        <SheetAction icon="film-outline" label="Recordings" hint="Browse this camera’s clips by day" onPress={() => { setMoreOpen(false); openPlayback(); }} />
        <SheetAction icon="grid-outline" label="Live Wall" hint="Every camera on one screen" onPress={() => { setMoreOpen(false); navigation.navigate('LiveWall'); }} />
      </BottomSheet>

      {/* snapshot result, or an honest reason there isn't one */}
      <BottomSheet
        visible={!!notice}
        onClose={() => setNotice(null)}
        title={notice?.title}
        footer={<Button title="Close" variant="secondary" onPress={() => setNotice(null)} style={{ marginTop: spacing.sm }} />}
      >
        {notice?.thumb ? (
          <>
            <Image source={notice.thumb} style={styles.shot} contentFit="cover" transition={120} />
            <Txt t="caption" c={colors.faint} style={{ textAlign: 'center', marginTop: spacing.sm }}>
              Captured from the live stream. Saving to the gallery needs a media-library
              permission the app doesn’t request yet.
            </Txt>
          </>
        ) : (
          <View style={styles.noticeRow}>
            <Ionicons name="information-circle-outline" size={22} color={colors.sub} />
            <Txt t="sub" c={colors.sub} style={{ flex: 1 }}>{notice?.body}</Txt>
          </View>
        )}
      </BottomSheet>
    </View>
  );
}

// Device clock burned onto the frame, VMS style. It is the PHONE's time, not
// the camera's OSD — the stream carries no timestamp we can read — so it
// answers "when am I looking at this", not "when was this recorded". Its own
// component so the 1Hz tick re-renders a pill, not the whole screen.
function ClockPill() {
  const styles = useStyles(makeStyles);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const d = now.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  const t = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <View style={styles.clockPill} pointerEvents="none">
      <Text style={styles.clockText}>{d}  |  {t}</Text>
    </View>
  );
}

// One control on the video frame. `dimmed` marks a control that exists in the
// design but has no endpoint behind it — it still takes a press and explains.
function FrameAction({ icon, label, onPress, dimmed }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={dimmed ? `${label}, not available` : label}
      style={({ pressed }) => [styles.frameAction, pressed && styles.frameBtnOn]}
    >
      <Ionicons name={icon} size={19} color={dimmed ? 'rgba(255,255,255,0.4)' : '#fff'} />
    </Pressable>
  );
}

function QualityPill({ label, on, disabled, onPress }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled: !!disabled }}
      accessibilityLabel={`${label} quality${disabled ? ', not offered by this camera' : ''}`}
      style={[styles.qPill, on && { backgroundColor: colors.primary }, disabled && { opacity: 0.35 }]}
    >
      <Text style={[styles.qText, on && { color: colors.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

function DetailRow({ icon, label, value, dot, last }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.detailRow, !last && styles.rowBorder]}>
      <View style={styles.detailIcon}><Ionicons name={icon} size={15} color={colors.primaryInk} /></View>
      <Txt t="bodyMed" style={{ flex: 1 }}>{label}</Txt>
      {dot ? <View style={[styles.detailDot, { backgroundColor: dot }]} /> : null}
      <Txt t="sub" c={colors.sub} numberOfLines={1} style={{ flexShrink: 1 }}>{value}</Txt>
    </View>
  );
}

// The thumbnail is the event's own evidence JPEG, fetched lazily and only when
// the event actually has one. There is deliberately NO play triangle on it:
// the recordings endpoint is day-based with no time seek, so we cannot jump to
// this moment, and a play button that can't play is a lie. Tapping opens
// Playback for the camera, which is the closest true thing.
function EventRow({ event, last, onPress }) {
  const { colors, sevOf } = useTheme();
  const styles = useStyles(makeStyles);
  const sv = sevOf(event.severity);
  const { data: url } = useQuery({
    queryKey: ['ev-snap', event.id],
    queryFn: () => getEventSnapshotUrl(event.id),
    enabled: !!event.snapshotKey && event.id != null,
    staleTime: 30 * 60_000,
    retry: 0,
  });
  const when = event.ts
    ? `Today, ${new Date(event.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : '—';
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      accessibilityRole="button"
      accessibilityLabel={`${eventTitle(event.eventType)}, ${when}. Open recordings`}
      style={({ pressed }) => [styles.eventRow, !last && styles.rowBorder, pressed && { opacity: 0.6 }]}
    >
      <View style={[styles.eventIcon, { backgroundColor: sv.bg }]}>
        <Ionicons name={eventIcon(event.eventType)} size={17} color={sv.fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="bodyMed" numberOfLines={1} style={{ textTransform: 'capitalize' }}>{eventTitle(event.eventType)}</Txt>
        <Txt t="caption" c={colors.sub} numberOfLines={1}>{when}</Txt>
      </View>
      {url ? (
        <Image source={{ uri: url }} style={styles.eventThumb} contentFit="cover" transition={150} />
      ) : null}
    </Pressable>
  );
}

const makeStyles = ({ colors, type }) => StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingBottom: spacing.md,
  },
  headerMid: { flex: 1, minWidth: 0, alignItems: 'center' },
  headStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  headDot: { width: 7, height: 7, borderRadius: 3.5 },

  // The frame is its own ground: everything on it is a fixed literal, not a
  // theme token, because the backdrop is footage in both themes.
  player: {
    // height is supplied inline (frameH) — see the note where it is computed.
    // No aspectRatio here: it is what left the on-frame overlays unpositioned.
    width: '100%',
    backgroundColor: colors.video,
    borderRadius: radius.lg, overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  playerTop: {
    position: 'absolute', top: spacing.lg, left: spacing.md, right: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
  },
  livePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.primary, borderRadius: radius.sm,
    paddingHorizontal: 8, paddingVertical: 4,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  livePillText: { ...type.badge, color: '#fff' },
  clockPill: {
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.sm,
    paddingHorizontal: 8, paddingVertical: 5,
  },
  clockText: { ...type.caption, color: '#fff' },
  frameBtn: {
    width: 36, height: 36, borderRadius: radius.sm,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  frameBtnOn: { backgroundColor: 'rgba(0,0,0,0.75)' },

  controls: {
    position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.md, padding: 4,
  },
  frameAction: { width: 40, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  qGroup: { flexDirection: 'row', gap: 3 },
  qPill: {
    minWidth: 40, height: 36, borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8,
  },
  qText: { ...type.badge, fontSize: 12, color: '#fff' },

  // NOT absoluteFillObject. That sets top:0 AND bottom:0 with no height and
  // asks the engine to stretch between them — unambiguous in CSS, which is why
  // this always looked right on web, and the one thing left here that Yoga can
  // resolve differently. Each usage passes an explicit { height: frameH }, so
  // there is no stretch to resolve and both platforms centre against the same
  // box.
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(11,15,20,0.55)', gap: 10, padding: 24,
  },
  centerFill: {
    position: 'absolute', top: 0, left: 0, right: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  bufferPill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  pausedBadge: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  oSub: { ...type.caption, color: 'rgba(255,255,255,0.75)', textAlign: 'center' },
  // Insets resolve against the parent's PADDING box, so bottom:0 lands on the
  // inner edge of the overlay's 24pt padding rather than on the frame edge.
  oHint: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  retry: { marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 10 },

  switcher: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.sm, marginBottom: spacing.md,
  },
  switchBtn: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  switchOff: { opacity: 0.35 },
  pbPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, height: 40, borderRadius: radius.md, backgroundColor: colors.muted },

  card: {
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: spacing.md, overflow: 'hidden',
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  cardIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  cardBody: { paddingHorizontal: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 6, paddingHorizontal: 4 },

  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56 },
  detailIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  detailDot: { width: 7, height: 7, borderRadius: 3.5 },

  eventRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, minHeight: 64 },
  eventIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  eventThumb: { width: 56, height: 44, borderRadius: radius.sm, backgroundColor: colors.video },
  showMore: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: spacing.md, marginHorizontal: -spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },

  footNote: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xs },
  footIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },

  shot: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md, backgroundColor: colors.video },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
});
