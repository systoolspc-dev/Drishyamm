/**
 * The camera table's column definitions — the single declaration the header
 * cells, the body cells, the column chooser, the sort comparator and every
 * export all read from. Adding a column is one entry in this array, and it
 * cannot end up in the export but missing from the chooser.
 *
 * `sort` returns the value to order BY — deliberately separate from how a
 * column is DRAWN. What a column shows ("1.1 Mbps") is not what it should
 * sort by (1_100_000); sorting the formatted strings is how tables end up
 * ordering 900 Kbps above 1.1 Mbps.
 *
 * `tier` is how the column behaves as the viewport narrows. The table shows
 * tier 1 at every width, adds tier 2 from `md` and tier 3 from `xl`; a chosen
 * column above the current tier is not dropped, it moves into the row's
 * expandable detail panel. That is what keeps the metric columns — bitrate,
 * errors, drops, codec, resolution — from pushing the table into a horizontal
 * scroll on a tablet while still leaving them one tap away.
 *
 *   1  identity and state: who this is, and whether it is working
 *   2  the operational read: where it is, how far behind, when it last spoke
 *   3  the diagnostics, for when tier 2 says something is wrong
 *
 * `help` is the one line the guide dialog shows for the column. It lives here
 * rather than in the dialog so a column cannot be added to the table and left
 * unexplained — and so the explanation describes what this page actually
 * renders, not what the field is called in the payload.
 *
 * Lives apart from HealthTable.jsx because a module that exports both
 * components and constants breaks React Fast Refresh.
 */
import {
  bucketMeta,
  bucketOf,
  fmtBps,
  fmtDuration,
  isStreaming,
  severityOf,
} from './health-vocabulary';

export const COLUMNS = [
  {
    id: 'camera', label: 'Camera', locked: true, tier: 1,
    help: 'The name given to the feed, with its unique stream ID underneath.',
    sort: (c) => String(c.name || '').toLowerCase(),
  },
  {
    id: 'location', label: 'Site / Location', tier: 2,
    help: 'The physical site and camera group the camera is installed in.',
    sort: (c) => `${c.siteName || ''} ${c.groupName || ''}`.toLowerCase(),
  },
  {
    id: 'status', label: 'Status', tier: 1,
    help: 'What the stream engine reports right now — Online, Unstable, Offline or Needs setup.',
    sort: severityOf,
  },
  {
    id: 'delay', label: 'Delay', tier: 2,
    help: 'End-to-end stream latency: how far behind live the feed runs. Under 80 ms is smooth, 80–200 ms is noticeable, above 200 ms will stall. A camera sending no video shows a dash rather than 0 ms.',
    sort: (c) => (isStreaming(c) ? Number(c.jitterMs) || 0 : -1),
  },
  {
    id: 'bitrate', label: 'Bitrate', tier: 3,
    help: 'The rate video is arriving at, in Kbps or Mbps. A sudden drop usually means the camera has reduced quality or lost frames.',
    sort: (c) => Number(c.bpsIn || c.meanBps) || 0,
  },
  {
    id: 'lastUpdate', label: 'Last Update', tier: 2,
    help: 'When this camera last reported in. Today shows a clock time; anything older carries its date.',
    sort: (c) => (c.lastUpdate ? Date.parse(c.lastUpdate) : 0),
  },
  // Off by default. Every one of these is already in the health payload — the
  // chooser exposes what the page has rather than promising data we'd have to
  // go and invent.
  {
    id: 'viewers', label: 'Viewers', optional: true, tier: 3,
    help: 'How many clients are watching this feed right now.',
    sort: (c) => Number(c.readers) || 0,
  },
  {
    id: 'errors', label: 'Errors', optional: true, tier: 3,
    help: 'Decoding and connection errors the engine is logging, per second. Anything above zero is worth looking at.',
    sort: (c) => Number(c.fieRate) || 0,
  },
  {
    id: 'drops', label: 'Drops 24h', optional: true, tier: 3,
    help: 'How many times the stream has dropped and reconnected in the last 24 hours. A camera that is up now but drops nightly shows it here.',
    sort: (c) => Number(c.flapCount) || 0,
  },
  {
    id: 'codec', label: 'Codec', optional: true, tier: 3,
    help: 'The video encoding the camera sends, such as H.264 or H.265.',
    sort: (c) => String(c.codec || ''),
  },
  {
    id: 'resolution', label: 'Resolution', optional: true, tier: 3,
    help: 'The frame size of the incoming video, such as 1920x1080.',
    sort: (c) => String(c.resolution || ''),
  },
  {
    id: 'uptime', label: 'Uptime', optional: true, tier: 3,
    help: 'How long the current stream has run without a break. It resets whenever the camera reconnects.',
    sort: (c) => Number(c.readSinceSec) || 0,
  },
];

export const DEFAULT_COLUMNS = COLUMNS.filter((c) => !c.optional).map((c) => c.id);
export const PAGE_SIZES = [10, 25, 50, 100];

/** The text a column puts in a CSV cell or a PDF table cell — never JSX. */
export function csvValue(camera, columnId) {
  switch (columnId) {
    case 'camera': return `${camera.name || ''} (${camera.monitorId || ''})`;
    case 'location': return [camera.siteName, camera.groupName].filter(Boolean).join(' / ');
    case 'status': return bucketMeta(bucketOf(camera)).label;
    case 'delay': return isStreaming(camera) ? `${Math.round(Number(camera.jitterMs) || 0)} ms` : '';
    case 'bitrate': {
      const bps = Number(camera.bpsIn || camera.meanBps) || 0;
      return bps > 0 ? fmtBps(bps) : '';
    }
    case 'lastUpdate': return camera.lastUpdate ? new Date(camera.lastUpdate).toISOString() : '';
    case 'viewers': return String(Number(camera.readers) || 0);
    case 'errors': return String(Number(camera.fieRate) || 0);
    case 'drops': return String(Number(camera.flapCount) || 0);
    case 'codec': return camera.codec || '';
    case 'resolution': return camera.resolution || '';
    case 'uptime': return camera.readSinceSec != null ? fmtDuration(camera.readSinceSec) : '';
    default: return '';
  }
}
