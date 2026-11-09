/**
 * vendors/index.js — single source of truth for per-vendor camera behaviour.
 *
 * Before this module, vendor logic was scattered across FOUR drifting switch
 * statements (deviceProbe.service probe/setEncoderConfig/setKeyframeInterval)
 * plus TWO duplicated RTSP path builders (cameraGroup.controller +
 * bulkImport.controller) and a Hik/Dahua-only deriveSubPath in streamService.shim.
 * Adding a vendor meant editing six places and three API allow-lists, and any
 * unknown/mislabeled device silently fell back to Hikvision ISAPI — producing
 * confidently-wrong RTSP URLs and garbage probes with no operator-visible error.
 *
 * Now every call-site delegates to one driver descriptor per vendor. Adding a
 * vendor = adding one entry here; the API allow-lists derive from listDeviceTypes().
 *
 * A driver descriptor:
 *   {
 *     id, displayName, aliases[],
 *     defaultRtspPort, defaultHttpPort,
 *     capabilities: { probe, encoder, keyframe, subStream, ptz, talkback, hasVideo },
 *     probeStrategy   : 'hikvision'|'dahua'|'axis'|'onvif'|null,  // which prober deviceProbe runs
 *     encoderStrategy : 'hikvision'|'dahua'|'onvif'|null,
 *     keyframeStrategy: 'hikvision'|'dahua'|'onvif'|null,
 *     pathStrategy    : 'template'|'onvif',   // 'onvif' => RTSP URL should come from GetStreamUri (Wave 3) or a raw URL
 *     buildRtspPath(channel, opts) : main-stream RTSP path,
 *     buildSubPath(channel, opts)  : sub-stream RTSP path or null,
 *   }
 *
 * NOTE on probe/encoder STRATEGY vs the driver's own functions: the actual
 * probe/encoder HTTP logic still lives in deviceProbe.service.js (large, vendor
 * -specific). This registry only declares WHICH strategy a vendor uses, so the
 * two cannot drift on vendor set. deviceProbe maps the strategy string to its
 * internal function. This avoids a circular require (vendors must not import
 * deviceProbe).
 */

const AppError = require('../../utils/AppError');

class UnsupportedVendorError extends AppError {
  constructor(deviceType) {
    super(`Unsupported camera vendor / device type: "${deviceType}". Supported: ${listDeviceTypes().join(', ')}.`, 422);
    this.name = 'UnsupportedVendorError';
    this.code = 'unsupported-vendor';
    this.deviceType = deviceType;
  }
}

// ── RTSP path templates (channel is 1-based) ─────────────────────────────────

const hikMain  = (ch) => `/Streaming/Channels/${ch * 100 + 1}`; // ch1 -> 101
const hikSub   = (ch) => `/Streaming/Channels/${ch * 100 + 2}`; // ch1 -> 102
const dahuaMain = (ch) => `/cam/realmonitor?channel=${ch}&subtype=0`;
const dahuaSub  = (ch) => `/cam/realmonitor?channel=${ch}&subtype=1`;
const axisMain  = (ch) => `/axis-media/media.amp?camera=${ch}`;
const univMain  = (ch) => `/unicast/c${ch}/s0/live`;  // Uniview/UNV standard
const univSub   = (ch) => `/unicast/c${ch}/s1/live`;
const boschMain = (ch) => `/rtsp_tunnel?inst=1&line=${ch}`; // Bosch RCP+ tunnel; line=channel for multi-imager
const boschSub  = (ch) => `/rtsp_tunnel?inst=2&line=${ch}`;
// Hanwha/Wisenet & Honeywell direct-camera defaults; multi-channel NVRs and
// exact profile numbering should be resolved via ONVIF GetStreamUri (Wave 3)
// or a per-camera raw RTSP URL. These are documented best-effort fallbacks.
const hanwhaMain = (ch) => `/profile${ch === 1 ? 2 : ch + 1}/media.smp`;
const hanwhaSub  = (ch) => `/profile${ch === 1 ? 3 : ch + 2}/media.smp`;
const genericMain = (ch) => `/stream${ch}`; // legacy 'generic' behaviour, kept for back-compat

// ── Driver registry ──────────────────────────────────────────────────────────

const CAP_FULL = { probe: true, encoder: true, keyframe: true, subStream: true, ptz: false, talkback: true, hasVideo: true };

