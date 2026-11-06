/**
 * deviceProbe.service.js
 *
 * Talks directly to NVR / camera HTTP APIs to discover:
 *   - the device's own name + model (deviceInfo)
 *   - the per-channel names already configured on the device
 *   - whether each channel actually has a video signal
 *
 * Used during camera onboarding so the user does NOT have to re-type names
 * that already exist on the NVR. The frontend "Discover" button calls
 * POST /api/groups/probe with the same connection details the user is about
 * to save, and we return [{ channel, name, hasVideo, model }].
 *
 * Vendor coverage:
 *   hikvision  →  ISAPI XML endpoints (/ISAPI/System/...)
 *   dahua      →  CGI key=value endpoints (/cgi-bin/configManager.cgi)
 *   axis       →  param.cgi (Basic auth, simple)
 *   generic    →  ONVIF GetProfiles (works for many "ONVIF Profile S" cameras)
 *
 * Each probe is bounded by a tight timeout (default 5s per HTTP roundtrip)
 * because this is called interactively from the UI.
 */

const { digestRequest } = require('../utils/digestAuth');
const logger = require('../config/logger');
const vendors = require('./vendors');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEVICE_PROBE_TIMEOUT_MS || '5000', 10);

// ── XML / kv parsers (no XML lib dep — these formats are tiny) ───────────────

/**
 * Parse Hikvision-style XML by extracting <tag>value</tag> pairs.
 * Robust enough for ISAPI responses, which are a flat schema with no attributes
 * in the values we care about. Returns repeated tags as arrays.
 */
function parseFlatXml(xml) {
  if (!xml || typeof xml !== 'string') return {};
  const out = {};
  const re = /<(\w[\w:-]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[1];
    const val = m[2].trim();
    if (out[tag] === undefined) out[tag] = val;
    else if (Array.isArray(out[tag])) out[tag].push(val);
    else out[tag] = [out[tag], val];
  }
  return out;
}

/**
 * Hikvision channels are wrapped in <VideoInputChannel>...</VideoInputChannel>
 * sections; each has <id>, <name>, <inputPort>, <videoInputEnabled>. Extract
 * those blocks individually before flat-parsing each one.
 */
function extractHikvisionChannels(xml) {
  const blocks = [];
  if (!xml) return blocks;
  const re = /<VideoInputChannel\b[^>]*>([\s\S]*?)<\/VideoInputChannel>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const inner = parseFlatXml(m[1]);
    blocks.push({
      channel:    parseInt(inner.id, 10) || null,
      name:       inner.name || null,
      enabled:    String(inner.videoInputEnabled || '').toLowerCase() === 'true',
    });
  }
  return blocks;
}

/**
 * Hikvision NVRs (DS-76xxNI, DS-77xxNI, DS-96xxNI …) front IP cameras, and the
 * per-channel names live under InputProxy — NOT the Video/inputs/channels
 * endpoint used by analog DVRs. Each channel is an <InputProxyChannel> with
 * <id> and <name>. Without this, every NVR-attached IP camera comes back nameless
 * and falls back to the generated "<group> - Camera NN".
 */
function extractHikvisionInputProxyChannels(xml) {
  const blocks = [];
  if (!xml) return blocks;
  const re = /<InputProxyChannel\b[^>]*>([\s\S]*?)<\/InputProxyChannel>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const inner = parseFlatXml(m[1]);
    // The first <name> in the block is the channel's display name; later <name>
    // tags belong to the nested sourceInputPortDescriptor and are ignored.
    blocks.push({
      channel: parseInt(inner.id, 10) || null,
      name:    inner.name || null,
      enabled: true,
    });
  }
  return blocks;
}

// ── Hikvision ────────────────────────────────────────────────────────────────

