#!/usr/bin/env node
/**
 * smoke-retention.js — end-to-end smoke test for the recording-retention +
 * MediaMTX sync feature. Exercises the real HTTP API, the DB, and the live
 * MediaMTX config, asserting each guarantee. Restores original state on exit.
 *
 * Run (inside the backend container, which can reach the API + MediaMTX + DB):
 *   docker exec drishyam-backend node scripts/smoke-retention.js
 *
 * Exit code: 0 = all passed, 1 = a check failed, 2 = setup/error.
 * CI-friendly: prints PASS/FAIL per check and a summary.
 */

const axios     = require('axios');
const config    = require('../src/config/env');
const { Camera, CameraGroup, User } = require('../src/models');
const authSvc   = require('../src/services/auth.service');
const reconcile = require('../src/services/mediamtxReconcile.service');

const API      = process.env.SMOKE_API || 'http://localhost:5000/api';
const MTX      = config.mediamtx.apiUrl;
const MTX_AUTH = config.mediamtx.apiUser
  ? { username: config.mediamtx.apiUser, password: config.mediamtx.apiPass || '' }
  : undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  \x1b[32m✓ PASS\x1b[0m  ${name}`); passed += 1; }
  else    { console.log(`  \x1b[31m✗ FAIL\x1b[0m  ${name}${detail ? `  — ${detail}` : ''}`); failed += 1; }
}

// MediaMTX path recordDeleteAfter → seconds (unit-agnostic: 30d / 720h / 0s …)
function durSec(s) {
  if (!s || s === '0s') return 0;
  let t = 0, m; const u = { d: 86400, h: 3600, m: 60, s: 1 };
  const re = /(\d+)(d|h|m|s)/g;
  while ((m = re.exec(s))) t += parseInt(m[1], 10) * u[m[2]];
  return t;
}
async function mtxDays(monitorId) {
  try {
    const { data } = await axios.get(`${MTX}/v3/config/paths/get/cam_${monitorId}`, { auth: MTX_AUTH, timeout: 8000 });
    return durSec(data.recordDeleteAfter) / 86400;
  } catch { return null; }
}
async function setMtxDrift(monitorId, value) {
  await axios.patch(`${MTX}/v3/config/paths/patch/cam_${monitorId}`, { recordDeleteAfter: value }, { auth: MTX_AUTH, timeout: 8000 });
}

async function main() {
  // ── Setup: pick a real group with cameras + mint its owner's token ──────────
  const group = await CameraGroup.findOne({ include: [{ model: Camera, as: 'cameras' }] });
  if (!group || !group.cameras.length) { console.error('SETUP FAIL: no camera group with cameras'); process.exit(2); }
  const user  = await User.findByPk(group.userId);
  const token = authSvc.generateAccessToken(user);
  const http  = axios.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });

  const gid  = group.id;
  const cams = group.cameras;
  const cam  = cams[0];
  const bulkIds = cams.slice(0, Math.min(3, cams.length)).map((c) => c.monitorId);

  // Snapshot original retention to restore at the end
  const orig = { group: group.retentionDays, cams: Object.fromEntries(cams.map((c) => [c.monitorId, c.retentionDays])) };

  console.log(`\n== Retention/sync smoke test — group "${group.name}" (${cams.length} cams) ==\n`);

  try {
    // 1) Backend reachable + auth works
    const list = await http.get('/groups');
    check('backend reachable + auth (GET /groups 200)', list.status === 200);

    // 2) Group default applies to MediaMTX
    const r1 = await http.post(`/groups/${gid}/retention`, { retentionDays: 30 });
    check('set group default = 30 (200)', r1.status === 200 && r1.data.success);
    await sleep(600);
    check('group default reached MediaMTX (cam = 30d)', (await mtxDays(cam.monitorId)) === 30);

    // 3) Per-camera override beats the group default
    const r2 = await http.post(`/groups/${gid}/cameras/${cam.monitorId}/retention`, { retentionDays: 90 });
    check('set single override = 90 (200)', r2.status === 200);
    await sleep(600);
    check('override applied (cam = 90d, not 30d)', (await mtxDays(cam.monitorId)) === 90);

    // 4) Bulk override
    const r3 = await http.post(`/groups/${gid}/cameras/retention`, { monitorIds: bulkIds, retentionDays: 15 });
    check(`bulk override ${bulkIds.length} cams = 15 (200 + count)`, r3.status === 200 && r3.data.count === bulkIds.length);
    await sleep(600);
    check('bulk applied (first cam = 15d)', (await mtxDays(bulkIds[0])) === 15);

    // 5) Inheritance: clear an override → it follows the group default
    await http.post(`/groups/${gid}/cameras/${cam.monitorId}/retention`, { retentionDays: null });
    await http.post(`/groups/${gid}/retention`, { retentionDays: 45 });
    await sleep(800);
    check('cleared override now inherits group (cam = 45d)', (await mtxDays(cam.monitorId)) === 45);

    // 6) Drift → periodic reconcile self-heals
    await setMtxDrift(cam.monitorId, '2d');
    check('drift induced (cam = 2d in MediaMTX)', (await mtxDays(cam.monitorId)) === 2);
    await reconcile.reconcileRetention();
    await sleep(400);
    check('reconcile self-healed drift (cam back to 45d)', (await mtxDays(cam.monitorId)) === 45);

    // 7) Event-driven trigger (debounced) self-heals
    await setMtxDrift(cam.monitorId, '5d');
    reconcile.requestReconcile('smoke');
    await sleep(2300);   // debounce (1500) + run
    check('event-triggered reconcile self-healed (cam back to 45d)', (await mtxDays(cam.monitorId)) === 45);

    // 8) Validation + auth guards
    const e1 = await http.post(`/groups/${gid}/retention`, { retentionDays: -5 });
    check('negative days rejected (400)', e1.status === 400);
    const e2 = await http.post(`/groups/${gid}/cameras/retention`, { monitorIds: [], retentionDays: 30 });
    check('empty bulk rejected (400)', e2.status === 400);
    const e3 = await axios.post(`${API}/groups/${gid}/retention`, { retentionDays: 30 }, { validateStatus: () => true });
    check('unauthenticated rejected (401)', e3.status === 401);
  } finally {
    // ── Restore original state + re-sync MediaMTX ──────────────────────────────
    await CameraGroup.update({ retentionDays: orig.group }, { where: { id: gid } });
    for (const c of cams) await Camera.update({ retentionDays: orig.cams[c.monitorId] }, { where: { monitorId: c.monitorId } });
    await reconcile.reconcileRetention().catch(() => {});
    console.log('\n  (restored original retention values + re-synced MediaMTX)');
  }

  console.log(`\n== Result: ${passed} passed, ${failed} failed ==\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('SMOKE ERROR:', err.message); process.exit(2); });
