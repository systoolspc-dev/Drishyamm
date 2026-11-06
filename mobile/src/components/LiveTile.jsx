// LiveTile — a grid tile that plays the camera LIVE on the low-res SUB stream
// (bandwidth-friendly, muted). Streams only while `live` is true so screens can
// gate on focus and cap concurrency (the NVR tolerates ~6-7 pulls TOTAL); when
// disabled the source is detached (replaceAsync(null)) so segment fetches stop
// and MediaMTX can close the on-demand path. `delay` staggers connects so a
// page of tiles never hits the NVR all at once. No status badges — the picture
// IS the status; a small dot next to the name covers live/offline. Buffering
// shows a debounced spinner and gives up quietly ("No preview") after the
// watchdog instead of spinning forever. `fill` stretches the tile to its row
// (Live Wall): there the video letterboxes (contain) so the operator always
// sees the FULL camera frame — cover-cropping a surveillance feed hides parts
// of the scene — and the caption drops to one line with a tighter corner
// radius so a dense wall reads as a wall, not as cards.
import { useEffect, useRef, useState } from 'react';
import { Pressable, View, Text, StyleSheet, ActivityIndicator, Animated } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { startStream } from '../lib/api';
import { logError, warn } from '../lib/log';
import { acquireStream, releaseStream } from '../lib/streamBudget';
import { radius, spacing, motion, useTheme, useStyles } from '../theme';
import { haptic } from './ui';

