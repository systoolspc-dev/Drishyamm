// ─────────────────────────────────────────────────────────────────────────────
// Live Zone Headcount exports — the header's Export menu.
//
// Every format goes through the module's branded report writer
// (report-document.js), so the file carries the Drishyam logo and header like
// every other Activity Monitoring export:
//   pdf   occupancy report: summary tiles, a compact zone table, peak by zone
//   xlsx  Summary (with logo) · Zones (every column) · Peak by zone
//   csv   header block, then the full zone table
//
// Every format reads the same rows (zoneExportRows), so the columns never drift.
// ─────────────────────────────────────────────────────────────────────────────

import { exportReportDocument } from '../report-document';
import { zoneExportRows, STATUS_LABEL } from './headcount-data';

/**
 * @param {'csv'|'pdf'|'xlsx'} format
 * @param {{ zones, peak, cards: { label, value, sub }[], words, siteId, siteLabel, date }} ctx
 */
export function exportHeadcount(format, ctx) {
  const { zones, peak, cards, words, siteId, siteLabel, date } = ctx;
  const full = zoneExportRows(zones, peak);

  // The PDF page is portrait A4, so it gets the seven columns a reader scans;
  // the spreadsheet formats keep every column.
  const zoneTable = format === 'pdf'
    ? {
      title: 'Zone occupancy',
      sheet: 'Zones',
      columns: ['Zone', words.area, 'Count', 'Capacity', 'Util.', 'Staff', 'Status'],
      rows: zones.map((z) => [
        z.label, z.area,
        z.mode === 'line' ? z.inside : z.count,
        z.capacity ?? '-',
        z.mode === 'line' || z.utilization == null ? '-' : `${z.utilization}%`,
        z.staffRequired ? `${z.staffOnPost}/${z.staffRequired}` : '-',
        STATUS_LABEL[z.status],
      ]),
    }
    : { title: 'Zone occupancy', sheet: 'Zones', columns: full.head, rows: full.body };

  const tables = [zoneTable];
  if (peak?.perZone?.length) {
    tables.push({
      title: 'Peak by zone',
      columns: ['Zone', words.area, 'Peak count', 'Peak at', 'Capacity', 'Peak utilization'],
      rows: peak.perZone.map((p) => [p.label, p.area, p.count, p.at, p.capacity ?? '', p.utilization == null ? '' : `${p.utilization}%`]),
    });
  }

  return exportReportDocument({
    title: 'Zone Occupancy Report',
    code: 'HDC',
    subtitle: 'Drishyam Activity Monitoring  -  Live zone headcount',
    details: [[words.site, siteLabel || '-'], ['Date', date], ['Zones', String(zones.length)]],
    kpis: cards.map((c) => ({ label: c.label, value: c.value, note: c.sub })),
    tables,
    countLine: `${zones.length} zone${zones.length === 1 ? '' : 's'}`,
    footer: 'Anonymous person counts; no identity data. Times IST. Confidential - for internal use.',
    filename: `live-headcount-${words.site.toLowerCase()}-${siteId || 'site'}-${date}`,
  }, format);
}
