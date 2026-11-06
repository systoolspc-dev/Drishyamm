// Alerts — AI events, filtered by SEVERITY. The operator's first question is
// "how bad?", not "what kind?", so severity owns the chip row and type hides
// behind the filter button.
//
// FOUR FILTER/ORDER AXES, deliberately unequal in weight:
//   · severity — the chip row, always visible, the primary axis
//   · type     — behind the funnel button, and preset by Home's AI-insight
//                deep links. Shows as a REMOVABLE pill when active, so it can
//                never be on without being visible.
//   · day      — the docked footer's date control
//   · sort     — the docked footer's "Sort by"
// The two footer controls are docked rather than scrolled away with the list:
// they describe the whole list, so they must stay readable while you scroll it.
//
// Each row: severity stripe · brand icon chip · title · "Detection" qualifier ·
// location and camera · relative time · severity pill · the event's own
// evidence JPEG when it has one. Tapping opens THAT CAMERA LIVE, resolved
// against the groups cache — which is also the only source of an event's
// location, since the events endpoint returns a camera name and nothing about
// where it is.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { View, SectionList, RefreshControl, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { listAiEvents, listGroups, getEventSnapshotUrl } from '../lib/api';
import { eventIcon, eventTitle } from '../lib/events';
import { EmptyState, Chip, Txt, AlertRowSkeleton, BottomSheet, SheetAction, haptic } from '../components/ui';
import { radius, spacing, fonts, tabBarClearance, useTheme, useStyles } from '../theme';

// Severity buckets. "High" swallows `critical` too: the backend emits both and
// the design shows four chips, so an operator filtering High must not miss a
// critical. Unknown/absent severity falls to Low, matching theme `sevOf`.
const SEVERITIES = [
  { key: 'all',    label: 'All' },
  { key: 'high',   label: 'High',   match: (s) => s === 'high' || s === 'critical' },
  { key: 'medium', label: 'Medium', match: (s) => s === 'medium' },
  { key: 'low',    label: 'Low',    match: (s) => !s || (s !== 'high' && s !== 'critical' && s !== 'medium') },
];

const TYPES = [
  { key: 'all',     icon: 'albums-outline',        label: 'All events', hint: 'Every detection type' },
  { key: 'person',  icon: 'person-outline',        label: 'People',     hint: 'Faces and person detections', match: (t) => /face|person|crowd/.test(t) },
  { key: 'vehicle', icon: 'car-outline',           label: 'Vehicles',   hint: 'ANPR and vehicle detections', match: (t) => /anpr|vehicle|car/.test(t) },
  { key: 'motion',  icon: 'walk-outline',          label: 'Motion',     hint: 'Movement and loitering',      match: (t) => /motion|loiter/.test(t) },
  { key: 'alert',   icon: 'warning-outline',       label: 'Threats',    hint: 'Weapons, fire, aggression',   match: (t) => /weapon|fire|aggression|intrusion|restricted/.test(t) },
];

const SORTS = [
  { key: 'latest',   label: 'Latest',   icon: 'arrow-down-outline',   hint: 'Newest events first' },
  { key: 'oldest',   label: 'Oldest',   icon: 'arrow-up-outline',     hint: 'Oldest events first' },
  { key: 'severity', label: 'Severity', icon: 'alert-circle-outline', hint: 'Most severe first, then newest' },
];

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const rankOf = (e) => SEV_RANK[String(e?.severity || '').toLowerCase()] ?? 3;
const tsOf = (e) => (e?.ts ? new Date(e.ts).getTime() : 0);

const COMPARE = {
  latest:   (a, b) => tsOf(b) - tsOf(a),
  oldest:   (a, b) => tsOf(a) - tsOf(b),
  // severity first, newest-within-severity second — a list of equally red rows
  // in random time order is unreadable.
  severity: (a, b) => rankOf(a) - rankOf(b) || tsOf(b) - tsOf(a),
};

// Local midnight, as a number. The bucket key for day grouping AND for the
// footer's date filter, so the two can never disagree about which day a row is
// in. 0 is reserved for events the backend sent without a timestamp.
const startOfDay = (ts) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

