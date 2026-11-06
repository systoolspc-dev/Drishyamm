// Site Details — one site, from the SAME cached GET /api/groups the rest of the
// app uses. No new endpoint, no per-site fetch: the groups payload already
// carries this site and its cameras, so opening a site costs nothing.
//
// WHAT IS SHOWN IS WHAT THE SERVER SENDS. The reference design asks for an
// address, an added date, a site type, a timezone, a site admin and a
// description; the API returns none of those, so those rows do not exist here
// rather than existing filled with plausible values. `host` — the recorder
// address — is real, so it is shown and labelled for what it actually is.
//
// Likewise the ACTIONS: only the ones the mobile API can actually perform are
// live. Edit / users / settings / archive have no routes (see src/lib/api.js
// for the complete list of what this client can call), so they state that
// instead of firing a request that would fail or, worse, appear to succeed.
import { useMemo, useState, useCallback } from 'react';
import { View, ScrollView, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';
import { listGroups, listAiEvents } from '../lib/api';
import { eventIcon, eventTitle } from '../lib/events';
import { siteStats, siteStatus } from '../lib/sites';
import {
  Card, Txt, Button, EmptyState, ScreenHeader, IconButton,
  BottomSheet, Skeleton, haptic,
} from '../components/ui';
import { radius, spacing, fonts, useTheme, useStyles } from '../theme';

const RECENT_ACTIVITY = 5;

// Every action the design calls for. `to` = a route this app really has;
// `reason` = why it cannot be done from the phone. Exactly one of the two.
const ACTIONS = [
  { key: 'cameras', icon: 'videocam-outline', label: 'Manage Cameras', hint: 'Open this site’s live wall', to: 'LiveWall' },
  { key: 'edit',    icon: 'create-outline',   label: 'Edit Site',
    reason: 'The mobile API has no site-update route — site details are edited on the Drishyam web console.' },
  { key: 'users',   icon: 'people-outline',   label: 'Manage Users',
    reason: 'User administration is web-only, and deliberately so — it changes who can see your cameras.' },
  { key: 'settings', icon: 'settings-outline', label: 'Site Settings',
    reason: 'Recorder and site settings are configured on the web console; the app has no route for them.' },
  { key: 'archive', icon: 'archive-outline',  label: 'Archive Site', destructive: true,
    reason: 'Archiving removes a site for every user of the account. There is no mobile route for it, and it belongs on the web console.' },
];

export default function SiteDetailsScreen({ navigation, route }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const groupId = route.params?.groupId;
  const [sheet, setSheet] = useState(null);   // 'more' | { label, reason }

  const { data: groups = [], isLoading, error, refetch } = useQuery({
    queryKey: ['groups'], queryFn: listGroups, refetchInterval: 15_000,
  });
  const site = useMemo(() => groups.find((g) => g.id === groupId), [groups, groupId]);

  // Activity = the AI events this site's own cameras produced. There is no
  // site audit log in the API ("camera went offline" etc. is not recorded
  // anywhere this client can read), so rather than invent one this shows real
  // detections, matched to this site's cameras and labelled for what they are.
  const { data: events = [] } = useQuery({
    queryKey: ['ai-events'], queryFn: () => listAiEvents({ limit: 100 }), staleTime: 30_000,
  });
  const activity = useMemo(() => {
    if (!site) return [];
    const cams = site.cameras || [];
    const ids = new Set(cams.map((c) => c.monitorId));
    const names = new Set(cams.map((c) => String(c.name || '').trim().toLowerCase()));
    return events
      .filter((e) => ids.has(e.monitorId) || ids.has(e.cameraId)
        || names.has(String(e.cameraName || '').trim().toLowerCase()))
      .slice(0, RECENT_ACTIVITY);
  }, [events, site]);

  const openCameras = useCallback(() => {
    if (!site) return;
    haptic.light();
    // The existing per-site camera view: LiveWall already filters by groupId.
    navigation.navigate('LiveWall', { groupId: site.id, groupName: site.name });
  }, [navigation, site]);

  const runAction = (a) => {
    haptic.light();
    setSheet(null);
    if (a.reason) { setSheet({ label: a.label, reason: a.reason }); return; }
    if (a.to === 'LiveWall') openCameras();
  };

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader title={route.params?.name || 'Site'} onBack={() => navigation.goBack()} />
        <View style={styles.page}>
          <Skeleton width="100%" height={168} r={radius.lg} />
          <Skeleton width="100%" height={132} r={radius.lg} style={{ marginTop: spacing.lg }} />
          <Skeleton width="100%" height={180} r={radius.lg} style={{ marginTop: spacing.lg }} />
        </View>
      </View>
    );
  }

  // Loaded, but this id isn't in the payload — it was removed, or the account
  // lost access. Say so; don't render an empty shell of a site.
  if (!site) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScreenHeader title={route.params?.name || 'Site'} onBack={() => navigation.goBack()} />
        <EmptyState
          icon={error ? 'cloud-offline-outline' : 'business-outline'}
          title={error ? 'Unable to load sites' : 'Site unavailable'}
          subtitle={error
            ? 'Check your connection and try again.'
            : 'This site is no longer in your account, or you no longer have access to it.'}
          action={error ? 'Try Again' : 'Back'}
          onAction={() => (error ? refetch() : navigation.goBack())}
        />
      </View>
    );
  }

  const status = siteStatus(site);
  const { total, online, offline } = siteStats(site);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScreenHeader
        title={site.name}
        subtitle={status.label}
        onBack={() => navigation.goBack()}
        right={
          <IconButton
            icon="ellipsis-horizontal"
            variant="plain"
            onPress={() => { haptic.light(); setSheet('more'); }}
            accessibilityLabel="Site actions"
          />
        }
      />

      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + spacing.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {/* HERO. The API returns no site imagery, so this is a branded panel
            rather than stock photography standing in for a real place. */}
        <View style={styles.hero}>
          <LinearGradient
            colors={[colors.primary, colors.primaryDk]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <Ionicons name="business" size={64} color="rgba(42,26,5,0.18)" style={styles.heroGlyph} />
          <View style={[styles.heroBadge, { backgroundColor: colors[`${status.tint}Soft`] }]}>
            <View style={[styles.dot, { backgroundColor: colors[status.tint] }]} />
            <Txt t="badge" c={colors[`${status.tint}Ink`]}>{status.label.toUpperCase()}</Txt>
          </View>
          <View style={styles.heroFoot}>
            <Txt t="h2" c={colors.onPrimary} numberOfLines={2}>{site.name}</Txt>
            <Txt t="caption" c="rgba(42,26,5,0.75)" numberOfLines={1}>
              {total} {total === 1 ? 'camera' : 'cameras'} · {online} online
            </Txt>
          </View>
        </View>

        {/* SITE INFORMATION — only fields the server actually returns. */}
        <Txt t="label" c={colors.sub} style={styles.sectionLabel}>Site Information</Txt>
        <Card variant="flat" padding="none" style={styles.group}>
          <InfoRow icon="business-outline" label="Site Name" value={site.name} />
          {site.host ? <InfoRow icon="server-outline" label="Recorder" value={site.host} /> : null}
          <InfoRow icon="videocam-outline" label="Total Cameras" value={String(total)} />
          <InfoRow icon="pulse-outline" label="Status" value={status.label} tint={status.tint} last />
        </Card>

        {/* CAMERA SUMMARY — counted from this site's own cameras array. There
            is no maintenance state on a camera, so there is no such bar. */}
        <Txt t="label" c={colors.sub} style={styles.sectionLabel}>Camera Summary</Txt>
        <Card variant="flat" style={styles.summary}>
          {total === 0 ? (
            <Txt t="sub" c={colors.sub}>This site has no cameras yet.</Txt>
          ) : (
            <>
              <Bar label="Online" value={online} total={total} tint="ok" />
              <Bar label="Offline" value={offline} total={total} tint="critical" />
              <Bar label="Total" value={total} total={total} tint="info" />
            </>
          )}
          <Button
            title="View All Cameras"
            icon="grid-outline"
            variant="secondary"
            onPress={openCameras}
            disabled={total === 0}
            style={{ marginTop: spacing.md }}
          />
        </Card>

        {/* SITE ACTIONS */}
        <Txt t="label" c={colors.sub} style={styles.sectionLabel}>Site Actions</Txt>
        <Card variant="flat" padding="none" style={styles.group}>
          {ACTIONS.map((a, i) => (
            <ActionRow key={a.key} action={a} last={i === ACTIONS.length - 1} onPress={() => runAction(a)} />
          ))}
        </Card>

        {/* RECENT ACTIVITY — hidden entirely when this site has produced none,
            rather than padded with placeholder rows. */}
        {activity.length ? (
          <>
            <Txt t="label" c={colors.sub} style={styles.sectionLabel}>Recent Activity</Txt>
            <Card variant="flat" padding="none" style={styles.group}>
              {activity.map((e, i) => (
                <ActivityRow
                  key={e.id ?? i}
                  event={e}
                  last={i === activity.length - 1}
                  onPress={() => {
                    const cam = (site.cameras || []).find(
                      (c) => c.monitorId === e.monitorId || c.monitorId === e.cameraId
                        || String(c.name || '').trim().toLowerCase() === String(e.cameraName || '').trim().toLowerCase()
                    );
                    if (!cam) return;
                    haptic.light();
                    navigation.navigate('LiveView', { monitorId: cam.monitorId, name: cam.name, location: site.name });
                  }}
                />
              ))}
            </Card>
          </>
        ) : null}
      </ScrollView>

      <BottomSheet visible={sheet === 'more'} onClose={() => setSheet(null)} title="Site actions" scrollable>
        {ACTIONS.map((a) => (
          <ActionRow key={a.key} action={a} last onPress={() => runAction(a)} />
        ))}
      </BottomSheet>

      <BottomSheet
        visible={!!sheet && sheet !== 'more'}
        onClose={() => setSheet(null)}
        title={sheet?.label}
        footer={<Button title="Close" variant="secondary" onPress={() => setSheet(null)} style={{ marginTop: spacing.sm }} />}
      >
        <View style={styles.reason}>
          <Ionicons name="information-circle-outline" size={19} color={colors.primaryInk} />
          <Txt t="sub" c={colors.sub} style={{ flex: 1 }}>{sheet?.reason}</Txt>
        </View>
      </BottomSheet>
    </View>
  );
}