async function probeHikvision({ host, httpPort, username, password }) {
  const base = `http://${host}:${httpPort || 80}`;
  const reqOpts = { username, password, timeout: DEFAULT_TIMEOUT_MS };

  // 1) Device info — model + serial + name
  let model = null;
  let deviceName = null;
  try {
    const r = await digestRequest({ ...reqOpts, url: `${base}/ISAPI/System/deviceInfo` });
    if (r.status === 200) {
      const d = parseFlatXml(r.data);
      deviceName = d.deviceName || null;
      model      = d.model      || null;
    }
  } catch (err) {
    logger.debug('hikvision deviceInfo failed', { host, error: err.message });
  }

  // 2) Channel list — names per channel.
  //   DVRs (analog inputs)  → /ISAPI/System/Video/inputs/channels
  //   NVRs (IP cameras)     → /ISAPI/ContentMgmt/InputProxy/channels
  // Try the analog endpoint first; if it yields nothing this is an NVR, so fall
  // back to InputProxy. Without the fallback, every NVR channel is nameless.
  let channels = [];
  try {
    const r = await digestRequest({ ...reqOpts, url: `${base}/ISAPI/System/Video/inputs/channels` });
    if (r.status === 200) channels = extractHikvisionChannels(r.data);
  } catch (err) {
    logger.debug('hikvision channels failed', { host, error: err.message });
  }
  if (channels.length === 0) {
    try {
      const r = await digestRequest({ ...reqOpts, url: `${base}/ISAPI/ContentMgmt/InputProxy/channels` });
      if (r.status === 200) channels = extractHikvisionInputProxyChannels(r.data);
    } catch (err) {
      logger.debug('hikvision InputProxy channels failed', { host, error: err.message });
    }
  }

  // 3) Live video presence — query input port status (best-effort)
  let inputStatus = [];
  try {
    const r = await digestRequest({ ...reqOpts, url: `${base}/ISAPI/System/Video/inputs/channels/status` });
    if (r.status === 200) {
      const xml = r.data;
      // Parse <InputProxyChannelStatus> or <VideoInputChannelStatus> blocks
      const re = /<\w*ChannelStatus\b[^>]*>([\s\S]*?)<\/\w*ChannelStatus>/g;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const inner = parseFlatXml(m[1]);
        inputStatus.push({
          channel: parseInt(inner.id, 10) || null,
          online:  String(inner.online || '').toLowerCase() === 'true',
        });
      }
    }
  } catch (_) { /* swallow — not all firmwares expose this */ }

  return {
    vendor:   'hikvision',
    model,
    deviceName,
    channels: channels.map((c) => ({
      channel: c.channel,
      name:    c.name,
      hasVideo: inputStatus.find((s) => s.channel === c.channel)?.online ?? c.enabled ?? null,
    })),
  };
}

// ── Dahua ────────────────────────────────────────────────────────────────────

/**
 * Parse Dahua key=value response into a nested object indexed by:
 *   table.ChannelTitle[0].Name=Front Door
 *   table.ChannelTitle[0].Color=255
 * → { 'ChannelTitle': [{ Name: 'Front Door', Color: '255' }, ...] }
 */
function parseDahuaKv(text) {
  if (!text) return {};
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('=')) continue;
    const [k, v] = line.split('=', 2).map((s) => s.trim());
    // Strip "table." prefix if present
    const norm = k.replace(/^table\./, '');
    // Pattern: Section[idx].Field
    const m = norm.match(/^([A-Za-z]+)\[(\d+)\]\.(.+)$/);
    if (m) {
      const [, section, idxStr, field] = m;
      const idx = parseInt(idxStr, 10);
      if (!out[section]) out[section] = [];
      if (!out[section][idx]) out[section][idx] = {};
      out[section][idx][field] = v;
    } else {
      out[norm] = v;
    }
  }
  return out;
}

