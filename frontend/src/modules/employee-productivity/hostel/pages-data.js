// ── migrated from Hostel/src/Movementdata.js ──
// Mock data source for the Workforce Movement Analytics page.

export const MOVEMENT_DATA = {
  boys: {
    zoneTransitionCount: { value: 1842, deltaLabel: "+3.8% vs. yesterday" },
    restrictedAreaEntry: { value: 1, deltaLabel: "1 resolved" },
    congestionDetection: { value: 2, deltaLabel: "zones flagged today" },
    zoneCompliance: [
      { zone: "Block A", compliance: 96 },
      { zone: "Block B", compliance: 91 },
      { zone: "Mess hall", compliance: 88 },
      { zone: "Reception / gate", compliance: 98 },
      { zone: "Maintenance workshop", compliance: 84 },
    ],
    areaCoverage: { value: "94%", deltaLabel: "of zones actively monitored" },
    movementEvents: [
      { type: "Restricted area entry", detail: "Non-authorized staff detected near server room", level: "high", time: "11:20 AM" },
      { type: "Congestion", detail: "Mess hall at 92% capacity, sustained 12+ min", level: "medium", time: "1:05 PM" },
      { type: "Off-zone staff", detail: "Housekeeping staff detected outside Block A assignment", level: "low", time: "9:40 AM" },
    ],
  },
  girls: {
    zoneTransitionCount: { value: 1420, deltaLabel: "+1.9% vs. yesterday" },
    restrictedAreaEntry: { value: 0, deltaLabel: "none today" },
    congestionDetection: { value: 1, deltaLabel: "zone flagged today" },
    zoneCompliance: [
      { zone: "Block A", compliance: 97 },
      { zone: "Block B", compliance: 95 },
      { zone: "Mess hall", compliance: 93 },
      { zone: "Reception / gate", compliance: 99 },
      { zone: "Maintenance workshop", compliance: 90 },
    ],
    areaCoverage: { value: "97%", deltaLabel: "of zones actively monitored" },
    movementEvents: [
      { type: "Congestion", detail: "Mess hall at 88% capacity, sustained 8+ min", level: "low", time: "12:50 PM" },
      { type: "Off-zone staff", detail: "Maintenance staff detected outside assigned block", level: "low", time: "10:15 AM" },
    ],
  },
};
// ── migrated from Hostel/src/Diningdata.js ──
// Mock data source for the Mess & Dining Analytics page.

export const DINING_DATA = {
  boys: {
    studentWaitingTime: { value: "6m 20s", deltaLabel: "-40s vs. avg" },
    queueLength: { value: 14, deltaLabel: "peak this hour" },
    counterAvailability: { value: 4, of: 5, deltaLabel: "1 closed for refill" },
    servingTime: { value: "38s", deltaLabel: "per student, avg" },
    diningHallOccupancy: { value: 72, deltaLabel: "of seating capacity" },
    mealTrend: [
      { meal: "Breakfast", waitingMin: 4, queueLength: 8 },
      { meal: "Lunch", waitingMin: 7, queueLength: 16 },
      { meal: "Snacks", waitingMin: 3, queueLength: 6 },
      { meal: "Dinner", waitingMin: 6, queueLength: 14 },
    ],
    counters: [
      { name: "Counter 1 — Main course", status: "open", queue: 5 },
      { name: "Counter 2 — Rice & bread", status: "open", queue: 4 },
      { name: "Counter 3 — Beverages", status: "open", queue: 2 },
      { name: "Counter 4 — Salad & sides", status: "closed", queue: 0 },
      { name: "Counter 5 — Dessert", status: "open", queue: 3 },
    ],
  },
  girls: {
    studentWaitingTime: { value: "5m 05s", deltaLabel: "-25s vs. avg" },
    queueLength: { value: 10, deltaLabel: "peak this hour" },
    counterAvailability: { value: 4, of: 4, deltaLabel: "all open" },
    servingTime: { value: "32s", deltaLabel: "per student, avg" },
    diningHallOccupancy: { value: 65, deltaLabel: "of seating capacity" },
    mealTrend: [
      { meal: "Breakfast", waitingMin: 3, queueLength: 6 },
      { meal: "Lunch", waitingMin: 5, queueLength: 12 },
      { meal: "Snacks", waitingMin: 2, queueLength: 4 },
      { meal: "Dinner", waitingMin: 5, queueLength: 10 },
    ],
    counters: [
      { name: "Counter 1 — Main course", status: "open", queue: 3 },
      { name: "Counter 2 — Rice & bread", status: "open", queue: 3 },
      { name: "Counter 3 — Beverages", status: "open", queue: 1 },
      { name: "Counter 4 — Dessert", status: "open", queue: 2 },
    ],
  },
};
// ── migrated from Hostel/src/Housekeepingdata.js ──
// Mock data source for the Housekeeping Analytics page.

