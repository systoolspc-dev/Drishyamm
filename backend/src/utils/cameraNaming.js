 /**
 * cameraNaming.js — shared heuristics for camera channel naming.
 *
 * Used by onboarding (cameraGroup.controller.discoverChannelNames) and the
 * "refresh names" endpoint (deviceProbe.controller.syncNames) so they agree on
 * what counts as a "real" device name worth adopting.
 */

/**
 * Is a device-reported channel name a GENUINELY custom name, or a factory
 * default we should ignore in favour of the group-prefixed fallback?
 *
 * Rejects factory/placeholder labels: "Camera 01", "IP Camera 1", "CH1",
 * "Channel 01", "cam1", "IPC 1", and the common ONVIF profile labels
 * ("mainStream", "subStream", "Profile_1"). A bare "Camera 01" pulled from 30
 * different NVRs is ambiguous; the group-prefixed "<group> - Camera 01" is not.
 */
function isMeaningfulDeviceName(name) {
  if (!name) return false;
  const t = String(name).trim();
  if (!t) return false;
  if (/^(ip\s*)?camera[\s_-]*\d+$/i.test(t)) return false;   // Camera 01, IPCamera 1
  if (/^ch(annel)?[\s_-]*\d+$/i.test(t))     return false;   // CH1, Channel 01
  if (/^cam[\s_-]*\d+$/i.test(t))            return false;   // cam1
  if (/^ipc[\s_-]*\d+$/i.test(t))            return false;   // IPC 1
  if (/^(main|sub)\s*stream$/i.test(t))      return false;   // ONVIF mainStream/subStream
  if (/^profile[\s_-]*\d+$/i.test(t))        return false;   // ONVIF Profile_1
  return true;
}

module.exports = { isMeaningfulDeviceName };
