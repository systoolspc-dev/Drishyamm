import api from './api';

// ── Local demo account (DEV builds only, opt-in) ─────────────────────────────
// Lets the UI be explored with no auth backend. Off unless BOTH
// VITE_DEMO_EMAIL and VITE_DEMO_PASSWORD are set in frontend/.env — the
// compose stack runs the Vite dev server, so a hard-coded account would be
// live on every deployment. The `import.meta.env.DEV` guard strips it from
// production bundles. Tokens are prefixed "demo." so api.js knows never to
// force-logout this session.
const DEMO_EMAIL = (import.meta.env.VITE_DEMO_EMAIL || '').trim().toLowerCase();
const DEMO_ACCOUNT = {
  email: DEMO_EMAIL,
  password: import.meta.env.VITE_DEMO_PASSWORD || '',
  user: {
    id: 'demo-user',
    name: 'Demo User',
    email: DEMO_EMAIL,
    role: 'owner',
  },
};

function demoLogin() {
  const data = {
    token: `demo.${btoa(JSON.stringify({ sub: DEMO_ACCOUNT.user.id, iat: Date.now() }))}`,
    refreshToken: 'demo.refresh',
    user: DEMO_ACCOUNT.user,
  };
  localStorage.setItem('auth_token', data.token);
  localStorage.setItem('refresh_token', data.refreshToken);
  localStorage.setItem('user', JSON.stringify(data.user));
  return data;
}

export const authService = {
  register: async (userData) => {
    const response = await api.post('/auth/register', userData);
    return response.data;
  },

  login: async (email, password) => {
    if (
      import.meta.env.DEV &&
      DEMO_ACCOUNT.email && DEMO_ACCOUNT.password &&
      email.trim().toLowerCase() === DEMO_ACCOUNT.email &&
      password === DEMO_ACCOUNT.password
    ) {
      return demoLogin();
    }

    const response = await api.post('/auth/login', { email, password });

    if (response.data.token) {
      localStorage.setItem('auth_token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
    }
    if (response.data.refreshToken) {
      localStorage.setItem('refresh_token', response.data.refreshToken);
    }
    if (response.data.user?.groupKey) {
      localStorage.setItem('group_key', response.data.user.groupKey);
    }

    return response.data;
  },

  logout: async () => {
    try {
      const refreshToken = localStorage.getItem('refresh_token');
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken }).catch(() => {});
      }
    } finally {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      localStorage.removeItem('group_key');
    }
  },

  getCurrentUser: () => {
    const user = localStorage.getItem('user');
    return user ? JSON.parse(user) : null;
  },

  isAuthenticated: () => {
    return !!localStorage.getItem('auth_token');
  },

  getToken: () => {
    return localStorage.getItem('auth_token');
  },

  getRefreshToken: () => {
    return localStorage.getItem('refresh_token');
  },

  forgotPassword: async (email) => {
    const response = await api.post('/auth/forgot-password', { email });
    return response.data;
  },

  resetPassword: async (token, password) => {
    const response = await api.post('/auth/reset-password', { token, password });
    return response.data;
  },

  updateProfile: async (data) => {
    const response = await api.put('/auth/profile', data);
    if (response.data.user) {
      localStorage.setItem('user', JSON.stringify(response.data.user));
    }
    return response.data;
  },

  changePassword: async (currentPassword, newPassword) => {
    const response = await api.put('/auth/change-password', { currentPassword, newPassword });
    return response.data;
  },
};
