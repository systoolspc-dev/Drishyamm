import api from '@/core/services/api';

export const cameraHealthService = {
  list() {
    return api.get('/cameras/health').then((r) => r.data);
  },

  /**
   * Mail a Camera Status report that the BROWSER has already rendered (see
   * camera-health/health-export.js) to a list of addresses.
   *
   * The file rides as base64 rather than the server re-deriving the same
   * table from a second health query: what the operator saw on screen is
   * exactly what lands in the inbox, filters and chosen columns included.
   *
   * It posts under /notifications because that subsystem already owns the
   * SMTP account and the recipient list the dialog offers. An API that
   * predates this route answers 404/405 and the caller falls back to a local
   * download plus a pre-addressed draft.
   *
   * @param {{ recipients: string[], subject: string, message: string,
   *   reportId: string, summary: object,
   *   attachment: { filename: string, mime: string, base64: string } }} body
   */
  emailReport(body) {
    return api.post('/notifications/reports/send', body).then((r) => r.data);
  },
};
