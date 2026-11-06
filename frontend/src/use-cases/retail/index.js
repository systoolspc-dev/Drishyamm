import { productivityDefaults } from '../employee-productivity.params'
import { headcountDefaults, ZONE_TYPE_TEMPLATES } from '../headcount.params'

// Retail floor vertical: longer/later trading hours, stricter phone policy (staff
// shouldn't be on phones on the floor), and footfall matters here. SAME
// employee-productivity module as corporate — only the parameters change.
export default {
  key: 'retail',
  label: 'Retail',
  modules: ['employee-productivity', 'footfall', 'face', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '10:00-22:00',
      lateAfter: '10:15',
      // Trading-hours roster. The dashboard shows whichever of these contains
      // the current time (narrowest wins, so Evening beats the all-day span).
      shifts: [
        { id: 'full',    label: 'Full Day', start: '10:00', end: '22:00' },
        { id: 'morning', label: 'Morning',  start: '10:00', end: '16:00' },
        { id: 'evening', label: 'Evening',  start: '16:00', end: '22:00' },
      ],
      breakGapSec: 600,       // shorter breaks on the shop floor
      phone: { holdSec: 2.5, requireHand: true, violationSec: 30, escalateAfter: 3 }, // stricter — flag sooner
      // Retail-only knobs: floor zones + billing queues. Their presence is what
      // enables the Zone Coverage page — corporate omits them and the page hides.
      zones: { counterUnattendedSec: 300, coverageTargetPct: 80 }, // counter empty ≥ 5m → alert; an hour ≥ 80% staffed is compliant
      queue: { maxQueue: 5, serviceTimeSec: 90 }, // waiting > 5 or est. wait too long → alert
      // Zone Headcount — same keys in every vertical, see ../headcount.params.js
      headcount: {
        ...headcountDefaults,
        densityPerM2: 2.0,   // shoppers pack tighter than office workers
        dwellAlertSec: 300,  // 5m in the till queue = abandonment risk
        label: { site: 'Store', area: 'Section', person: 'Customer', people: 'customers' },
        sites: [
          { id: 'st-01', label: 'Phoenix Mall — Pune' },
          { id: 'st-02', label: 'MG Road — Bengaluru' },
          { id: 'st-03', label: 'Cyber Hub — Gurugram' },
        ],
        areas: ['Whole store', 'Front of house', 'Back of house'],
        zoneTypes: ZONE_TYPE_TEMPLATES.retail,
        zones: [
          { id: 'ent', label: 'Main Entrance', type: 'entrance', mode: 'line', area: 'Front of house', cameraIds: ['cam-01', 'cam-02'] },
          { id: 'bill-a', label: 'Billing Counter A', type: 'billing', mode: 'region', area: 'Front of house', capacity: 15, cameraIds: ['cam-05'] },
          { id: 'bill-b', label: 'Billing Counter B', type: 'billing', mode: 'region', area: 'Front of house', capacity: 15, cameraIds: ['cam-06'] },
          { id: 'till', label: 'Checkout Queue', type: 'queue', mode: 'region', area: 'Front of house', capacity: 25, cameraIds: ['cam-16'] },
          { id: 'app', label: 'Apparel Zone', type: 'sales-floor', mode: 'region', area: 'Front of house', capacity: 60, cameraIds: ['cam-10', 'cam-11'] },
          { id: 'elec', label: 'Electronics Display', type: 'high-value', mode: 'region', area: 'Front of house', capacity: 40, cameraIds: ['cam-12'] },
          { id: 'jew', label: 'Watches & Jewellery', type: 'high-value', mode: 'region', area: 'Front of house', capacity: 10, cameraIds: ['cam-18'] },
          { id: 'groc', label: 'Grocery Aisles', type: 'sales-floor', mode: 'region', area: 'Front of house', capacity: 90, cameraIds: ['cam-13', 'cam-14', 'cam-15'] },
          { id: 'fit', label: 'Fitting Rooms', type: 'fitting', mode: 'region', area: 'Front of house', capacity: 12, cameraIds: ['cam-17'] },
          { id: 'stock', label: 'Stock Room', type: 'stockroom', mode: 'region', area: 'Back of house', capacity: 6, cameraIds: ['cam-30'] },
          { id: 'side', label: 'Side Exit', type: 'entrance', mode: 'line', area: 'Back of house', cameraIds: ['cam-31'] },
        ],
      },
    },
  },
}
