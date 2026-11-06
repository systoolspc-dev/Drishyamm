// CameraCard — the grid/overview camera preview (Hik-Connect / UniFi style).
// 16:9 frame with the name overlaid on a bottom scrim (not a separate strip),
// a status pill top-left, and quick actions top-right. Snapshot cover-fills
// when available; otherwise a clean dark placeholder with a camera glyph.
// Shadow lives on the OUTER wrapper and clipping on the INNER view (so the
// Android shadow isn't eaten by overflow).
//
// Everything drawn INSIDE the frame is theme-independent: the ground is
// footage, not a surface. Those styles come from theme.onVideo, which LiveTile
// shares — the two files previously carried byte-identical copies of the
// caption typography and drifted apart on every tweak.
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { radius, spacing, useTheme, useStyles } from '../theme';
import { haptic } from './ui';

export default function CameraCard({
  camera, snapshotUri, onPress, favorite, onToggleFavorite, onPlayback,
  variant = 'card',
}) {
  const { colors, shadow, press, onVideo } = useTheme();
  const styles = useStyles(makeStyles);
  const online = camera?.status === 'online';
  const name = camera?.name || 'Camera';
  const place = camera?.location || camera?.groupName || 'No location';

  // 'overview' — the dashboard tile: no top pill, no quick actions, status
  // folded UNDER the name and an expand affordance in the corner. Quieter, so
  // four of them on a dashboard read as one block instead of eight controls.
  // The whole tile is the button, so the glyph is decorative.
  const overview = variant === 'overview';

  return (
    <View style={[styles.outer, shadow(1)]}>
      <Pressable
        onPress={onPress}
        onPressIn={haptic.light}
        android_ripple={{ color: press.ripple }}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${online ? 'online' : 'offline'}, tap to view live`}
        style={({ pressed }) => [styles.clip, pressed && { transform: [{ scale: press.cardScale }] }]}
      >
        <View style={styles.frame}>
          {snapshotUri ? (
            <Image source={{ uri: snapshotUri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
          ) : (
            <View style={styles.placeholder}>
              <Ionicons name={online ? 'videocam-outline' : 'videocam-off-outline'} size={26} color="rgba(255,255,255,0.25)" />
            </View>
          )}

          {/* legibility scrim — top band carries the pill, bottom the caption */}
          <LinearGradient
            colors={['rgba(0,0,0,0.45)', 'transparent', 'rgba(0,0,0,0.68)']}
            locations={[0, 0.38, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          {/* offline dim */}
          {!online && <View style={styles.dim} pointerEvents="none" />}

          {/* corner expand mark — matches LiveTile's overview variant so a
              still tile and a streaming one are indistinguishable in the grid */}
          {overview && (
            <View style={styles.topRow} pointerEvents="box-none">
              {/* a real button, matching LiveTile — it looks like a control, so
                  it behaves like one and opens the same full-screen view */}
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
            </View>
          )}

          {/* status pill — an explicit word, not just a 6px dot. On a security
              grid "is this camera up?" should never require decoding a colour. */}
          {!overview && (
            <View style={styles.statusPill} pointerEvents="none">
              <View style={[styles.statusDot, { backgroundColor: online ? colors.ok : colors.off }]} />
              <Text style={onVideo.pill}>{online ? 'ONLINE' : 'OFFLINE'}</Text>
            </View>
          )}

          {/* quick actions */}
          {!overview && (
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
                <Ionicons
                  name={favorite ? 'heart' : 'heart-outline'}
                  size={15}
                  color={favorite ? colors.secondary : '#fff'}
                />
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
          )}

          {/* caption */}
          <View style={styles.caption} pointerEvents="none">
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={onVideo.title} numberOfLines={1}>{name}</Text>
              {overview ? (
                <View style={styles.captionStatus}>
                  <View style={[styles.statusDot, { backgroundColor: online ? colors.ok : colors.off }]} />
                  <Text style={onVideo.meta} numberOfLines={1}>{online ? 'Online' : 'Offline'}</Text>
                </View>
              ) : (
                <Text style={onVideo.meta} numberOfLines={1}>{place}</Text>
              )}
            </View>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  outer: { flex: 1, borderRadius: radius.lg, backgroundColor: colors.card },
  clip: { borderRadius: radius.lg, overflow: 'hidden' },
  // Centres its children — that is what positions the placeholder. The snapshot
  // Image, the gradient, the dim, the pill, the actions and the caption are all
  // absolutely positioned, so none of them is affected.
  frame: { aspectRatio: 16 / 9, backgroundColor: colors.video, alignItems: 'center', justifyContent: 'center' },
  // Dead centre of the frame, matching LiveTile exactly — a still tile and a
  // streaming one sit side by side in the same grid, so their glyphs must land
  // at the same height. A plain flow child, centred by the frame: see LiveTile
  // for why absolute insets inside an aspectRatio box drift on Yoga but not on
  // the web engine.
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,15,20,0.45)' },

  statusPill: {
    position: 'absolute', top: spacing.sm, left: spacing.sm,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },

  actions: { position: 'absolute', top: spacing.xs, right: spacing.xs, flexDirection: 'row', gap: 2 },
  action: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  actionOn: { backgroundColor: 'rgba(0,0,0,0.45)' },

  caption: {
    position: 'absolute', left: spacing.md - 2, right: spacing.md - 2, bottom: spacing.sm + 1,
    flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm,
  },
  captionStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  topRow: {
    position: 'absolute', top: spacing.md - 2, right: spacing.md - 2,
    flexDirection: 'row', alignItems: 'center',
  },
  // negative margins so a 30pt touch target leaves the 16pt glyph optically in
  // the same corner position it sat in as decoration
  expand: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    marginTop: -7, marginRight: -7,
  },
  expandOn: { backgroundColor: 'rgba(0,0,0,0.45)' },
});
