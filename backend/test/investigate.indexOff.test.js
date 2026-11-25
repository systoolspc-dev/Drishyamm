// Every investigation endpoint, with the AI's search index switched off
// (INVESTIGATE_INDEX_ENABLED=false → the AI answers 404 "investigation index is
// not enabled"), and the failures around it.
//
// What must hold, endpoint by endpoint:
//   * index off → 503 with the one plain, public message (never "Internal
//     Server Error", never the AI's raw text, never a misleading "not found");
//   * a genuine 404 from the AI stays a 404 with its own meaning;
//   * any other upstream failure keeps its detail out of the browser.
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/utils/aiTenant', () => ({ aiAuthHeader: (u) => ({ Authorization: `Bearer jwt-for-${u.id}` }) }));
jest.mock('../src/models', () => ({
  Camera: {
    findAll: jest.fn(async ({ where }) => [
      { monitorId: 'm1', name: 'Gate 3', userId: 'u1' },
      { monitorId: 'm9', name: 'Other', userId: 'u2' },
    ].filter((c) => [].concat(where.userId).includes(c.userId))),
  },
}));
const mockAi = { post: jest.fn(), get: jest.fn() };
jest.mock('axios', () => ({ create: () => mockAi }));

const ctrl = require('../src/controllers/investigate.controller');
const askSvc = require('../src/services/ask');
const errorHandler = require('../src/middleware/errorHandler');
const { INDEX_OFF, isIndexOff, indexOffError } = require('../src/utils/aiIndexOff');

const USER = { id: 'u1' };
const FROM = '2026-11-24T09:00:00.000Z';
const TO = '2026-11-24T10:00:00.000Z';
const indexOff = { response: { status: 404, data: { detail: 'investigation index is not enabled' } } };

/** Run a handler; resolve with the response or the error passed to next(). */
const run = (handler, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    set(k, v) { this.headers[k] = v; return this; },
    send(b) { resolve({ status: this.statusCode, body: b }); return this; },
    end() { resolve({ status: this.statusCode }); return this; },
  };
  handler(req, res, (err) => resolve({ error: err }));
});

/** What the browser would receive for an error, after errorHandler. */
function browserSees(err) {
  const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  errorHandler(err, { method: 'GET', originalUrl: '/api/investigate', ip: '::1' }, res, () => {});
  return { status: res.statusCode, message: res.body.message };
}

// [name, handler, request, how it reaches the AI]
const ENDPOINTS = [
  ['search', ctrl.search, { body: { q: 'red top' } }, 'post'],
  ['search by photo', ctrl.searchPhoto[1], { body: {}, file: { buffer: Buffer.from('jpg'), originalname: 'p.jpg', mimetype: 'image/jpeg', size: 3 } }, 'post'],
  ['track', ctrl.getTrack, { params: { id: 't1' } }, 'get'],
  ['status', ctrl.status, {}, 'get'],
  ['track-at', ctrl.trackAt, { body: { camera_code: 'm1', ts: FROM, x: 500, y: 500 } }, 'post'],
  ['journey', ctrl.journey, { body: { track_id: 't1' } }, 'post'],
  ['review', ctrl.review, { body: { seed_track_id: 't1', track_id: 't2', verdict: 'confirmed' } }, 'post'],
  ['stitch', ctrl.stitch, { body: { sightings: [{ camera_id: 'm1', start: FROM, end: TO }] } }, 'post'],
  ['stitch status', ctrl.stitchStatus, { params: { jobId: 'j1' } }, 'get'],
  ['activity', ctrl.activity, { query: { monitorId: 'm1', from: FROM, to: TO } }, 'get'],
  ['companions', ctrl.companions, { params: { id: 't1' }, query: {} }, 'get'],
  ['synopsis', ctrl.synopsis, { body: { monitorId: 'm1', from: FROM, to: TO } }, 'post'],
  ['synopsis status', ctrl.synopsisStatus, { params: { jobId: 'j1' } }, 'get'],
  ['transcribe', ctrl.transcribe, { body: { monitorId: 'm1' } }, 'post'],
  ['transcribe status', ctrl.transcribeStatus, { params: { jobId: 'j1' } }, 'get'],
  ['speech search', ctrl.speechSearch, { query: { q: 'hello there' } }, 'get'],
  ['ask', ctrl.ask, { body: { question: 'How many people came to the gate today?' } }, 'ask'],
  ['summary', ctrl.summary, { query: { period: 'last_night' } }, 'summary'],
];

