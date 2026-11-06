import { productivityDefaults } from '../employee-productivity.params'
import { headcountDefaults, ZONE_TYPE_TEMPLATES } from '../headcount.params'

// Corporate office vertical: standard 9–6 day, phone use tolerated at desks,
// footfall not relevant. A use-case is just "which modules + what parameters".
export default {
  key: 'corporate',
  label: 'Corporate',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '09:00-18:00',
      lateAfter: '09:30',
      shifts: [
        { id: 'full',  label: 'Full Day', start: '09:00', end: '18:00' },
        { id: 'early', label: 'Early',    start: '08:00', end: '16:00' },
        { id: 'flexi', label: 'Flexi',    start: '11:00', end: '20:00' },
      ],
      breakGapSec: 900, // 15-min coffee/meeting gaps excluded from on-site time
      // Zone Headcount — same keys in every vertical, see ../headcount.params.js
      headcount: {
        ...headcountDefaults,
        dwellAlertSec: 900, // meeting rooms are meant to be sat in; alert late
        label: { site: 'Building', area: 'Floor', person: 'Employee', people: 'employees' },
        sites: [
          { id: 'hq-blr', label: 'HQ — Bengaluru' },
          { id: 'tp-pune', label: 'Tech Park — Pune' },
          { id: 'ch-ggn', label: 'Cyber Hub — Gurugram' },
        ],
        areas: ['All floors', 'Ground', 'Level 3', 'Level 4'],
        zoneTypes: ZONE_TYPE_TEMPLATES.corporate,
        zones: [
          { id: 'lobby', label: 'Reception Lobby', type: 'reception', mode: 'line', area: 'Ground', cameraIds: ['cam-01', 'cam-02'] },
          { id: 'wk3', label: 'Level 3 Workspace', type: 'workstation', mode: 'region', area: 'Level 3', capacity: 120, cameraIds: ['cam-10', 'cam-11', 'cam-12'] },
          { id: 'wk4', label: 'Level 4 Workspace', type: 'workstation', mode: 'region', area: 'Level 4', capacity: 120, cameraIds: ['cam-20', 'cam-21', 'cam-22'] },
          { id: 'mrA', label: 'Meeting Room A', type: 'conference', mode: 'region', area: 'Level 3', capacity: 12, cameraIds: ['cam-13'] },
          { id: 'mrB', label: 'Meeting Room B', type: 'conference', mode: 'region', area: 'Level 4', capacity: 8, cameraIds: ['cam-23'] },
          { id: 'exec', label: 'Executive Suite', type: 'executive', mode: 'region', area: 'Level 4', capacity: 6, cameraIds: ['cam-25'] },
          { id: 'caf', label: 'Cafeteria', type: 'cafeteria', mode: 'region', area: 'Ground', capacity: 80, cameraIds: ['cam-05', 'cam-06'] },
          { id: 'fx3', label: 'Fire Exit Corridor L3', type: 'fire-exit', mode: 'region', area: 'Level 3', capacity: 10, cameraIds: ['cam-14'] },
          { id: 'svr', label: 'Server Room', type: 'restricted', mode: 'region', area: 'Level 4', capacity: 4, minOccupancy: 2, cameraIds: ['cam-24'] },
          { id: 'park', label: 'Parking Lift Lobby', type: 'reception', mode: 'line', area: 'Ground', cameraIds: ['cam-03'] },
        ],
      },
    },
  },
}
