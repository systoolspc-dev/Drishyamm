// ─────────────────────────────────────────────────────────────────────────────
// Minimal ZIP writer — enough for the .xlsx workbook (which is a zip of XML
// parts) and the Federated report's archive. No dependency.
//
// Entries are deflated with the platform's CompressionStream('deflate-raw')
// when the browser has it, and stored as-is when it does not; both are valid
// ZIP methods, so every unzip tool and Excel reads either.
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // 'deflate-raw' unsupported → store
  }
}

// DOS date/time, which is what ZIP stores.
function dosStamp(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build a zip.
 * @param {{ name: string, data: string | Uint8Array | Blob }[]} files
 * @param {{ compress?: boolean, date?: Date }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function zipFiles(files, { compress = true, date = new Date() } = {}) {
  const enc = new TextEncoder();
  const { time, date: day } = dosStamp(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data)
      : f.data instanceof Uint8Array ? f.data
        : new Uint8Array(await f.data.arrayBuffer());
    const packed = compress ? await deflateRaw(raw) : null;
    const method = packed && packed.length < raw.length ? 8 : 0;
    const body = method === 8 ? packed : raw;
    const name = enc.encode(f.name);
    const crc = crc32(raw);

    // Local file header (30 bytes + name). Flag bit 11 = UTF-8 names.
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, body);

    // Central directory record (46 bytes + name).
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, day, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  all.forEach((b) => { out.set(b, p); p += b.length; });
  return out;
}
