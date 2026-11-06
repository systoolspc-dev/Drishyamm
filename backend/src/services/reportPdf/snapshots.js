'use strict';
/**
 * snapshots.js — evidence stills for the PDF, sized for paper.
 *
 * Snapshots live in two stores (the backend's S3 under `snapshot_key`, the
 * AI's MinIO under `payload.snapshotUri`); alertEngine.fetchAlertSnapshot()
 * already knows both. Full frames are far too big to embed a thousand times,
 * so each still is resized here to exactly what the layout prints — a 16:9
 * table thumbnail and, for evidence entries, a larger still — and the bounding
 * box is re-projected into that resized image.
 *
 * Fetching is bounded three ways so a slow object store can never turn a
 * download into a hung request: a concurrency cap, a wall-clock budget, and a
 * circuit breaker that stops asking after a run of failures. A still that
 * cannot be fetched prints as "No snapshot"; it never blocks the report.
 */

const sharp = require('sharp');
const logger = require('../../config/logger');
const { fetchAlertSnapshot } = require('../alertEngine');
const { mapBox } = require('./geometry');

const THUMB = { w: 168, h: 95 };   // 21 × 11.8 mm at ~200 dpi
const LARGE = { w: 880, h: 495 };  // 110 × 61.9 mm at ~200 dpi
const LETTERBOX = '#E2E8F0';

async function sized(buf, bbox, { w, h }, quality) {
  const img = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const out = await img
    .resize(w, h, { fit: 'contain', background: LETTERBOX })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return { buf: out, box: mapBox(bbox, meta.width, meta.height, w, h) };
}

class SnapshotStore {
  constructor({ concurrency = 6, maxFailures = 8, budgetMs = 45000, enabled = true, fetch = fetchAlertSnapshot } = {}) {
    this.concurrency = concurrency;
    this.maxFailures = maxFailures;
    this.deadline = Date.now() + budgetMs;
    this.enabled = enabled;
    this.fetch = fetch;
    this.failures = 0;
    this.tripped = false;
    this.items = new Map(); // event id → { thumb, thumbBox, large, largeBox }
    this.stats = { requested: 0, fetched: 0, missing: 0, skipped: 0 };
  }

  static hasSource(evt) {
    const uri = evt?.payload?.snapshotUri || evt?.payload?.snapshot_uri;
    return Boolean(evt?.snapshotKey || (uri && String(uri).startsWith('s3://')));
  }

  /**
   * @param {Array} events rows with { id, snapshotKey, payload, userId, bbox }
   * @param {Set<string>} largeIds ids that also need the evidence-size still
   */
  async load(events, largeIds = new Set()) {
    const todo = [];
    const seen = new Set();
    for (const e of events) {
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      if (!this.enabled || !SnapshotStore.hasSource(e)) { this.stats.skipped += 1; continue; }
      todo.push(e);
    }
    this.stats.requested = todo.length;

    let cursor = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const evt = todo[cursor];
        cursor += 1;
        if (this.tripped || Date.now() > this.deadline) { this.stats.skipped += 1; continue; }
        await this.one(evt, largeIds.has(evt.id));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, todo.length || 1) }, worker));

    if (this.tripped) {
      logger.warn('report.pdf snapshots: circuit tripped after repeated failures', this.stats);
    }
    return this.items;
  }

  async one(evt, wantLarge) {
    try {
      const raw = await this.fetch(evt);
      if (!raw) { this.miss(); return; }
      const thumb = await sized(raw, evt.bbox, THUMB, 70);
      const entry = { thumb: thumb.buf, thumbBox: thumb.box, large: null, largeBox: null };
      if (wantLarge) {
        const large = await sized(raw, evt.bbox, LARGE, 74);
        entry.large = large.buf;
        entry.largeBox = large.box;
      }
      this.items.set(evt.id, entry);
      this.failures = 0;
      this.stats.fetched += 1;
    } catch (err) {
      logger.debug('report.pdf snapshot failed', { id: evt.id, error: err.message });
      this.miss();
    }
  }

  miss() {
    this.stats.missing += 1;
    this.failures += 1;
    if (this.failures >= this.maxFailures) this.tripped = true;
  }

  get(id) { return this.items.get(id) || null; }
}

module.exports = { SnapshotStore, sized, THUMB, LARGE };
