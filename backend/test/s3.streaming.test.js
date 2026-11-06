const fs = require('fs');
const os = require('os');
const path = require('node:path');
const crypto = require('node:crypto');
const s3 = require('../src/services/s3.service');

describe('s3.uploadRecordingFromFile — streams from disk (bounded memory)', () => {
  let tmp;
  afterEach(() => { if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); tmp = null; });

  test('a >5MB file is read in 5MB parts, in order, and reassembles byte-exact', async () => {
    tmp = path.join(os.tmpdir(), `rec-${crypto.randomBytes(6).toString('hex')}.bin`);
    const content = crypto.randomBytes(12 * 1024 * 1024); // 12MB → 3 parts (5+5+2)
    fs.writeFileSync(tmp, content);

    const parts = [];
    s3.client = {
      send: jest.fn(async (cmd) => {
        const n = cmd.constructor.name;
        if (n === 'CreateMultipartUploadCommand') return { UploadId: 'uid-1' };
        if (n === 'UploadPartCommand') {
          parts.push({ pn: cmd.input.PartNumber, body: Buffer.from(cmd.input.Body) });
          return { ETag: `etag-${cmd.input.PartNumber}` };
        }
        return {};
      }),
    };

    const key = await s3.uploadRecordingFromFile('u1', 'grp', 'cam', 'clip.mp4', tmp, 'video/mp4', '2026-07-05');
    expect(typeof key).toBe('string');

    expect(parts.map((p) => p.pn)).toEqual([1, 2, 3]);
    expect(parts[0].body.length).toBe(5 * 1024 * 1024);
    expect(parts[2].body.length).toBe(2 * 1024 * 1024);

    const reassembled = Buffer.concat(parts.sort((a, b) => a.pn - b.pn).map((p) => p.body));
    expect(reassembled.length).toBe(content.length);
    expect(reassembled.equals(content)).toBe(true); // exact bytes, correct offsets
  });

  test('a <5MB file uses a single PUT, not multipart', async () => {
    tmp = path.join(os.tmpdir(), `rec-${crypto.randomBytes(6).toString('hex')}.bin`);
    fs.writeFileSync(tmp, Buffer.alloc(2048, 7));

    const seen = [];
    s3.client = { send: jest.fn(async (cmd) => { seen.push(cmd.constructor.name); return {}; }) };

    await s3.uploadRecordingFromFile('u1', 'grp', 'cam', 'small.mp4', tmp);
    expect(seen).toContain('PutObjectCommand');
    expect(seen).not.toContain('CreateMultipartUploadCommand');
  });

  test('a failed part aborts the multipart upload (no orphaned upload) and throws', async () => {
    tmp = path.join(os.tmpdir(), `rec-${crypto.randomBytes(6).toString('hex')}.bin`);
    fs.writeFileSync(tmp, crypto.randomBytes(6 * 1024 * 1024)); // 2 parts

    let aborted = false;
    s3.client = {
      send: jest.fn(async (cmd) => {
        const n = cmd.constructor.name;
        if (n === 'CreateMultipartUploadCommand') return { UploadId: 'uid-x' };
        if (n === 'UploadPartCommand') throw new Error('10pb part upload failed');
        if (n === 'AbortMultipartUploadCommand') { aborted = true; return {}; }
        return {};
      }),
    };

    await expect(s3.uploadRecordingFromFile('u1', 'grp', 'cam', 'clip.mp4', tmp)).rejects.toThrow();
    expect(aborted).toBe(true);
  }, 15000); // per-part retry backoff (2s+4s) exceeds the 5s default
});
