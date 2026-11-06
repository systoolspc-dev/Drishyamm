import { GraduationCap, UserCheck, Building2, UserPlus, ShieldAlert, BadgeCheck } from 'lucide-react';
import { HOSTEL_DATA, metricCard } from '../data';
import { useHostelStore } from '../useHostelStore';
import { StatCards } from './bits';

const ICONS = { students: GraduationCap, staff: UserCheck, occupancy: Building2, visitors: UserPlus, safety: ShieldAlert, compliance: BadgeCheck };

export default function KeyMetrics() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = HOSTEL_DATA[hostel];
  const cards = [
    metricCard('students', 'Students Present', d.studentsPresent),
    metricCard('staff', 'Staff on Duty', d.staffOnDuty),
    { key: 'occupancy', label: 'Occupancy', value: `${d.hostelOccupancy.value}%`, sub: d.hostelOccupancy.deltaLabel },
    metricCard('visitors', 'Visitors', d.visitorCount),
    metricCard('safety', 'Safety Alerts', d.safetyAlerts),
    { key: 'compliance', label: 'Compliance Score', value: `${d.complianceScore.value}`, sub: d.complianceScore.deltaLabel },
  ];
  return <StatCards cards={cards} icons={ICONS} />;
}
