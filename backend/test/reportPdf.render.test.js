/**
 * reportPdf — the layout renders hand-built page models without a database.
 *
 * Covers: the page arithmetic (1 summary + the sections' pages), that the PDF
 * is well-formed with fonts embedded, a stills table and a plain table, the
 * vocabulary the report prints, and the bbox re-projection that decides
 * whether a detection box is drawn on a still.
 */
const layout = require('../src/services/reportPdf/layout');
const V = require('../src/services/reportPdf/vocabulary');
const { mapBox } = require('../src/services/reportPdf/geometry');
const { sampleModel, cameraHealthModel } = require('./helpers/reportPdfSample');

const TZ = '+05:30';

function countPages(pdf) {
  const text = pdf.toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![s])/g) || []).length;
}

const records = (n, thumb = true) => ({
  kind: 'records',
  heading: 'x',
  columns: thumb ? [{ key: 'a', w: 10, cell: 'thumb' }] : [{ key: 'a', w: 10 }],
  rows: new Array(n).fill({}),
});
const evidence = (n) => ({ kind: 'evidence', heading: 'e', entries: new Array(n).fill({}) });

describe('reportPdf layout', () => {
  test('page arithmetic (A4 portrait): 15 rows a page with stills, 23 without, 3 evidence cards a page', () => {
    expect(layout.pageCounts({ sections: [records(0), evidence(0)] }).total).toBe(2);
    expect(layout.pageCounts({ sections: [records(15)] }).total).toBe(2);
    expect(layout.pageCounts({ sections: [records(16), evidence(4)] })).toMatchObject({ total: 5 });
    expect(layout.pageCounts({ sections: [records(23, false)] }).total).toBe(2);
    expect(layout.pageCounts({ sections: [records(24, false)] }).total).toBe(3);
    const pc = layout.pageCounts({ sections: [records(35), evidence(1)] });
    expect(pc.plan.map((p) => [p.start, p.end])).toEqual([[2, 4], [5, 5]]);
  });

  test('renders the AI Event Report with the expected page count and embedded Inter', async () => {
    const m = await sampleModel({ rows: 23, evidence: 3 });
    const pdf = await layout.render(m);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(countPages(pdf)).toBe(1 + 2 + 1);
    expect(pdf.toString('latin1')).toMatch(/Inter/);
    expect(pdf.length).toBeGreaterThan(20000);
  }, 30000);

  test('an empty period still produces a two-page document', async () => {
    const m = await sampleModel({ rows: 0, evidence: 0 });
    m.blocks[0].items = []; m.blocks[1].rows = []; m.blocks[1].rest = null;
    const pdf = await layout.render(m);
    expect(countPages(pdf)).toBe(2);
  }, 30000);

  test('renders a plain status table (Camera Health) at 23 rows a page, no evidence', async () => {
    const m = cameraHealthModel({ cameras: 18 });
    const pdf = await layout.render(m);
    expect(countPages(pdf)).toBe(1 + 1);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  }, 30000);
});