async function probeDahua({ host, httpPort, username, password }) {
  const base = `http://${host}:${httpPort || 80}`;
  const reqOpts = { username, password, timeout: DEFAULT_TIMEOUT_MS };

  let deviceName = null;
  let model      = null;
  try {
    const r = await digestRequest({ ...reqOpts, url: `${base}/cgi-bin/magicBox.cgi?action=getDeviceType` });
    if (r.status === 200) {
      const kv = parseDahuaKv(r.data);
      model = kv.type || null;
    }
  } catch (_) { /* swallow */ }
  try {
    const r = await digestRequest({ ...reqOpts, url: `${base}/cgi-bin/configManager.cgi?action=getConfig&name=General` });
    if (r.status === 200) {
      const kv = parseDahuaKv(r.data);
      deviceName = kv.General?.[0]?.MachineName || kv.General?.MachineName || null;
    }
  } catch (_) { /* swallow */ }

  let channels = [];
  try {
    const r = await digestRequest({ ...reqOpts, url: `${base}/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle` });
    if (r.status === 200) {
      const kv = parseDahuaKv(r.data);
      const titles = kv.ChannelTitle || [];
      channels = titles.map((t, i) => ({
        channel: i + 1,           // Dahua zero-indexes; humans want 1-based
        name:    t?.Name || null,
        hasVideo: null,
      }));
    }
  } catch (err) {
    logger.debug('dahua channels failed', { host, error: err.message });
  }

  // Live video presence: getVideoInWidth — present implies channel has signal
  try {
    const r = await digestRequest({ ...reqOpts, url: `${base}/cgi-bin/devVideoInput.cgi?action=getCaps` });
    if (r.status === 200) {
      const kv = parseDahuaKv(r.data);
      const totalIn = parseInt(kv.caps?.VideoInChannel || kv.caps?.[0]?.VideoInChannel || '0', 10);
      if (totalIn && !channels.length) {
        channels = Array.from({ length: totalIn }, (_, i) => ({
          channel: i + 1, name: null, hasVideo: null,
        }));
      }
    }
  } catch (_) { /* swallow */ }

  return { vendor: 'dahua', model, deviceName, channels };
}

// ── Axis ─────────────────────────────────────────────────────────────────────

async function probeAxis({ host, httpPort, username, password }) {
  // Axis cameras are typically single-channel. param.cgi exposes everything.
  const base = `http://${host}:${httpPort || 80}`;
  let deviceName = null;
  let model      = null;
  let channelName = null;
  try {
    const r = await digestRequest({
      url: `${base}/axis-cgi/param.cgi?action=list&group=Brand,Network.HostName,Image.I0.Name`,
      username, password, timeout: DEFAULT_TIMEOUT_MS,
    });
    if (r.status === 200) {
      const kv = parseDahuaKv(r.data);   // same key=value format
      model       = kv['Brand.ProdNbr'] || kv['Brand.ProdShortName'] || null;
      deviceName  = kv['Network.HostName'] || null;
      channelName = kv['Image.I0.Name']    || null;
    }
  } catch (err) {
    logger.debug('axis param.cgi failed', { host, error: err.message });
  }
  return {
    vendor:   'axis',
    model,
    deviceName,
    channels: [{ channel: 1, name: channelName, hasVideo: null }],
  };
}

// ── ONVIF (generic) ──────────────────────────────────────────────────────────

const axios = require('axios');
const crypto = require('node:crypto');