export const HOUSEKEEPING_DATA = {
  boys: {
    floorCleaningDuration: { value: "42 min", deltaLabel: "-3 min vs. avg" },
    washroomCleaningDuration: { value: "26 min", deltaLabel: "+1 min vs. avg" },
    commonAreaCleaningTime: { value: "34 min", deltaLabel: "steady" },
    activeWorkingTime: { value: "5h 10m", deltaLabel: "82% of shift" },
    idleTime: { value: "1h 8m", deltaLabel: "18% of shift" },
    routeCoverage: { value: 88, deltaLabel: "+4% vs. yesterday" },
    activeIdleByStaff: [
      { name: "R. Kumar", active: 312, idle: 68 },
      { name: "S. Yadav", active: 288, idle: 92 },
      { name: "M. Prasad", active: 340, idle: 40 },
      { name: "A. Verma", active: 265, idle: 115 },
    ],
    zoneCoverage: [
      { zone: "Block A — Floors 1-4", coverage: 100, status: "done" },
      { zone: "Block B — Floors 1-4", coverage: 70, status: "in-progress" },
      { zone: "Common washrooms", coverage: 100, status: "done" },
      { zone: "Mess hall", coverage: 0, status: "pending" },
      { zone: "Recreation room", coverage: 100, status: "done" },
    ],
  },
  girls: {
    floorCleaningDuration: { value: "38 min", deltaLabel: "-1 min vs. avg" },
    washroomCleaningDuration: { value: "24 min", deltaLabel: "-2 min vs. avg" },
    commonAreaCleaningTime: { value: "30 min", deltaLabel: "steady" },
    activeWorkingTime: { value: "5h 32m", deltaLabel: "88% of shift" },
    idleTime: { value: "0h 46m", deltaLabel: "12% of shift" },
    routeCoverage: { value: 95, deltaLabel: "+2% vs. yesterday" },
    activeIdleByStaff: [
      { name: "P. Sharma", active: 330, idle: 50 },
      { name: "K. Devi", active: 350, idle: 30 },
      { name: "N. Reddy", active: 305, idle: 75 },
    ],
    zoneCoverage: [
      { zone: "Block A — Floors 1-3", coverage: 100, status: "done" },
      { zone: "Block B — Floors 1-3", coverage: 100, status: "done" },
      { zone: "Common washrooms", coverage: 60, status: "in-progress" },
      { zone: "Mess hall", coverage: 100, status: "done" },
      { zone: "Reading room", coverage: 0, status: "pending" },
    ],
  },
};
// ── migrated from Hostel/src/Maintenancedata.js ──
// Mock data source for the Maintenance Analytics page.

