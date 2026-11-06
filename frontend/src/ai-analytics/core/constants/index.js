export const EVENT_TYPES = Object.freeze({
  WEAPON_DETECTED:     'weapon_detected',
  AGGRESSION_DETECTED: 'aggression_detected',
  FACE_MATCH:          'face_match',
  REID_MATCH:          'reid_match',
  VEHICLE_DETECTED:    'vehicle_detected',
  CROWD_OVERCROWDING:  'crowd_overcrowding',
  BOUNDARY_CROSSED:    'boundary_crossed',
  RESTRICTED_ENTRY:    'restricted_entry',
})

export const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH:     'high',
  WARNING:  'warning',
  INFO:     'info',
})

export const EVENT_STATUS = Object.freeze({
  ACTIVE:         'active',
  ACKNOWLEDGED:   'acknowledged',
  RESOLVED:       'resolved',
  FALSE_POSITIVE: 'false_positive',
})

export const SEVERITY_CONFIG = {
  critical: { label: 'CRITICAL', color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   border: '#ef4444' },
  high:     { label: 'HIGH',     color: '#b45309', bg: 'rgba(249,115,22,0.12)',  border: '#b45309' },
  warning:  { label: 'WARNING',  color: '#eab308', bg: 'rgba(234,179,8,0.12)',   border: '#eab308' },
  info:     { label: 'INFO',     color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  border: '#3b82f6' },
}

export const EVENT_TYPE_LABELS = {
  weapon_detected:     'Weapon Detected',
  aggression_detected: 'Aggression Detected',
  face_match:          'Face Match',
  reid_match:          'REID Match',
  vehicle_detected:    'Vehicle Detected',
  crowd_overcrowding:  'Crowd Overcrowding',
  boundary_crossed:    'Boundary Crossed',
  restricted_entry:    'Restricted Entry',
}

export const EVENT_TYPE_ICONS = {
  weapon_detected:     'report',
  aggression_detected: 'front_hand',
  face_match:          'face',
  reid_match:          'route',
  vehicle_detected:    'directions_car',
  crowd_overcrowding:  'groups_3',
  boundary_crossed:    'fence',
  restricted_entry:    'no_accounts',
}
