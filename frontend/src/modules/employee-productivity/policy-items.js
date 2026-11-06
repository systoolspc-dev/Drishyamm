// The active vertical's thresholds — the "why" behind every number the module
// shows. One source, two renderings: PolicyBar draws them as a strip under a
// page header, PolicyTip folds them into an ⓘ. Keeping the list here (rather
// than inside either component) stops the two from drifting apart, and keeps
// both files exporting nothing but components, which Fast Refresh requires.
//
// Values come from moduleParams(useCase, 'employee-productivity') — see
// src/use-cases/<vertical>/index.js. Returns [label, value] pairs already
// filtered to the keys this vertical actually defines.

export function policyItems(params) {
  return [
    ['Hours', params.businessHours],
    ['Late after', params.lateAfter],
    ['Break gap', params.breakGapSec ? `${Math.round(params.breakGapSec / 60)}m` : null],
    ['Max tea break', params.breaks?.teaMaxSec ? `${Math.round(params.breaks.teaMaxSec / 60)}m` : null],
    ['Max lunch break', params.breaks?.lunchMaxSec ? `${Math.round(params.breaks.lunchMaxSec / 60)}m` : null],
    ['Max idle / event', params.idleAlertSec ? `${Math.round(params.idleAlertSec / 60)}m` : null],
    ['Phone hold', params.phone && !params.campus && !params.school ? `${params.phone.holdSec}s${params.phone.requireHand ? ' · in-hand' : ''}` : null],
    ['Counter unattended', params.zones ? `${Math.round(params.zones.counterUnattendedSec / 60)}m` : null],
    ['Max queue', params.queue ? `${params.queue.maxQueue}` : null],
    ['Library capacity', params.library ? `${params.library.capacity}` : null],
    ['Attendance target', params.campus ? `${params.campus.attendanceTarget}%` : null],
    ['Attendance target', params.school ? `${params.school.attendanceTarget}%` : null],
    ['Curfew', params.hostel ? params.hostel.curfew : null],
    ['Capacity', params.hostel ? `${params.hostel.occupancyCapacity}` : null],
    ['Response target', params.hospitality ? `${params.hospitality.responseTargetMin}m` : null],
    ['Housekeeping SLA', params.hospitality ? `${params.hospitality.housekeepingSlaMin}m` : null],
    ['Rooms', params.hospitality ? `${params.hospitality.occupancyCapacity}` : null],
    ['Teller SLA', params.bank ? `${params.bank.tellerSlaMin}m` : null],
    ['Max queue', params.bank ? `${params.bank.maxQueue}` : null],
    ['Vault dual-auth', params.bank ? (params.bank.vaultDualControl ? 'required' : 'off') : null],
  ].filter(([, v]) => v);
}

// The same thresholds grouped the way HR reads them — one row per rule family
// instead of one per knob. Used by the Reports policy popover and written into
// the report exports, so what a manager sees and what payroll receives match.
// `site` is the vertical's word for a location ("Store", "Building").
export function policySummary(params, site = 'Store') {
  const min = (sec) => `${Math.round(sec / 60)}m`;
  const breaks = [
    params.breaks?.teaMaxSec ? `Max tea ${min(params.breaks.teaMaxSec)}` : null,
    params.breaks?.lunchMaxSec ? `Max lunch ${min(params.breaks.lunchMaxSec)}` : null,
    params.breakGapSec ? `Min gap ${min(params.breakGapSec)}` : null,
  ].filter(Boolean).join(' · ');

  return [
    [`${site} hours`, params.businessHours
      ? `${params.businessHours.replace('-', ' – ')}${params.lateAfter ? ` (grace until ${params.lateAfter})` : ''}`
      : null],
    ['Break thresholds', breaks || null],
    ['Max idle / event', params.idleAlertSec ? min(params.idleAlertSec) : null],
    ['Phone usage limit', params.phone
      ? `${params.phone.holdSec}s hold${params.phone.requireHand ? ' · active in-hand detection' : ''}`
      : null],
    ['Unattended counter limit', params.zones ? min(params.zones.counterUnattendedSec) : null],
    ['Max queue threshold', params.queue ? `${params.queue.maxQueue} customers` : null],
  ].filter(([, v]) => v);
}
