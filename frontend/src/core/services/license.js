import api from './api';

export const licenseService = {
  /**
   * GET /subscription/license — fetch the current user's active enterprise
   * license with allocated quotas, enabled features, and live utilisation.
   *
   * Returns null when the user is on the legacy plan model (no License row).
   */
  getMyLicense: async () => {
    const { data } = await api.get('/subscription/license');
    return data?.license || null;
  },
};
