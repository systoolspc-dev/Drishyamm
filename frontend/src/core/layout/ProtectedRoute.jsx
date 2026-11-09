import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/core/store/authStore';
import { routeAllowed } from '@/core/nav/entitlements';
import api from '@/core/services/api';
import { useStreamPrewarm } from '@/core/hooks/useStreamPrewarm';

// The user object is read from localStorage at login, so a feature an admin
// switches off (or on) in the admin console would otherwise only reach this
// browser at the next login. Re-read the account's switches from /auth/me on
// entry and whenever the tab regains focus, at most once a minute. Shared
// across every ProtectedRoute instance, hence module scope.
const REFRESH_MS = 60_000;
let lastRefresh = 0;
let inflight = null;

function refreshEntitlements() {
  const token = useAuthStore.getState().token;
  if (!token || String(token).startsWith('demo.')) return; // local demo login has no backend
  if (inflight || Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();
  inflight = api.get('/auth/me')
    .then(({ data }) => {
      const fresh = data?.user;
      const current = useAuthStore.getState().user;
      if (!fresh || !current) return;
      const next = { ...current, aiEnabled: fresh.aiEnabled, features: fresh.features ?? null };
      if (next.aiEnabled !== current.aiEnabled
        || JSON.stringify(next.features) !== JSON.stringify(current.features ?? null)) {
        useAuthStore.getState().updateUser(next);
      }
    })
    .catch(() => { /* offline or logged out — keep what we have */ })
    .finally(() => { inflight = null; });
}

export default function ProtectedRoute({ children }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const { pathname } = useLocation();
  // Logged in → keep the user's camera streams warm so tiles open instantly.
  useStreamPrewarm(isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    refreshEntitlements();
    const onFocus = () => refreshEntitlements();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // A page whose feature is switched off for this account is not reachable by
  // URL either — the sidebar hide alone would leave bookmarks working.
  if (!routeAllowed(pathname, user)) {
    return <Navigate to="/home" replace state={{ blockedFrom: pathname }} />;
  }

  return children;
}
