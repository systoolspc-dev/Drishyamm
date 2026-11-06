import { create } from 'zustand';
import { authService } from '../services/auth';
import { shinobiService } from '../services/shinobi';
import { connectSocket, disconnectSocket } from '../services/socket';

export const useAuthStore = create((set) => ({
  user: authService.getCurrentUser(),
  token: authService.getToken(),
  isAuthenticated: authService.isAuthenticated(),

  login: async (email, password) => {
    const data = await authService.login(email, password);
    set({
      user: data.user,
      token: data.token,
      isAuthenticated: true,
    });
    // Open the socket immediately so AI events / live overlays start flowing
    connectSocket();
    return data;
  },

  logout: async () => {
    await authService.logout();
    shinobiService.clearCache();
    disconnectSocket();
    set({ user: null, token: null, isAuthenticated: false });
  },

  register: async (userData) => {
    const data = await authService.register(userData);
    // Auto-login: persist tokens exactly like login does
    if (data.token) {
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
    }
    if (data.refreshToken) {
      localStorage.setItem('refresh_token', data.refreshToken);
    }
    if (data.user?.groupKey) {
      localStorage.setItem('group_key', data.user.groupKey);
    }
    set({ user: data.user, token: data.token, isAuthenticated: true });
    connectSocket();
    return data;
  },

  updateUser: (user) => {
    localStorage.setItem('user', JSON.stringify(user));
    set({ user });
  },

  updateProfile: async (data) => {
    const result = await authService.updateProfile(data);
    set({ user: result.user });
    return result;
  },

  changePassword: async (currentPassword, newPassword) => {
    return await authService.changePassword(currentPassword, newPassword);
  },

  forgotPassword: async (email) => {
    return await authService.forgotPassword(email);
  },

  resetPassword: async (token, password) => {
    return await authService.resetPassword(token, password);
  },
}));
