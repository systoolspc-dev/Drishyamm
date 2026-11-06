// Branded toast renderers + a tiny helper. Kept theme-consistent (themed card,
// severity-coloured leading icon). Use notify.success/error/info(text).
//
// The toastConfig entries are RENDERED as components by react-native-toast-message,
// and the Toast host lives inside ThemeProvider — so Row can use hooks and a
// toast raised from anywhere in the app arrives wearing the active theme.
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { radius, spacing, useTheme, useStyles } from '../theme';

function Row({ icon, tint, soft, text1, text2 }) {
  const { colors, shadow } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.toast, shadow(2)]}>
      <View style={[styles.icon, { backgroundColor: colors[soft] }]}>
        <Ionicons name={icon} size={18} color={colors[tint]} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.t1} numberOfLines={1}>{text1}</Text>
        {text2 ? <Text style={styles.t2} numberOfLines={2}>{text2}</Text> : null}
      </View>
    </View>
  );
}

// Colours are passed as token NAMES, not values — these factories run at module
// scope where no theme exists yet; Row resolves them against the live palette.
export const toastConfig = {
  success: (p) => <Row icon="checkmark-circle"   tint="ok"       soft="okSoft"   {...p} />,
  error:   (p) => <Row icon="alert-circle"       tint="critical" soft="critSoft" {...p} />,
  info:    (p) => <Row icon="information-circle" tint="info"     soft="infoSoft" {...p} />,
};

export const notify = {
  success: (text1, text2) => Toast.show({ type: 'success', text1, text2, visibilityTime: 2500 }),
  error:   (text1, text2) => Toast.show({ type: 'error',   text1, text2, visibilityTime: 3000 }),
  info:    (text1, text2) => Toast.show({ type: 'info',    text1, text2, visibilityTime: 2500 }),
};

const makeStyles = ({ colors, type }) => StyleSheet.create({
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    width: '92%', backgroundColor: colors.surface,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.md, paddingHorizontal: spacing.md,
  },
  icon: { width: 34, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  t1: { ...type.bodyMed },
  t2: { ...type.sub, marginTop: 1 },
});
