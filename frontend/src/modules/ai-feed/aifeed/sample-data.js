/**
 * sample-data.js — a realistic multi-site scene for reviewing the AI Feed
 * layout when the account has no cameras or no AI events yet.
 *
 * Opt-in only: the page enables it with `?demo=1`, and the header shows a
 * "Sample data" chip while it is on, so nobody mistakes it for the live
 * estate. Nothing here talks to a backend; the cameras carry no stream and
 * the events carry no snapshot, so the tiles draw the event's bounding box
 * on a placeholder scene instead of video.
 */

const SITE_HQ = 'site-hq';
const SITE_PLANT = 'site-plant';

export const SAMPLE_SITES = [
  { id: SITE_HQ,    name: 'Corporate HQ — Gurugram' },
  { id: SITE_PLANT, name: 'Manufacturing Plant — Manesar' },
];

// monitorId, name, location (group), site, models the card lists on hover
export const SAMPLE_CAMERAS = [
  { monitorId: 'demo-01', name: 'Main Gate - Entrance',     location: 'Main Gate',       siteId: SITE_HQ,    channel: 1, status: 'online',  models: ['ANPR', 'Vehicle Detection', 'Face Recognition'] },
  { monitorId: 'demo-02', name: 'Lobby - Main Building',    location: 'Lobby',           siteId: SITE_HQ,    channel: 2, status: 'online',  models: ['Face Recognition', 'Person Headcount'] },
  { monitorId: 'demo-03', name: 'Restricted Area - Zone A', location: 'Restricted Area', siteId: SITE_PLANT, channel: 3, status: 'online',  models: ['Restricted Zone', 'Person Tracking'] },
  { monitorId: 'demo-04', name: 'Factory Floor - Unit 1',   location: 'Factory Floor',   siteId: SITE_PLANT, channel: 4, status: 'online',  models: ['PPE Compliance', 'Person Headcount'] },
  { monitorId: 'demo-05', name: 'Cafeteria',                location: 'Cafeteria',       siteId: SITE_HQ,    channel: 5, status: 'online',  models: ['Crowd Density', 'Occupancy & Flow'] },
  { monitorId: 'demo-06', name: 'Parking Area - B1',        location: 'Parking',         siteId: SITE_HQ,    channel: 6, status: 'online',  models: ['ANPR', 'Vehicle Detection'] },
  { monitorId: 'demo-07', name: 'Warehouse - Loading Bay',  location: 'Warehouse',       siteId: SITE_PLANT, channel: 7, status: 'online',  models: ['Object Left Behind', 'Person Detection'] },
  { monitorId: 'demo-08', name: 'Perimeter - East Side',    location: 'Perimeter',       siteId: SITE_PLANT, channel: 8, status: 'online',  models: ['Line Crossing', 'Perimeter Intrusion'] },
  { monitorId: 'demo-09', name: 'Office - 2nd Floor',       location: 'Office',          siteId: SITE_HQ,    channel: 9, status: 'offline', models: ['Face Recognition'] },
];

// The bounding boxes are on a 1920×1080 frame; the placeholder scene draws
// them exactly where a live overlay would.
const F = { w: 1920, h: 1080 };

const PLATES = ['DL-01-MJ-8821', 'HR-26-DK-4410', 'UP-16-CA-7732', 'DL-3C-AX-1290', 'HR-51-BF-0067'];
const PEOPLE = ['Aastha Sharma', 'Rohit Verma', 'Priya Nair', 'Vikram Singh', 'Neha Gupta'];

