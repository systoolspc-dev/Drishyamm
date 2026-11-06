// AlarmBanner — the on-screen face of a ringing alarm. Sits above EVERYTHING
// (all tabs/screens) while the alarm loop sounds; it does not go away on its
// own — tapping STOP silences, tapping the body silences AND jumps to the
// Alarms tab. Pulsing icon so it reads as "ringing" even on mute.
import { useEffect, useRef } from 'react';
import { View, Pressable, StyleSheet, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAlarm } from '../lib/alarmStore';
import { navigationRef } from '../navigation/AppNavigator';
import { Txt, haptic } from './ui';
import { radius, spacing, useTheme, useStyles } from '../theme';

// The STOP pill is a fixed WHITE ground in both themes, so its label needs a
// fixed dark red too — the dark palette's criticalInk (#FF6B60) would only be
// 2.55:1 on white. 5.20:1.
const ALARM_INK = '#C8372C';

export default function AlarmBanner() {
  const { colors, shadow } = useTheme();
  const styles = useStyles(makeStyles);
  const active = useAlarm((s) => s.active);
  const silence = useAlarm((s) => s.silence);

  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 500, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const insets = useSafeAreaInsets();
  if (!active) return null;

  const openAlarms = () => {
    haptic.medium();
    silence();
    if (navigationRef.isReady()) navigationRef.navigate('Main', { screen: 'Alerts' });
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 6 }, shadow(3)]} accessibilityLiveRegion="assertive">
      <Pressable onPress={openAlarms} style={styles.body} accessibilityRole="button" accessibilityLabel={`${active.title}. Tap to open alarms`}>
        <Animated.View style={[styles.icon, { opacity: pulse }]}>
          <Ionicons name="warning" size={19} color="#fff" />
        </Animated.View>
        <View style={{ flex: 1 }}>
          <Txt t="bodyMed" c="#fff" numberOfLines={1} style={{ textTransform: 'capitalize' }}>{active.title}</Txt>
          {!!active.body && <Txt t="caption" c="rgba(255,255,255,0.85)" numberOfLines={1}>{active.body}</Txt>}
        </View>
      </Pressable>
      <Pressable
        onPress={() => { haptic.medium(); silence(); }}
        accessibilityRole="button"
        accessibilityLabel="Stop alarm"
        style={({ pressed }) => [styles.stop, pressed && { opacity: 0.8 }]}
      >
        <Txt t="bodyMed" c={ALARM_INK} style={{ fontSize: 13 }}>STOP</Txt>
      </Pressable>
    </View>
  );
}

// The banner sits on its own critical-red ground in both themes, so the white
// icon/text/STOP pill are fixed literals, not theme tokens.
const makeStyles = ({ colors }) => StyleSheet.create({
  wrap: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 200,
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.alarm, paddingBottom: spacing.md, paddingHorizontal: spacing.lg,
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  stop: { backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: 16, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
});
