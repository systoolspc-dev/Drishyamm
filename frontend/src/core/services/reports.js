/**
 * reports.js — the report library API.
 *
 * Two shapes come back from the server and they are not the same thing:
 *   · a ROW   — the library listing (name, type, period, status, who made it)
 *   · a PAYLOAD — the report itself (coverage, summary, incidents, breakdown)
 *
 * `preview` builds a payload without keeping it, which is what a report type
 * card opens: you look first and only save what is worth saving.
 */

import api from '@/core/services/api';
import { API_URL } from '@/core/config/endpoints';

export const reportService = {
  list(params = {}) {
    return api.get('/reports', { params }).then((r) => r.data);
  },

  /** Generate without saving. Same payload shape as a saved report. */
  preview(params = {}) {
    return api.get('/reports/preview', { params }).then((r) => r.data.report);
  },

  get(id) {
    return api.get(`/reports/${id}`).then((r) => r.data);
  },

  create(body) {
    return api.post('/reports', body).then((r) => r.data);
  },

  /** Same question, today's data. `slide` moves the window to now. */
  rerun(id, { slide = true } = {}) {
    return api.post(`/reports/${id}/rerun`, { slide }).then((r) => r.data);
  },

  remove(id) {
    return api.delete(`/reports/${id}`).then((r) => r.data);
  },

  /**
   * Exports are fetched by the BROWSER, not by axios. The earlier version
   * fetched a blob and named it through `<a download>`; Edge's download
   * prompt ignores that name for blob: URLs and saves "25786bd8-09cd-…" with
   * no extension. A real request lets the server's Content-Disposition name
   * the file ("AI Event Report _ 14 Sept _ 21 Sept.pdf"), which every browser
   * and download manager honours.
   *
   * The JWT rides as ?token= because a navigation cannot carry an
   * Authorization header — the same convention the snapshot relay uses. The
   * request goes through a hidden iframe so an attachment downloads without
   * leaving the page, and a server error renders inside the invisible frame
   * instead of replacing the console.
   */
  downloadViaBrowser(pathWithQuery) {
    const token = localStorage.getItem('auth_token') || '';
    const sep = pathWithQuery.includes('?') ? '&' : '?';
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.src = `${API_URL}${pathWithQuery}${sep}token=${encodeURIComponent(token)}`;
    document.body.appendChild(frame);
    // A PDF with a thousand stills takes the server a few seconds to draw;
    // the frame stays until the download has certainly been handed off.
    setTimeout(() => frame.remove(), 120000);
    // Resolve after the button's "Building…" state has had a moment to show.
    return new Promise((resolve) => { setTimeout(resolve, 1500); });
  },

  downloadCsv(id) {
    return this.downloadViaBrowser(`/reports/${encodeURIComponent(id)}/csv`);
  },

  /** The printed report — summary, event records with stills, evidence. */
  downloadPdf(id) {
    return this.downloadViaBrowser(`/reports/${encodeURIComponent(id)}/pdf`);
  },

  /** The same document for a preview that has not been saved. */
  downloadPreviewPdf(params) {
    const qs = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== '') qs.set(k, String(v)); });
    return this.downloadViaBrowser(`/reports/preview/pdf?${qs.toString()}`);
  },

  csvUrl(id) {
    return `${API_URL}/reports/${id}/csv`;
  },
};

export default reportService;