function buildOnvifEnvelope({ username, password, body }) {
  // ONVIF uses WS-Security UsernameToken with Digest password
  const created = new Date().toISOString();
  const nonce   = crypto.randomBytes(16).toString('base64');
  const nonceBuf = Buffer.from(nonce, 'base64');
  const passDigest = crypto.createHash('sha1')
    .update(Buffer.concat([nonceBuf, Buffer.from(created, 'utf8'), Buffer.from(password || '', 'utf8')]))
    .digest('base64');

  const security = `
    <wsse:Security s:mustUnderstand="1"
                   xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
                   xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${username}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${passDigest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</wsse:Nonce>
        <wsu:Created>${created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Header>${security}</s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

async function probeOnvif({ host, httpPort, username, password }) {
  const url = `http://${host}:${httpPort || 80}/onvif/device_service`;
  const body = `<tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>`;
  let deviceName = null, model = null;
  try {
    const resp = await axios.post(url, buildOnvifEnvelope({ username, password, body }), {
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      timeout: DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (resp.status === 200) {
      const xml = String(resp.data || '');
      const grab = (tag) => (xml.match(new RegExp(`<\\w*:?${tag}>([^<]+)<`, 'i'))?.[1] || null);
      deviceName = grab('Manufacturer');
      model      = grab('Model');
    }
  } catch (err) {
    logger.debug('onvif GetDeviceInformation failed', { host, error: err.message });
  }

  // Fetch profiles to read profile names (≈ channel names on multi-sensor cameras)
  let channels = [];
  try {
    const mediaUrl = `http://${host}:${httpPort || 80}/onvif/Media`;
    const profilesBody = `<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>`;
    const resp = await axios.post(mediaUrl, buildOnvifEnvelope({ username, password, body: profilesBody }), {
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      timeout: DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (resp.status === 200) {
      const xml = String(resp.data || '');
      const blocks = xml.match(/<\w*:?Profiles\b[\s\S]*?<\/\w*:?Profiles>/g) || [];
      blocks.forEach((b, i) => {
        const name = b.match(/<\w*:?Name>([^<]+)<\/\w*:?Name>/)?.[1] || null;
        channels.push({ channel: i + 1, name, hasVideo: null });
      });
    }
  } catch (err) {
    logger.debug('onvif GetProfiles failed', { host, error: err.message });
  }

  return { vendor: 'onvif', model, deviceName, channels };
}

// ── Unified entry point ─────────────────────────────────────────────────────

/**
 * @param {object} args
 *   host, httpPort (default 80), username, password, deviceType
 * @returns {Promise<{vendor,model,deviceName,channels:[{channel,name,hasVideo}]}>}
 */
async function probe({ host, httpPort = 80, username, password, deviceType }) {
  const args = { host, httpPort, username, password };
  // The registry maps each vendor to its probe strategy and throws
  // UnsupportedVendorError (422) for an unknown deviceType — no silent
  // fallback to Hikvision (which produced garbage probes for mislabeled gear).
  const strategy = vendors.getDriver(deviceType || 'hikvision').probeStrategy;
  switch (strategy) {
    case 'hikvision': return probeHikvision(args);
    case 'dahua':     return probeDahua(args);
    case 'axis':      return probeAxis(args);
    case 'onvif':     return probeOnvif(args);
    default:          return { vendor: strategy || 'unknown', model: null, deviceName: null, channels: [] };
  }
}

// ── Encoder writers (keyframe acceleration) ──────────────────────────────────
// Cameras default to GOP intervals of 50–100 frames (≈2–4s @ 25fps), which
// dominates time-to-first-frame for live viewers. We can override the GOP
// length per channel via vendor APIs.
//
// For viewer-pop-in latency to be sub-1s, we want GOP ≤ camera_fps (≈ 1s).
// The cost is ~10–15% extra bitrate; for surveillance that's a fair trade.

async function setHikvisionKeyframeInterval({ host, httpPort, username, password, channel = 1, gopFrames }) {
  const base = `http://${host}:${httpPort || 80}`;
  const channelId = channel * 100 + 1; // Hikvision standard mapping (ch 1 = 101)
  const url = `${base}/ISAPI/Streaming/channels/${channelId}`;
  // ISAPI requires a full <StreamingChannel> XML on PUT. Read first, mutate the
  // <Video><GovLength> element, write back. Single-roundtrip is unsafe because
  // PUT replaces the entire object.
  let existingXml = '';
  try {
    const r = await digestRequest({ url, username, password, timeout: DEFAULT_TIMEOUT_MS });
    if (r.status !== 200) return { ok: false, status: r.status, error: r.data?.toString() };
    existingXml = String(r.data);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const newXml = existingXml.replace(
    /<GovLength>\s*\d+\s*<\/GovLength>/,
    `<GovLength>${gopFrames}</GovLength>`,
  );
  if (newXml === existingXml) return { ok: false, error: 'GovLength element not found' };
  try {
    const r = await digestRequest({
      url, method: 'PUT', data: newXml,
      headers: { 'Content-Type': 'application/xml' },
      username, password, timeout: DEFAULT_TIMEOUT_MS,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function setDahuaKeyframeInterval({ host, httpPort, username, password, channel = 1, gopFrames }) {
  const base = `http://${host}:${httpPort || 80}`;
  // Dahua zero-indexes channels; main stream is Encode[ch].MainFormat[0].
  // GOPLength is in frames per IDR.
  const idx  = Math.max(0, channel - 1);
  const path = `/cgi-bin/configManager.cgi?action=setConfig` +
               `&Encode[${idx}].MainFormat[0].VideoEnable=true` +
               `&Encode[${idx}].MainFormat[0].Video.GOPLength=${gopFrames}`;
  try {
    const r = await digestRequest({ url: `${base}${path}`, username, password, timeout: DEFAULT_TIMEOUT_MS });
    return { ok: r.status === 200, status: r.status, body: String(r.data || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function setOnvifKeyframeInterval({ host, httpPort, username, password, profileToken, gopFrames }) {
  const url = `http://${host}:${httpPort || 80}/onvif/Media`;
  // ONVIF SetVideoEncoderConfiguration requires the FULL config object.
  // We GET it first, mutate H264.GovLength, then POST it back.
  const getBody = `<trt:GetVideoEncoderConfiguration xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:ConfigurationToken>${profileToken}</trt:ConfigurationToken></trt:GetVideoEncoderConfiguration>`;
  let existingXml = '';
  try {
    const r = await axios.post(url, buildOnvifEnvelope({ username, password, body: getBody }), {
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      timeout: DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (r.status !== 200) return { ok: false, status: r.status };
    existingXml = String(r.data);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // Extract the inner <Configuration>...</Configuration> block, mutate GovLength
  const cfg = existingXml.match(/<\w*:?Configuration\b[\s\S]*?<\/\w*:?Configuration>/)?.[0];
  if (!cfg) return { ok: false, error: 'Configuration element not found' };
  const newCfg = cfg.replace(/(<\w*:?GovLength>)\s*\d+\s*(<\/\w*:?GovLength>)/, `$1${gopFrames}$2`);
  if (newCfg === cfg) return { ok: false, error: 'GovLength element not present in profile' };
  const setBody = `<trt:SetVideoEncoderConfiguration xmlns:trt="http://www.onvif.org/ver10/media/wsdl">${newCfg}<trt:ForcePersistence>true</trt:ForcePersistence></trt:SetVideoEncoderConfiguration>`;
  try {
    const r = await axios.post(url, buildOnvifEnvelope({ username, password, body: setBody }), {
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      timeout: DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return { ok: r.status === 200, status: r.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Encoder writers — full config (bitrate + GOP + fps) ─────────────────────
//
// Most "blurry stream" complaints turn out to be the camera's encoder set to
// a low bitrate. A 1080p stream at 800 kbps is unavoidably soft no matter how
// fast the network is. These writers push a target bitrate / fps / GOP onto
// the camera in one shot. Conservative defaults: 4 Mbps for 1080p, 6 Mbps for
// higher resolutions, 1s GOP for snappy viewer pop-in.

/**
 * Hikvision: PUT /ISAPI/Streaming/channels/{N01} with mutated <Video> block.
 *  - constantBitRate  in kbps when CBR
 *  - vbrUpperCap      in kbps when VBR (already set, just bump it)
 *  - GovLength        frames per IDR
 *  - maxFrameRate     in 1/100 fps (Hikvision quirk: 2500 = 25fps)
 */
async function setHikvisionEncoder({
  host, httpPort, username, password, channel = 1,
  bitrateKbps, gopFrames, fpsX100,
}) {
  const base = `http://${host}:${httpPort || 80}`;

  // Hikvision firmwares vary; try the standard `Streaming/channels/{N01}` path
  // first, fall back to the InputProxy namespace used by NVR-attached channels.
  const candidatePaths = [
    `/ISAPI/Streaming/channels/${channel * 100 + 1}`,
    `/ISAPI/ContentMgmt/StreamingProxy/channels/${channel * 100 + 1}`,
    `/ISAPI/ContentMgmt/InputProxy/channels/${channel}/video`,
  ];

  let xml = '';
  let chosenUrl = null;
  for (const p of candidatePaths) {
    const url = `${base}${p}`;
    try {
      const r = await digestRequest({ url, username, password, timeout: DEFAULT_TIMEOUT_MS });
      if (r.status === 200 && /Video|Encod|GovLength|BitRate/i.test(String(r.data))) {
        xml = String(r.data);
        chosenUrl = url;
        break;
      }
    } catch (_) { /* try next */ }
  }
  if (!chosenUrl) {
    return { ok: false, error: 'could not GET any video-encoder endpoint (paths tried: '
      + candidatePaths.join(', ') + ')' };
  }

  // Detect the encoder's current rate-control mode. Hikvision firmwares
  // include `<videoQualityControlType>CBR</videoQualityControlType>` (or
  // `VBR`) inside the Video block, and they validate the rest of the body
  // against that mode. Earlier we blindly mutated BOTH `<constantBitRate>`
  // and `<vbrUpperCap>` in the same PUT regardless of mode — the firmware
  // saw the body as internally inconsistent (a CBR profile with VBR caps
  // changed underneath it, or vice versa) and rejected the PUT with
  // statusCode 6 "Invalid XML Content". Now we mutate ONLY the fields that
  // match the active mode.
  const modeMatch = xml.match(/<videoQualityControlType>\s*(CBR|VBR)\s*<\/videoQualityControlType>/i);
  const detectedMode = modeMatch ? modeMatch[1].toUpperCase() : null;

  // Clamp the requested bitrate against the device's advertised max if it
  // exposes one. Asking for 8 Mbps on an encoder whose `<maxBitRate>` is
  // 4096 also returns "Invalid XML Content" — Hikvision validates ranges
  // before applying. Without a max declaration we trust the caller.
  let safeBitrate = bitrateKbps;
  if (bitrateKbps != null) {
    const maxMatch = xml.match(/<(?:maxBitRate|bitRateMax)>\s*(\d+)\s*<\/(?:maxBitRate|bitRateMax)>/i);
    if (maxMatch) {
      const cap = parseInt(maxMatch[1], 10);
      if (Number.isFinite(cap) && cap > 0 && bitrateKbps > cap) safeBitrate = cap;
    }
  }

  let next = xml;
  let edits = 0;
  const swap = (re, replacement) => {
    const before = next;
    next = next.replace(re, replacement);
    if (next !== before) edits++;
  };

  if (gopFrames != null) {
    swap(/<GovLength>\s*\d+\s*<\/GovLength>/i,                 `<GovLength>${gopFrames}</GovLength>`);
    swap(/<keyFrameInterval>\s*\d+\s*<\/keyFrameInterval>/i,   `<keyFrameInterval>${gopFrames}</keyFrameInterval>`);
  }
  if (fpsX100 != null) {
    // Hikvision NVR-attached channels treat `<maxFrameRate>0</maxFrameRate>`
    // as a special "follow source" setting and refuse to overwrite it with
    // a concrete value via ISAPI — the firmware bounces the whole PUT with
    // statusCode 6 "Invalid XML Content", even when every other field in
    // the body is valid. Only touch maxFrameRate when the current value
    // is non-zero (i.e. the operator/install has already locked it).
    const curFps = xml.match(/<maxFrameRate>\s*(\d+)\s*<\/maxFrameRate>/i);
    if (curFps && parseInt(curFps[1], 10) > 0) {
      swap(/<maxFrameRate>\s*\d+\s*<\/maxFrameRate>/i,         `<maxFrameRate>${fpsX100}</maxFrameRate>`);
    }
    swap(/<frameRate>\s*\d+\s*<\/frameRate>/i,                 `<frameRate>${Math.round(fpsX100/100)}</frameRate>`);
  }
  if (safeBitrate != null) {
    if (detectedMode === 'VBR') {
      // VBR: bump the cap to our target; set the average to 60% of the
      // cap so the encoder has headroom. Do NOT touch <constantBitRate>
      // — its value is meaningless in VBR mode and changing it makes the
      // firmware reject the whole body.
      swap(/<vbrUpperCap>\s*\d+\s*<\/vbrUpperCap>/i,             `<vbrUpperCap>${safeBitrate}</vbrUpperCap>`);
      swap(/<vbrAverageCap>\s*\d+\s*<\/vbrAverageCap>/i,         `<vbrAverageCap>${Math.round(safeBitrate * 0.6)}</vbrAverageCap>`);
    } else if (detectedMode === 'CBR') {
      // CBR: set the constant bitrate; leave vbr* fields alone.
      swap(/<constantBitRate>\s*\d+\s*<\/constantBitRate>/i,     `<constantBitRate>${safeBitrate}</constantBitRate>`);
      swap(/<fixedQuality>\s*\d+\s*<\/fixedQuality>/i,           `<fixedQuality>${Math.min(100, Math.round(safeBitrate / 80))}</fixedQuality>`);
    } else {
      // Older firmwares (NVR proxy namespace) don't expose
      // <videoQualityControlType>. They typically use one of these
      // simpler element names that aren't mode-tagged, so touching them
      // is safe even without a detected mode.
      swap(/<bitRate>\s*\d+\s*<\/bitRate>/i,                     `<bitRate>${safeBitrate}</bitRate>`);
      swap(/<videoBitrate>\s*\d+\s*<\/videoBitrate>/i,           `<videoBitrate>${safeBitrate}</videoBitrate>`);
      swap(/<averageBitrate>\s*\d+\s*<\/averageBitrate>/i,       `<averageBitrate>${safeBitrate}</averageBitrate>`);
    }
  }

  if (edits === 0) {
    // Nothing matched. Show the operator the actual element names this
    // firmware uses, so they (or we) can extend the schema list.
    const tags = [...new Set((xml.match(/<\w[\w:-]+>/g) || [])
      .map((t) => t.slice(1, -1))
      .filter((t) => /(rate|gov|key|quality|frame)/i.test(t)))];
    return {
      ok: false,
      error: 'no encoder fields matched (firmware variation?)',
      hint: `URL ${chosenUrl} returned XML with these encoder-related tags: ${tags.join(', ') || '<none>'}. ` +
            `Send the full GET response to support so we can add this firmware's schema.`,
      url: chosenUrl,
    };
  }

  try {
    const r = await digestRequest({
      url: chosenUrl, method: 'PUT', data: next,
      headers: { 'Content-Type': 'application/xml' },
      username, password, timeout: DEFAULT_TIMEOUT_MS,
    });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      url: chosenUrl,
      edits,
      mode: detectedMode || 'unknown',
      // Surface the actually-applied bitrate (after clamping against
      // <maxBitRate>) so the operator can see when the request was
      // silently capped — and so a "Invalid XML Content" reply is easier
      // to correlate with the value the device cared about.
      applied: { bitrateKbps: safeBitrate, requestedKbps: bitrateKbps, gopFrames, fpsX100 },
      deviceResponse: r.status >= 200 && r.status < 300 ? null : String(r.data || '').slice(0, 240),
    };
  } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Dahua: setConfig CGI with key=value triples. Bitrate is in kbps.
 * BitRateControl=CBR is the simplest path for predictable quality.
 */
async function setDahuaEncoder({
  host, httpPort, username, password, channel = 1,
  bitrateKbps, gopFrames, fps,
}) {
  const base = `http://${host}:${httpPort || 80}`;
  const idx  = Math.max(0, channel - 1);
  const params = [`Encode[${idx}].MainFormat[0].VideoEnable=true`];
  if (bitrateKbps != null) {
    params.push(`Encode[${idx}].MainFormat[0].Video.BitRateControl=CBR`);
    params.push(`Encode[${idx}].MainFormat[0].Video.BitRate=${bitrateKbps}`);
  }
  if (gopFrames != null) params.push(`Encode[${idx}].MainFormat[0].Video.GOPLength=${gopFrames}`);
  if (fps != null)       params.push(`Encode[${idx}].MainFormat[0].Video.FPS=${fps}`);
  const url = `${base}/cgi-bin/configManager.cgi?action=setConfig&${params.join('&')}`;
  try {
    const r = await digestRequest({ url, username, password, timeout: DEFAULT_TIMEOUT_MS });
    return { ok: r.status === 200, status: r.status, applied: { bitrateKbps, gopFrames, fps }, body: String(r.data || '').trim() };
  } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * ONVIF: SetVideoEncoderConfiguration. Mutate BitrateLimit, GovLength,
 * FrameRateLimit on the configuration we GET first.
 */
async function setOnvifEncoder({
  host, httpPort, username, password, profileToken,
  bitrateKbps, gopFrames, fps,
}) {
  if (!profileToken) return { ok: false, error: 'ONVIF requires profileToken' };
  const url = `http://${host}:${httpPort || 80}/onvif/Media`;
  const getBody = `<trt:GetVideoEncoderConfiguration xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><trt:ConfigurationToken>${profileToken}</trt:ConfigurationToken></trt:GetVideoEncoderConfiguration>`;
  let xml = '';
  try {
    const r = await axios.post(url, buildOnvifEnvelope({ username, password, body: getBody }), {
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      timeout: DEFAULT_TIMEOUT_MS, validateStatus: () => true,
    });
    if (r.status !== 200) return { ok: false, status: r.status };
    xml = String(r.data);
  } catch (err) { return { ok: false, error: err.message }; }

  let cfg = xml.match(/<\w*:?Configuration\b[\s\S]*?<\/\w*:?Configuration>/)?.[0];
  if (!cfg) return { ok: false, error: 'Configuration element not found' };
  const before = cfg;

  if (gopFrames != null) {
    cfg = cfg.replace(/(<\w*:?GovLength>)\s*\d+\s*(<\/\w*:?GovLength>)/, `$1${gopFrames}$2`);
  }
  if (fps != null) {
    cfg = cfg.replace(/(<\w*:?FrameRateLimit>)\s*\d+\s*(<\/\w*:?FrameRateLimit>)/, `$1${fps}$2`);
  }
  if (bitrateKbps != null) {
    cfg = cfg.replace(/(<\w*:?BitrateLimit>)\s*\d+\s*(<\/\w*:?BitrateLimit>)/, `$1${bitrateKbps}$2`);
  }
  if (cfg === before) return { ok: false, error: 'no encoder fields matched in profile' };

  const setBody = `<trt:SetVideoEncoderConfiguration xmlns:trt="http://www.onvif.org/ver10/media/wsdl">${cfg}<trt:ForcePersistence>true</trt:ForcePersistence></trt:SetVideoEncoderConfiguration>`;
  try {
    const r = await axios.post(url, buildOnvifEnvelope({ username, password, body: setBody }), {
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      timeout: DEFAULT_TIMEOUT_MS, validateStatus: () => true,
    });
    return { ok: r.status === 200, status: r.status, applied: { bitrateKbps, gopFrames, fps } };
  } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Unified encoder writer. Push bitrate + GOP + fps to a camera in one call.
 *
 * Sensible defaults if caller omits a field:
 *   bitrateKbps  4096 (1080p H.264 floor — sharp without being heavy)
 *   gopSec       1.0  (snappy viewer pop-in)
 *   fps          25
 *
 * @param {object} args
 *   host, httpPort, username, password, deviceType   (connection)
 *   channel       1-based (default 1)
 *   bitrateKbps   target encoder bitrate in kbps (e.g. 4096 for 4 Mbps)
 *   gopSec        seconds between IDR frames
 *   fps           target frame rate (and used to derive gopFrames)
 *   profileToken  ONVIF only
 */
async function setEncoderConfig({
  host, httpPort = 80, username, password, deviceType,
  channel = 1, bitrateKbps = 4096, gopSec = 1, fps = 25, profileToken,
}) {
  const gopFrames = Math.max(1, Math.round(gopSec * fps));
  const fpsX100   = Math.max(100, Math.round(fps * 100));
  const args = { host, httpPort, username, password, channel, bitrateKbps, gopFrames, fps, fpsX100, profileToken };
  if (!vendors.isSupported(deviceType || 'hikvision')) {
    return { ok: false, error: `unsupported deviceType: ${deviceType}` };
  }
  switch (vendors.getDriver(deviceType || 'hikvision').encoderStrategy) {
    case 'hikvision': return setHikvisionEncoder(args);
    case 'dahua':     return setDahuaEncoder(args);
    case 'onvif':     return setOnvifEncoder(args);
    default:          return { ok: false, error: `encoder configuration not supported for deviceType: ${deviceType}` };
  }
}

/**
 * Unified keyframe-interval writer. Calculates `gopFrames` from `gopSec` × fps
 * if frames not given; defaults to 1 second of GOP for snappy viewer pop-in.
 *
 * @param {object} args  same connection bag as probe(), plus:
 *   channel       1-based channel index (default 1)
 *   gopSec        target GOP length in seconds (default 1)
 *   fps           assumed frame rate when computing gopFrames (default 25)
 *   profileToken  ONVIF only — token from GetProfiles
 */
async function setKeyframeInterval({
  host, httpPort = 80, username, password, deviceType,
  channel = 1, gopSec = 1, fps = 25, profileToken,
}) {
  const gopFrames = Math.max(1, Math.round(gopSec * fps));
  const args = { host, httpPort, username, password, channel, gopFrames, profileToken };
  if (!vendors.isSupported(deviceType || 'hikvision')) {
    return { ok: false, error: `unsupported deviceType: ${deviceType}` };
  }
  switch (vendors.getDriver(deviceType || 'hikvision').keyframeStrategy) {
    case 'hikvision': return setHikvisionKeyframeInterval(args);
    case 'dahua':     return setDahuaKeyframeInterval(args);
    case 'onvif':
      if (!profileToken) return { ok: false, error: 'ONVIF requires profileToken' };
      return setOnvifKeyframeInterval(args);
    default:          return { ok: false, error: `keyframe configuration not supported for deviceType: ${deviceType}` };
  }
}

module.exports = {
  probe,
  setKeyframeInterval,
  setEncoderConfig,
  // exposed for unit tests
  parseFlatXml,
  extractHikvisionChannels,
  parseDahuaKv,
};