// A template per event kind. `ago` is seconds before "now"; the generator
// spaces repeated templates out so the stream reads like a real half hour.
const TEMPLATES = [
  { cam: 'demo-03', eventType: 'zone.intrusion',   severity: 'critical', bbox: [1180, 320, 1360, 820], payload: { zoneName: 'Zone A · Switchgear' } },
  { cam: 'demo-08', eventType: 'line.cross',       severity: 'critical', bbox: [420, 380, 560, 860],   payload: { zoneName: 'East fence line' } },
  { cam: 'demo-08', eventType: 'perimeter.breach', severity: 'critical', bbox: [1420, 300, 1600, 800], payload: { zoneName: 'East fence line' } },
  { cam: 'demo-04', eventType: 'weapon.detected',  severity: 'critical', bbox: [860, 420, 1010, 640],  payload: { className: 'Long object' } },
  { cam: 'demo-05', eventType: 'crowd.density',    severity: 'warning',  bbox: [200, 260, 1500, 1000], payload: { count: 14, capacity: 12 } },
  { cam: 'demo-04', eventType: 'ppe.violation',    severity: 'warning',  bbox: [640, 300, 800, 780],   payload: { description: 'No helmet' } },
  { cam: 'demo-07', eventType: 'object.left',      severity: 'warning',  bbox: [980, 700, 1120, 820],  payload: { description: 'Bag unattended 4 min' } },
  { cam: 'demo-05', eventType: 'occupancy.threshold', severity: 'warning', bbox: null,               payload: { count: 13, capacity: 12, spaceName: 'Cafeteria' } },
  { cam: 'demo-02', eventType: 'person.match',     severity: 'info',     bbox: [880, 220, 1010, 400],  payload: {}, person: true },
  { cam: 'demo-02', eventType: 'person.unknown',   severity: 'info',     bbox: [520, 240, 640, 410],   payload: {} },
  { cam: 'demo-02', eventType: 'person.alert',     severity: 'critical', bbox: [1240, 210, 1370, 390], payload: {}, person: true },
  { cam: 'demo-02', eventType: 'person.headcount', severity: 'info',     bbox: null,                   payload: { count: 6 } },
  { cam: 'demo-04', eventType: 'person.headcount', severity: 'info',     bbox: null,                   payload: { count: 9 } },
  { cam: 'demo-07', eventType: 'person.detected',  severity: 'info',     bbox: [300, 380, 440, 900],   payload: {} },
  { cam: 'demo-01', eventType: 'vehicle.lpr',      severity: 'info',     bbox: [700, 620, 1020, 720],  payload: {}, plate: true },
  { cam: 'demo-01', eventType: 'vehicle.detected', severity: 'info',     bbox: [520, 360, 1280, 900],  payload: { vehicleType: 'SUV' } },
  { cam: 'demo-06', eventType: 'vehicle.lpr',      severity: 'info',     bbox: [1100, 640, 1380, 730], payload: {}, plate: true },
  { cam: 'demo-06', eventType: 'vehicle.detected', severity: 'info',     bbox: [900, 300, 1600, 880],  payload: { vehicleType: 'Hatchback' } },
  { cam: 'demo-03', eventType: 'person.tracked',   severity: 'info',     bbox: [640, 300, 780, 820],   payload: {}, person: true },
  { cam: 'demo-09', eventType: 'camera.offline',   severity: 'warning',  bbox: null,                   payload: {} },
];

let seq = 0;

function pick(list, i) {
  return list[i % list.length];
}

/** Build one sample event `ago` seconds in the past. */
export function sampleEvent(template, ago, now = Date.now()) {
  seq += 1;
  const cam = SAMPLE_CAMERAS.find((c) => c.monitorId === template.cam);
  const payload = { ...template.payload, frame_w: F.w, frame_h: F.h, camera_name: cam?.name };
  if (template.plate) payload.plate = pick(PLATES, seq);
  if (template.person) payload.matchedName = pick(PEOPLE, seq);
  const confidence = template.person ? 0.86 + ((seq * 7) % 12) / 100 : template.plate ? 0.9 + ((seq * 3) % 9) / 100 : null;
  return {
    id: `demo-evt-${seq}`,
    monitorId: template.cam,
    eventType: template.eventType,
    severity: template.severity,
    ts: new Date(now - ago * 1000).toISOString(),
    bbox: template.bbox,
    trackId: template.bbox ? `t${String(seq).padStart(6, '0')}` : null,
    confidence,
    payload,
    demo: true,
  };
}

/** ~40 events over the last 30 minutes, newest first. */
export function sampleEvents(now = Date.now()) {
  const out = [];
  let ago = 8;
  for (let i = 0; i < 42; i += 1) {
    const template = TEMPLATES[(i * 7) % TEMPLATES.length];
    out.push(sampleEvent(template, ago, now));
    ago += 20 + ((i * 13) % 70);
  }
  return out;
}

/** One fresh event for the live ticker, on a random template. */
export function nextSampleEvent(now = Date.now()) {
  const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return sampleEvent(template, 0, now);
}
