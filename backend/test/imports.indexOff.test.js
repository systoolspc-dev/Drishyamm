// Imported videos (I-7) with the AI's search index switched off.
//
//   * (Re)indexing marks the import failed with the plain "switched off"
//     explanation, not the AI's raw words, so the Imports page tells the user why.
//   * Deleting is refused with that same explanation, and NOTHING is deleted:
//     the file and the row stay, because the AI still holds the video's people
//     and removing only half would leave them searchable with no video.
//   * Other failures keep their existing behaviour; a working AI deletes all.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/utils/aiTenant', () => ({ aiAuthHeader: (u) => ({ Authorization: `Bearer jwt-for-${u.id}` }) }));
const mockAi = { post: jest.fn(), get: jest.fn(), delete: jest.fn() };
jest.mock('axios', () => ({ create: () => mockAi }));
const mockRows = new Map();
jest.mock('../src/models', () => ({
  VideoImport: { findByPk: jest.fn(async (id) => mockRows.get(id) || null) },
}));

const ctrl = require('../src/controllers/imports.controller');
const { audit } = require('../src/utils/audit');
const errorHandler = require('../src/middleware/errorHandler');
const { INDEX_OFF } = require('../src/utils/aiIndexOff');

const indexOff = { response: { status: 404, data: { detail: 'investigation index is not enabled' } } };
const OWNER = { id: 'owner-1' };

const run = (handler, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
  };
  handler(req, res, (err) => resolve({ error: err }));
});

function browserSees(err) {
  const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  errorHandler(err, { method: 'DELETE', originalUrl: '/api/investigate/imports/x', ip: '::1' }, res, () => {});
  return { status: res.statusCode, message: res.body.message };
}

let dir;
function makeRow(extra = {}) {
  const folder = path.join(dir, 'imp-1');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'clip.mp4');
  fs.writeFileSync(file, 'video');
  const row = {
    id: 'imp-1', userId: 'owner-1', title: 'Phone clip', path: file, status: 'ready', progress: 1, tracks: 7,
    recordedStart: '2026-11-24T09:00:00Z', sha256: 'ab'.repeat(32), originalName: 'clip.mp4', size: 5,
    update: jest.fn(async function update(v) { Object.assign(this, v); return this; }),
    destroy: jest.fn(async () => {}),
    ...extra,
  };
  mockRows.set(row.id, row);
  return row;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imports-off-'));
  mockRows.clear();
  Object.values(mockAi).forEach((f) => f.mockReset());
  audit.mockClear();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('re-index with the index off', () => {
  test('marks the import failed with the plain explanation', async () => {
    const row = makeRow();
    mockAi.post.mockRejectedValue(indexOff);
    const out = await run(ctrl.reindex, { user: OWNER, params: { id: 'imp-1' } });
    expect(out.error).toBeUndefined();
    expect(row.status).toBe('failed');
    expect(row.error).toBe(`Could not start indexing: ${INDEX_OFF}`.slice(0, 500));
    expect(row.error).not.toMatch(/not enabled/);
    expect(out.body.import.status).toBe('failed');
  });

  test('another AI failure keeps the AI\'s explanation', async () => {
    const row = makeRow();
    mockAi.post.mockRejectedValue({ response: { status: 422, data: { detail: 'that file has no video stream' } } });
    await run(ctrl.reindex, { user: OWNER, params: { id: 'imp-1' } });
    expect(row.error).toBe('Could not start indexing: that file has no video stream');
  });

  test('a working AI starts indexing and clears the old error', async () => {
    const row = makeRow({ status: 'failed', error: 'old' });
    mockAi.post.mockResolvedValue({ data: { status: 'indexing', progress: 0 } });
    await run(ctrl.reindex, { user: OWNER, params: { id: 'imp-1' } });
    expect(row.status).toBe('indexing');
    expect(row.error).toBeNull();
    expect(mockAi.post.mock.calls[0][1]).toMatchObject({ import_id: 'imp-1', path: row.path });
  });

  test('someone else\'s import is a 404 and the AI is never asked', async () => {
    makeRow({ userId: 'owner-2' });
    const out = await run(ctrl.reindex, { user: OWNER, params: { id: 'imp-1' } });
    expect(out.error).toMatchObject({ statusCode: 404 });
    expect(mockAi.post).not.toHaveBeenCalled();
  });
});

describe('delete with the index off', () => {
  test('is refused with the plain explanation, publicly', async () => {
    makeRow();
    mockAi.delete.mockRejectedValue(indexOff);
    const { error } = await run(ctrl.remove, { user: OWNER, params: { id: 'imp-1' } });
    expect(error).toMatchObject({ statusCode: 503, expose: true, message: INDEX_OFF });
    expect(browserSees(error)).toEqual({ status: 503, message: INDEX_OFF });
  });

  test('deletes nothing: the file, its folder and the row all stay', async () => {
    const row = makeRow();
    mockAi.delete.mockRejectedValue(indexOff);
    await run(ctrl.remove, { user: OWNER, params: { id: 'imp-1' } });
    expect(fs.existsSync(row.path)).toBe(true);
    expect(row.destroy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalledWith('investigate.import_delete', expect.anything());
  });
});

describe('delete otherwise', () => {
  test('another AI failure is the existing public "try again" (502), nothing deleted', async () => {
    const row = makeRow();
    mockAi.delete.mockRejectedValue({ response: { status: 500, data: { detail: 'qdrant at 10.0.0.7 timed out' } } });
    const { error } = await run(ctrl.remove, { user: OWNER, params: { id: 'imp-1' } });
    expect(error).toMatchObject({ statusCode: 502, expose: true });
    const seen = browserSees(error);
    expect(seen.message).toBe('Could not remove the indexed people for this video. Try again.');
    expect(seen.message).not.toMatch(/10\.0\.0\.7|qdrant/);
    expect(fs.existsSync(row.path)).toBe(true);
    expect(row.destroy).not.toHaveBeenCalled();
  });

  test('with a working AI, the people, the file and the row all go, and it is audited', async () => {
    const row = makeRow();
    mockAi.delete.mockResolvedValue({ data: { deleted: 7 } });
    const out = await run(ctrl.remove, { user: OWNER, params: { id: 'imp-1' } });
    expect(out.body).toEqual({ success: true });
    expect(mockAi.delete.mock.calls[0][0]).toBe('/investigate/imports/imp-1');
    expect(fs.existsSync(path.dirname(row.path))).toBe(false);
    expect(row.destroy).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('investigate.import_delete', expect.objectContaining({ targetId: 'imp-1' }));
  });

  test('someone else\'s import is a 404 and nothing is touched', async () => {
    const row = makeRow({ userId: 'owner-2' });
    const { error } = await run(ctrl.remove, { user: OWNER, params: { id: 'imp-1' } });
    expect(error).toMatchObject({ statusCode: 404 });
    expect(mockAi.delete).not.toHaveBeenCalled();
    expect(fs.existsSync(row.path)).toBe(true);
  });

  test('a team member deletes their organisation\'s import (same owner)', async () => {
    makeRow();
    mockAi.delete.mockResolvedValue({ data: {} });
    const out = await run(ctrl.remove, { user: { id: 'member-9', parentUserId: 'owner-1' }, params: { id: 'imp-1' } });
    expect(out.body).toEqual({ success: true });
  });
});
