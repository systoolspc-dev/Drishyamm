jest.mock('../src/utils/digestAuth', () => ({ digestRequest: jest.fn() }));

const { digestRequest } = require('../src/utils/digestAuth');
const s = require('../src/services/nvrRecordingSearch.service');

const item = (start, end, type = 'timing') => `
  <searchMatchItem>
    <sourceID>{0000}</sourceID>
    <trackID>101</trackID>
    <timeSpan><startTime>${start}</startTime><endTime>${end}</endTime></timeSpan>
    <mediaSegmentDescriptor><contentType>video</contentType><codecType>H.265</codecType></mediaSegmentDescriptor>
    <metadataMatches><metadataDescriptor>recordType.meta.hikvision.com/${type}</metadataDescriptor></metadataMatches>
  </searchMatchItem>`;

const result = (status, items) => `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <searchID>{abc}</searchID>
  <responseStatus>true</responseStatus>
  <responseStatusStrg>${status}</responseStatusStrg>
  <numOfMatches>${items.length}</numOfMatches>
  <matchList>${items.join('')}</matchList>
</CMSearchResult>`;

const T = (hms) => Date.parse(`2026-09-11T${hms}Z`);

describe('Hikvision ISAPI recording search - request', () => {
  test('channel N searches track N01 over the window in UTC Z, with ISAPI\'s own "Postion" spelling', () => {
    const xml = s.buildSearchXml({ searchId: 'x', trackId: 301, start: T('00:00:00'), end: T('23:59:59'), position: 100 });
    expect(xml).toContain('<trackList><trackID>301</trackID></trackList>');
    expect(xml).toContain('<startTime>2026-09-11T00:00:00Z</startTime>');
    expect(xml).toContain('<endTime>2026-09-11T23:59:59Z</endTime>');
    expect(xml).toContain('<searchResultPostion>100</searchResultPostion>');
  });
});

describe('Hikvision ISAPI recording search - response parsing', () => {
  test('reads each match as a span with its record type', () => {
    const { status, segments } = s.parseSearchResult(result('OK', [
      item('2026-09-11T10:00:00Z', '2026-09-11T10:20:00Z'),
      item('2026-09-11T10:25:00Z', '2026-09-11T10:26:00Z', 'motion'),
      item('2026-09-11T10:30:00Z', '2026-09-11T10:31:00Z', 'alarm'),
    ]));
    expect(status).toBe('OK');
    expect(segments).toEqual([
      { start: T('10:00:00'), end: T('10:20:00'), kind: 'continuous' },
      { start: T('10:25:00'), end: T('10:26:00'), kind: 'motion' },
      { start: T('10:30:00'), end: T('10:31:00'), kind: 'alarm' },
    ]);
  });

  test('a time without an offset is read as UTC, the same convention as the playback URL', () => {
    expect(s.parseIsapiTime('2026-09-11T10:00:00')).toBe(T('10:00:00'));
    expect(s.parseIsapiTime('2026-09-11T15:30:00+05:30')).toBe(T('10:00:00'));
  });

  test('skips malformed or zero-length spans instead of failing the whole day', () => {
    const { segments } = s.parseSearchResult(result('OK', [
      item('garbage', '2026-09-11T10:20:00Z'),
      item('2026-09-11T10:20:00Z', '2026-09-11T10:20:00Z'),
      item('2026-09-11T11:00:00Z', '2026-09-11T11:05:00Z'),
    ]));
    expect(segments).toHaveLength(1);
  });

  test('"NO MATCHES" is an empty day, not an error', () => {
    expect(s.parseSearchResult(result('NO MATCHES', []))).toEqual({ status: 'NO MATCHES', segments: [] });
  });

  test('record types: motion and alarm families, everything else is continuous', () => {
    expect(s.classifyRecordType('recordType.meta.hikvision.com/VMD')).toBe('motion');
    expect(s.classifyRecordType('recordType.meta.hikvision.com/motionOrAlarm')).toBe('alarm');
    expect(s.classifyRecordType('recordType.meta.hikvision.com/lineDetection')).toBe('alarm');
    expect(s.classifyRecordType('recordType.meta.hikvision.com/timing')).toBe('continuous');
    expect(s.classifyRecordType(null)).toBe('continuous');
  });
});

describe('mergeSegments', () => {
  test('joins touching files of the same kind, keeps different kinds apart', () => {
    const merged = s.mergeSegments([
      { start: T('10:20:00'), end: T('10:40:00'), kind: 'continuous' },
      { start: T('10:00:00'), end: T('10:20:01'), kind: 'continuous' },
      { start: T('10:40:01'), end: T('10:41:00'), kind: 'motion' },
      { start: T('11:00:00'), end: T('11:10:00'), kind: 'continuous' },
    ]);
    expect(merged).toEqual([
      { start: T('10:00:00'), end: T('10:40:00'), kind: 'continuous' },
      { start: T('10:40:01'), end: T('10:41:00'), kind: 'motion' },
      { start: T('11:00:00'), end: T('11:10:00'), kind: 'continuous' },
    ]);
  });
});

describe('searchRecordings', () => {
  beforeEach(() => digestRequest.mockReset());

  const base = { host: '10.0.0.5', httpPort: 80, username: 'u', password: 'p', channel: 1 };

  test('a non-Hikvision NVR is reported as unsupported without touching the network', async () => {
    const r = await s.searchRecordings({ ...base, deviceType: 'dahua', start: T('00:00:00'), end: T('23:59:59') });
    expect(r.supported).toBe(false);
    expect(r.segments).toEqual([]);
    expect(digestRequest).not.toHaveBeenCalled();
  });

  test('follows "MORE" pages, clips spans to the window and merges them', async () => {
    digestRequest
      .mockResolvedValueOnce({ status: 200, data: result('MORE', [item('2026-09-10T23:50:00Z', '2026-09-11T00:10:00Z')]) })
      .mockResolvedValueOnce({ status: 200, data: result('OK', [item('2026-09-11T00:10:00Z', '2026-09-11T00:30:00Z')]) });
    const r = await s.searchRecordings({ ...base, deviceType: 'hikvision', start: T('00:00:00'), end: T('23:59:59') });
    expect(digestRequest).toHaveBeenCalledTimes(2);
    expect(digestRequest.mock.calls[1][0].data).toContain('<searchResultPostion>1</searchResultPostion>');
    expect(r).toEqual({ supported: true, segments: [{ start: T('00:00:00'), end: T('00:30:00'), kind: 'continuous' }] });
  });

  test('bad credentials and unreachable NVRs surface as readable errors', async () => {
    digestRequest.mockResolvedValueOnce({ status: 401, data: '' });
    await expect(s.searchRecordings({ ...base, deviceType: 'hikvision', start: T('01:00:00'), end: T('02:00:00') }))
      .rejects.toThrow('rejected the saved credentials');

    digestRequest.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await expect(s.searchRecordings({ ...base, deviceType: 'hikvision', start: T('03:00:00'), end: T('04:00:00') }))
      .rejects.toThrow("Couldn't reach the NVR's web interface at 10.0.0.5:80 (ECONNABORTED)");
  });
});
