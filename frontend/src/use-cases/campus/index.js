import { productivityDefaults } from '../employee-productivity.params'
import { headcountDefaults } from '../headcount.params'

// Education / University campus vertical. SAME Activity Monitoring module as
// corporate and retail — only the parameters change. The presence of the
// `campus` param block is what makes the Activity Monitoring dashboard render
// its campus layout (hierarchy filters, student/faculty/library metrics) instead
// of the store/office layout; module code stays written-once.
export default {
  key: 'campus',
  label: 'Campus',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '08:00-18:00', // campus operating window
      lateAfter: '09:15',           // student/faculty late-to-class threshold
      breakGapSec: 900,
      // Campus-only knobs. Their presence flips the dashboard to the education
      // layout and drives the campus alert thresholds. The University → Building
      // → Department → Floor → Room hierarchy itself is dummy data in the module
      // (campus/data.js) until the campus directory API lands.
      campus: {
        presenceWindowSec: 120,     // last-seen window that counts as "present"
        attendanceTarget: 85,       // % — sessions below this flag low attendance
      },
      library: {
        capacity: 600,              // Central Library seating
        overcrowdAt: 380,           // reading-hall headcount that raises an alert
      },
      // Zone Headcount — same keys in every vertical, see ../headcount.params.js
      headcount: {
        ...headcountDefaults,
        dwellAlertSec: 1800,        // students are *meant* to sit in the library
        label: { site: 'Campus', area: 'Block', person: 'Student', people: 'students' },
        areas: ['All blocks', 'Academic', 'Residential', 'Sports'],
        zones: [
          { id: 'gate', label: 'Main Gate', type: 'gate', mode: 'line', area: 'Academic', cameraIds: ['cam-01', 'cam-02', 'cam-03'] },
          { id: 'lhA', label: 'Lecture Hall A', type: 'hall', mode: 'region', area: 'Academic', capacity: 180, cameraIds: ['cam-10', 'cam-11'] },
          { id: 'lhB', label: 'Lecture Hall B', type: 'hall', mode: 'region', area: 'Academic', capacity: 120, cameraIds: ['cam-12', 'cam-13'] },
          { id: 'lib', label: 'Central Library', type: 'library', mode: 'region', area: 'Academic', capacity: 240, cameraIds: ['cam-20', 'cam-21', 'cam-22', 'cam-23'] },
          { id: 'cant', label: 'Canteen', type: 'dining', mode: 'region', area: 'Academic', capacity: 150, cameraIds: ['cam-30', 'cam-31'] },
          { id: 'sport', label: 'Sports Complex', type: 'sports', mode: 'region', area: 'Sports', capacity: 200, cameraIds: ['cam-40', 'cam-41'] },
          { id: 'admin', label: 'Admin Block', type: 'office', mode: 'region', area: 'Academic', capacity: 50, cameraIds: ['cam-50'] },
          { id: 'hgate', label: 'Hostel Gate', type: 'gate', mode: 'line', area: 'Residential', cameraIds: ['cam-60'] },
        ],
      },
    },
  },
}
