/**
 * nvrRecordingSearch.service.js — ask the NVR WHERE it has footage.
 *
 * NVR playback (playback.controller.js) can replay any window, but on its own
 * it cannot say which parts of a day were actually recorded. The Playback
 * page's timeline draws that as its "Recording" track, so this asks the
 * device: Hikvision's ISAPI content search returns one match per recorded
 * file, with its time span and record type (continuous / motion / alarm).
 *
 * Only Hikvision is implemented. Dahua's mediaFileFind.cgi is a stateful
 * create -> findFile -> findNextFile -> close exchange; until that is built
 * the caller gets `supported: false`, and the timeline says so rather than
 * drawing an empty track that would read as "nothing was recorded".
 *
 * Times follow the playback URL's convention (fmtHik in vendors/index.js):
 * UTC with a Z suffix, so the bars line up with what the player replays.
 */
const crypto = require('node:crypto');
const { digestRequest } = require('../utils/digestAuth');
const vendors = require('./vendors');

const PAGE_SIZE = 100;
const MAX_PAGES = 10;             // 1000 files per query; a motion-recorded day stays well under
const CACHE_TTL_MS = 60 * 1000;   // the timeline re-asks on every camera/date switch
const CACHE_MAX = 500;
const cache = new Map();          // key -> { at, value }

class RecordingSearchError extends Error {
  constructor(message) {
    super(message);
    this.expose = true;           // safe to show the operator verbatim
  }
}

const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function buildSearchXml({ searchId, trackId, start, end, position = 0, maxResults = PAGE_SIZE }) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<CMSearchDescription>'
    + `<searchID>${searchId}</searchID>`
    + `<trackList><trackID>${trackId}</trackID></trackList>`
    + `<timeSpanList><timeSpan><startTime>${isoZ(start)}</startTime><endTime>${isoZ(end)}</endTime></timeSpan></timeSpanList>`
    + `<maxResults>${maxResults}</maxResults>`
    // "Postion" is ISAPI's own spelling; the corrected one is ignored.
    + `<searchResultPostion>${position}</searchResultPostion>`
    + '<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>'
    + '</CMSearchDescription>';
}

// Namespace-tolerant tag readers. `\b` after the name keeps <timeSpan> from
// matching <timeSpanList>.
const tagRe = (name, flags) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, flags);
function tagText(xml, name) {
  const m = tagRe(name, 'i').exec(String(xml || ''));
  return m ? m[1].trim() : null;
}
function tagBlocks(xml, name) {
  return [...String(xml || '').matchAll(tagRe(name, 'gi'))].map((m) => m[1]);
}

// A time with no offset is read as UTC, matching the Z we send.
function parseIsapiTime(s) {
  if (!s) return NaN;
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`);
}

function classifyRecordType(descriptor) {
  const d = String(descriptor || '').toLowerCase();
  if (/alarm|vca|smart|intrusion|linedetection|fielddetection/.test(d)) return 'alarm';
  if (/motion|vmd/.test(d)) return 'motion';
  return 'continuous';
}

function parseSearchResult(xml) {
  const status = (tagText(xml, 'responseStatusStrg') || '').toUpperCase();
  const segments = [];
  for (const item of tagBlocks(xml, 'searchMatchItem')) {
    const span = tagText(item, 'timeSpan') || '';
    const start = parseIsapiTime(tagText(span, 'startTime'));
    const end = parseIsapiTime(tagText(span, 'endTime'));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    segments.push({ start, end, kind: classifyRecordType(tagText(item, 'metadataDescriptor')) });
  }
  return { status, segments };
}

// NVRs split continuous recording into ~1 GB files, which would otherwise draw
// as dozens of touching bars with hairline gaps. Same-kind files that touch
// (within `gapMs`) become one span.
function mergeSegments(segments, gapMs = 2000) {
  const out = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && last.kind === s.kind && s.start - last.end <= gapMs) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

async function searchHikvision({ host, httpPort, username, password, channel, start, end }) {
  const url = `http://${host}:${httpPort || 80}/ISAPI/ContentMgmt/search`;
  const trackId = (channel || 1) * 100 + 1;
  const searchId = crypto.randomUUID();
  const found = [];
  let position = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let r;
    try {
      r = await digestRequest({
        url,
        method: 'POST',
        username,
        password,
        timeout: 8000,
        headers: { 'Content-Type': 'application/xml' },
        data: buildSearchXml({ searchId, trackId, start, end, position }),
      });
    } catch (err) {
      throw new RecordingSearchError(`Couldn't reach the NVR's web interface at ${host}:${httpPort || 80} (${err.code || err.message}).`);
    }
    if (r.status === 401) throw new RecordingSearchError('The NVR rejected the saved credentials for recording search.');
    if (r.status !== 200) throw new RecordingSearchError(`The NVR's recording search answered HTTP ${r.status}.`);
    const { status, segments } = parseSearchResult(r.data);
    found.push(...segments);
    if (status !== 'MORE' || segments.length === 0) break;
    position += segments.length;
  }
  return found;
}

/**
 * Recorded spans for one camera between `start` and `end` (epoch ms).
 * @returns {Promise<{ supported: boolean, reason?: string, segments: Array<{start:number,end:number,kind:string}> }>}
 */
async function searchRecordings({ deviceType, host, httpPort, username, password, channel, start, end, cacheKey }) {
  let vendor = null;
  try { vendor = vendors.canonicalId(deviceType); } catch { /* unknown vendor */ }
  if (vendor !== 'hikvision') {
    return { supported: false, reason: 'This NVR does not report where it has footage yet (Hikvision only).', segments: [] };
  }

  const key = cacheKey ? `${cacheKey}|${start}|${end}` : null;
  const hit = key && cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const raw = await searchHikvision({ host, httpPort, username, password, channel, start, end });
  // A file that began before the window (or ran past it) is clipped to it.
  const clipped = raw
    .map((s) => ({ ...s, start: Math.max(s.start, start), end: Math.min(s.end, end) }))
    .filter((s) => s.end > s.start);
  const value = { supported: true, segments: mergeSegments(clipped) };

  if (key) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return value;
}

module.exports = {
  searchRecordings,
  // exported for tests
  buildSearchXml,
  parseSearchResult,
  parseIsapiTime,
  classifyRecordType,
  mergeSegments,
  RecordingSearchError,
};
