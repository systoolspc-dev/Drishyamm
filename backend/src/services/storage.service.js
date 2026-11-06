/**
 * storage.service.js
 *
 * Reports real on-disk storage stats — the backend container has the
 * /recordings volume bind-mounted from the host, so a single `df` + `du`
 * pair gives us the four numbers the dashboard's Storage card needs:
 *
 *   recordingsBytes   bytes currently consumed by Stream Service MP4 segments
 *   totalBytes        size of the filesystem holding /recordings
 *   freeBytes         free bytes on that filesystem
 *   usedBytes         total - free (whole-fs use, not just our share)
 *
 * Why this lives in its own service:
 *   - du can take a few seconds on a fat /recordings tree; we cache results
 *     for STORAGE_CACHE_MS so the dashboard's 30s polling doesn't keep
 *     spawning shell processes.
 *   - df is cheap (1–5 ms) and gives the only correct answer for "bytes free"
 *     — calling fs.statSync on the mount point or counting recursive sizes
 *     fails to account for sparse files / overlay filesystems.
 *
 * Optionally the service can also pull the S3 bucket usage (10 PB tier),
 * but that requires a list-objects sweep which on multi-million-object
 * buckets is expensive. We expose s3.skipped:true for now and let ops
 * enable it via STORAGE_S3_SUMMARY=true once they're sure the bucket size
 * is small enough.
 */

const { spawn } = require('node:child_process');
const path      = require('node:path');

const config  = require('../config/env');
const logger  = require('../config/logger');

const STORAGE_CACHE_MS = parseInt(process.env.STORAGE_CACHE_MS || '60000', 10);
const RECORDINGS_DIR   = config.streamService.recordingsDir || '/recordings';

let _cache = { at: 0, value: null };

// Run a shell command and return stdout (trimmed). Rejects on non-zero exit.
function run(cmd, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/** `du -sb <path>` returns "<bytes>\t<path>" — first column. */
async function recordingsBytes() {
  try {
    const out = await run('du', ['-sb', RECORDINGS_DIR], { timeoutMs: 15_000 });
    const n = parseInt(out.split(/\s+/)[0], 10);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    logger.debug('storage: du failed', { error: err.message });
    return 0;
  }
}

/**
 * `df -B1 <path>` returns headers then a single row. Columns:
 *   Filesystem 1B-blocks Used Available Use% Mounted on
 * We grab columns 2 and 4 (1-indexed: total, available).
 */
async function filesystemStats() {
  try {
    const out = await run('df', ['-B1', RECORDINGS_DIR], { timeoutMs: 5_000 });
    const lines = out.split('\n').filter(Boolean);
    if (lines.length < 2) throw new Error('df returned no data row');
    // Some df implementations wrap to the next line for long Filesystem names;
    // last line is always the data row.
    const cols = lines[lines.length - 1].split(/\s+/);
    // Find the first column that's a pure number — that's "1B-blocks"
    const firstNumIdx = cols.findIndex((c) => /^\d+$/.test(c));
    if (firstNumIdx < 0) throw new Error('df row has no numeric columns');
    const totalBytes  = parseInt(cols[firstNumIdx],     10);
    const usedBytes   = parseInt(cols[firstNumIdx + 1], 10);
    const freeBytes   = parseInt(cols[firstNumIdx + 2], 10);
    return {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
      usedBytes:  Number.isFinite(usedBytes)  ? usedBytes  : 0,
      freeBytes:  Number.isFinite(freeBytes)  ? freeBytes  : 0,
    };
  } catch (err) {
    logger.debug('storage: df failed', { error: err.message });
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  }
}

/**
 * Compute storage stats. Cached for STORAGE_CACHE_MS so the dashboard's
 * 30 s polling cadence doesn't keep spawning du processes.
 */
async function snapshot() {
  if (_cache.value && Date.now() - _cache.at < STORAGE_CACHE_MS) return _cache.value;

  const [recBytes, fs] = await Promise.all([recordingsBytes(), filesystemStats()]);
  const value = {
    recordingsDir:   path.resolve(RECORDINGS_DIR),
    recordingsBytes: recBytes,
    totalBytes:      fs.totalBytes,
    usedBytes:       fs.usedBytes,
    freeBytes:       fs.freeBytes,
    // Easy ratio for the progress bar: how much of the disk is used (whole-fs)
    usedRatio:       fs.totalBytes > 0 ? fs.usedBytes / fs.totalBytes : 0,
    // What proportion of the disk our recordings consume
    recordingsRatio: fs.totalBytes > 0 ? recBytes / fs.totalBytes : 0,
    capturedAt:      new Date().toISOString(),
    s3: { enabled: false, skipped: true, reason: 'expensive list-objects sweep' },
  };
  _cache = { at: Date.now(), value };
  return value;
}

module.exports = { snapshot };
