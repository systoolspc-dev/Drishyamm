/**
 * codecSupport — what can THIS browser actually decode?
 *
 * WHY THIS EXISTS
 * ---------------
 * Most IP cameras publish H.265 (HEVC). For years no browser could decode it
 * through Media Source Extensions, so the server re-encoded every H.265 camera
 * to H.264 before a browser could see it. That transcode is expensive: it burns
 * a hardware encoder slot per camera (a hard ceiling on how many H.265 cameras
 * can be watched at once), costs a re-encode generation of quality, and adds
 * latency.
 *
 * That assumption is now out of date. Chromium has shipped HEVC-over-MSE by
 * default since v105, decoding through the platform's hardware decoder, so a
 * large share of real machines can play the camera's native stream directly.
 *
 * Support is a property of the MACHINE, not the browser version — it needs an
 * OS/GPU HEVC decoder (on Windows that can mean the HEVC Video Extensions are
 * installed). So we cannot infer it from a user-agent string; we have to ask.
 * The result is sent to the server, which serves native H.265 when we can take
 * it and transcodes only when we can't.
 *
 * Fails closed: anything unexpected ⇒ report "cannot decode" ⇒ server transcodes,
 * which is exactly the old behaviour.
 */

// Both fourccs matter. `hvc1` carries parameter sets in the sample entry and is
// what Apple/fMP4 tooling emits; `hev1` carries them in-band. A browser may
// accept one and not the other, so we treat either as success.
//
// The profile string is Main profile, level 3.1 — the baseline a CCTV H.265
// stream realistically uses. If a decoder handles this it handles typical
// camera output.
const HEVC_TYPES = [
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
];

let cached = null;   // probe once per page load; the answer cannot change

/**
 * True when this machine can decode H.265 in a fragmented-MP4 media source
 * (which is what our HLS delivery uses).
 */
export function canDecodeHevc() {
  if (cached !== null) return cached;

  try {
    // MediaSource is the decode path HLS.js uses. `video.canPlayType` is NOT a
    // valid substitute — it answers for progressive file playback and reports
    // support in cases where MSE playback still fails.
    const MS = typeof window !== 'undefined'
      ? (window.ManagedMediaSource || window.MediaSource)
      : null;

    cached = !!(MS && typeof MS.isTypeSupported === 'function'
      && HEVC_TYPES.some((t) => MS.isTypeSupported(t)));
  } catch {
    cached = false;   // fail closed → server transcodes
  }

  return cached;
}

/** Query-param form for the stream API: '1' when we can take H.265 natively. */
export function hevcParam() {
  return canDecodeHevc() ? '1' : undefined;
}