function InfoRow({ icon, label, value, tint, last }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={17} color={colors.primaryInk} /></View>
      <Txt t="bodyMed" style={{ flex: 1 }} numberOfLines={1}>{label}</Txt>
      <Txt t="sub" c={tint ? colors[`${tint}Ink`] : colors.sub} numberOfLines={1} style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </Txt>
    </View>
  );
}

// Horizontal proportion bar. `total` is the denominator, so "Total" always
// reads full and the others read as their share of it.
function Bar({ label, value, total, tint }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <View style={styles.bar} accessibilityLabel={`${label}, ${value} of ${total}`}>
      <View style={styles.barHead}>
        <Txt t="caption" c={colors.sub} style={{ flex: 1 }}>{label}</Txt>
        <Txt t="caption" c={colors.text} style={{ fontFamily: fonts.semi }}>{value}</Txt>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: colors[tint] }]} />
      </View>
    </View>
  );
}

// An action row. Unsupported actions are NOT hidden and NOT silently inert:
// they read as unavailable and, on tap, say why.
function ActionRow({ action, last, onPress }) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  const blocked = !!action.reason;
  const tint = action.destructive ? colors.criticalInk : colors.primaryInk;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={blocked ? `${action.label}. Unavailable on mobile` : action.label}
      style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && { backgroundColor: colors.muted }]}
    >
      <View style={[styles.rowIcon, blocked && { backgroundColor: colors.muted }]}>
        <Ionicons name={action.icon} size={17} color={blocked ? colors.faint : tint} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="bodyMed" c={blocked ? colors.faint : (action.destructive ? colors.criticalInk : undefined)} numberOfLines={1}>
          {action.label}
        </Txt>
        {action.hint && !blocked ? <Txt t="caption" c={colors.faint} numberOfLines={1}>{action.hint}</Txt> : null}
      </View>
      {blocked ? (
        <View style={styles.webPill}><Txt t="badge" c={colors.faint}>WEB ONLY</Txt></View>
      ) : (
        <Ionicons name="chevron-forward" size={16} color={colors.faint} />
      )}
    </Pressable>
  );
}

