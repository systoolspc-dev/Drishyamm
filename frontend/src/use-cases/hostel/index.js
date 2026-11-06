import { productivityDefaults } from '../employee-productivity.params'
import { headcountDefaults } from '../headcount.params'

// Hostel (student residence) vertical. SAME Activity Monitoring module as the
// other verticals — only the parameters change. The `hostel` param block flips
// the dashboard to the hostel layout (workforce + facility monitoring: security,
// housekeeping, maintenance, dining, movement, safety) and gates the hostel-only
// subpages. It's a 24×7 residence, so hours span the day and curfew matters.
export default {
  key: 'hostel',
  label: 'Hostel',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '00:00-24:00',
      hostel: {
        curfew: '22:00',            // late-entry threshold
        occupancyCapacity: 680,     // beds (boys); girls read their own from data
        restrictedWings: ['Generator Room', 'Server Room', 'Opposite Wing'],
      },
      // Zone Headcount — same keys in every vertical, see ../headcount.params.js
      headcount: {
        ...headcountDefaults,
        dwellAlertSec: 600,
        label: { site: 'Hostel', area: 'Block', person: 'Resident', people: 'residents' },
        areas: ['All blocks', 'Block A', 'Block B', 'Common'],
        zones: [
          { id: 'gate', label: 'Main Gate', type: 'gate', mode: 'line', area: 'Common', cameraIds: ['cam-01', 'cam-02'] },
          { id: 'mess', label: 'Mess Hall', type: 'dining', mode: 'region', area: 'Common', capacity: 220, cameraIds: ['cam-10', 'cam-11'] },
          { id: 'comm', label: 'Common Room', type: 'lounge', mode: 'region', area: 'Common', capacity: 60, cameraIds: ['cam-12'] },
          { id: 'corrA', label: 'Block A Corridor', type: 'corridor', mode: 'region', area: 'Block A', capacity: 40, cameraIds: ['cam-20'] },
          { id: 'gym', label: 'Gym', type: 'sports', mode: 'region', area: 'Common', capacity: 25, cameraIds: ['cam-13'] },
          { id: 'study', label: 'Study Hall', type: 'library', mode: 'region', area: 'Common', capacity: 80, cameraIds: ['cam-14'] },
          { id: 'laun', label: 'Laundry', type: 'service', mode: 'region', area: 'Block B', capacity: 15, cameraIds: ['cam-30'] },
          { id: 'rear', label: 'Rear Gate', type: 'gate', mode: 'line', area: 'Block B', cameraIds: ['cam-31'] },
        ],
      },
    },
  },
}
