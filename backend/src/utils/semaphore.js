/**
 * semaphore.js — in-process concurrency limiter.
 *
 * Used to cap the number of simultaneous FFmpeg processes so a burst of
 * thumbnail requests (e.g. 50 clips loading at once) cannot exhaust server
 * memory or CPU.  Excess requests queue up and run as slots become free.
 *
 * Usage:
 *   const sem = createSemaphore(6);       // max 6 concurrent
 *   const release = await sem.acquire();  // waits if at capacity
 *   try {
 *     // ... do work ...
 *   } finally {
 *     release();                          // always release, even on error
 *   }
 *
 * This is zero-dependency — no external packages needed.
 */

function createSemaphore(maxConcurrent) {
  let active = 0;
  const queue = [];   // pending resolve() functions

  function acquire() {
    return new Promise((resolve) => {
      if (active < maxConcurrent) {
        active++;
        resolve();
      } else {
        queue.push(resolve);
      }
    });
  }

  function release() {
    active--;
    if (queue.length > 0) {
      active++;
      const next = queue.shift();
      next();
    }
  }

  return { acquire, release, get active() { return active; }, get queued() { return queue.length; } };
}

// Shared semaphore for FFmpeg thumbnail spawns.
// 6 concurrent gives reasonable throughput without hammering the CPU.
// Increase if the server has many cores; decrease if you see high CPU load.
const ffmpegThumbnailSemaphore = createSemaphore(6);

module.exports = { createSemaphore, ffmpegThumbnailSemaphore };