export const MAINTENANCE_DATA = {
  boys: {
    complaintResponseTime: { value: "22 min", deltaLabel: "-4 min vs. avg" },
    repairCompletionTime: { value: "3h 12m", deltaLabel: "+18 min vs. avg" },
    activeRepairDuration: { value: "1h 40m", deltaLabel: "avg per open task" },
    pendingTasks: { value: 6, deltaLabel: "2 high priority" },
    repeatVisits: { value: 3, deltaLabel: "this month" },
    responseTrend: [
      { day: "Mon", minutes: 28 },
      { day: "Tue", minutes: 24 },
      { day: "Wed", minutes: 30 },
      { day: "Thu", minutes: 19 },
      { day: "Fri", minutes: 22 },
      { day: "Sat", minutes: 26 },
      { day: "Sun", minutes: 21 },
    ],
    tasks: [
      { task: "Leaking tap", room: "Block A, Room 214", assignee: "Ramesh (Plumber)", status: "in-progress", logged: "10:22 AM" },
      { task: "Fan repair", room: "Block B, Room 108", assignee: "Suresh (Electrician)", status: "pending", logged: "11:05 AM" },
      { task: "Corridor light", room: "Block A, Floor 3", assignee: "Suresh (Electrician)", status: "done", logged: "9:15 AM" },
      { task: "Door lock", room: "Block C, Room 302", assignee: "Vikram (Carpenter)", status: "pending", logged: "1:40 PM" },
      { task: "Water heater", room: "Block B, Room 220", assignee: "Ramesh (Plumber)", status: "pending", logged: "2:10 PM" },
      { task: "Window latch", room: "Block A, Room 118", assignee: "Vikram (Carpenter)", status: "done", logged: "8:50 AM" },
    ],
  },
  girls: {
    complaintResponseTime: { value: "18 min", deltaLabel: "-2 min vs. avg" },
    repairCompletionTime: { value: "2h 45m", deltaLabel: "-10 min vs. avg" },
    activeRepairDuration: { value: "1h 15m", deltaLabel: "avg per open task" },
    pendingTasks: { value: 3, deltaLabel: "0 high priority" },
    repeatVisits: { value: 1, deltaLabel: "this month" },
    responseTrend: [
      { day: "Mon", minutes: 20 },
      { day: "Tue", minutes: 18 },
      { day: "Wed", minutes: 22 },
      { day: "Thu", minutes: 16 },
      { day: "Fri", minutes: 19 },
      { day: "Sat", minutes: 17 },
      { day: "Sun", minutes: 15 },
    ],
    tasks: [
      { task: "AC servicing", room: "Block A, Room 112", assignee: "Maintenance Supervisor", status: "in-progress", logged: "10:05 AM" },
      { task: "Window latch", room: "Block B, Room 204", assignee: "Authorized Carpenter", status: "done", logged: "9:20 AM" },
      { task: "Water cooler", room: "Ground floor", assignee: "Authorized Plumber", status: "pending", logged: "12:30 PM" },
    ],
  },
};
// ── migrated from Hostel/src/Securitydata.js ──
// Mock data source for the Security & Access Analytics page.
// Swap for real API data later — structure mirrors hostelData.js.

export const SECURITY_DATA = {
  boys: {
    entryVerificationTime: { value: "18s", deltaLabel: "-2s vs. yesterday" },
    visitorWaitingTime: { value: "3m 40s", deltaLabel: "+0.4m vs. avg" },
    studentEntryExit: { value: 412, deltaLabel: "218 in · 194 out" },
    unauthorizedEntry: { value: 2, deltaLabel: "both resolved" },
    lateNightEntry: { value: 7, deltaLabel: "after 10 PM" },
    securityStaffAvailability: { value: 9, of: 11, deltaLabel: "2 on break" },
    verificationTrend: [
      { time: "6am", avgSeconds: 14 },
      { time: "8am", avgSeconds: 22 },
      { time: "10am", avgSeconds: 16 },
      { time: "12pm", avgSeconds: 19 },
      { time: "2pm", avgSeconds: 15 },
      { time: "4pm", avgSeconds: 18 },
      { time: "6pm", avgSeconds: 26 },
      { time: "8pm", avgSeconds: 20 },
      { time: "10pm", avgSeconds: 24 },
    ],
    incidents: [
      { type: "Unauthorized entry", detail: "Tailgating attempt, Main Gate", level: "high", time: "9:42 PM" },
      { type: "Late night entry", detail: "Student returned after curfew, Gate 2", level: "medium", time: "10:58 PM" },
      { type: "Unauthorized entry", detail: "Non-resident attempted entry, Gate 1", level: "high", time: "6:15 PM" },
      { type: "Visitor overstay", detail: "Visitor exceeded 60 min limit", level: "low", time: "4:20 PM" },
    ],
  },
  girls: {
    entryVerificationTime: { value: "21s", deltaLabel: "+1s vs. yesterday" },
    visitorWaitingTime: { value: "2m 55s", deltaLabel: "-0.3m vs. avg" },
    studentEntryExit: { value: 356, deltaLabel: "180 in · 176 out" },
    unauthorizedEntry: { value: 0, deltaLabel: "none today" },
    lateNightEntry: { value: 2, deltaLabel: "after 10 PM" },
    securityStaffAvailability: { value: 8, of: 9, deltaLabel: "1 on break" },
    verificationTrend: [
      { time: "6am", avgSeconds: 16 },
      { time: "8am", avgSeconds: 24 },
      { time: "10am", avgSeconds: 18 },
      { time: "12pm", avgSeconds: 20 },
      { time: "2pm", avgSeconds: 17 },
      { time: "4pm", avgSeconds: 19 },
      { time: "6pm", avgSeconds: 23 },
      { time: "8pm", avgSeconds: 21 },
      { time: "10pm", avgSeconds: 22 },
    ],
    incidents: [
      { type: "Late night entry", detail: "Student returned after curfew, Reception", level: "medium", time: "10:12 PM" },
      { type: "Visitor overstay", detail: "Visitor exceeded 60 min limit", level: "low", time: "5:05 PM" },
    ],
  },
};
// ── migrated from Hostel/src/Safetydata.js ──
// Mock data source for the Safety & Compliance Analytics page.