/** @type {Record<string, object>} keyed by canonical id */
const DRIVERS = {
  hikvision: {
    id: 'hikvision', displayName: 'Hikvision', aliases: ['hik', 'hilook'],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'template',
    probeStrategy: 'hikvision', encoderStrategy: 'hikvision', keyframeStrategy: 'hikvision',
    capabilities: { ...CAP_FULL, hasVideo: true },
    buildRtspPath: hikMain, buildSubPath: hikSub,
  },
  dahua: {
    id: 'dahua', displayName: 'Dahua', aliases: ['amcrest', 'empiretech'],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'template',
    probeStrategy: 'dahua', encoderStrategy: 'dahua', keyframeStrategy: 'dahua',
    capabilities: { ...CAP_FULL, hasVideo: false, talkback: true },
    buildRtspPath: dahuaMain, buildSubPath: dahuaSub,
  },
  // CP Plus is a Dahua OEM (same SoC/firmware family) — alias the Dahua driver.
  cpplus: {
    id: 'cpplus', displayName: 'CP Plus', aliases: ['cp-plus', 'cpplus'],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'template',
    probeStrategy: 'dahua', encoderStrategy: 'dahua', keyframeStrategy: 'dahua',
    capabilities: { ...CAP_FULL, hasVideo: false, talkback: true },
    buildRtspPath: dahuaMain, buildSubPath: dahuaSub,
  },
  axis: {
    id: 'axis', displayName: 'Axis', aliases: [],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'template',
    probeStrategy: 'axis', encoderStrategy: null, keyframeStrategy: null,
    capabilities: { probe: true, encoder: false, keyframe: false, subStream: false, ptz: false, talkback: false, hasVideo: false },
    buildRtspPath: axisMain, buildSubPath: () => null,
  },
  uniview: {
    id: 'uniview', displayName: 'Uniview (UNV)', aliases: ['unv'],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'template',
    probeStrategy: 'onvif', encoderStrategy: 'onvif', keyframeStrategy: 'onvif',
    capabilities: { probe: true, encoder: true, keyframe: true, subStream: true, ptz: false, talkback: false, hasVideo: false },
    buildRtspPath: univMain, buildSubPath: univSub,
  },
  hanwha: {
    id: 'hanwha', displayName: 'Hanwha Vision (Wisenet)', aliases: ['wisenet', 'samsung'],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'onvif',
    probeStrategy: 'onvif', encoderStrategy: 'onvif', keyframeStrategy: 'onvif',
    capabilities: { probe: true, encoder: true, keyframe: true, subStream: true, ptz: false, talkback: false, hasVideo: false },
    buildRtspPath: hanwhaMain, buildSubPath: hanwhaSub,
  },
  bosch: {
    id: 'bosch', displayName: 'Bosch', aliases: [],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'onvif',
    probeStrategy: 'onvif', encoderStrategy: 'onvif', keyframeStrategy: 'onvif',
    capabilities: { probe: true, encoder: true, keyframe: true, subStream: true, ptz: false, talkback: false, hasVideo: false },
    buildRtspPath: boschMain, buildSubPath: boschSub,
  },
  honeywell: {
    id: 'honeywell', displayName: 'Honeywell', aliases: [],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'onvif',
    probeStrategy: 'onvif', encoderStrategy: 'onvif', keyframeStrategy: 'onvif',
    capabilities: { probe: true, encoder: true, keyframe: true, subStream: false, ptz: false, talkback: false, hasVideo: false },
    buildRtspPath: genericMain, buildSubPath: () => null,
  },
  // Pure ONVIF Profile-S device of unknown make. Probe/encoder via ONVIF.
  // RTSP path SHOULD come from ONVIF GetStreamUri (Wave 3) or a raw URL; the
  // template here is a best-effort placeholder, not authoritative.
  onvif: {
    id: 'onvif', displayName: 'ONVIF (generic)', aliases: [],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'onvif',
    probeStrategy: 'onvif', encoderStrategy: 'onvif', keyframeStrategy: 'onvif',
    capabilities: { probe: true, encoder: true, keyframe: true, subStream: false, ptz: false, talkback: false, hasVideo: false },
    buildRtspPath: genericMain, buildSubPath: () => null,
  },
  // Back-compat alias retained from the original 4-value enum. Behaves like onvif.
  generic: {
    id: 'generic', displayName: 'Generic / ONVIF', aliases: [],
    defaultRtspPort: 554, defaultHttpPort: 80, pathStrategy: 'onvif',
    probeStrategy: 'onvif', encoderStrategy: 'onvif', keyframeStrategy: 'onvif',
    capabilities: { probe: true, encoder: true, keyframe: true, subStream: false, ptz: false, talkback: false, hasVideo: false },
    buildRtspPath: genericMain, buildSubPath: () => null,
  },
};

