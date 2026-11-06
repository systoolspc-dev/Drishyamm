import { productivityDefaults } from '../employee-productivity.params'
import { headcountDefaults } from '../headcount.params'

// Bank (branch) vertical. SAME Activity Monitoring module as the other verticals
// — only the parameters change. The `bank` param block flips the dashboard to the
// branch layout (teller queue, cash & vault ops, security, facility, staff
// productivity) and gates the bank-only subpages. Standard branch hours.
export default {
  key: 'bank',
  label: 'Bank',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '09:00-18:00',
      bank: {
        tellerSlaMin: 5,            // customer-wait SLA (minutes)
        maxQueue: 10,               // per-counter queue threshold
        vaultDualControl: true,     // dual-authorization required for vault access
        cashDrawerLimit: 200000,    // per-drawer cash cap (₹)
        restrictedZones: ['Vault', 'Server Room', 'Cash Room'],
      },
      // Zone Headcount — same keys in every vertical, see ../headcount.params.js
      headcount: {
        ...headcountDefaults,
        dwellAlertSec: 300,        // 5m at the teller line breaches the wait SLA
        label: { site: 'Branch', area: 'Area', person: 'Customer', people: 'customers' },
        areas: ['Whole branch', 'Public', 'Restricted'],
        zones: [
          { id: 'ent', label: 'Main Entrance', type: 'gate', mode: 'line', area: 'Public', cameraIds: ['cam-01', 'cam-02'] },
          { id: 'hall', label: 'Banking Hall', type: 'hall', mode: 'region', area: 'Public', capacity: 60, cameraIds: ['cam-10', 'cam-11'] },
          { id: 'queue', label: 'Teller Queue', type: 'queue', mode: 'region', area: 'Public', capacity: 20, cameraIds: ['cam-12'] },
          // minOccupancy encodes dual control: a lone person in the vault is a
          // breach even though the room is nearly empty. Only a headcount can
          // assert "there are at least two people here".
          { id: 'vault', label: 'Vault', type: 'secure', mode: 'region', area: 'Restricted', capacity: 4, minOccupancy: 2, cameraIds: ['cam-20', 'cam-21'] },
          { id: 'cash', label: 'Cash Room', type: 'secure', mode: 'region', area: 'Restricted', capacity: 6, minOccupancy: 2, cameraIds: ['cam-22'] },
          { id: 'atm', label: 'ATM Lobby', type: 'lobby', mode: 'region', area: 'Public', capacity: 8, cameraIds: ['cam-03'] },
          { id: 'cabin', label: 'Manager Cabins', type: 'office', mode: 'region', area: 'Public', capacity: 12, cameraIds: ['cam-13'] },
          { id: 'staff', label: 'Staff Entry', type: 'gate', mode: 'line', area: 'Restricted', cameraIds: ['cam-23'] },
        ],
      },
    },
  },
}