export const SAFETY_DATA = {
  boys: {
    uniformCompliance: { value: "93%", deltaLabel: "+0.5pt vs. yesterday" },
    ppeComplianceHousekeeping: { value: "89%", deltaLabel: "+1.2pt vs. yesterday" },
    restrictedAreaEntry: { value: 1, deltaLabel: "1 resolved" },
    emergencyResponseTime: { value: "2m 15s", deltaLabel: "-8s vs. avg" },
    safetyViolationCount: { value: 4, deltaLabel: "-1 vs. yesterday" },
    checkpoints: [
      { point: "Main gate — fire extinguisher", status: "done", updated: "8:00 AM" },
      { point: "Block A — emergency exit", status: "done", updated: "8:10 AM" },
      { point: "Block B — emergency exit", status: "in-progress", updated: "10:30 AM" },
      { point: "Kitchen — fire suppression", status: "done", updated: "7:45 AM" },
      { point: "Generator room — access log", status: "pending", updated: "—" },
    ],
    incidents: [
      { type: "PPE violation", detail: "Housekeeping staff without gloves, Block B corridor", level: "medium", time: "10:05 AM" },
      { type: "Uniform violation", detail: "Security guard without ID badge, Main gate", level: "low", time: "8:30 AM" },
      { type: "Restricted area entry", detail: "Unbadged entry near generator room", level: "high", time: "11:40 AM" },
    ],
  },
  girls: {
    uniformCompliance: { value: "96%", deltaLabel: "+0.3pt vs. yesterday" },
    ppeComplianceHousekeeping: { value: "94%", deltaLabel: "+0.8pt vs. yesterday" },
    restrictedAreaEntry: { value: 0, deltaLabel: "none today" },
    emergencyResponseTime: { value: "1m 58s", deltaLabel: "-4s vs. avg" },
    safetyViolationCount: { value: 1, deltaLabel: "-2 vs. yesterday" },
    checkpoints: [
      { point: "Main gate — fire extinguisher", status: "done", updated: "7:55 AM" },
      { point: "Block A — emergency exit", status: "done", updated: "8:05 AM" },
      { point: "Block B — emergency exit", status: "done", updated: "8:20 AM" },
      { point: "Kitchen — fire suppression", status: "done", updated: "7:40 AM" },
      { point: "Reception — visitor log", status: "in-progress", updated: "9:15 AM" },
    ],
    incidents: [
      { type: "Uniform violation", detail: "Housekeeping staff without apron, Mess hall", level: "low", time: "9:20 AM" },
    ],
  },
};
// ── migrated from Hostel/src/Staffdata.js ──
// Mock data source for the Staff Roles roster + Employee Detail page.
// Role lists per hostel type reflect the Boys Hostel / Girls Hostel staff
// breakdown from the workforce analytics spec.

