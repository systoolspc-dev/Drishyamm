// PushRegistrar — registers this device's Expo push token with the backend when
// logged in and tears it down on logout. Renders nothing; mounted once in App.
//
// The alerts themselves are produced server-side (alertEngine) and delivered as
// OS push even when the app is backgrounded/killed — this complements the
// foreground-only AlertWatcher. Everything is best-effort: a device without
// push (simulator, denied permission, no EAS projectId) just stays silent.
import { useEffect, useRef } from 'react';
import { useAuth } from '../lib/authStore';
import { initPushHandler, registerForPush, unregisterForPush } from '../lib/push';

export default function PushRegistrar() {
  const token = useAuth((s) => s.token);
  const expoToken = useRef(null);

  useEffect(() => { initPushHandler(); }, []);

  useEffect(() => {
    let cancelled = false;
    if (token) {
      registerForPush()
        .then((t) => { if (!cancelled) expoToken.current = t; })
        .catch(() => {});
    } else if (expoToken.current) {
      // Logged out — best-effort unregister (row rebinds on next login anyway).
      unregisterForPush(expoToken.current).catch(() => {});
      expoToken.current = null;
    }
    return () => { cancelled = true; };
  }, [token]);

  return null;
}
