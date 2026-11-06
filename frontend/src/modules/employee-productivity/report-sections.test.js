/**
 * Tests for the Reports hub's export layer: the report sections, the zip
 * writer and the .xlsx writer.
 *
 * Runs on Node's built-in test runner (`npm test`). Everything here is pure or
 * uses web APIs Node ships (Blob, CompressionStream), so the files can be
 * built and read back without a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSection, complianceChecks, employeePayloadInput, federatedPayloadInput, sectionAvailable, sectionPayloadInput,
} from './report-sections.js';
import { crc32, zipFiles } from './zip.js';
import { buildXlsx } from './xlsx.js';
import {
  WEEKLY_REPORT, ZONE_COVERAGE, ZONE_HOURS_LABELS, ZONE_INCIDENTS, ZONE_LIVE, demoEvents,
} from './pages-data.js';

const rows = [...WEEKLY_REPORT].sort((a, b) => b.score - a.score);
const retail = {
  site: 'Store', storeLabel: 'Phoenix Mall — Pune', storeCode: '804', from: '2026-07-13', to: '2026-07-16',
  shiftLabel: 'All Shifts', generatedBy: 'Test', policy: [['Late after', '10:15']],
  rows, showImpact: true, healthScore: 88,
  zones: { hours: ZONE_HOURS_LABELS, coverage: ZONE_COVERAGE, live: ZONE_LIVE, incidents: ZONE_INCIDENTS },
  alerts: demoEvents('2026-07-16').filter((e) => e.kind === 'alert'),
  asOf: '2026-07-16',
};
const noZones = { ...retail, zones: null, showImpact: false };

// Read a zip back: { name → bytes }, inflating deflated entries.
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const crc = dv.getUint32(p + 14, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const body = bytes.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    const raw = method === 8
      ? new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())
      : body;
    assert.equal(crc32(raw), crc, `CRC of ${name}`);
    out[name] = raw;
    p += 30 + nameLen + size;
  }
  assert.equal(dv.getUint32(p, true), 0x02014b50, 'central directory follows the entries');
  return out;
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a zip round-trips, stored or deflated, with UTF-8 names', async () => {
  const text = 'Phoenix Mall — Pune\n'.repeat(200);
  for (const compress of [false, true]) {
    const files = await unzip(await zipFiles([{ name: 'a/räport.csv', data: text }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }], { compress }));
    assert.equal(new TextDecoder().decode(files['a/räport.csv']), text);
    assert.deepEqual([...files['b.bin']], [1, 2, 3]);
  }
});

test('the workbook has one tab per sheet, numeric cells, and heat-tinted percents', async () => {
  const blob = await buildXlsx([
    { name: 'Summary', rows: [{ cells: ['Title'], style: 'title' }] },
    { name: 'Coverage: Heat/map', heat: { good: 80, warn: 50 }, rows: [{ cells: ['Zone', '10:00'], style: 'head' }, { cells: ['Billing 3', '47%'] }, { cells: ['Entrance', 12] }] },
  ]);
  const files = await unzip(new Uint8Array(await blob.arrayBuffer()));
  const workbook = new TextDecoder().decode(files['xl/workbook.xml']);
  assert.match(workbook, /name="Summary"/);
  assert.match(workbook, /name="Coverage Heat map"/, 'illegal sheet-name characters are replaced');
  const sheet = new TextDecoder().decode(files['xl/worksheets/sheet2.xml']);
  assert.match(sheet, /<c r="B2" s="7"><v>0.47<\/v><\/c>/, '47% is a number, tinted bad');
  assert.match(sheet, /<c r="B3"><v>12<\/v><\/c>/);
  assert.match(sheet, /<c r="B1" t="inlineStr" s="1">/, 'header row keeps its text and style');
});

test('zones are offered only where the vertical tracks them', () => {
  assert.equal(sectionAvailable(retail, 'zones'), true);
  assert.equal(sectionAvailable(noZones, 'zones'), false);
  assert.equal(buildSection(noZones, 'zones'), null);
  assert.deepEqual(federatedPayloadInput(noZones, ['health', 'zones', 'violations']).sections, ['health', 'violations']);
});

test('the federated bundle leads with the executive summary and prints a shared table once', () => {
  const fed = federatedPayloadInput(retail, ['violations', 'zones', 'employees', 'health']);
  assert.deepEqual(fed.sections, ['health', 'employees', 'zones', 'violations']);
  assert.equal(fed.tables[0].id, 'compliance');
  assert.equal(fed.tables.filter((t) => t.id === 'zone-incidents').length, 1);
  assert.equal(fed.kpis[0].value, '88%');
  assert.equal(fed.countLine, `4 sections - ${fed.tables.length} tables`);
});

test('the employee report keeps the scorecard title and filename it always had', () => {
  const input = sectionPayloadInput(retail, 'employees');
  assert.equal(input.title, undefined);
  assert.equal(input.slug, undefined);
  assert.equal(input.tables[0].rows.length, rows.length);
  assert.equal(input.tables[0].columns.includes('Queue Breaches'), true);
  assert.equal(sectionPayloadInput(noZones, 'employees').tables[0].columns.includes('Queue Breaches'), false);
});

test('compliance checks and the alert log follow the data', () => {
  const checks = complianceChecks(retail);
  assert.equal(checks.length, 7);
  assert.equal(checks.find((c) => c.metric === 'Open zone incidents').met, ZONE_INCIDENTS.every((i) => !i.active));
  assert.equal(complianceChecks(noZones).length, 4);

  const log = buildSection(retail, 'violations').tables[0];
  assert.equal(log.rows.length, retail.alerts.length);
  assert.deepEqual(log.rows.map((r) => r[0]), [...log.rows.map((r) => r[0])].sort(), 'oldest first');
  assert.equal(log.rows.at(-1)[5], 'Critical');
});

test('an employee report ranks the person and lists their coaching flags', () => {
  const worst = rows.at(-1);
  const input = employeePayloadInput(retail, worst);
  assert.equal(input.kpis[1].value, `#${rows.length} of ${rows.length}`);
  assert.equal(input.tables[0].rows.length, 1);
  assert.ok(input.tables[1].rows.length >= 1);
});

test('a compliance check is judged on the value it displays', () => {
  for (const c of complianceChecks(retail)) {
    const m = /^>= (\d+)%$/.exec(c.target);
    if (m && c.actual.endsWith('%')) assert.equal(c.met, parseInt(c.actual, 10) >= Number(m[1]), c.metric);
  }
});
