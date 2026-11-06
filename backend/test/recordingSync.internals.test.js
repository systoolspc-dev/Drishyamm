const fs = require('fs');
const os = require('os');
const path = require('node:path');

describe('recordingSync: rememberUploaded — bounded FIFO cache', () => {
  let internals;
  beforeAll(() => {
    jest.resetModules();
    process.env.RECORDING_UPLOADED_CACHE_MAX = '5';
    internals = require('../src/services/recordingSync.service')._internals;
  });
  afterAll(() => { delete process.env.RECORDING_UPLOADED_CACHE_MAX; jest.resetModules(); });

  test('caps at the max and evicts the oldest (S3 exists() is the real guard)', () => {
    const { rememberUploaded, _uploaded } = internals;
    for (let i = 0; i < 8; i++) rememberUploaded(`key-${i}`);
    expect(_uploaded.size).toBe(5);
    expect(_uploaded.has('key-0')).toBe(false); // oldest evicted
    expect(_uploaded.has('key-2')).toBe(false);
    expect(_uploaded.has('key-7')).toBe(true);  // newest kept
  });
});

describe('recordingSync: sweepStaleTempFiles — reaps orphaned temps', () => {
  let internals, dir;
  beforeAll(() => { internals = require('../src/services/recordingSync.service')._internals; });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('deletes matching files older than the threshold; keeps fresh + non-matching', async () => {
    const { sweepStaleTempFiles, STALE_TEMP_MS } = internals;
    const oldF = path.join(dir, 'concat-old.txt');
    const freshF = path.join(dir, 'concat-fresh.txt');
    const otherF = path.join(dir, 'keep.mp4');
    for (const f of [oldF, freshF, otherF]) fs.writeFileSync(f, 'x');

    const past = (Date.now() - STALE_TEMP_MS - 60_000) / 1000; // seconds
    fs.utimesSync(oldF, past, past);

    await sweepStaleTempFiles(dir, (n) => n.startsWith('concat-') && n.endsWith('.txt'));

    expect(fs.existsSync(oldF)).toBe(false);   // old + matching → deleted
    expect(fs.existsSync(freshF)).toBe(true);  // fresh → kept (a live stitch might own it)
    expect(fs.existsSync(otherF)).toBe(true);  // non-matching → untouched
  });

  test('a missing directory is a no-op (never throws)', async () => {
    const { sweepStaleTempFiles } = internals;
    await expect(sweepStaleTempFiles(path.join(dir, 'does-not-exist'), () => true)).resolves.toBeUndefined();
  });
});
