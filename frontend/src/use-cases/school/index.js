import { productivityDefaults } from '../employee-productivity.params'
import { headcountDefaults } from '../headcount.params'

// K-12 School vertical. SAME Activity Monitoring module as the other verticals —
// only the parameters change. The `school` param block flips the dashboard to
// the school layout (grade/section hierarchy, safety + transport + attendance
// focus) and gates the school-only subpages. Child-safety is the priority, so
// this vertical leans on gate/perimeter, visitor, transport and pickup analytics
// rather than the university's faculty/library depth.
export default {
  key: 'school',
  label: 'School',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '08:00-15:00', // school day
      lateAfter: '08:15',           // late-to-assembly threshold
      breakGapSec: 900,
      // School-only knobs. Their presence flips the dashboard to the school
      // layout and drives the safety / attendance / transport thresholds.
      school: {
        presenceWindowSec: 120,   // last-seen window that counts as "present"
        attendanceTarget: 90,     // % — sections below this flag low attendance
      },
      safety: {
        restrictedZones: ['Gate', 'Rooftop', 'Pool', 'Lab Store'],
        unattendedChildSec: 120,  // a child alone in a monitored zone ≥ this → alert
      },
      transport: {
        buses: 12,                // fleet size
        boardingWindowMin: 20,    // dismissal boarding window
      },
      // Zone Headcount — same keys in every vertical, see ../headcount.params.js
      headcount: {
        ...headcountDefaults,
        densityPerM2: 1.2,        // children crush more easily — tighter limit
        label: { site: 'School', area: 'Wing', person: 'Student', people: 'students' },
        areas: ['All wings', 'Primary', 'Middle', 'Senior', 'Sports Complex'],
        zones: [
          { id: 'gate', label: 'Main Gate', type: 'gate', mode: 'line', area: 'Primary', cameraIds: ['cam-01', 'cam-02'] },
          { id: 'c5a', label: 'Grade 5-A', type: 'classroom', mode: 'region', area: 'Primary', capacity: 36, cameraIds: ['cam-10'] },
          { id: 'lab', label: 'Science Lab 2', type: 'lab', mode: 'region', area: 'Senior', capacity: 30, minOccupancy: 1, cameraIds: ['cam-20', 'cam-21'] },
          { id: 'corr', label: 'Primary Corridor', type: 'corridor', mode: 'region', area: 'Primary', capacity: 60, cameraIds: ['cam-11', 'cam-12'] },
          { id: 'caf', label: 'Cafeteria', type: 'dining', mode: 'region', area: 'Middle', capacity: 180, cameraIds: ['cam-30', 'cam-31'] },
          { id: 'play', label: 'Playground', type: 'sports', mode: 'region', area: 'Sports Complex', capacity: 400, cameraIds: ['cam-40', 'cam-41', 'cam-42'] },
          { id: 'lib', label: 'Library', type: 'library', mode: 'region', area: 'Middle', capacity: 60, cameraIds: ['cam-32'] },
          { id: 'bus', label: 'Bus Bay', type: 'gate', mode: 'line', area: 'Primary', cameraIds: ['cam-03', 'cam-04'] },
        ],
      },
    },
  },
}