export const STAFF_DATA = {
  boys: [
    {
      id: "b-warden-rao", name: "K. Ramesh Rao", role: "Chief Warden", dept: "Administration",
      status: "active", employeeId: "BH-1001", scheduledShift: "9:00 AM – 6:00 PM", actualClockIn: "8:52 AM",
      activePct: 71, complianceScore: 97, tasksAssigned: 6, tasksCompleted: 6,
    },
    {
      id: "b-warden-iyer", name: "S. Iyer", role: "Hostel Warden", dept: "Administration",
      status: "active", employeeId: "BH-1014", scheduledShift: "8:00 AM – 8:00 PM", actualClockIn: "7:58 AM",
      activePct: 78, complianceScore: 95, tasksAssigned: 10, tasksCompleted: 8,
    },
    {
      id: "b-sec-sup-nair", name: "Vikram Nair", role: "Security Supervisor", dept: "Security",
      status: "active", employeeId: "BH-2003", scheduledShift: "6:00 AM – 2:00 PM", actualClockIn: "5:57 AM",
      activePct: 88, complianceScore: 96, tasksAssigned: 14, tasksCompleted: 13,
    },
    {
      id: "b-sec-guard-ali", name: "Mohammed Ali", role: "Security Guard", dept: "Security",
      status: "active", employeeId: "BH-2041", scheduledShift: "10:00 PM – 6:00 AM", actualClockIn: "9:56 PM",
      activePct: 82, complianceScore: 91, tasksAssigned: 8, tasksCompleted: 7,
    },
    {
      id: "b-gate-op-singh", name: "Harpreet Singh", role: "Gate Operator", dept: "Security",
      status: "break", employeeId: "BH-2077", scheduledShift: "6:00 AM – 2:00 PM", actualClockIn: "6:04 AM",
      activePct: 65, complianceScore: 89, tasksAssigned: 5, tasksCompleted: 4,
    },
    {
      id: "b-hk-sup-yadav", name: "R. Yadav", role: "Housekeeping Supervisor", dept: "Housekeeping",
      status: "active", employeeId: "BH-3002", scheduledShift: "7:00 AM – 3:00 PM", actualClockIn: "6:59 AM",
      activePct: 74, complianceScore: 90, tasksAssigned: 12, tasksCompleted: 10,
    },
    {
      id: "b-hk-staff-kumar", name: "R. Kumar", role: "Housekeeping Staff", dept: "Housekeeping",
      status: "active", employeeId: "BH-3018", scheduledShift: "7:00 AM – 3:00 PM", actualClockIn: "7:10 AM",
      activePct: 69, complianceScore: 84, tasksAssigned: 16, tasksCompleted: 14,
    },
    {
      id: "b-elec-suresh", name: "Suresh", role: "Electrician", dept: "Maintenance",
      status: "active", employeeId: "BH-4005", scheduledShift: "9:00 AM – 5:00 PM", actualClockIn: "9:03 AM",
      activePct: 61, complianceScore: 93, tasksAssigned: 6, tasksCompleted: 4,
    },
    {
      id: "b-plumber-ramesh", name: "Ramesh", role: "Plumber", dept: "Maintenance",
      status: "offline", employeeId: "BH-4012", scheduledShift: "9:00 AM – 5:00 PM", actualClockIn: "—",
      activePct: 0, complianceScore: 88, tasksAssigned: 6, tasksCompleted: 5,
    },
    {
      id: "b-mess-mgr-joshi", name: "P. Joshi", role: "Mess Manager", dept: "Mess & Dining",
      status: "active", employeeId: "BH-5001", scheduledShift: "5:30 AM – 2:00 PM", actualClockIn: "5:28 AM",
      activePct: 85, complianceScore: 94, tasksAssigned: 9, tasksCompleted: 9,
    },
    {
      id: "b-serving-lal", name: "B. Lal", role: "Serving Staff", dept: "Mess & Dining",
      status: "active", employeeId: "BH-5019", scheduledShift: "6:30 AM – 9:30 AM, 6:30 PM – 9:30 PM", actualClockIn: "6:32 AM",
      activePct: 72, complianceScore: 90, tasksAssigned: 4, tasksCompleted: 4,
    },
  ],
  girls: [
    {
      id: "g-warden-menon", name: "Latha Menon", role: "Chief Warden", dept: "Administration",
      status: "active", employeeId: "GH-1001", scheduledShift: "9:00 AM – 6:00 PM", actualClockIn: "8:50 AM",
      activePct: 74, complianceScore: 98, tasksAssigned: 6, tasksCompleted: 6,
    },
    {
      id: "g-warden-fernandes", name: "M. Fernandes", role: "Resident Warden", dept: "Administration",
      status: "active", employeeId: "GH-1015", scheduledShift: "Resident, on-call", actualClockIn: "On premises",
      activePct: 80, complianceScore: 97, tasksAssigned: 8, tasksCompleted: 7,
    },
    {
      id: "g-sec-sup-devi", name: "K. Devi", role: "Female Security Supervisor", dept: "Security",
      status: "active", employeeId: "GH-2004", scheduledShift: "6:00 AM – 2:00 PM", actualClockIn: "5:59 AM",
      activePct: 90, complianceScore: 97, tasksAssigned: 12, tasksCompleted: 12,
    },
    {
      id: "g-sec-guard-priya", name: "P. Priya", role: "Female Security Guard", dept: "Security",
      status: "active", employeeId: "GH-2038", scheduledShift: "10:00 PM – 6:00 AM", actualClockIn: "9:58 PM",
      activePct: 84, complianceScore: 95, tasksAssigned: 8, tasksCompleted: 8,
    },
    {
      id: "g-reception-anjali", name: "Anjali Rao", role: "Reception Staff", dept: "Security",
      status: "active", employeeId: "GH-2061", scheduledShift: "8:00 AM – 4:00 PM", actualClockIn: "7:57 AM",
      activePct: 76, complianceScore: 93, tasksAssigned: 10, tasksCompleted: 9,
    },
    {
      id: "g-hk-sup-sharma", name: "P. Sharma", role: "Housekeeping Supervisor", dept: "Housekeeping",
      status: "active", employeeId: "GH-3002", scheduledShift: "7:00 AM – 3:00 PM", actualClockIn: "6:58 AM",
      activePct: 79, complianceScore: 93, tasksAssigned: 12, tasksCompleted: 12,
    },
    {
      id: "g-hk-staff-devi2", name: "K. Devi (Housekeeping)", role: "Housekeeping Staff", dept: "Housekeeping",
      status: "break", employeeId: "GH-3021", scheduledShift: "7:00 AM – 3:00 PM", actualClockIn: "7:05 AM",
      activePct: 68, complianceScore: 91, tasksAssigned: 14, tasksCompleted: 14,
    },
    {
      id: "g-maint-sup-nanda", name: "R. Nanda", role: "Maintenance Supervisor", dept: "Maintenance",
      status: "active", employeeId: "GH-4001", scheduledShift: "9:00 AM – 5:00 PM", actualClockIn: "9:00 AM",
      activePct: 63, complianceScore: 92, tasksAssigned: 7, tasksCompleted: 6,
    },
    {
      id: "g-elec-verma", name: "S. Verma", role: "Electrician (Authorized Access)", dept: "Maintenance",
      status: "offline", employeeId: "GH-4014", scheduledShift: "9:00 AM – 5:00 PM", actualClockIn: "—",
      activePct: 0, complianceScore: 90, tasksAssigned: 5, tasksCompleted: 4,
    },
    {
      id: "g-mess-mgr-kaur", name: "H. Kaur", role: "Mess Manager", dept: "Mess & Dining",
      status: "active", employeeId: "GH-5001", scheduledShift: "5:30 AM – 2:00 PM", actualClockIn: "5:27 AM",
      activePct: 87, complianceScore: 96, tasksAssigned: 9, tasksCompleted: 9,
    },
    {
      id: "g-serving-meera", name: "Meera S.", role: "Serving Staff", dept: "Mess & Dining",
      status: "active", employeeId: "GH-5022", scheduledShift: "6:30 AM – 9:30 AM, 6:30 PM – 9:30 PM", actualClockIn: "6:31 AM",
      activePct: 75, complianceScore: 92, tasksAssigned: 4, tasksCompleted: 4,
    },
  ],
};

