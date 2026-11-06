// Login — email + password (server built in; Advanced reveals it). Themed.
//
// Validation runs on submit, then live once the user has tried once: the first
// attempt is never pre-emptively red, but corrections clear as they type.
// Field-level problems render at the field; server-side failures render BOTH
// inline (persistent, re-readable) and as a toast (immediate, categorised).
import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, KeyboardAvoidingView, Keyboard, Platform, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../lib/authStore';
import { login } from '../lib/api';
import { apiErrorMessage } from '../lib/client';
import { normalizeServerUrl, DEFAULT_SERVER_URL } from '../lib/config';
import { notify } from '../components/toast';
import { Card, Button, TextField, FieldError, IconButton, Txt, haptic } from '../components/ui';
import { radius, spacing, useTheme, useStyles } from '../theme';

// Breathing room kept between the focused field and the top of the keyboard.
const FOCUS_GAP = spacing.lg;

// Deliberately permissive: one @, a dotted domain, no whitespace. Stricter
// patterns reject valid addresses — the server stays the real authority.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Client-side floor only, to catch obvious typos before a round trip. Must stay
// <= the backend's real minimum or it locks out legitimate short passwords.
const MIN_PASSWORD = 6;

function validate({ email, password, server }) {
  const next = {};
  const mail = email.trim();
  if (!mail) next.email = 'Enter your email.';
  else if (!EMAIL_RE.test(mail)) next.email = 'Enter a valid email address.';

  if (!password) next.password = 'Enter your password.';
  else if (password.length < MIN_PASSWORD) next.password = `Password must be at least ${MIN_PASSWORD} characters.`;

  if (!normalizeServerUrl(server || DEFAULT_SERVER_URL)) next.server = 'Enter a valid server address.';
  return next;
}

// Toast headline per failure class, so "wrong password" never looks like
// "the box is down". The body always carries apiErrorMessage's detail.
function failureTitle(e) {
  if (e?.code === 'ECONNABORTED') return 'Server not responding';
  if (!e?.response) return 'Network error';
  const s = e.response.status;
  if (s === 401 || s === 403) return 'Login failed';
  if (s === 429) return 'Too many attempts';
  if (s >= 500) return 'Server unreachable';
  return 'Couldn’t sign in';
}

