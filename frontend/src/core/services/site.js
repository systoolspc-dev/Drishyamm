/**
 * site.js — REST client for Sites + Bulk Camera Import.
 */

import api from '@/core/services/api';

export const siteService = {
  list()                      { return api.get('/sites').then((r) => r.data); },
  get(id)                     { return api.get(`/sites/${id}`).then((r) => r.data); },
  create(payload)             { return api.post('/sites', payload).then((r) => r.data); },
  update(id, patch)           { return api.put(`/sites/${id}`, patch).then((r) => r.data); },
  remove(id)                  { return api.delete(`/sites/${id}`).then((r) => r.data); },
  archive(id)                 { return api.post(`/sites/${id}/archive`).then((r) => r.data); },
  restore(id)                 { return api.post(`/sites/${id}/restore`).then((r) => r.data); },

  // ── Bulk import ────────────────────────────────────────────────────────────
  /**
   * Preview a CSV without writing anything. Accepts either a File (uploaded)
   * or a raw csv string.
   */
  previewImport(siteId, fileOrText) {
    if (fileOrText instanceof File || fileOrText instanceof Blob) {
      const fd = new FormData();
      fd.append('file', fileOrText);
      return api.post(`/sites/${siteId}/import/preview`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }).then((r) => r.data);
    }
    return api.post(`/sites/${siteId}/import/preview`, { csv: String(fileOrText || '') })
      .then((r) => r.data);
  },

  commitImport(siteId, rows, dryRun = false) {
    return api.post(`/sites/${siteId}/import/commit`, { rows, dryRun })
      .then((r) => r.data);
  },

  templateUrl() {
    // Direct download via the auth header — easier to fetch as blob
    return `/sites/__/import/template`.replace('__', 'TEMPLATE');
  },

  async downloadTemplate() {
    // Pick any site id — endpoint is per-site only for routing reasons
    // but the CSV template doesn't actually depend on the site.
    const sites = await this.list();
    const id = sites?.data?.[0]?.id;
    const url = id ? `/sites/${id}/import/template` : null;
    if (!url) {
      // Fall back to a static template the UI can offer
      const blob = new Blob([
        'name,host,port,http_port,username,password,device_type,total_channels,location,latitude,longitude\n',
        'Office NVR,192.168.1.10,554,80,admin,admin,hikvision,16,Mumbai HQ,19.07,72.87\n',
      ], { type: 'text/csv' });
      return URL.createObjectURL(blob);
    }
    const res = await api.get(url, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },
};