function failUpstream(via, err) {
  if (via === 'ask') return jest.spyOn(askSvc, 'ask').mockRejectedValue(err);
  if (via === 'summary') return jest.spyOn(askSvc, 'summary').mockRejectedValue(err);
  mockAi[via].mockRejectedValue(err);
  return null;
}

const request = (req) => ({ user: USER, headers: {}, params: {}, query: {}, body: {}, ...req });

beforeEach(() => {
  mockAi.post.mockReset();
  mockAi.get.mockReset();
  jest.restoreAllMocks();
});

describe('isIndexOff', () => {
  test('recognises the AI\'s answer in detail or error', () => {
    expect(isIndexOff(indexOff)).toBe(true);
    expect(isIndexOff({ response: { status: 404, data: { error: 'Investigation index is NOT enabled' } } })).toBe(true);
  });

  test.each([
    ['another 404', { response: { status: 404, data: { detail: 'track not found' } } }],
    ['the same words on a 500', { response: { status: 500, data: { detail: 'investigation index is not enabled' } } }],
    ['the same words on a 503', { response: { status: 503, data: { detail: 'investigation index is not enabled' } } }],
    ['a 404 with no body', { response: { status: 404 } }],
    ['a 404 with a non-string detail', { response: { status: 404, data: { detail: [{ msg: 'investigation index is not enabled' }] } } }],
    ['no response (network error)', { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }],
    ['null', null],
    ['undefined', undefined],
  ])('is false for %s', (_l, err) => {
    expect(isIndexOff(err)).toBe(false);
  });

  test('the message is plain and public, never the AI\'s words', () => {
    const e = indexOffError();
    expect(e.statusCode).toBe(503);
    expect(e.expose).toBe(true);
    expect(e.message).toBe(INDEX_OFF);
    expect(INDEX_OFF).not.toMatch(/not enabled|index_enabled|INVESTIGATE_/);
  });
});

