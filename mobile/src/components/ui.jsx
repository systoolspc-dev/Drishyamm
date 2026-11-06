// Drishyam UI kit — small, reusable, shipped-product quality.
// Rules baked in: border XOR shadow (never both), weight via fontFamily,
// pressed = bg/scale (not opacity), 44pt touch targets, light haptics.
//
// Every component here reads colour from useTheme(), so a screen that composes
// the kit is dark-mode-correct without knowing the theme exists. The one rule
// that bends on a dark ground is "border XOR shadow" — see Card.
import { useEffect } from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator, Animated, StyleSheet, Modal, ScrollView, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNetInfo } from '@react-native-community/netinfo';
import * as Haptics from 'expo-haptics';
import { radius, spacing, fonts, useTheme, useStyles } from '../theme';

// ── haptics ──────────────────────────────────────────────────────────────────
export const haptic = {
  light:  () => { try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {} },
  medium: () => { try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {} },
  select: () => { try { Haptics.selectionAsync(); } catch {} },
};

// ── Txt: role-based text (single source of typographic truth) ────────────────
export function Txt({ t = 'body', c, style, children, ...rest }) {
  const { type } = useTheme();
  return <Text style={[type[t], c && { color: c }, style]} {...rest}>{children}</Text>;
}

// ── Card: flat = border, no shadow · raised = shadow, no border ──────────────
// On a DARK ground a shadow has almost nothing to darken, so `raised` also
// picks up a hairline there — otherwise a #1E1E1E card on a #121212 page has
// no edge at all. This is the deliberate exception to border-XOR-shadow, and
// it lives here so no screen has to think about it.
const PAD = { none: 0, sm: spacing.md, md: spacing.lg, lg: spacing.xl };
export function Card({ variant = 'flat', padding = 'md', level = 1, style, children, onPress, ...rest }) {
  const { shadow, press } = useTheme();
  const styles = useStyles(makeStyles);
  const base = [
    styles.card,
    variant === 'raised' ? [shadow(level), styles.cardElevatedEdge] : styles.cardBorder,
    { padding: PAD[padding] },
    style,
  ];
  if (!onPress) return <View style={base} {...rest}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      android_ripple={{ color: press.ripple }}
      style={({ pressed }) => [base, pressed && { transform: [{ scale: press.cardScale }] }]}
      {...rest}
    >
      {children}
    </Pressable>
  );
}

// ── SectionHeader ────────────────────────────────────────────────────────────
export function SectionHeader({ title, actionLabel, onAction, first }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.sectionHeader, first && { marginTop: spacing.sm }]}>
      <Txt t="title" style={{ flex: 1 }} numberOfLines={1}>{title}</Txt>
      {actionLabel ? (
        // primaryInk, not primary: this is small brand-coloured TEXT on a light
        // ground, where the vivid orange is only 2.2:1.
        <Pressable onPress={onAction} onPressIn={haptic.light} hitSlop={8} style={styles.sectionAction}>
          <Txt t="bodyMed" c={colors.primaryInk}>{actionLabel}</Txt>
          <Ionicons name="chevron-forward" size={14} color={colors.primaryInk} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ── StatusDot + Badge ────────────────────────────────────────────────────────
export function StatusDot({ state = 'off', size = 7 }) {
  const { colors } = useTheme();
  const c = { online: colors.ok, live: colors.live, warn: colors.warn, off: colors.off }[state] || colors.off;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c }} />;
}

