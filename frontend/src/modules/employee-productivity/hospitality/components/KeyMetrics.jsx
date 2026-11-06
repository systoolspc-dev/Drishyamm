import { Users, Clock, Sparkles, ShieldCheck, BedDouble, AlertTriangle } from 'lucide-react';
import { HOSPITALITY_DATA, metricCard } from '../data';
import { StatCards } from './bits';

const ICONS = { staff: Users, response: Clock, cleaning: Sparkles, compliance: ShieldCheck, occupancy: BedDouble, incidents: AlertTriangle };

export default function KeyMetrics() {
  const d = HOSPITALITY_DATA;
  const cards = [
    metricCard('staff', 'Active Staff', d.activeStaff),
    { key: 'response', label: 'Guest Response', value: d.guestResponseTime.value, sub: d.guestResponseTime.deltaLabel },
    { key: 'cleaning', label: 'Room Cleaning', value: d.roomCleaningTime.value, sub: d.roomCleaningTime.deltaLabel },
    { key: 'compliance', label: 'Compliance Score', value: `${d.complianceScore.value}%`, sub: d.complianceScore.deltaLabel },
    { key: 'occupancy', label: 'Occupancy', value: `${d.occupancy.value}%`, sub: d.occupancy.deltaLabel },
    { key: 'incidents', label: 'Open Incidents', value: `${d.openIncidents.value}`, sub: d.openIncidents.deltaLabel },
  ];
  return <StatCards cards={cards} icons={ICONS} />;
}
