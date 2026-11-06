// Camera/stream metadata for Needs Attention rows — what the in-place
// CameraPreviewModal plays.
//
// FRONTEND-ONLY: the URLs are derived from the alert's camera + start time
// against a placeholder media host. When the backend lands,
// GET /activity/alerts returns these fields directly (clip pre-buffered around
// started_ts, live = the camera's HLS playlist) and this helper goes away.
const STREAM_BASE = 'https://stream.example.com';

/**
 * Attach cameraId / cameraName / timestamp / startTimeISO / clipUrl /
 * liveStreamUrl to each alert. Alerts with no attributable camera ("—") get
 * `cameraId: null`, and the panel hides the preview button for them.
 */
export function withCameraStreams(alerts, day) {
  return alerts.map((a) => {
    const hasCamera = a.camera && a.camera !== '—';
    return {
      ...a,
      cameraId: hasCamera ? a.camera : null,
      cameraName: hasCamera ? `${a.camera} · ${a.location}` : null,
      timestamp: `${a.since} IST`,
      startTimeISO: `${day}T${a.since}:00+05:30`,
      clipUrl: hasCamera ? `${STREAM_BASE}/clips/${a.camera}-${a.since.replace(':', '')}.mp4` : null,
      liveStreamUrl: hasCamera ? `${STREAM_BASE}/live/${a.camera}.m3u8` : null,
    };
  });
}

/**
 * Preview source for one Break & Idle log event: the clip pre-buffered at the
 * event's start (so the reviewer sees the moment it began), with live as the
 * alternative. `event` comes from summarizeDay() in ../break-idle.js.
 */
export function eventPreviewSource(event, { title, subtitle }) {
  if (!event.cameraId) return null;
  const hhmm = event.start.replace(':', '');
  return {
    cameraId: event.cameraId,
    cameraName: `${event.cameraId} · ${event.location}`,
    title,
    subtitle,
    timestamp: `${event.start} IST`,
    startTimeISO: `${event.date}T${event.start}:00+05:30`,
    clipUrl: `${STREAM_BASE}/clips/${event.cameraId}-${event.date.replaceAll('-', '')}-${hhmm}.mp4`,
    liveStreamUrl: `${STREAM_BASE}/live/${event.cameraId}.m3u8`,
  };
}

/**
 * Preview source for one Phone Usage detection: the clip pre-buffered at the
 * exact detection second, with live as the alternative. `ev` is a
 * PHONE_EVENTS row (date, ts "HH:MM:SS", camera, location).
 */
export function phonePreviewSource(ev, { title, subtitle }) {
  if (!ev.camera) return null;
  return {
    cameraId: ev.camera,
    cameraName: `${ev.camera} · ${ev.location}`,
    title,
    subtitle,
    timestamp: `${ev.ts} IST`,
    startTimeISO: `${ev.date}T${ev.ts}+05:30`,
    clipUrl: `${STREAM_BASE}/clips/${ev.camera}-${ev.date.replaceAll('-', '')}-${ev.ts.replaceAll(':', '')}.mp4`,
    liveStreamUrl: `${STREAM_BASE}/live/${ev.camera}.m3u8`,
  };
}

// Zone config writes camera ids as 'cam-05'; everything operator-facing says CAM-05.
export const cameraLabel = (id) => String(id).toUpperCase();

/**
 * Preview source for a zone at a past moment — the Peak Occupancy drill-in's
 * camera button: the zone's first camera, clip pre-buffered at the peak
 * (`date` "YYYY-MM-DD", `at` "HH:MM", IST), live as the alternative.
 */
export function zonePeakPreviewSource(zone, date, at, { subtitle } = {}) {
  const cam = zone.cameraIds?.[0];
  if (!cam) return null;
  const id = cameraLabel(cam);
  return {
    cameraId: id,
    cameraName: `${id} · ${zone.label}`,
    title: zone.label,
    subtitle: subtitle || `Peak occupancy · ${at} IST`,
    timestamp: `${at} IST`,
    startTimeISO: `${date}T${at}:00+05:30`,
    clipUrl: `${STREAM_BASE}/clips/${id}-${date.replaceAll('-', '')}-${at.replace(':', '')}.mp4`,
    liveStreamUrl: `${STREAM_BASE}/live/${id}.m3u8`,
  };
}

/**
 * Preview source for a Zone Headcount row: the zone's first camera, live only
 * (a zone is a place, not an event, so there is no clip to pre-buffer). The
 * playback deep link opens at `at`, the moment the operator clicked.
 */
export function zonePreviewSource(zone, at = new Date()) {
  const cam = zone.cameraIds?.[0];
  if (!cam) return null;
  const id = cameraLabel(cam);
  const more = zone.cameraIds.length - 1;
  return {
    cameraId: id,
    cameraName: `${id} · ${zone.label}`,
    title: zone.label,
    subtitle: `${zone.typeLabel || zone.type} · ${zone.area}${more > 0 ? ` · +${more} more camera${more === 1 ? '' : 's'} in this zone` : ''}`,
    timestamp: 'Now',
    startTimeISO: at.toISOString(),
    clipUrl: null,
    liveStreamUrl: `${STREAM_BASE}/live/${id}.m3u8`,
  };
}
