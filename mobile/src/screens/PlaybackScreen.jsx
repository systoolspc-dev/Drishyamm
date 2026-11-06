// Playback — recorded clips for one camera. Header (back · name · CCTV icon),
// a player pinned at 16:9 (same centered-indicator rules as live), a 7-day
// date strip, then the clip list (first-frame thumbnail · start time · size).
// Tap a clip → fetch a fresh play URL (they expire) → play in place. Honest
// empty state: this system records on demand, so many days are empty.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { View, FlatList, Pressable, StyleSheet, ActivityIndicator, ScrollView, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { listGroups, listRecordings, getPlaybackUrl, recordingThumbUrl } from '../lib/api';
import { Txt, EmptyState, ScreenHeader, haptic } from '../components/ui';
import { radius, spacing, useTheme, useStyles } from '../theme';

function lastDays(n = 7) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ iso, label: i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) });
  }
  return out;
}
const clipTime = (r) => {
  const m = String(r.filename || '').match(/^(\d{2})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  return r.lastModified ? new Date(r.lastModified).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';
};
const mb = (b) => (b > 0 ? `${(b / 1048576).toFixed(1)} MB` : '');

export default function PlaybackScreen({ route, navigation }) {
  const { monitorId, name } = route.params || {};
  const { colors, type } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const days = useMemo(() => lastDays(7), []);
  const [date, setDate] = useState(days[0].iso);
  const [selected, setSelected] = useState(null); // clip key

  // resolve the camera's group from the shared cache (route may not carry it)
  const { data: groups = [] } = useQuery({ queryKey: ['groups'], queryFn: listGroups, staleTime: 60_000 });
  const groupId = useMemo(() => {
    if (route.params?.groupId != null) return route.params.groupId;
    for (const g of groups) if ((g.cameras || []).some((c) => c.monitorId === monitorId)) return g.id;
    return null;
  }, [route.params?.groupId, groups, monitorId]);

  const { data: clips = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['recordings', groupId, monitorId, date],
    queryFn: () => listRecordings(groupId, monitorId, date),
    enabled: groupId != null && monitorId != null,
    staleTime: 30_000,
  });

  // play URL fetched per-clip on tap (they expire — never cache long)
  const { data: playUrl, isFetching: urlLoading } = useQuery({
    queryKey: ['recording-url', groupId, selected],
    queryFn: () => getPlaybackUrl(groupId, selected),
    enabled: !!selected && groupId != null,
    staleTime: 60_000,
  });

  const player = useVideoPlayer(null, (p) => { p.loop = false; });
  const statusEvt = useEvent(player, 'statusChange', { status: player?.status ?? 'idle' });
  const status = statusEvt?.status ?? 'idle';

  useEffect(() => {
    if (playUrl && player) player.replaceAsync(playUrl).then(() => player.play()).catch(() => {});
  }, [playUrl, player]);

  const pickClip = useCallback((key) => { haptic.select(); setSelected(key); }, []);
  const retryClip = useCallback(() => {
    if (playUrl && player) player.replaceAsync(playUrl).then(() => player.play()).catch(() => {});
  }, [playUrl, player]);
  const pickDate = (iso) => { haptic.select(); setDate(iso); setSelected(null); player?.replaceAsync(null).catch(() => {}); };

  const loadingVideo = !!selected && (urlLoading || status === 'loading');

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* header */}
      <ScreenHeader
        title="Playback"
        subtitle={name || 'Camera'}
        onBack={() => navigation.goBack()}
        right={<View style={styles.headIcon}><MaterialCommunityIcons name="cctv" size={17} color={colors.primaryInk} /></View>}
      />

      {/* player — same centered-indicator rules as live */}
      <View style={styles.player}>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={!!selected} fullscreenOptions={{ enable: true }} />
        {!selected && (
          <View style={styles.centerFill} pointerEvents="none">
            <Ionicons name="film-outline" size={34} color="rgba(255,255,255,0.35)" />
            <Text style={styles.oSub}>Select a recording below</Text>
          </View>
        )}
        {loadingVideo && (
          <View style={styles.centerFill} pointerEvents="none">
            <ActivityIndicator size="large" color={colors.primaryInk} />
          </View>
        )}
        {!!selected && status === 'error' && (
          <View style={styles.centerFill}>
            <Pressable style={styles.retry} onPress={retryClip}>
              <Ionicons name="refresh" size={15} color={colors.onPrimary} />
              <Text style={[type.bodyMed, { color: colors.onPrimary }]}>Retry</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* date strip */}
      <View style={styles.dateWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dateRow}>
          {days.map((d) => {
            const on = date === d.iso;
            return (
              <Pressable key={d.iso} onPress={() => pickDate(d.iso)} style={[styles.dateChip, on && styles.dateChipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                <Txt t="caption" c={on ? colors.onPrimary : colors.sub}>{d.label}</Txt>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* clips */}
      {isLoading ? (
        <View style={{ padding: spacing.xl, alignItems: 'center' }}><ActivityIndicator color={colors.primaryInk} /></View>
      ) : (
        <FlatList
          data={clips}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.xl, paddingTop: spacing.sm }}
          renderItem={({ item }) => {
            const on = selected === item.key;
            return (
              <Pressable
                onPress={() => pickClip(item.key)}
                accessibilityRole="button"
                accessibilityLabel={`Recording at ${clipTime(item)}`}
                style={({ pressed }) => [styles.clipRow, on && styles.clipRowOn, pressed && { backgroundColor: colors.muted }]}
              >
                <Image source={{ uri: recordingThumbUrl(groupId, item.key) }} style={styles.thumb} contentFit="cover" transition={150} />
                <View style={{ flex: 1 }}>
                  <Txt t="bodyMed" numberOfLines={1}>{clipTime(item)}</Txt>
                  <Txt t="caption" c={colors.faint} numberOfLines={1}>{item.date}{mb(item.size) ? ` · ${mb(item.size)}` : ''}</Txt>
                </View>
                <Ionicons name={on ? 'pause-circle' : 'play-circle'} size={26} color={on ? colors.primaryInk : colors.faint} />
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              icon={isError ? 'cloud-offline-outline' : 'film-outline'}
              title={isError ? 'Can’t load recordings' : 'No recordings this day'}
              subtitle={isError ? 'Check your connection and try again.' : 'This system records on demand — days without recording sessions are empty.'}
              action={isError ? 'Retry' : undefined}
              onAction={() => refetch()}
            />
          }
        />
      )}
    </View>
  );
}

const makeStyles = ({ colors, onVideo }) => StyleSheet.create({
  headIcon: { width: 34, height: 34, borderRadius: radius.chip, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  player: { width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.video },
  centerFill: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 8 },
  oSub: onVideo.overlay,   // shared on-video family, not a local copy
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 20, paddingVertical: 10 },
  dateWrap: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  dateRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2, gap: spacing.sm },
  dateChip: { paddingHorizontal: 14, height: 32, borderRadius: radius.pill, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  dateChipOn: { backgroundColor: colors.primary },
  clipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md, marginBottom: 2 },
  clipRowOn: { backgroundColor: colors.primarySoft },
  thumb: { width: 72, height: 40, borderRadius: radius.sm, backgroundColor: colors.video },
});
