import { productivityDefaults } from '../employee-productivity.params'
import { headcountDefaults } from '../headcount.params'

// Hospitality (hotel) vertical. SAME Activity Monitoring module as the other
// verticals — only the parameters change. The `hospitality` param block flips
// the dashboard to the hotel layout (guest service, housekeeping, movement,
// safety, staff productivity) and gates the hospitality-only subpages. It's a
// 24×7 property, so hours span the day and guest-response SLAs matter.
export default {
  key: 'hospitality',
  label: 'Hospitality',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '00:00-24:00',
      hospitality: {
        responseTargetMin: 4,       // guest-response SLA (minutes)
        occupancyCapacity: 320,     // sellable rooms
        housekeepingSlaMin: 45,     // room turnaround target (minutes)
        restrictedAreas: ['Server Room', 'Chemical Storage', 'Loading Dock'],
      },
      // Zone Headcount — same keys in every vertical, see ../headcount.params.js
      headcount: {
        ...headcountDefaults,
        breachPct: 95,       // banquet halls carry a fire-code limit — warn early
        densityPerM2: 1.8,
        dwellAlertSec: 600,
        label: { site: 'Property', area: 'Wing', person: 'Guest', people: 'guests' },
        areas: ['Whole property', 'Public areas', 'Banquets', 'Leisure'],
        zones: [
          { id: 'port', label: 'Porte-cochère', type: 'gate', mode: 'line', area: 'Public areas', cameraIds: ['cam-01', 'cam-02'] },
          { id: 'lobby', label: 'Lobby', type: 'lobby', mode: 'region', area: 'Public areas', capacity: 90, cameraIds: ['cam-10', 'cam-11'] },
          { id: 'recep', label: 'Reception Queue', type: 'queue', mode: 'region', area: 'Public areas', capacity: 20, cameraIds: ['cam-12'] },
          { id: 'banq', label: 'Grand Banquet', type: 'hall', mode: 'region', area: 'Banquets', capacity: 400, cameraIds: ['cam-20', 'cam-21', 'cam-22'] },
          { id: 'rest', label: 'Restaurant', type: 'dining', mode: 'region', area: 'Public areas', capacity: 120, cameraIds: ['cam-30', 'cam-31'] },
          { id: 'pool', label: 'Pool Deck', type: 'leisure', mode: 'region', area: 'Leisure', capacity: 60, minOccupancy: 1, cameraIds: ['cam-40'] },
          { id: 'gym', label: 'Gym', type: 'sports', mode: 'region', area: 'Leisure', capacity: 30, cameraIds: ['cam-41'] },
          { id: 'spa', label: 'Spa', type: 'leisure', mode: 'region', area: 'Leisure', capacity: 18, cameraIds: ['cam-42'] },
        ],
      },
    },
  },
}
