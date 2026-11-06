// The four report services the Reports hub offers, in catalog order. The
// catalog cards and the Federated Site Report dialog both read this list, so a
// service cannot be offered in one and missing from the other. Section ids
// match report-sections.js; every service exports as PDF, XLSX or CSV.
import { Activity, LayoutGrid, ShieldAlert, Users } from 'lucide-react';

export const REPORT_SERVICES = [
  {
    id: 'employees',
    icon: Users,
    title: () => 'Employee Productivity',
    description: 'Shift compliance, break time overstays, and phone distraction scores.',
  },
  {
    id: 'zones',
    icon: LayoutGrid,
    title: () => 'Zone Occupancy & Traffic',
    description: 'Hourly staffed-coverage heatmap, occupancy vs capacity, and unattended-zone logs.',
    unavailable: 'Zone tracking is not configured for this site type.',
  },
  {
    id: 'violations',
    icon: ShieldAlert,
    title: () => 'Policy Violations & Alerts',
    description: 'Unattended counters, queue length breaches, and security alerts.',
  },
  {
    id: 'health',
    icon: Activity,
    title: (site) => `${site} Health & Operational Compliance`,
    description: 'Overall shift health, staffing coverage, and SLA achievement.',
  },
];
