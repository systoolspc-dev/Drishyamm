const { createEngine, ENGINES } = require('../src/services/streaming');
const StreamingEngine = require('../src/services/streaming/StreamingEngine');

describe('streaming engine factory', () => {
  const orig = process.env.STREAMING_ENGINE;
  afterEach(() => {
    if (orig === undefined) delete process.env.STREAMING_ENGINE;
    else process.env.STREAMING_ENGINE = orig;
  });

  test('defaults to the mediamtx engine', () => {
    delete process.env.STREAMING_ENGINE;
    expect(createEngine().engineName).toBe('mediamtx');
  });

  test('is case-insensitive', () => {
    process.env.STREAMING_ENGINE = 'MediaMTX';
    expect(createEngine().engineName).toBe('mediamtx');
  });

  test('throws a clear error on an unknown engine', () => {
    process.env.STREAMING_ENGINE = 'bogus';
    expect(() => createEngine()).toThrow(/Unknown STREAMING_ENGINE 'bogus'/);
  });

  test('the ENGINES registry exposes mediamtx', () => {
    expect(typeof ENGINES.mediamtx).toBe('function');
  });
});

describe('StreamingEngine contract enforcement', () => {
  test('a sync contract method throws not-implemented', () => {
    expect(() => new StreamingEngine().pathName('x')).toThrow(/not implemented/);
  });

  test('an async contract method rejects with not-implemented', async () => {
    await expect(new StreamingEngine().addCamera('x')).rejects.toThrow(/not implemented/);
  });
});