function ActivityRow({ event, last, onPress }) {
  const { colors, press, sevOf } = useTheme();
  const styles = useStyles(makeStyles);
  const sv = sevOf(event.severity);
  const when = event.ts
    ? new Date(event.ts).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={`${eventTitle(event.eventType)} on ${event.cameraName || 'camera'}, ${when}`}
      style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && { backgroundColor: colors.muted }]}
    >
      <View style={[styles.rowIcon, { backgroundColor: sv.bg }]}>
        <Ionicons name={eventIcon(event.eventType)} size={17} color={sv.fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="bodyMed" numberOfLines={1} style={{ textTransform: 'capitalize' }}>{eventTitle(event.eventType)}</Txt>
        <Txt t="caption" c={colors.faint} numberOfLines={1}>
          {event.cameraName || 'Unknown camera'} · {when}
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.faint} />
    </Pressable>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  page: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },

  hero: {
    height: 168, borderRadius: radius.lg, overflow: 'hidden',
    justifyContent: 'flex-end', padding: spacing.lg,
  },
  heroGlyph: { position: 'absolute', right: spacing.md, top: spacing.md },
  heroBadge: {
    position: 'absolute', top: spacing.md, left: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4,
  },
  heroFoot: { gap: 2 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },

  sectionLabel: { marginTop: spacing.xl, marginBottom: spacing.sm, marginLeft: spacing.xs },
  group: { paddingHorizontal: spacing.lg },
  summary: { gap: spacing.md },

  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 58, paddingVertical: spacing.sm },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowIcon: {
    width: 36, height: 36, borderRadius: radius.sm,
    backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center',
  },
  webPill: { backgroundColor: colors.muted, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },

  bar: { gap: 6 },
  barHead: { flexDirection: 'row', alignItems: 'center' },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.muted, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },

  reason: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm },
});
