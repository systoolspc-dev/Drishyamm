// Catches render/runtime errors so one bad subtree can't white-screen the app.
// Root usage shows the message on screen (so it's diagnosable in Expo Go);
// leaf usage (fallback={null}) silently drops a non-critical widget.
//
// Class component, so it reaches the theme via contextType rather than a hook.
// The context default is the light theme, so even an error thrown ABOVE
// ThemeProvider still renders a readable screen instead of crashing again.
import { Component } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { radius, spacing, ThemeContext } from '../theme';

export default class ErrorBoundary extends Component {
  static contextType = ThemeContext;

  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.log('[ErrorBoundary]', error?.message, info?.componentStack); }
  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if ('fallback' in this.props) return this.props.fallback;
    const e = this.state.error;
    const styles = makeStyles(this.context);
    return (
      <ScrollView contentContainerStyle={styles.wrap} style={{ backgroundColor: this.context.colors.bg }}>
        <View style={styles.card}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.msg}>{String(e?.message || e)}</Text>
          {!!e?.stack && <Text style={styles.stack}>{String(e.stack).split('\n').slice(0, 6).join('\n')}</Text>}
          <Pressable style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }
}

// Built per render rather than through useStyles() (no hooks in a class). This
// only ever runs on the error path, so the extra StyleSheet.create is free.
const makeStyles = ({ colors, type }) => StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, gap: spacing.md },
  title: { ...type.h2, color: colors.text },
  msg: { ...type.body, color: colors.criticalInk },
  stack: { fontFamily: 'Inter_400Regular', fontSize: 11, color: colors.sub, backgroundColor: colors.muted, padding: spacing.md, borderRadius: radius.sm },
  btn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginTop: spacing.sm },
  btnText: { ...type.bodyMed, color: colors.onPrimary },
});
