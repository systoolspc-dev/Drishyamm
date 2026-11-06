// AI event → icon. Lives in a .js file, not .jsx, because a module that mixes
// components and constants breaks Fast Refresh.
//
// The Alerts screen carries its own copy today; this is the shared home for it
// so the two can converge without a screen importing from another screen.
const EVENT_ICON = {
  face: 'person-outline',
  face_match: 'person-outline',
  person: 'person-outline',
  crowd: 'people-outline',
  intrusion: 'log-in-outline',
  restricted: 'log-in-outline',
  loitering: 'walk-outline',
  weapon: 'warning-outline',
  fire: 'flame-outline',
  aggression: 'alert-circle-outline',
  anpr: 'car-outline',
  vehicle: 'car-outline',
  motion: 'walk-outline',
  doorbell: 'notifications-outline',
};

/** Matches on substring, so "restricted_area_entry" still resolves. */
export function eventIcon(eventType) {
  const t = String(eventType || '').toLowerCase();
  if (EVENT_ICON[t]) return EVENT_ICON[t];
  for (const key of Object.keys(EVENT_ICON)) {
    if (t.includes(key)) return EVENT_ICON[key];
  }
  return 'notifications-outline';
}

/** "Restricted Area Entry" from "restricted_area_entry". */
export const eventTitle = (eventType) =>
  String(eventType || 'detection').replace(/[_-]+/g, ' ').trim();