describe('reportPdf vocabulary', () => {
  test('labels known detectors and prettifies unknown slugs', () => {
    expect(V.eventLabel('zone.intrusion')).toBe('Restricted Area Entry');
    expect(V.eventLabel('person.alert')).toBe('Face Watchlist Match');
    expect(V.eventLabel('helmet.missing')).toBe('Helmet Missing');
    expect(V.eventLabel('')).toBe('AI Event');
  });

  test('formats times in the report offset, not the server zone', () => {
    const t = new Date('2026-09-18T10:33:12.000Z'); // 16:03:12 IST
    expect(V.fmtDate(t, TZ)).toBe('18 Sep 2026');
    expect(V.fmtTime(t, TZ)).toBe('04:03:12 PM');
    expect(V.fmtOsd(t, TZ)).toBe('18-09-2026 16:03:12');
    expect(V.fmtTime(new Date('2026-09-18T18:30:00.000Z'), TZ, { seconds: false })).toBe('12:00 AM');
    expect(V.tzLabel(TZ)).toBe('IST · UTC +05:30');
    expect(V.tzLabel('+04:00')).toBe('GST · UTC +04:00');
  });

  test('report code is stable, typed and dated', () => {
    const row = { id: '4f2a9c1e-0000-4000-8000-000000000000', type: 'ai_events', createdAt: '2026-09-18T12:42:00.000Z' };
    expect(V.reportCode(row, TZ)).toBe('DR-AER-20260918-4F2A');
    expect(V.reportCode({ ...row, type: 'camera_health' }, TZ)).toBe('DR-CHR-20260918-4F2A');
  });

  test('severity words follow the product: critical=High, warning=Medium, info=Info (grey)', () => {
    expect(V.severityOf('critical').label).toBe('High');
    expect(V.severityOf('warning').label).toBe('Medium');
    expect(V.severityOf('info').label).toBe('Info');
    expect(V.severityOf(undefined).label).toBe('Info');
    expect(V.pct(0.923)).toBe('92%');
    expect(V.pct(87)).toBe('87%');
    expect(V.pct(null)).toBeNull();
  });

  test('event detail names the zone, the person or the count', () => {
    expect(V.eventDetail({ eventType: 'person.alert', payload: { matchedName: 'Vikram Sethi', role: 'blacklist' } })).toBe('Vikram Sethi · Watchlist');
    expect(V.eventDetail({ eventType: 'zone.intrusion', payload: { zoneName: 'Loading Bay' } })).toBe('Zone: Loading Bay');
    // The zone guard reuses matchedName as a dedup subject ("1 person"): it is
    // printed as a count, never flagged as a watchlist identity.
    expect(V.eventDetail({ eventType: 'zone.intrusion', payload: { zoneName: 'Loading Bay', matchedName: '1 person', role: 'blacklist' } })).toBe('Zone: Loading Bay · 1 person');
    expect(V.isFaceEvent('zone.intrusion')).toBe(false);
    expect(V.isFaceEvent('person.alert')).toBe(true);
    expect(V.isPersonSubject({ eventType: 'zone.intrusion', payload: { personId: 'zone:72506631', matchedName: '1 person', zoneName: 'Loading Bay' } })).toBe(false);
    expect(V.isPersonSubject({ eventType: 'person.alert', payload: { personId: 'p-1', matchedName: 'Vikram Sethi' } })).toBe(true);
    expect(V.eventDetail({ eventType: 'occupancy.threshold', payload: { count: 62, capacity: 60 } })).toBe('62 of 60 capacity');
    expect(V.eventDetail({ eventType: 'occupancy.threshold', payload: { matchedName: '5 people (limit 3)', count: 5, capacity: 3 } })).toBe('5 people (limit 3)');
    expect(V.eventDetail({ payload: {} })).toBeNull();
  });
});

describe('reportPdf geometry — bbox re-projection', () => {
  test('a full-frame box lands inside the letterboxed output', () => {
    const box = mapBox([640, 360, 704, 468], 1280, 720, 168, 95);
    expect(box).not.toBeNull();
    const [x, y, w, h] = box;
    expect(x).toBeCloseTo(0.5, 2);
    expect(w).toBeCloseTo(0.05, 2);
    expect(y).toBeGreaterThan(0.49); expect(h).toBeGreaterThan(0.1);
  });

  test('normalised boxes are accepted', () => {
    expect(mapBox([0.1, 0.1, 0.3, 0.5], 1280, 720, 880, 495)).not.toBeNull();
  });

  test('a box that cannot belong to this image is dropped', () => {
    expect(mapBox([640, 360, 704, 468], 200, 300, 168, 95)).toBeNull();   // face crop, full-frame box
    expect(mapBox([0, 0, 1280, 720], 1280, 720, 168, 95)).toBeNull();     // whole frame
    expect(mapBox(null, 1280, 720, 168, 95)).toBeNull();
    expect(mapBox([1, 2], 1280, 720, 168, 95)).toBeNull();
  });
});