// Deterministic pseudo-random generator, seeded by employee id, so each
// employee's history is stable across renders instead of reshuffling.
function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  return function () {
    h = (h * 9301 + 49297) % 233280;
    return h / 233280;
  };
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// 7 days of active% history around the employee's current level.
export function generateActivityTrend(employee) {
  const rand = seededRandom(employee.id + "-trend");
  return DAY_LABELS.map((label) => {
    const wobble = (rand() - 0.5) * 22;
    return {
      label,
      activePct: Math.max(15, Math.min(100, Math.round(employee.activePct + wobble))),
    };
  });
}

const TASK_TEMPLATES = {
  Security: ["Gate rounds", "Visitor log review", "CCTV spot-check", "Late-entry follow-up"],
  Housekeeping: ["Floor cleaning", "Washroom cleaning", "Common area cleaning", "Route coverage check"],
  Maintenance: ["Complaint response", "Repair task", "Preventive check", "Parts inventory"],
  "Mess & Dining": ["Counter setup", "Serving shift", "Inventory check", "Hygiene checklist"],
  Administration: ["Resident check-in review", "Staff roster review", "Incident sign-off", "Parent call follow-up"],
};

export function generateAssignedTasks(employee) {
  const rand = seededRandom(employee.id + "-tasks");
  const templates = TASK_TEMPLATES[employee.dept] || TASK_TEMPLATES.Administration;
  return templates.map((task) => {
    const target = 2 + Math.floor(rand() * 4);
    const completed = Math.max(0, Math.min(target, Math.round(target * (0.6 + rand() * 0.4))));
    return { task, completed, target };
  });
}