export default function LoginScreen() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const { serverUrl, setServerUrl, setSession } = useAuth();
  const [server, setServer]     = useState(serverUrl || DEFAULT_SERVER_URL);
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [errors, setErrors]     = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState('');

  const scrollRef  = useRef(null);
  const emailRef   = useRef(null);
  const pwRef      = useRef(null);
  const serverRef  = useRef(null);
  const focusedRef = useRef(null); // host instance of the field being edited
  const busyRef    = useRef(false); // guards re-entry from the keyboard "go" key

  // Scroll the field being edited clear of the keyboard. ScrollView exposes this
  // for exactly this purpose (see its onFocus docs): it measures the input and
  // scrolls the minimum amount needed, using keyboard metrics it tracks itself.
  // `true` = never pull content downward when the field is already visible.
  const revealFocusedField = useCallback(() => {
    const node = focusedRef.current;
    if (!node || !scrollRef.current) return;
    try { scrollRef.current.scrollResponderScrollNativeHandleToKeyboard(node, FOCUS_GAP, true); } catch {}
  }, []);

  // Android only reports the keyboard once it has finished animating in — after
  // onFocus has already run — so re-run the reveal when it actually appears.
  // Moving between fields while the keyboard is already up fires no show event,
  // which is why onFocus reveals as well.
  useEffect(() => {
    const sub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      revealFocusedField,
    );
    return () => sub.remove();
  }, [revealFocusedField]);

  // Live re-validation, but only after the first submit.
  useEffect(() => {
    if (submitted) setErrors(validate({ email, password, server }));
  }, [submitted, email, password, server]);

  // Accepts the host instance; falls back to the focus event's react tag, which
  // scrollResponderScrollNativeHandleToKeyboard also accepts.
  const onFieldFocus = (ref) => (e) => {
    focusedRef.current = ref.current ?? e?.target ?? null;
    revealFocusedField();
  };

  const focusFirstInvalid = (errs) => {
    if (errs.email) return emailRef.current?.focus();
    if (errs.password) return pwRef.current?.focus();
    if (errs.server) {
      setAdvanced(true);
      requestAnimationFrame(() => serverRef.current?.focus());
    }
  };

  const fail = (title, msg) => {
    setFormError(msg);
    notify.error(title, msg);
    busyRef.current = false;
    setBusy(false);
  };

  const onLogin = async () => {
    if (busyRef.current) return; // keyboard "go" can fire while the button is disabled
    Keyboard.dismiss();
    setSubmitted(true);
    setFormError('');

    const errs = validate({ email, password, server });
    setErrors(errs);
    if (Object.keys(errs).length) {
      haptic.light();
      focusFirstInvalid(errs);
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      await setServerUrl(normalizeServerUrl(server || DEFAULT_SERVER_URL));
      const data = await login(email.trim(), password);
      if (!data?.token) {
        return fail('Login failed', 'The server did not return a session token. Contact your administrator.');
      }
      // This flips the navigation tree and unmounts the screen — deliberately
      // no state updates after it, and no `finally` that would clear `busy`
      // on the way out.
      await setSession({ token: data.token, refresh: data.refreshToken, user: data.user });
    } catch (e) {
      fail(failureTitle(e), apiErrorMessage(e, 'Could not sign in'));
    }
  };

  const onForgotPassword = () => {
    haptic.light();
    notify.info('Forgot Password', 'Forgot Password functionality coming soon.');
  };

  const toggleAdvanced = () => {
    haptic.light();
    setAdvanced((v) => !v);
  };

  // Cheapest possible gate — presence, not format. Format errors still surface
  // through validate() on submit, so the button never blocks someone whose
  // address our regex disagrees with.
  const canSubmit = !!email.trim() && !!password;

  return (
    // `behavior` must be set on Android too: without it KeyboardAvoidingView
    // renders a plain View and does nothing at all. "padding" is self-correcting
    // — it measures its own laid-out frame, so if the window already resized
    // under the keyboard it adds ~0 and never double-compensates. The screen is
    // headerless (AppNavigator: headerShown false), so no keyboardVerticalOffset.
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior="padding">
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.wrap}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.inner}>
          {/* Brand. The logo mark ALONE — the wordmark and tagline that used to
              sit under it made three competing brand elements stacked above the
              form. The product name now lives in the welcome line, where it
              does a job instead of just being large. */}
          <View style={styles.brand}>
            <Image source={require('../../assets/images/drishyam-logo.svg')} style={styles.logoImg} contentFit="contain" />
          </View>

          <View style={styles.welcome}>
            <Txt t="display">Welcome back</Txt>
            <Txt t="body" c={colors.sub} style={{ marginTop: spacing.xs }}>
              Sign in to your Drishyam account
            </Txt>
          </View>

          <Card variant="flat" padding="lg" style={styles.formCard}>
            <Txt t="label" c={colors.sub} style={styles.labelFirst}>Email</Txt>
            <TextField
              inputRef={emailRef}
              onFocus={onFieldFocus(emailRef)}
              invalid={!!errors.email}
              icon="mail-outline"
              placeholder="you@company.com"
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => pwRef.current?.focus()}
              value={email}
              onChangeText={setEmail}
              editable={!busy}
              accessibilityLabel="Email"
            />
            <FieldError>{errors.email}</FieldError>

            <Txt t="label" c={colors.sub} style={styles.label}>Password</Txt>
            <TextField
              inputRef={pwRef}
              onFocus={onFieldFocus(pwRef)}
              invalid={!!errors.password}
              icon="lock-closed-outline"
              placeholder="••••••••"
              secureTextEntry={!showPw}
              autoComplete="password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={onLogin}
              value={password}
              onChangeText={setPassword}
              editable={!busy}
              accessibilityLabel="Password"
              right={
                <IconButton
                  icon={showPw ? 'eye-off-outline' : 'eye-outline'}
                  variant="plain"
                  size="sm"
                  color={colors.faint}
                  hitSlop={12}
                  onPress={() => { haptic.light(); setShowPw((v) => !v); }}
                  accessibilityLabel={showPw ? 'Hide password' : 'Show password'}
                />
              }
            />
            <FieldError>{errors.password}</FieldError>

            {advanced && (
              <>
                <Txt t="label" c={colors.sub} style={styles.label}>Server</Txt>
                <TextField
                  inputRef={serverRef}
                  onFocus={onFieldFocus(serverRef)}
                  invalid={!!errors.server}
                  icon="server-outline"
                  placeholder="192.168.1.50:5000"
                  keyboardType="url"
                  autoComplete="off"
                  returnKeyType="go"
                  onSubmitEditing={onLogin}
                  value={server}
                  onChangeText={setServer}
                  editable={!busy}
                  accessibilityLabel="Server address"
                />
                <FieldError>{errors.server}</FieldError>
              </>
            )}

            {!!formError && (
              <View style={styles.errorBox} accessibilityLiveRegion="polite">
                <Ionicons name="alert-circle" size={15} color={colors.criticalInk} />
                <Txt t="caption" c={colors.criticalInk} style={{ flex: 1 }}>{formError}</Txt>
              </View>
            )}

            <Button
              title="Sign in"
              loadingLabel="Signing in…"
              onPress={onLogin}
              loading={busy}
              // Disabled until both credentials are present, so the primary
              // action stops inviting a tap that can only fail validation.
              disabled={!canSubmit}
              style={{ marginTop: spacing.xl }}
            />

            {/* Forgot Password moved out from between the field and its error
                slot — it used to shift down whenever a validation message
                appeared, and it sat closer to the password field than the
                field's own error did. */}
            <Pressable
              onPress={onForgotPassword}
              hitSlop={10}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Forgot password"
              style={({ pressed }) => [styles.forgot, pressed && { opacity: 0.6 }]}
            >
              <Txt t="caption" c={colors.primaryInk}>Forgot password?</Txt>
            </Pressable>
          </Card>

          <Pressable
            onPress={toggleAdvanced}
            hitSlop={10}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ expanded: advanced }}
            style={({ pressed }) => [styles.advanced, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name={advanced ? 'chevron-up' : 'options-outline'} size={14} color={colors.sub} />
            <Txt t="caption" c={colors.sub}>{advanced ? 'Hide server settings' : 'Advanced · change server'}</Txt>
          </Pressable>

          <Txt t="caption" c={colors.faint} style={styles.footer}>
            Drishyam VMS · Secure, encrypted sign-in
          </Txt>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = ({ colors }) => StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  inner: { width: '100%', maxWidth: 440, alignSelf: 'center' },
  brand: { alignItems: 'center', marginBottom: spacing.xl },
  logoImg: { width: 108, height: 70 },
  welcome: { marginBottom: spacing.lg },
  // Flat + bordered, not raised: on a near-white page a shadowed card floating
  // over nothing reads as a modal. The border is enough to group the form.
  formCard: { backgroundColor: colors.surface },
  labelFirst: { marginBottom: spacing.sm },
  label: { marginTop: spacing.lg, marginBottom: spacing.sm },
  forgot: { alignSelf: 'center', marginTop: spacing.lg, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg, backgroundColor: colors.critSoft, borderRadius: radius.sm, padding: spacing.md },
  advanced: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: spacing.lg, paddingVertical: spacing.sm },
  footer: { textAlign: 'center', marginTop: spacing.xl },
});