describe.each(ENDPOINTS)('%s', (name, handler, req, via) => {
  test('index off → 503 with the plain message, all the way to the browser', async () => {
    failUpstream(via, indexOff);
    const { error } = await run(handler, request(req));
    expect(error).toBeDefined();
    expect(error).toMatchObject({ statusCode: 503, expose: true, message: INDEX_OFF });
    expect(browserSees(error)).toEqual({ status: 503, message: INDEX_OFF });
  });

  test('an upstream 500 with internal detail is hidden from the browser', async () => {
    failUpstream(via, { response: { status: 500, data: { detail: 'psycopg.OperationalError: connection to 10.0.0.5:5432 failed' } } });
    const { error } = await run(handler, request(req));
    expect(error).toBeDefined();
    expect(error.expose).not.toBe(true);
    const seen = browserSees(error);
    expect(seen.message).toBe('Internal Server Error');
    expect(seen.message).not.toMatch(/10\.0\.0\.5|psycopg/);
  });

  test('the AI not answering at all is a hidden 502, not a crash', async () => {
    failUpstream(via, Object.assign(new Error('connect ECONNREFUSED smart-cam-ai:8001'), { code: 'ECONNREFUSED' }));
    const { error } = await run(handler, request(req));
    expect(error).toBeDefined();
    expect(error.statusCode).toBe(502);
    expect(browserSees(error).message).toBe('Internal Server Error');
  });

  test('a timeout says "still starting up", publicly', async () => {
    failUpstream(via, Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
    const { error } = await run(handler, request(req));
    expect(error).toMatchObject({ statusCode: 503, expose: true });
    expect(browserSees(error).message).toMatch(/still starting up/);
  });

  if (!['search', 'search by photo'].includes(name)) {
    test('a genuine 404 stays a 404 (never reported as "index off")', async () => {
      failUpstream(via, { response: { status: 404, data: { detail: 'not found' } } });
      const { error } = await run(handler, request(req));
      expect(error).toBeDefined();
      expect(error.statusCode).toBe(404);
      expect(error.message).not.toBe(INDEX_OFF);
    });
  }
});

describe('handlers with their own "not found" wording keep it, but not for index off', () => {
  test('track-at: a real miss says nobody is at that spot', async () => {
    mockAi.post.mockRejectedValue({ response: { status: 404, data: { detail: 'no track at that point' } } });
    const { error } = await run(ctrl.trackAt, request({ body: { camera_code: 'm1', ts: FROM, x: 1, y: 1 } }));
    expect(error).toMatchObject({ statusCode: 404, message: expect.stringMatching(/No one indexed at that spot/) });
  });

  test('track-at: index off is NOT reported as "no one at that spot"', async () => {
    mockAi.post.mockRejectedValue(indexOff);
    const { error } = await run(ctrl.trackAt, request({ body: { camera_code: 'm1', ts: FROM, x: 1, y: 1 } }));
    expect(error.message).not.toMatch(/No one indexed/);
    expect(error.message).toBe(INDEX_OFF);
  });

  test('synopsis: a real "no activity" keeps the AI\'s explanation', async () => {
    mockAi.post.mockRejectedValue({ response: { status: 404, data: { detail: 'no activity in that range: nothing to put in a synopsis' } } });
    const { error } = await run(ctrl.synopsis, request({ body: { monitorId: 'm1', from: FROM, to: TO } }));
    expect(error).toMatchObject({ statusCode: 404, message: 'no activity in that range: nothing to put in a synopsis' });
  });

  test('transcribe: a real "no recordings" keeps the AI\'s explanation', async () => {
    mockAi.post.mockRejectedValue({ response: { status: 404, data: { detail: 'this server has no recordings of that camera for that time' } } });
    const { error } = await run(ctrl.transcribe, request({ body: { monitorId: 'm1', from: FROM, to: TO } }));
    expect(error).toMatchObject({ statusCode: 404, message: 'this server has no recordings of that camera for that time' });
  });
});

describe('validation and ownership still come before the AI', () => {
  test.each([
    ['track-at on a camera the caller does not have', ctrl.trackAt, { body: { camera_code: 'm9', ts: FROM, x: 1, y: 1 } }, 404],
    ['synopsis on a camera the caller does not have', ctrl.synopsis, { body: { monitorId: 'm9', from: FROM, to: TO } }, 404],
    ['transcribe on a camera the caller does not have', ctrl.transcribe, { body: { monitorId: 'm9' } }, 404],
    ['activity on a camera the caller does not have', ctrl.activity, { query: { monitorId: 'm9', from: FROM, to: TO } }, 404],
    ['search with an over-long query', ctrl.search, { body: { q: 'x'.repeat(301) } }, 400],
    ['speech search with one letter', ctrl.speechSearch, { query: { q: 'a' } }, 400],
    ['review without a verdict', ctrl.review, { body: { seed_track_id: 't1', track_id: 't2' } }, 400],
    ['ask with an empty question', ctrl.ask, { body: { question: '  ' } }, 400],
  ])('%s → %i, and the AI is never called', async (_l, handler, req, code) => {
    mockAi.post.mockRejectedValue(indexOff);
    mockAi.get.mockRejectedValue(indexOff);
    const askSpy = jest.spyOn(askSvc, 'ask');
    const { error } = await run(handler, request(req));
    expect(error.statusCode).toBe(code);
    expect(error.message).not.toBe(INDEX_OFF);
    expect(mockAi.post).not.toHaveBeenCalled();
    expect(mockAi.get).not.toHaveBeenCalled();
    expect(askSpy).not.toHaveBeenCalled();
  });
});

describe('media endpoints (an <img>/<video> src: status only, never a body)', () => {
  test.each([
    ['track crop', ctrl.getTrackCrop, { params: { id: 't1' } }],
    ['stitch video', ctrl.stitchVideo, { params: { jobId: 'j1' } }],
    ['synopsis video', ctrl.synopsisVideo, { params: { jobId: 'j1' } }],
  ])('%s with the index off answers 404 with no AI text', async (_l, handler, req) => {
    mockAi.get.mockResolvedValue({ status: 404, data: Buffer.from('{"detail":"investigation index is not enabled"}'), headers: {} });
    const out = await run(handler, request(req));
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(404);
    expect(JSON.stringify(out.body ?? '')).not.toMatch(/not enabled/);
  });
});

describe('the tenant is never taken from the browser, index on or off', () => {
  test('a body carrying tenant_id is not forwarded; the JWT header is', async () => {
    mockAi.post.mockRejectedValue(indexOff);
    await run(ctrl.search, request({ body: { q: 'red', tenant_id: 'someone-else', tid: 'someone-else' } }));
    const [, body, opts] = mockAi.post.mock.calls[0];
    expect(body).not.toHaveProperty('tenant_id');
    expect(body).not.toHaveProperty('tid');
    expect(opts.headers.Authorization).toBe('Bearer jwt-for-u1');
  });
});