const MOVEMENT_ZONES = ["Main gate", "Block A", "Block B", "Mess hall", "Reception", "Maintenance workshop"];

export function generateMovementHistory(employee) {
  const rand = seededRandom(employee.id + "-movement");
  const count = 3 + Math.floor(rand() * 3);
  const history = [];
  for (let i = 0; i < count; i++) {
    const zone = MOVEMENT_ZONES[Math.floor(rand() * MOVEMENT_ZONES.length)];
    const hour = 6 + Math.floor(rand() * 14);
    const minute = Math.floor(rand() * 60);
    const displayHour = hour > 12 ? hour - 12 : hour;
    const meridiem = hour >= 12 ? "PM" : "AM";
    history.push({ zone, time: `${displayHour}:${String(minute).padStart(2, "0")} ${meridiem}` });
  }
  return history.sort((a, b) => a.time.localeCompare(b.time));
}

const ALERT_TEMPLATES = [
  { type: "Late clock-in", level: "low", detail: "Clocked in after scheduled shift start" },
  { type: "Uniform compliance flag", level: "medium", detail: "Uniform/ID badge not detected during zone entry" },
  { type: "Extended break", level: "low", detail: "Break duration exceeded policy by several minutes" },
  { type: "Off-zone detection", level: "medium", detail: "Detected outside assigned zone during shift" },
];

export function generateAlerts(employee) {
  const rand = seededRandom(employee.id + "-alerts");
  const count = Math.floor(rand() * 3);
  const alerts = [];
  for (let i = 0; i < count; i++) {
    const template = ALERT_TEMPLATES[Math.floor(rand() * ALERT_TEMPLATES.length)];
    const hoursAgo = Math.floor(rand() * 48) + 1;
    alerts.push({
      ...template,
      timeLabel: hoursAgo < 24 ? `${hoursAgo} hr ago` : `${Math.floor(hoursAgo / 24)} day ago`,
    });
  }
  return alerts;
}
// ── migrated from Hostel/src/Productivitydata.js ──
// Mock data source for the Workforce Productivity Analytics page.