export default function LiveTile({ camera, live = true, onPress, aspect = 16 / 9, fill = false, delay = 0, favorite, onToggleFavorite, onPlayback, variant = 'card', actions, playerRef }) {
  const { colors, shadow, press, onVideo } = useTheme();
  const styles = useStyles(makeStyles);
  const online = camera?.status === 'online';
  const name = camera?.name || 'Camera';
  const place = camera?.location || camera?.groupName || 'No location';

  // 'overview' — the dashboard tile: no top pill, no quick actions, status
  // folded UNDER the name and an expand affordance in the corner. Quieter, so
  // four of them read as one block instead of eight controls. The whole tile is
  // the button, so the glyph is decorative.
  // 'hero' is 'overview' plus circular action buttons in the caption's right
  // slot — same layout, louder affordances, for the one tile that is the focus.
  const hero = variant === 'hero' && !fill;
  const overview = (variant === 'overview' || hero) && !fill;

  // staggered arm — tiles connect a few hundred ms apart, never as a herd
  const [armed, setArmed] = useState(delay === 0);
  useEffect(() => {
    if (armed || !live) return;
    const t = setTimeout(() => setArmed(true), delay);
    return () => clearTimeout(t);
  }, [armed, live, delay]);

  const enabled = live && online && armed;

  // Shared cache key with the full player — the sub URL comes back on hlsSubUrl.
  const { data: stream, isLoading, isError } = useQuery({
    queryKey: ['stream', camera?.monitorId],
    queryFn: () => startStream(camera.monitorId),
    enabled: !!enabled && !!camera?.monitorId,
    staleTime: 60_000,
    retry: 1,
  });
  const uri = stream ? (stream.hlsSubUrl || stream.hlsUrl) : null;

  const player = useVideoPlayer(null, (p) => { p.loop = false; p.muted = true; });

  // Hand the player up to an owner that needs the live frame (Live View's
  // Snapshot). Sharing the instance beats duplicating the whole streaming
  // lifecycle in the parent just to own a second player for the same camera —
  // which would also double the pull on the recorder.
  useEffect(() => {
    if (!playerRef) return;
    playerRef.current = player;
    return () => { if (playerRef.current === player) playerRef.current = null; };
  }, [player, playerRef]);

  useEffect(() => {
    if (!player) return;
    const id = camera?.monitorId;
    if (enabled && uri) {
      acquireStream(id, camera?.name || String(id));
      player.replaceAsync(uri)
        .then(() => player.play())
        .catch((e) => logError('stream', `${camera?.name || camera?.monitorId}: could not open source`, e));
    } else {
      releaseStream(id);
      player.replaceAsync(null).catch(() => {}); // detaching can't fail usefully
    }
  }, [enabled, uri, player, camera?.name, camera?.monitorId]);

  // Unmount is the case the effect above cannot cover: navigating away tears
  // the tile down without ever running the `else` branch, so a screen left
  // behind would hold its slots forever and starve the next one.
  useEffect(() => () => releaseStream(camera?.monitorId), [camera?.monitorId]);

  const statusEvt = useEvent(player, 'statusChange', { status: player?.status ?? 'idle' });
  const playing = enabled && statusEvt?.status === 'readyToPlay';

  // expo-video's statusChange carries a PlayerError. Nothing read it, which is
  // why a failed tile could only ever say "No preview" — the decoder/network
  // reason was right there and being dropped on the floor.
  useEffect(() => {
    if (statusEvt?.status !== 'error') return;
    warn('stream', `${camera?.name || camera?.monitorId}: player error`, {
      message: statusEvt?.error?.message ?? '(no message from player)',
      uri,
    });
  }, [statusEvt?.status, statusEvt?.error?.message, camera?.name, camera?.monitorId, uri]);

  // debounced spinner + give-up watchdog (no eternal buffering on a grid)
  const [spinner, setSpinner] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const failed = enabled && (isError || statusEvt?.status === 'error' || gaveUp);
  const waiting = enabled && !playing && !failed;
  useEffect(() => {
    if (!waiting) { setSpinner(false); return; }
    const s = setTimeout(() => setSpinner(true), motion.spinnerDebounce);
    const w = setTimeout(() => setGaveUp(true), motion.watchdog);
    return () => { clearTimeout(s); clearTimeout(w); };
  }, [waiting]);
  useEffect(() => { if (playing || !enabled) setGaveUp(false); }, [playing, enabled]);

  // signature "alive" pulse on the status dot while actually streaming
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!playing) { pulse.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [playing, pulse]);

  const r = fill ? radius.sm : radius.lg;

  return (
    <View style={[styles.outer, { borderRadius: r }, shadow(1)]}>
      <Pressable
        onPress={onPress}
        onPressIn={haptic.light}
        android_ripple={{ color: press.ripple }}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${playing ? 'live' : failed ? 'no signal' : online ? 'online' : 'offline'}, tap for full screen`}
        style={({ pressed }) => [styles.clip, { borderRadius: r }, fill && styles.fill, pressed && { transform: [{ scale: press.cardScale }] }]}
      >
        <View style={[styles.frame, fill ? styles.fill : { aspectRatio: aspect }]}>
          {enabled ? (
            <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={fill ? 'contain' : 'cover'} nativeControls={false} pointerEvents="none" />
          ) : null}

          {/* Quiet placeholder when not playing. ONE consistent treatment for
              every non-playing state — a single glyph, or a spinner while
              connecting. The REASON lives in the pill, not here: this used to
              print "No preview" when a stream failed but a glyph when it was
              merely un-budgeted, so two identical-looking cameras side by side
              showed different things for reasons the operator couldn't see.
              Status belongs in the status element.
              It centres in the space BETWEEN the pill and the caption, not the
              whole frame — a strip tile is only ~95pt tall, so centring on the
              frame put the glyph straight through the pill. */}
          {!playing && (
            <View style={styles.placeholder}>
              {spinner ? (
                <ActivityIndicator color="rgba(255,255,255,0.7)" />
              ) : (
                <Ionicons
                  name={online && !failed ? 'videocam-outline' : 'videocam-off-outline'}
                  size={22}
                  color="rgba(255,255,255,0.25)"
                />
              )}
            </View>
          )}

          <LinearGradient
            colors={['rgba(0,0,0,0.40)', 'transparent', 'rgba(0,0,0,0.68)']}
            locations={[0, 0.38, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          {/* Top row for the dashboard variants: the hero repeats its name up
              here (the caption is 200pt away on a 4:3 tile, so the label reads
              as a title rather than a duplicate), and every tile gets a corner
              expand mark. Decorative — the tile itself is the button. */}
          {overview && (
            // box-none, not none: the row itself must not eat touches, but the
            // expand button inside it has to receive them.
            <View style={styles.topRow} pointerEvents="box-none">
              {hero ? (
                <Text style={[onVideo.meta, styles.topName]} numberOfLines={1} pointerEvents="none">{name}</Text>
              ) : <View />}
              {/* ONE expand affordance per tile. The grid tile carries it here,
                  in the conventional corner; the hero doesn't, because its
                  action row below already has an expand button and two of them
                  on one tile is just noise.
                  It is a REAL button, not decoration: it looks like a control,
                  so it has to behave like one. It opens the same full-screen
                  view as the tile body, and the negative margins keep the glyph
                  optically where it was while giving it a 30pt target. */}
              {!hero ? (
                <Pressable
                  onPress={onPress}
                  onPressIn={haptic.light}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${name} full screen`}
                  style={({ pressed }) => [styles.expand, pressed && styles.expandOn]}
                >
                  <Ionicons name="scan-outline" size={16} color="rgba(255,255,255,0.85)" />
                </Pressable>
              ) : null}
            </View>
          )}
          {!online && <View style={styles.dim} pointerEvents="none" />}

          {/* Status pill — the pulsing dot alone never said what it meant, and
              it is now the ONLY place a tile reports state. NO SIGNAL is the
              honest reading of "the recorder says this camera is up, but it
              won't give us a stream": amber, because it is a fault to look at,
              not an offline device. Hidden on `fill` (Live Wall), where a pill
              per tile would be noise. */}
          {!fill && !overview && (
            <View style={styles.statusPill} pointerEvents="none">
              {/* Same dot colours as CameraCard for the same words — a live
                  tile and a still tile both reading ONLINE must look identical,
                  or the grid implies a difference that doesn't exist. */}
              <Animated.View
                style={[styles.dot, {
                  opacity: pulse,
                  backgroundColor: playing ? colors.live
                    : failed ? colors.warn
                    : online ? colors.ok
                    : colors.off,
                }]}
              />
              <Text style={onVideo.pill}>
                {playing ? 'LIVE' : failed ? 'NO SIGNAL' : online ? 'ONLINE' : 'OFFLINE'}
              </Text>
            </View>
          )}

          {/* Quick actions — identical set and layout to CameraCard. A screen
              mixes both components freely, so a tile must not gain or lose an
              affordance purely because it happened to win a live-stream slot. */}
          {!fill && !overview && (onToggleFavorite || onPlayback) ? (
            <View style={styles.actions}>
              {onToggleFavorite ? (
                <Pressable
                  onPress={() => { haptic.select(); onToggleFavorite(); }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!favorite }}
                  accessibilityLabel={favorite ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
                  style={({ pressed }) => [styles.action, pressed && styles.actionOn]}
                >
                  <Ionicons name={favorite ? 'heart' : 'heart-outline'} size={15} color={favorite ? colors.secondary : '#fff'} />
                </Pressable>
              ) : null}
              {onPlayback ? (
                <Pressable
                  onPress={() => { haptic.light(); onPlayback(); }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Open recordings for ${name}`}
                  style={({ pressed }) => [styles.action, pressed && styles.actionOn]}
                >
                  <Ionicons name="film-outline" size={15} color="#fff" />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {/* caption — one line on the wall, two in a grid. Wall tiles carry no
              pill, so on `fill` this dot is the ONLY status indicator; it uses
              the same colour scale as the pill so the two never disagree. */}
          <View
            style={[styles.caption, fill && styles.captionFill, overview && styles.captionOverview]}
            pointerEvents={hero ? 'box-none' : 'none'}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={styles.nameRow}>
                {fill ? (
                  <Animated.View
                    style={[styles.dot, {
                      opacity: pulse,
                      backgroundColor: playing ? colors.live
                        : failed ? colors.warn
                        : online ? colors.ok
                        : colors.off,
                    }]}
                  />
                ) : null}
                <Text style={[fill ? onVideo.titleSm : onVideo.title, { flex: 1 }]} numberOfLines={1}>{name}</Text>
              </View>
              {overview ? (
                <View style={styles.captionStatus}>
                  <Animated.View
                    style={[styles.dot, {
                      opacity: pulse,
                      backgroundColor: playing ? colors.live
                        : failed ? colors.warn
                        : online ? colors.ok
                        : colors.off,
                    }]}
                  />
                  <Text style={onVideo.meta} numberOfLines={1}>
                    {playing ? 'Live' : failed ? 'No signal' : online ? 'Online' : 'Offline'}
                  </Text>
                </View>
              ) : !fill ? (
                <Text style={[onVideo.meta, { marginLeft: 0 }]} numberOfLines={1}>{place}</Text>
              ) : null}
            </View>
            {hero && actions?.length ? (
              <View style={styles.heroActions}>
                {actions.map((a) => (
                  <Pressable
                    key={a.key}
                    onPress={a.onPress}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={a.label}
                    accessibilityState={{ selected: !!a.active }}
                    style={({ pressed }) => [styles.heroAction, pressed && styles.heroActionOn]}
                  >
                    <Ionicons name={a.icon} size={16} color={a.active ? colors.secondary : '#fff'} />
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}

// As with CameraCard: everything inside the frame sits on the video ground and
// stays fixed across themes; only the tile's own surface follows the palette.
const makeStyles = ({ colors }) => StyleSheet.create({
  outer: { flex: 1, backgroundColor: colors.card },
  clip: { overflow: 'hidden' },
  fill: { flex: 1 },
  // The frame CENTRES its children, which is what positions the placeholder.
  // Everything else it holds — VideoView, the gradient, the dim, the pill, the
  // actions, the caption, the top row — is absolutely positioned and therefore
  // untouched by these two properties.
  frame: { backgroundColor: colors.video, alignItems: 'center', justifyContent: 'center' },
  // Dead centre of the frame, every variant. NOT absoluteFill: this is a plain
  // flow child, centred by the frame's own alignItems/justifyContent above.
  //
  // It used to be absolutely positioned with all four insets at 0, which is
  // correct on the web layout engine but not dependably so on Yoga — the frame
  // derives its height from `aspectRatio`, and resolving absolute insets
  // against an aspect-derived box is where the two engines disagree. That is
  // why the spinner sat centred in a browser and off-centre on the device.
  // Centring by flexbox has no such ambiguity and behaves identically on both.
  //
  // It also carried per-variant padding once, to dodge the pill and the
  // caption; on a ~102pt tile reserving a 45pt caption band dragged the
  // midpoint ~22pt above centre and the glyph read as pinned to the top.
  placeholder: { alignItems: 'center', justifyContent: 'center', gap: 5 },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,15,20,0.45)' },

  statusPill: {
    position: 'absolute', top: spacing.sm, left: spacing.sm,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  // mirrors CameraCard exactly
  actions: { position: 'absolute', top: spacing.xs, right: spacing.xs, flexDirection: 'row', gap: 2 },
  action: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  actionOn: { backgroundColor: 'rgba(0,0,0,0.45)' },

  caption: { position: 'absolute', left: spacing.md - 2, right: spacing.md - 2, bottom: spacing.sm + 1 },
  captionFill: { left: spacing.sm, right: spacing.sm, bottom: 7 },
  captionOverview: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  captionStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  topRow: {
    position: 'absolute', top: spacing.md - 2, left: spacing.md - 2, right: spacing.md - 2,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm,
  },
  topName: { flex: 1, color: 'rgba(255,255,255,0.92)' },
  // negative margins so a 30pt touch target leaves the 16pt glyph optically in
  // the same corner position it sat in as decoration
  expand: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    marginTop: -7, marginRight: -7,
  },
  expandOn: { backgroundColor: 'rgba(0,0,0,0.45)' },
  heroActions: { flexDirection: 'row', gap: spacing.sm },
  heroAction: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  heroActionOn: { backgroundColor: 'rgba(0,0,0,0.7)' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