export function Badge({ label, fg, bg, dot, style }) {
  const { colors, type } = useTheme();
  const styles = useStyles(makeStyles);
  const fgc = fg || colors.sub;
  return (
    <View style={[styles.badge, { backgroundColor: bg || colors.muted }, style]}>
      {dot ? <View style={[styles.badgeDot, { backgroundColor: fgc }]} /> : null}
      <Text style={[type.badge, { color: fgc }]}>{label}</Text>
    </View>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────
export function Button({
  title, onPress, variant = 'primary', size = 'md', loading, disabled, icon,
  fullWidth = true, style, accessibilityLabel, loadingLabel,
}) {
  const { colors, type, brandShadow, press, isDark } = useTheme();
  const styles = useStyles(makeStyles);
  const V = {
    primary:     { bg: colors.primary,   pressed: colors.primaryDk, fg: colors.onPrimary, sh: brandShadow },
    secondary:   { bg: colors.surface,   pressed: colors.muted,     fg: colors.text,      border: true },
    ghost:       { bg: 'transparent',    pressed: colors.muted,     fg: colors.text },
    // The soft-tint destructive button needs a pressed state that reads on both
    // grounds: a touch darker on light, a touch lighter on dark.
    destructive: { bg: colors.critSoft,  pressed: isDark ? 'rgba(239,83,80,0.30)' : '#F9DADA', fg: colors.criticalInk },
  }[variant];
  const H = { sm: 40, md: 48, lg: 54 }[size];
  const isOff = disabled || loading;
  // Single foreground for icon, label and spinner — a disabled+loading button
  // would otherwise draw white-on-muted and vanish.
  const fg = disabled ? colors.faint : V.fg;

  return (
    <Pressable
      onPress={onPress}
      onPressIn={variant === 'primary' ? haptic.medium : haptic.light}
      disabled={isOff}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityState={{ disabled: isOff, busy: !!loading }}
      style={({ pressed }) => [
        styles.btn,
        { minHeight: H, backgroundColor: pressed ? V.pressed : V.bg },
        V.border && { borderWidth: 1, borderColor: colors.border },
        variant === 'primary' && !isOff && V.sh,
        fullWidth && { alignSelf: 'stretch' },
        // Loading keeps the filled brand colour (the spinner carries the state);
        // only a truly disabled button greys out, so the two read differently.
        disabled && { backgroundColor: colors.muted, opacity: 0.7 },
        style,
      ]}
    >
      {loading ? (
        // loadingLabel is opt-in: without it we keep the original spinner-only
        // body, so existing callers don't change size mid-press.
        <>
          <ActivityIndicator size="small" color={fg} />
          {loadingLabel ? <Text style={[type.bodyMed, { color: fg }]}>{loadingLabel}</Text> : null}
        </>
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
          <Text style={[type.bodyMed, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

// ── IconButton (44pt touch) ──────────────────────────────────────────────────
export function IconButton({ icon, onPress, variant = 'plain', size = 'md', color, disabled, accessibilityLabel, style, hitSlop }) {
  const { colors, press } = useTheme();
  const V = {
    plain:  { bg: 'transparent',       fg: color || colors.text },
    tinted: { bg: colors.muted,        fg: color || colors.text },
    solid:  { bg: colors.primary,      fg: colors.onPrimary },
    // Sits ON a video frame, so it ignores the theme entirely — the ground is
    // footage, not a surface.
    onVideo: { bg: 'rgba(0,0,0,0.45)', fg: color || colors.onVideo },
  }[variant];
  const s = size === 'sm' ? 36 : 44;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      disabled={disabled}
      // sm renders at 36pt; callers embedding it in a dense row can widen the
      // slop to reach the 44pt target the kit promises.
      hitSlop={hitSlop ?? (size === 'sm' ? 6 : 0)}
      android_ripple={{ color: press.ripple, borderless: true, radius: s / 2 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        { width: s, height: s, borderRadius: variant === 'onVideo' ? s / 2 : radius.md, backgroundColor: V.bg, alignItems: 'center', justifyContent: 'center' },
        pressed && variant === 'onVideo' && { backgroundColor: 'rgba(0,0,0,0.65)' },
        pressed && variant !== 'plain' && variant !== 'onVideo' && { backgroundColor: colors.mutedAlt },
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      <Ionicons name={icon} size={size === 'sm' ? 18 : 22} color={V.fg} />
    </Pressable>
  );
}

// ── SearchField ──────────────────────────────────────────────────────────────
// TextField + magnifier + clear affordance. Extracted because Cameras had this
// assembled inline and Home now needs the identical control — two copies of a
// search box drift apart within one release.
export function SearchField({ value, onChangeText, placeholder = 'Search…', onSubmitEditing, style, accessibilityLabel }) {
  const { colors } = useTheme();
  return (
    <TextField
      icon="search"
      placeholder={placeholder}
      value={value}
      onChangeText={onChangeText}
      returnKeyType="search"
      onSubmitEditing={onSubmitEditing}
      style={style}
      accessibilityLabel={accessibilityLabel || placeholder}
      right={value ? (
        <IconButton
          icon="close-circle" variant="plain" size="sm" color={colors.faint} hitSlop={10}
          onPress={() => onChangeText('')} accessibilityLabel="Clear search"
        />
      ) : null}
    />
  );
}

// ── Chip: inline filter ──────────────────────────────────────────────────────
// Only ONE chip in a row is ever selected, so the selected state takes a solid
// brand fill — it has to win against four unselected neighbours, and a soft
// tint loses that fight at a glance. Its label is onPrimary, NOT white: white
// on #F7983A is 2.21:1.
//
// `variant`:
//   soft   — muted fill, no lift. For chips that sit inside a busy screen
//            (Cameras) where a row of floating pills would compete with the
//            content under them.
//   raised — surface fill on its own shadow, for a chip row that IS the
//            screen's primary control (Alerts). Unselected labels go to `text`
//            rather than `sub`: on a white pill the whole row reads as a set of
//            buttons, and a grey label makes them look disabled.
export function Chip({ label, icon, selected, onPress, count, variant = 'soft', style }) {
  const { colors, type, shadow, brandShadow } = useTheme();
  const styles = useStyles(makeStyles);
  const raised = variant === 'raised';
  const fg = selected ? colors.onPrimary : (raised ? colors.text : colors.sub);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.select}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={count != null ? `${label}, ${count}` : label}
      style={({ pressed }) => [
        styles.chip,
        raised && styles.chipTall,
        raised
          ? [selected ? styles.chipRaisedOn : styles.chipRaisedOff, selected ? brandShadow : shadow(1)]
          : (selected ? styles.chipOn : styles.chipOff),
        pressed && !selected && { backgroundColor: colors.mutedAlt },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={14} color={fg} /> : null}
      <Text style={[type.caption, { color: fg }, selected && { fontFamily: fonts.semi }]}>
        {label}
      </Text>
      {count != null ? (
        // On the filled chip the counter can't also be brand-coloured, so it
        // darkens the fill instead of adding a third colour.
        <View style={[styles.chipCount, selected && styles.chipCountOn]}>
          <Text style={[type.badge, { fontSize: 10, color: fg }]}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ── SegmentedControl ─────────────────────────────────────────────────────────
// One implementation for what used to be three hand-rolled segmented rows
// (Profile stream quality, Profile appearance, Live Wall density). The moving
// part is a raised "thumb" on a muted track — the iOS/M3 idiom operators
// already read as "pick exactly one".
export function SegmentedControl({ options, value, onChange, style, accessibilityLabel, variant = 'thumb' }) {
  const { colors, type, shadow } = useTheme();
  const styles = useStyles(makeStyles);
  // 'filled' — BOTH segments are solid pills that split the width: brand fill
  // for the selected one, surface for the rest. No shared track, because a
  // track would make the unselected half read as empty space rather than as the
  // other half of a choice. For a top-level view switch, where the switch is
  // the point. The selected label uses onPrimary, NOT white — white on
  // #F7983A is 2.21:1.
  const filled = variant === 'filled';
  return (
    <View
      style={[styles.segment, filled && styles.segmentFilled, style]}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((o) => {
        const on = value === o.key;
        const fg = filled
          ? (on ? colors.onPrimary : colors.text)
          : (on ? colors.text : colors.faint);
        return (
          <Pressable
            key={o.key}
            onPress={() => { if (!on) { haptic.select(); onChange(o.key); } }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            style={[
              styles.segBtn,
              filled && styles.segBtnTall,
              filled
                ? (on ? styles.segBtnFilledOn : styles.segBtnFilledOff)
                : (on && [styles.segBtnOn, shadow(1)]),
            ]}
          >
            {o.icon ? <Ionicons name={o.icon} size={13} color={fg} /> : null}
            <Text style={[filled ? type.bodyMed : type.caption, { color: fg }, on && { fontFamily: fonts.semi }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── StatCard: one dashboard metric ───────────────────────────────────────────
// `tint` is a palette KEY so callers stay theme-agnostic.
export function StatCard({ icon, tint = 'primary', value, label, onPress, loading, style, accessibilityLabel }) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  const body = (
    <>
      {/* icon draws from the ink tier — it sits on its own soft background,
          where the vivid tone falls under 3:1 */}
      <View style={[styles.statIcon, { backgroundColor: colors[`${tint}Soft`] || colors.muted }]}>
        <Ionicons name={icon} size={16} color={colors[`${tint}Ink`] || colors[tint] || colors.primaryInk} />
      </View>
      {loading ? <Skeleton width={28} height={22} style={{ marginTop: 2 }} /> : <Txt t="statSm">{value}</Txt>}
      <Txt t="caption" c={colors.sub} numberOfLines={1}>{label}</Txt>
    </>
  );
  if (!onPress) return <View style={[styles.statCard, style]}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || `${value} ${label}`}
      style={({ pressed }) => [styles.statCard, pressed && { backgroundColor: colors.muted }, style]}
    >
      {body}
    </Pressable>
  );
}

// ── BottomSheet ──────────────────────────────────────────────────────────────
// One sheet for the whole app. Handles the four things every caller was
// re-implementing: scrim tap-to-close, the grab handle, safe-area bottom
// padding, and Android hardware back (via Modal's onRequestClose).
//
// `maxHeightRatio` caps the scrollable body so a long list can't push the sheet
// off the top of the screen. Content shorter than the cap keeps its own height.
export function BottomSheet({
  visible, onClose, title, right, children, footer,
  scrollable = false, maxHeightRatio = 0.6, accessibilityLabel,
}) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const body = scrollable
    ? <ScrollView style={{ maxHeight: height * maxHeightRatio }} showsVerticalScrollIndicator={false}>{children}</ScrollView>
    : children;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* scrim closes; the sheet swallows its own presses so a tap inside
          never bubbles up to the scrim */}
      <Pressable style={styles.sheetScrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}
          onPress={() => {}}
          accessibilityViewIsModal
          accessibilityLabel={accessibilityLabel || title}
        >
          <View style={styles.sheetHandle} />
          {title ? (
            <View style={styles.sheetHead}>
              <Txt t="title" style={{ flex: 1 }} numberOfLines={1}>{title}</Txt>
              {right}
            </View>
          ) : null}
          {body}
          {footer}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// A single tappable option inside a BottomSheet. `disabled` carries a `reason`
// rather than just greying out — a control that can't act should say why.
export function SheetAction({ icon, label, hint, onPress, disabled, reason, destructive }) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  const tint = destructive ? colors.criticalInk : colors.primaryInk;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onPressIn={disabled ? undefined : haptic.light}
      disabled={disabled}
      android_ripple={disabled ? undefined : { color: press.ripple }}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={disabled && reason ? `${label}. ${reason}` : label}
      style={({ pressed }) => [styles.sheetAction, pressed && { backgroundColor: colors.muted }]}
    >
      <View style={[styles.sheetActionIcon, { backgroundColor: disabled ? colors.muted : colors.primarySoft }]}>
        <Ionicons name={icon} size={19} color={disabled ? colors.faint : tint} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="bodyMed" c={disabled ? colors.faint : undefined}>{label}</Txt>
        {(disabled ? reason : hint) ? (
          <Txt t="caption" c={colors.faint} numberOfLines={2}>{disabled ? reason : hint}</Txt>
        ) : null}
      </View>
      {!disabled ? <Ionicons name="chevron-forward" size={16} color={colors.faint} /> : null}
    </Pressable>
  );
}

// ── SummaryCard: a headline metric with a qualifier under it ─────────────────
// Two numbers, not one: "128 cameras" answers a different question from
// "how many are up right now", and a dashboard that shows only one of them
// makes you open a screen to learn the other. `tint` is a palette KEY so
// callers stay theme-agnostic.
export function SummaryCard({
  icon, tint = 'primary', label, value, footLabel, footState,
  onPress, loading, style, accessibilityLabel,
}) {
  const { colors, press } = useTheme();
  const styles = useStyles(makeStyles);
  const body = (
    <>
      <View style={[styles.summaryIcon, { backgroundColor: colors[`${tint}Soft`] || colors.muted }]}>
        <Ionicons name={icon} size={15} color={colors[`${tint}Ink`] || colors[tint] || colors.primaryInk} />
      </View>
      <Txt t="caption" c={colors.sub} numberOfLines={1}>{label}</Txt>
      {loading
        ? <Skeleton width={38} height={26} style={{ marginTop: 2 }} />
        : <Txt t="statValue" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{value}</Txt>}
      {footLabel ? (
        <View style={styles.summaryFoot}>
          {footState ? <StatusDot state={footState} size={6} /> : null}
          <Txt t="caption" c={colors.sub} numberOfLines={1} style={{ flexShrink: 1 }}>{footLabel}</Txt>
        </View>
      ) : null}
    </>
  );
  if (!onPress) return <View style={[styles.summaryCard, style]}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={haptic.light}
      android_ripple={{ color: press.ripple }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || `${value} ${label}${footLabel ? `, ${footLabel}` : ''}`}
      style={({ pressed }) => [styles.summaryCard, pressed && { backgroundColor: colors.muted }, style]}
    >
      {body}
    </Pressable>
  );
}

// ── ScreenHeader ─────────────────────────────────────────────────────────────
// Back · title/subtitle · trailing slot. Live View, Live Wall and Playback each
// hand-rolled this exact row; they now share one, so the three headerless
// screens can never drift in height or padding again.
export function ScreenHeader({ title, subtitle, onBack, right, style }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screenHeader, { paddingTop: insets.top + spacing.sm }, style]}>
      {onBack ? <IconButton icon="chevron-back" variant="plain" onPress={onBack} accessibilityLabel="Back" /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt t="title" numberOfLines={1}>{title}</Txt>
        {/* a string subtitle is styled for you; anything else (e.g. Live View's
            status dot + word) renders as given */}
        {typeof subtitle === 'string'
          ? <Txt t="caption" c={colors.sub} numberOfLines={1}>{subtitle}</Txt>
          : subtitle || null}
      </View>
      {right}
    </View>
  );
}

// ── TextField ────────────────────────────────────────────────────────────────
// `invalid` tints the border + leading icon so validation reads at the field,
// not only as a paragraph under the form. `inputRef` reaches the inner
// TextInput — passed explicitly rather than relying on React 19 forwarding a
// bare `ref` through the prop spread, which is easy to break by accident.
export function TextField({ icon, right, style, invalid, inputRef, ...props }) {
  const { colors, isDark } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.field, invalid && styles.fieldInvalid, style]}>
      {icon ? <Ionicons name={icon} size={17} color={invalid ? colors.criticalInk : colors.faint} /> : null}
      <TextInput
        ref={inputRef}
        style={styles.fieldInput}
        placeholderTextColor={colors.faint}
        // Drives the iOS keyboard's own appearance — without it a dark app
        // still summons a bright white keyboard.
        keyboardAppearance={isDark ? 'dark' : 'light'}
        selectionColor={colors.primary}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
      />
      {right}
    </View>
  );
}

// Inline validation message for a single field. Announced on change so screen
// readers hear the reason instead of just landing on a red box.
export function FieldError({ children }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  if (!children) return null;
  return (
    <View style={styles.fieldError} accessibilityLiveRegion="polite">
      <Ionicons name="alert-circle" size={13} color={colors.criticalInk} />
      <Txt t="caption" c={colors.criticalInk} style={{ flex: 1 }}>{children}</Txt>
    </View>
  );
}

// ── Avatar ───────────────────────────────────────────────────────────────────
export function Avatar({ name, size = 40, onPress }) {
  const { colors, type } = useTheme();
  const styles = useStyles(makeStyles);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const inner = (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[type.h2, { color: colors.onPrimary, fontSize: size * 0.4, lineHeight: size * 0.5 }]}>{initial}</Text>
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} onPressIn={haptic.light} accessibilityRole="button" accessibilityLabel="Open account">
      {inner}
    </Pressable>
  );
}

// ── EmptyState ───────────────────────────────────────────────────────────────
// `compact` trims the full-screen top padding so the same component can sit
// inside a section on a scrolling page (Home) as well as fill a list.
export function EmptyState({ icon = 'ellipse-outline', title, subtitle, action, onAction, compact }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.empty, compact && styles.emptyCompact]}>
      <View style={styles.emptyIcon}><Ionicons name={icon} size={28} color={colors.faint} /></View>
      <Txt t="title" style={{ textAlign: 'center' }}>{title}</Txt>
      {subtitle ? <Txt t="sub" c={colors.sub} style={{ textAlign: 'center' }}>{subtitle}</Txt> : null}
      {action ? <Button title={action} variant="secondary" onPress={onAction} fullWidth={false} size="sm" style={{ marginTop: spacing.md, paddingHorizontal: spacing.xl }} /> : null}
    </View>
  );
}

// ── Skeleton (shared pulse) ──────────────────────────────────────────────────
const pulse = new Animated.Value(0.5);
let pulseStarted = false;
function startPulse() {
  if (pulseStarted) return;
  pulseStarted = true;
  Animated.loop(
    Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
    ])
  ).start();
}
export function Skeleton({ width, height, r = radius.sm, style }) {
  const { colors } = useTheme();
  useEffect(() => { startPulse(); }, []);
  // `skeleton`, not `muted`: on the dark palette muted sits too close to bg to
  // register as a pulsing placeholder.
  return <Animated.View style={[{ width, height, borderRadius: r, backgroundColor: colors.skeleton, opacity: pulse }, style]} />;
}

export function CameraTileSkeleton() {
  return (
    <View style={{ flex: 1 }}>
      <Skeleton width="100%" height={undefined} r={radius.lg} style={{ aspectRatio: 16 / 9 }} />
      <Skeleton width="70%" height={13} style={{ marginTop: 8 }} />
      <Skeleton width="45%" height={11} style={{ marginTop: 6 }} />
    </View>
  );
}
export function StatTileSkeleton() {
  return (
    <Card variant="raised" padding="none" style={{ flex: 1, alignItems: 'center', paddingVertical: spacing.lg, gap: 8 }}>
      <Skeleton width={38} height={38} r={radius.chip} />
      <Skeleton width={34} height={22} />
      <Skeleton width={46} height={10} />
    </Card>
  );
}
export function AlertRowSkeleton() {
  return (
    <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center', paddingVertical: spacing.md }}>
      <Skeleton width={42} height={42} r={radius.chip} />
      <View style={{ flex: 1, gap: 7 }}>
        <Skeleton width="55%" height={13} />
        <Skeleton width="80%" height={11} />
      </View>
    </View>
  );
}

// ── OfflineBanner (device network state) ─────────────────────────────────────
export function OfflineBanner() {
  const { colors, type } = useTheme();
  const styles = useStyles(makeStyles);
  const net = useNetInfo();
  const insets = useSafeAreaInsets();
  const offline = net.isConnected === false; // undefined at boot = unknown, don't flash
  if (!offline) return null;
  return (
    <View style={[styles.offline, { paddingTop: insets.top + 6 }]} accessibilityLiveRegion="polite">
      <Ionicons name="cloud-offline-outline" size={15} color={colors.onVideo} />
      <Text style={[type.caption, { color: colors.onVideo }]}>You’re offline — showing last known data</Text>
    </View>
  );
}

export function Divider() {
  const styles = useStyles(makeStyles);
  return <View style={styles.divider} />;
}

const makeStyles = ({ colors, type }) => StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg },
  cardBorder: { borderWidth: 1, borderColor: colors.border },
  // empty on light (shadow alone carries the lift), a hairline on dark
  cardElevatedEdge: colors.elevatedBorder
    ? { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.elevatedBorder }
    : {},
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xl, marginBottom: spacing.md },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 8, paddingHorizontal: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4, alignSelf: 'flex-start' },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },

  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    minHeight: 34, paddingHorizontal: spacing.md,
    borderRadius: radius.pill, borderWidth: 1,
  },
  chipOff: { backgroundColor: colors.muted, borderColor: 'transparent' },
  chipOn:  { backgroundColor: colors.primary, borderColor: colors.primary },
  // raised: the lift comes from the shadow, so the border goes transparent —
  // except on dark, where the shadow has nothing to darken (same relaxation as
  // Card's `cardElevatedEdge`).
  chipTall:       { minHeight: 42, paddingHorizontal: spacing.lg },
  chipRaisedOff:  { backgroundColor: colors.surface, borderColor: colors.elevatedBorder || 'transparent' },
  chipRaisedOn:   { backgroundColor: colors.primary, borderColor: 'transparent' },
  chipCount: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    backgroundColor: colors.mutedAlt, alignItems: 'center', justifyContent: 'center',
  },
  chipCountOn: { backgroundColor: 'rgba(0,0,0,0.16)' },

  segment: { flexDirection: 'row', backgroundColor: colors.muted, borderRadius: radius.pill, padding: 3, gap: 2 },
  segBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.pill, minHeight: 30,
  },
  segBtnOn: { backgroundColor: colors.surface },
  // no track and no padding — the two pills ARE the control
  segmentFilled: { backgroundColor: 'transparent', padding: 0, gap: spacing.sm },
  // flex:1 so the segments split the width evenly instead of hugging their text
  segBtnTall: { flex: 1, minHeight: 44, borderRadius: radius.md },
  segBtnFilledOn:  { backgroundColor: colors.primary },
  segBtnFilledOff: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },

  statCard: {
    flex: 1, alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.md, paddingHorizontal: spacing.xs,
  },
  statIcon: { width: 32, height: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },

  summaryCard: {
    flex: 1, minWidth: 0,
    backgroundColor: colors.card, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: spacing.xs,
  },
  summaryIcon: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  summaryFoot: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },

  screenHeader: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },

  sheetScrim: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet,
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
  },
  sheetHandle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.mutedAlt, marginBottom: spacing.md },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  sheetAction: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 60, borderRadius: radius.md, paddingHorizontal: spacing.sm },
  sheetActionIcon: { width: 40, height: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.md, paddingHorizontal: spacing.lg },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48,
    backgroundColor: colors.muted, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 13,
  },
  fieldInvalid: { borderColor: colors.critical, backgroundColor: colors.critSoft },
  fieldInput: { flex: 1, ...type.body, paddingVertical: 12 },
  fieldError: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.xs + 2 },
  avatar: { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingTop: 64, paddingHorizontal: 40, gap: 8 },
  emptyCompact: { paddingTop: spacing.xl, paddingBottom: spacing.md, paddingHorizontal: spacing.xl },
  emptyIcon: { width: 56, height: 56, borderRadius: radius.lg, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  offline: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: colors.alarm, paddingBottom: 7, paddingHorizontal: 12,
  },
  divider: { height: 1, backgroundColor: colors.border },
});