// alias -> canonical id
const ALIASES = {};
for (const d of Object.values(DRIVERS)) {
  for (const a of d.aliases || []) ALIASES[a.toLowerCase()] = d.id;
}

function canonicalId(deviceType) {
  const key = String(deviceType || '').trim().toLowerCase();
  if (DRIVERS[key]) return key;
  if (ALIASES[key]) return ALIASES[key];
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** All canonical device-type ids (drives the API allow-lists). */
function listDeviceTypes() {
  return Object.keys(DRIVERS);
}

/** Every accepted token (ids + aliases) — for permissive input validation. */
function listAcceptedTypes() {
  return [...Object.keys(DRIVERS), ...Object.keys(ALIASES)];
}

function isSupported(deviceType) {
  return canonicalId(deviceType) !== null;
}

/** Resolve a driver or throw UnsupportedVendorError (422). NEVER silently falls back. */
function getDriver(deviceType) {
  const id = canonicalId(deviceType);
  if (!id) throw new UnsupportedVendorError(deviceType);
  return DRIVERS[id];
}

/** Build the main-stream RTSP path for a channel. Throws for unknown vendors. */
function buildRtspPath(deviceType, channel, opts = {}) {
  return getDriver(deviceType).buildRtspPath(channel, opts);
}

/** Build the sub-stream RTSP path for a channel, or null if none. */
function buildSubPath(deviceType, channel, opts = {}) {
  const fn = getDriver(deviceType).buildSubPath;
  return fn ? fn(channel, opts) : null;
}

/**
 * Pattern-based sub-stream derivation from a stored main-stream path.
 * Used by the media layer, which has the path string but not always the
 * deviceType. Tries every known vendor sub-stream convention.
 * Returns null when no convention matches (caller falls back to main stream).
 */
function deriveSubPath(mainPath) {
  if (!mainPath) return null;
  // Hikvision: /Channels/N01 -> /Channels/N02
  const hik = mainPath.match(/^(.*\/Channels\/\d+)\d(\/?.*)$/);
  if (hik) return `${hik[1]}2${hik[2]}`;
  // Dahua / CP Plus: subtype=0 -> subtype=1
  if (mainPath.includes('subtype=0')) return mainPath.replace('subtype=0', 'subtype=1');
  // Uniview: /cN/s0/live -> /cN/s1/live
  if (/\/c\d+\/s0\/live/.test(mainPath)) return mainPath.replace('/s0/live', '/s1/live');
  // Bosch: inst=1 -> inst=2
  if (mainPath.includes('inst=1')) return mainPath.replace('inst=1', 'inst=2');
  // Hanwha/Honeywell: /profileN/media.smp -> /profile(N+1)/media.smp
  const han = mainPath.match(/\/profile(\d+)\/media\.smp/);
  if (han) return mainPath.replace(`/profile${han[1]}/`, `/profile${parseInt(han[1], 10) + 1}/`);
  return null;
}

// ── NVR playback (RTSP replay of the NVR's own recordings) ───────────────────
// Vendor-specific RTSP playback URLs with a time range. Only Hikvision + Dahua
// families are supported today (the two dominant NVR stacks); others throw.

const pad = (n) => String(n).padStart(2, '0');
// Our DVRs are configured in IST and interpret the RTSP playback timestamp as
// DEVICE-LOCAL time (the units ignore ISAPI's 'Z'/UTC marker), so UTC times
// landed playback ~5.5h before the requested moment. Send IST wall-clock: shift
// the UTC epoch by +5:30, then read the shifted date's UTC components. This is
// TZ-independent (does not rely on the process timezone).
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const istOf = (d) => new Date(d.getTime() + IST_OFFSET_MS);
// Hikvision ISAPI: /Streaming/tracks/<ch>01?starttime=YYYYMMDDThhmmssZ (digits = IST device-local)
function fmtHik(d) {
  const t = istOf(d);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}
// Dahua: /cam/playback?...&starttime=YYYY_MM_DD_hh_mm_ss (IST device-local)
function fmtDahua(d) {
  const t = istOf(d);
  return `${t.getUTCFullYear()}_${pad(t.getUTCMonth() + 1)}_${pad(t.getUTCDate())}_${pad(t.getUTCHours())}_${pad(t.getUTCMinutes())}_${pad(t.getUTCSeconds())}`;
}

const PLAYBACK_BUILDERS = {
  hikvision: (ch, s, e) => `/Streaming/tracks/${ch * 100 + 1}?starttime=${fmtHik(s)}&endtime=${fmtHik(e)}`,
  dahua:     (ch, s, e) => `/cam/playback?channel=${ch}&starttime=${fmtDahua(s)}&endtime=${fmtDahua(e)}`,
};

/** Which vendor family a device maps to for playback, or null if unsupported. */
function playbackFamily(deviceType) {
  const id = canonicalId(deviceType);
  if (id === 'hikvision') return 'hikvision';
  if (id === 'dahua' || id === 'cpplus') return 'dahua';
  return null;
}

function supportsPlayback(deviceType) {
  return playbackFamily(deviceType) !== null;
}

/**
 * Build the vendor RTSP playback path for a channel + time range.
 * @param {string} deviceType
 * @param {number} channel   1-based
 * @param {number|Date} start  epoch ms or Date
 * @param {number|Date} end
 * @returns {string|null} RTSP path (append to rtsp://host:port), or null if unsupported
 */
function buildPlaybackPath(deviceType, channel, start, end) {
  const fam = playbackFamily(deviceType);
  if (!fam) return null;
  return PLAYBACK_BUILDERS[fam](channel || 1, new Date(start), new Date(end));
}

// ── NVR/camera interface boundary ────────────────────────────────────────────

/**
 * Describe EXACTLY how drisyam interfaces with an NVR/camera of this vendor.
 * This is the authoritative answer to "are we reading/writing the NVR, and do
 * we use its recordings?" — surfaced here so the UI/ops can show it per device.
 *
 * The model is deliberately simple and the same for every vendor:
 *
 *   STREAM  — we READ the live RTSP stream (Stream Service pulls it; the NVR/camera
 *             only serves it). We never push video INTO the NVR.
 *   CONFIG  — we READ device info + channel names + signal presence over
 *             HTTP/ONVIF, and we WRITE only encoder settings (bitrate/GOP/fps),
 *             two-way audio, and PTZ — and only for vendors whose driver
 *             advertises that capability. We never touch the NVR's storage,
 *             recording schedule, users, or network config.
 *   RECORDINGS — drisyam-OWNED. Stream Service records the pulled RTSP to disk and
 *             Node uploads stitched MP4s to S3 (see recordingSync.service.js).
 *             The NVR's own HDD/recordings are NEVER read, played back, or
 *             modified. Playback in the app is always from S3, not the NVR.
 *
 * @returns {{ vendor, stream, reads, writes, recordings }}
 */
function nvrInterface(deviceType) {
  const d = getDriver(deviceType);
  const c = d.capabilities;

  const reads = [];
  if (c.probe)    reads.push('device info + per-channel names (HTTP/ONVIF)');
  if (c.hasVideo) reads.push('per-channel video-signal presence');

  const writes = [];
  if (c.encoder)  writes.push('encoder bitrate / GOP / fps');
  if (c.keyframe) writes.push('keyframe interval (GOP) for fast pop-in');
  if (c.talkback) writes.push('two-way audio to the device speaker');
  if (c.ptz)      writes.push('PTZ pan/tilt/zoom + presets');

  return {
    vendor: d.id,
    // Live video: we only ever PULL. The NVR/camera is the RTSP server.
    stream: { direction: 'read-only-pull', transport: 'rtsp', source: 'nvr-or-camera' },
    reads,
    // We never write to NVR storage / recording schedule / users / network.
    writes: writes.length ? writes : ['(none — read-only device)'],
    recordings: {
      owner: 'drisyam',
      pipeline: 'NVR RTSP → Stream Service (record MP4) → Node stitch → S3',
      usesNvrStorage: false,
      note: "The NVR's own recordings are never read or modified; app playback is from S3.",
    },
  };
}

module.exports = {
  DRIVERS,
  UnsupportedVendorError,
  listDeviceTypes,
  listAcceptedTypes,
  isSupported,
  canonicalId,
  getDriver,
  buildRtspPath,
  buildSubPath,
  deriveSubPath,
  supportsPlayback,
  buildPlaybackPath,
  nvrInterface,
};