export const PRODUCTIVITY_DATA = {
  boys: {
    activeTime: { value: "76%", deltaLabel: "+1.1% vs. avg" },
    idleTime: { value: "15%", deltaLabel: "-0.6% vs. avg" },
    breakDuration: { value: "21 min", deltaLabel: "avg per staff" },
    phoneUsageDuration: { value: "6 min", deltaLabel: "avg per staff" },
    zoneOccupancyTime: { value: "4h 40m", deltaLabel: "avg in assigned zone" },
    taskCompletionCount: { value: 58, deltaLabel: "+4 vs. yesterday" },
    activeIdleByDept: [
      { dept: "Security", active: 340, idle: 60 },
      { dept: "Housekeeping", active: 312, idle: 68 },
      { dept: "Maintenance", active: 268, idle: 92 },
      { dept: "Mess staff", active: 355, idle: 45 },
    ],
    taskCompletion: [
      { name: "R. Kumar", role: "Housekeeping", tasksCompleted: 14, target: 16 },
      { name: "Ben Santos", role: "Security guard", tasksCompleted: 9, target: 10 },
      { name: "Ramesh", role: "Plumber", tasksCompleted: 5, target: 6 },
      { name: "Suresh", role: "Electrician", tasksCompleted: 4, target: 6 },
    ],
  },
  girls: {
    activeTime: { value: "81%", deltaLabel: "+0.8% vs. avg" },
    idleTime: { value: "11%", deltaLabel: "-0.4% vs. avg" },
    breakDuration: { value: "18 min", deltaLabel: "avg per staff" },
    phoneUsageDuration: { value: "4 min", deltaLabel: "avg per staff" },
    zoneOccupancyTime: { value: "5h 05m", deltaLabel: "avg in assigned zone" },
    taskCompletionCount: { value: 47, deltaLabel: "+2 vs. yesterday" },
    activeIdleByDept: [
      { dept: "Security", active: 320, idle: 40 },
      { dept: "Housekeeping", active: 330, idle: 50 },
      { dept: "Maintenance", active: 210, idle: 55 },
      { dept: "Mess staff", active: 300, idle: 35 },
    ],
    taskCompletion: [
      { name: "P. Sharma", role: "Housekeeping", tasksCompleted: 15, target: 16 },
      { name: "K. Devi", role: "Housekeeping", tasksCompleted: 14, target: 14 },
      { name: "Maintenance Supervisor", role: "Maintenance", tasksCompleted: 6, target: 7 },
    ],
  },
};
// ── migrated from Hostel/src/Reportsdata.js ──
// Mock data source for the Reports & Analytics page.

export const REPORTS_DATA = {
  boys: {
    weeklyTrend: [
      { week: "Jun 22", violations: 7, compliance: 88 },
      { week: "Jun 29", violations: 6, compliance: 89 },
      { week: "Jul 6", violations: 5, compliance: 91 },
      { week: "Jul 13", violations: 4, compliance: 93 },
    ],
    reportHistory: [
      { name: "Weekly operations summary", range: "Jul 7 – Jul 13, 2026", generated: "Jul 14, 2026", format: "PDF" },
      { name: "Security trends report", range: "Jun 2026", generated: "Jul 5, 2026", format: "CSV" },
      { name: "Housekeeping performance report", range: "Jun 2026", generated: "Jul 3, 2026", format: "PDF" },
      { name: "Safety compliance report", range: "Q2 2026", generated: "Jul 1, 2026", format: "PDF" },
    ],
  },
  girls: {
    weeklyTrend: [
      { week: "Jun 22", violations: 3, compliance: 93 },
      { week: "Jun 29", violations: 2, compliance: 94 },
      { week: "Jul 6", violations: 1, compliance: 96 },
      { week: "Jul 13", violations: 1, compliance: 96 },
    ],
    reportHistory: [
      { name: "Weekly operations summary", range: "Jul 7 – Jul 13, 2026", generated: "Jul 14, 2026", format: "PDF" },
      { name: "Security trends report", range: "Jun 2026", generated: "Jul 5, 2026", format: "CSV" },
      { name: "Mess operations report", range: "Jun 2026", generated: "Jul 2, 2026", format: "CSV" },
      { name: "Safety compliance report", range: "Q2 2026", generated: "Jul 1, 2026", format: "PDF" },
    ],
  },
};