function dayLabel(d) {
  const now = new Date(); const day = new Date(d);
  const diff = Math.round((startOfDay(now) - startOfDay(day)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const dateLabel = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' });

function timeAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr ago` : new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function AlertsScreen({ navigation, route }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [severity, setSeverity] = useState('all');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState('latest');
  const [day, setDay] = useState(null);            // null = every day
  const [sheet, setSheet] = useState(null);        // 'type' | 'day' | 'sort'
  const [manual, setManual] = useState(false);

  // deep links from Home's AI insight tiles preset the TYPE axis
  useEffect(() => {
    const f = route.params?.filter;
    if (f && TYPES.some((t) => t.key === f)) setType(f);
  }, [route.params?.filter]);

  const { data: events = [], refetch, isLoading, error } = useQuery({
    queryKey: ['ai-events'], queryFn: () => listAiEvents({ limit: 100 }), refetchInterval: 15_000,
  });

  const { data: groups = [] } = useQuery({ queryKey: ['groups'], queryFn: listGroups, staleTime: 60_000 });
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

  const activeType = TYPES.find((t) => t.key === type) || TYPES[0];
  const activeSort = SORTS.find((s) => s.key === sort) || SORTS[0];

  // Type narrows the pool FIRST, so the severity counts describe what you are
  // actually looking at — "High: 3" beside a People filter must mean three
  // high-severity people events, not three high-severity anything.
  const pool = useMemo(() => {
    if (type === 'all' || !activeType.match) return events;
    return events.filter((e) => activeType.match(String(e.eventType || '').toLowerCase()));
  }, [events, type, activeType]);

  // The date control offers only days the loaded window actually contains —
  // the endpoint takes no date range, so offering an arbitrary calendar would
  // promise data this screen cannot fetch.
  const days = useMemo(() => {
    const m = new Map();
    for (const e of pool) {
      const k = e.ts ? startOfDay(e.ts) : 0;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([key, count]) => ({ key, count, label: key ? dayLabel(key) : 'Earlier' }));
  }, [pool]);

  // A day that drops out of the pool (type filter changed, window rolled over)
  // would otherwise leave the screen empty with no visible cause.
  useEffect(() => {
    if (day != null && !days.some((d) => d.key === day)) setDay(null);
  }, [days, day]);

  const dayPool = useMemo(
    () => (day == null ? pool : pool.filter((e) => (e.ts ? startOfDay(e.ts) : 0) === day)),
    [pool, day]
  );

  const counts = useMemo(() => {
    const c = { all: dayPool.length };
    for (const s of SEVERITIES) {
      if (s.key === 'all') continue;
      c[s.key] = dayPool.filter((e) => s.match(String(e.severity || '').toLowerCase())).length;
    }
    return c;
  }, [dayPool]);

  const activeSeverity = SEVERITIES.find((s) => s.key === severity) || SEVERITIES[0];
  const sections = useMemo(() => {
    const list = severity === 'all'
      ? dayPool
      : dayPool.filter((e) => activeSeverity.match(String(e.severity || '').toLowerCase()));
    const byDay = new Map();
    for (const e of list) {
      const k = e.ts ? startOfDay(e.ts) : 0;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    const cmp = COMPARE[sort] || COMPARE.latest;
    return [...byDay.entries()]
      // days follow the sort direction; severity sorting keeps days newest-first
      // and reorders WITHIN each day, so a date header never runs backwards.
      .sort((a, b) => (sort === 'oldest' ? a[0] - b[0] : b[0] - a[0]))
      .map(([k, data]) => ({
        title: k ? dayLabel(k) : 'Earlier',
        count: data.length,
        data: [...data].sort(cmp),
      }));
  }, [dayPool, severity, activeSeverity, sort]);

  const shown = sections.reduce((n, s) => n + s.count, 0);
  const filtered = severity !== 'all' || type !== 'all' || day != null;
  const onRefresh = useCallback(async () => { setManual(true); try { await refetch(); } finally { setManual(false); } }, [refetch]);

  const clearType = () => {
    haptic.light();
    setType('all');
    // clear the param too, or re-focusing the tab re-applies the deep link
    navigation.setParams({ filter: undefined });
  };

  const clearAll = () => { haptic.light(); setSeverity('all'); setDay(null); if (type !== 'all') clearType(); };
  const open = (which) => { haptic.light(); setSheet(which); };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* h1, matching Menu's page title — `display` (28) made this the only
              screen whose header outran every other page. */}
          <Txt t="h1">Alerts</Txt>
          {isLoading ? (
            <Txt t="sub" c={colors.sub}>Loading…</Txt>
          ) : (
            <Txt t="sub" c={colors.sub}>
              <Txt t="sub" c={colors.primaryInk} style={{ fontFamily: fonts.semi }}>{shown}</Txt>
              {` Event${shown === 1 ? '' : 's'}`}
            </Txt>
          )}
        </View>
        <View>
          <Pressable
            onPress={() => open('type')}
            onPressIn={haptic.light}
            accessibilityRole="button"
            accessibilityLabel={`Filter by type. Currently ${activeType.label}`}
            style={({ pressed }) => [styles.headerBtn, pressed && { backgroundColor: colors.muted }]}
          >
            <Ionicons name="options-outline" size={20} color={colors.primaryInk} />
          </Pressable>
          {type !== 'all' ? <View style={styles.filterDot} pointerEvents="none" /> : null}
        </View>
      </View>

      {/* the secondary axis is never active without being visible */}
      {type !== 'all' ? (
        <View style={styles.typeRow}>
          <Pressable
            onPress={clearType}
            accessibilityRole="button"
            accessibilityLabel={`Filtered to ${activeType.label}. Tap to clear`}
            style={({ pressed }) => [styles.typePill, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name={activeType.icon} size={13} color={colors.primaryInk} />
            <Txt t="caption" c={colors.primaryInk} style={{ fontFamily: fonts.semi }}>{activeType.label}</Txt>
            <Ionicons name="close" size={13} color={colors.primaryInk} />
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        style={styles.chipWrap}
      >
        {SEVERITIES.map((s) => (
          <Chip
            key={s.key}
            variant="raised"
            // the count rides IN the label here: a separate counter pill beside
            // four already-wide chips pushes the row off-screen
            label={`${s.label} (${counts[s.key] ?? 0})`}
            selected={severity === s.key}
            onPress={() => setSeverity(s.key)}
          />
        ))}
      </ScrollView>

      {isLoading ? (
        <View style={{ flex: 1, paddingHorizontal: spacing.lg }}>
          {[0, 1, 2, 3].map((i) => <AlertRowSkeleton key={i} />)}
        </View>
      ) : (
        <SectionList
          sections={sections}
          // flex:1 is load-bearing: the footer is a SIBLING below this list, and
          // RN's default flexShrink of 0 would let a long list push it off-screen.
          style={{ flex: 1 }}
          keyExtractor={(e, i) => String(e.id ?? i)}
          refreshControl={<RefreshControl refreshing={manual} onRefresh={onRefresh} tintColor={colors.primaryInk} colors={[colors.primaryInk]} />}
          // the footer is docked below the list, so the list only pads for its
          // own breathing room — not for the tab bar
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View style={styles.dayHeader}>
              <Txt t="label" c={colors.sub}>{section.title}</Txt>
              <Txt t="caption" c={colors.faint}>{section.count}</Txt>
            </View>
          )}
          renderItem={({ item }) => (
            <AlertCard
              event={item}
              camera={cameraFor(item)}
              onPress={(cam) => {
                haptic.light();
                navigation.navigate('LiveView', { monitorId: cam.monitorId, name: cam.name, location: cam.groupName });
              }}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon={error ? 'cloud-offline-outline' : 'shield-checkmark-outline'}
              title={error ? 'Can’t load alerts' : 'All clear'}
              subtitle={
                error ? 'Check your connection and try again.'
                  : filtered ? 'No events match the current filters.'
                  : 'No events yet.'
              }
              action={error ? 'Retry' : filtered ? 'Clear filters' : undefined}
              onAction={() => { if (error) return refetch(); clearAll(); }}
            />
          }
        />
      )}

      {/* Docked footer. It clears the FLOATING tab bar by reserving the same
          space every scrolling screen reserves (tabBarClearance + safe area),
          so it can never end up underneath it. */}
      <View style={[styles.footer, { marginBottom: insets.bottom + tabBarClearance }]}>
        <Pressable
          onPress={() => open('day')}
          onPressIn={haptic.light}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Date filter. Currently ${day == null ? 'all dates' : (day ? dateLabel(day) : 'earlier')}`}
          style={({ pressed }) => [styles.datePill, pressed && { backgroundColor: colors.mutedAlt }]}
        >
          <Ionicons name="calendar-outline" size={15} color={colors.primaryInk} />
          <Txt t="caption" c={colors.text}>
            {day == null ? 'All dates' : (day ? dateLabel(day) : 'Earlier')}
          </Txt>
          <Ionicons name="chevron-down" size={14} color={colors.faint} />
        </Pressable>

        <Pressable
          onPress={() => open('sort')}
          onPressIn={haptic.light}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Sort by ${activeSort.label}`}
          style={({ pressed }) => [styles.sortBtn, pressed && { opacity: 0.6 }]}
        >
          <Txt t="caption" c={colors.sub}>Sort by:</Txt>
          <Txt t="caption" c={colors.primaryInk} style={{ fontFamily: fonts.semi }}>{activeSort.label}</Txt>
          <Ionicons name="chevron-down" size={14} color={colors.primaryInk} />
        </Pressable>
      </View>

      <BottomSheet visible={sheet === 'type'} onClose={() => setSheet(null)} title="Filter by type">
        {TYPES.map((t) => (
          <SheetAction
            key={t.key}
            icon={t.key === type ? 'checkmark-circle' : t.icon}
            label={t.label}
            hint={t.hint}
            onPress={() => { setType(t.key); setSheet(null); if (t.key === 'all') navigation.setParams({ filter: undefined }); }}
          />
        ))}
      </BottomSheet>

      <BottomSheet visible={sheet === 'day'} onClose={() => setSheet(null)} title="Filter by date" scrollable>
        <SheetAction
          icon={day == null ? 'checkmark-circle' : 'calendar-outline'}
          label="All dates"
          hint={`${pool.length} event${pool.length === 1 ? '' : 's'} loaded`}
          onPress={() => { setDay(null); setSheet(null); }}
        />
        {days.map((d) => (
          <SheetAction
            key={d.key}
            icon={day === d.key ? 'checkmark-circle' : 'calendar-outline'}
            label={d.key ? dateLabel(d.key) : 'Earlier'}
            hint={`${d.label} · ${d.count} event${d.count === 1 ? '' : 's'}`}
            onPress={() => { setDay(d.key); setSheet(null); }}
          />
        ))}
      </BottomSheet>

      <BottomSheet visible={sheet === 'sort'} onClose={() => setSheet(null)} title="Sort by">
        {SORTS.map((s) => (
          <SheetAction
            key={s.key}
            icon={s.key === sort ? 'checkmark-circle' : s.icon}
            label={s.label}
            hint={s.hint}
            onPress={() => { setSort(s.key); setSheet(null); }}
          />
        ))}
      </BottomSheet>
    </View>
  );
}

// One alert. Severity drives the decorative left stripe (VIVID tone) and the
// badge (INK tone) — see the two-tier note in theme/palettes.js. The icon chip
// stays BRAND-tinted rather than severity-tinted: severity is already stated
// twice in the row (stripe + pill), and a third restatement turned the list
// into a wall of competing colour.
function AlertCard({ event, camera, onPress }) {
  const { colors, press, sevOf } = useTheme();
  const styles = useStyles(makeStyles);
  const sv = sevOf(event.severity);
  const place = camera?.location || camera?.groupName || null;

  const detail = event.personName || event.plateNumber || null;
  const where = [place, event.cameraName || camera?.name].filter(Boolean).join(' • ');

  // evidence JPEG, fetched lazily and only when the event actually has one
  const { data: url } = useQuery({
    queryKey: ['ev-snap', event.id],
    queryFn: () => getEventSnapshotUrl(event.id),
    enabled: !!event.snapshotKey && event.id != null,
    staleTime: 30 * 60_000,
    retry: 0,
  });

  const body = (
    <>
      <View style={[styles.stripe, { backgroundColor: sv.accent }]} />
      <View style={styles.icon}>
        <Ionicons name={eventIcon(event.eventType)} size={20} color={colors.primaryInk} />
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        {/* titleSm + caption, the same pair Home's AlertCard uses. An alert row
            must not change size depending on which screen you read it on. */}
        <Txt t="titleSm" numberOfLines={1} style={{ textTransform: 'capitalize' }}>
          {eventTitle(event.eventType)}
        </Txt>
        <Txt t="caption" c={colors.sub} numberOfLines={1} style={{ marginTop: 2 }}>
          {detail ? `Detection • ${detail}` : 'Detection'}
        </Txt>
        {where ? (
          <Txt t="caption" c={colors.sub} numberOfLines={1} style={{ marginTop: 1 }}>{where}</Txt>
        ) : null}
      </View>

      {/* stretched so time pins to the top and the pill to the bottom, matching
          the two text rows they belong to */}
      <View style={styles.meta}>
        <Txt t="caption" c={colors.faint} numberOfLines={1}>{event.ts ? timeAgo(event.ts) : '—'}</Txt>
        <View style={[styles.sevPill, { backgroundColor: sv.bg }]}>
          <View style={[styles.sevDot, { backgroundColor: sv.accent }]} />
          <Txt t="badge" c={sv.fg}>{String(event.severity || 'low').toUpperCase()}</Txt>
        </View>
      </View>

      {url ? <Image source={{ uri: url }} style={styles.thumb} contentFit="cover" transition={150} /> : null}
    </>
  );

  if (!camera) return <View style={styles.card}>{body}</View>;
  return (
    <Pressable
      onPress={() => onPress(camera)}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={`${eventTitle(event.eventType)} on ${event.cameraName || 'camera'}${place ? `, ${place}` : ''}, ${event.severity || 'low'} severity. Open live`}
      style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: press.cardScale }] }]}
    >
      {body}
    </Pressable>
  );
}

const makeStyles = ({ colors, shadow }) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  // raised, like the chip row under it — the two read as one control layer
  headerBtn: {
    width: 44, height: 44, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: colors.elevatedBorder ? StyleSheet.hairlineWidth : 0,
    borderColor: colors.elevatedBorder || 'transparent',
    ...shadow(1),
  },
  filterDot: {
    position: 'absolute', top: 2, right: 2, width: 9, height: 9, borderRadius: 5,
    backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.bg,
  },

  typeRow: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  typePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.primarySoft, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.primary,
    paddingHorizontal: spacing.md, minHeight: 30,
  },

  // the chip row rides on shadows, so its scroll container needs vertical room
  // for them — a tight wrapper clips the lift and the pills look pasted on
  chipWrap: { flexGrow: 0, paddingVertical: spacing.md },
  chipRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: 4 },
  dayHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.md, marginBottom: spacing.sm },

  // border XOR shadow: this card rides on its shadow, so it carries no border
  // (bar the dark-mode hairline, where a shadow has nothing to darken).
  card: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: colors.elevatedBorder ? StyleSheet.hairlineWidth : 0,
    borderColor: colors.elevatedBorder || 'transparent',
    paddingVertical: spacing.md, paddingRight: spacing.md, paddingLeft: spacing.lg,
    marginBottom: spacing.md,
    ...shadow(1),
  },
  // The card canNOT clip its children (`overflow: hidden` masks the layer on
  // iOS, which takes the shadow with it), so the stripe rounds its own left
  // corners to sit flush inside the card's radius.
  stripe: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
    borderTopLeftRadius: radius.lg, borderBottomLeftRadius: radius.lg,
  },
  icon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center',
  },
  meta: { alignSelf: 'stretch', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.sm },
  sevPill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4 },
  sevDot: { width: 6, height: 6, borderRadius: 3 },
  thumb: { width: 48, height: 48, borderRadius: radius.xs, backgroundColor: colors.video },

  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingTop: spacing.md,
  },
  datePill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: colors.muted, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, minHeight: 38,
  },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: spacing.sm, paddingHorizontal: 4 },
});
