// ============================================================
// FACE WATCHLIST MODULE â€” COMPLETE MOCK DATA
// Covers all 7 sub-pages:
//   1. FaceWatchlistPage (dashboard)
//   2. WatchlistManagementPage
//   3. SuspectProfilePage
//   4. LiveREIDTrackingPage
//   5. BehaviorIntelligencePage
//   6. RelationshipGraphPage
//   7. FaceSearchPage
// ============================================================

const faceWatchlistMockData = {

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 1. DASHBOARD â€” FaceWatchlistPage
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  dashboard: {
    stats: {
      matches: 1248,
      highRisk: 23,
      totalWatchlist: 5248,
      accuracy: 96.7,
      responseTime: 1.8,
    },

    liveMatches: [
      { id: "WL-2341", name: "Rahul Sharma",   camera: "CAM-04", confidence: 93, priority: "High",   time: "14:20:35" },
      { id: "WL-2342", name: "Aman Verma",     camera: "CAM-07", confidence: 88, priority: "High",   time: "14:18:45" },
      { id: "WL-2343", name: "Vikram Singh",   camera: "CAM-01", confidence: 91, priority: "Medium", time: "14:16:22" },
      { id: "WL-2344", name: "Neha Patel",     camera: "CAM-02", confidence: 85, priority: "Medium", time: "14:15:11" },
      { id: "WL-2345", name: "Rohit Mehta",    camera: "CAM-09", confidence: 77, priority: "Low",    time: "14:13:02" },
    ],

    categories: [
      { name: "Criminals",       count: 2145, color: "#ef4444" },
      { name: "Red List",        count: 1214, color: "#dc2626" },
      { name: "Missing Persons", count: 698,  color: "#eab308" },
      { name: "VIPs",            count: 494,  color: "#3b82f6" },
      { name: "Employees",       count: 697,  color: "#22c55e" },
    ],

    riskDistribution: [
      { label: "Critical", value: 3,   color: "#ef4444" },
      { label: "High",     value: 20,  color: "#b45309" },
      { label: "Medium",   value: 45,  color: "#eab308" },
      { label: "Low",      value: 32,  color: "#22c55e" },
    ],

    recentMatches: [
      { name: "Rahul Sharma", location: "CAM-04 Â· Main Gate",   time: "14:20:25", confidence: 93, level: "High"   },
      { name: "Aman Verma",   location: "CAM-07 Â· Bus Bay",     time: "14:18:45", confidence: 88, level: "High"   },
      { name: "Vikram Singh", location: "CAM-01 Â· North Entry", time: "14:16:22", confidence: 91, level: "Medium" },
      { name: "Neha Patel",   location: "CAM-02 Â· Parking",     time: "14:15:11", confidence: 85, level: "Medium" },
      { name: "Rohit Mehta",  location: "CAM-09 Â· Cafeteria",   time: "14:13:02", confidence: 77, level: "Low"    },
    ],

    timeline: [
      { time: "14:20", event: "Watchlist Match",    detail: "Rahul Sharma Â· CAM-04 Â· 93%",   level: "Critical" },
      { time: "14:18", event: "Watchlist Match",    detail: "Aman Verma Â· CAM-07 Â· 88%",     level: "High"     },
      { time: "14:16", event: "REID Activated",     detail: "Tracking Rahul Sharma",          level: "High"     },
      { time: "14:15", event: "Watchlist Match",    detail: "Vikram Singh Â· CAM-01 Â· 91%",   level: "Medium"   },
      { time: "14:10", event: "Alert Generated",    detail: "Critical threat Â· Main Gate",    level: "Critical" },
      { time: "14:05", event: "Watchlist Match",    detail: "Neha Patel Â· CAM-02 Â· 85%",     level: "Medium"   },
      { time: "13:58", event: "Face Search",        detail: "Manual search Â· operator query", level: "Info"     },
    ],

    topMatched: [
      { name: "Rahul Sharma", matches: 12, lastSeen: "14:20" },
      { name: "Aman Verma",   matches: 8,  lastSeen: "14:18" },
      { name: "Vikram Singh", matches: 6,  lastSeen: "14:16" },
      { name: "Neha Patel",   matches: 5,  lastSeen: "14:15" },
      { name: "Rohit Mehta",  matches: 3,  lastSeen: "14:13" },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 2. WATCHLIST MANAGEMENT PAGE
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  watchlistManagement: {
    tabs: ["All Persons", "Criminals", "Red List", "Missing Persons", "VIPs", "Employees", "Visitors"],

    persons: [
      {
        id: "WL-001",
        photo: null, // replace with avatar/image URL
        name: "Rahul Sharma",
        aliases: "Rahul S., RS, R. Sharma",
        category: "Criminal",
        riskLevel: "High",
        status: "Active",
        lastUpdated: "05 May 2026",
        addedBy: "Admin",
        notes: "Known vehicle DL8CAF1021. 12 prior incidents.",
      },
      {
        id: "WL-002",
        photo: null,
        name: "Aman Verma",
        aliases: "Aman V.",
        category: "Red List",
        riskLevel: "High",
        status: "Active",
        lastUpdated: "04 May 2026",
        addedBy: "Admin",
        notes: "Restricted entry. Security threat.",
      },
      {
        id: "WL-003",
        photo: null,
        name: "Vikram Singh",
        aliases: "Vicky, VS",
        category: "Criminal",
        riskLevel: "High",
        status: "Active",
        lastUpdated: "04 May 2026",
        addedBy: "Operator",
        notes: "Wanted for questioning. Do not apprehend alone.",
      },
      {
        id: "WL-004",
        photo: null,
        name: "Neha Patel",
        aliases: "N. Patel",
        category: "Missing Person",
        riskLevel: "Medium",
        status: "Active",
        lastUpdated: "03 May 2026",
        addedBy: "Admin",
        notes: "Reported missing 01 May 2026. Family notified.",
      },
      {
        id: "WL-005",
        photo: null,
        name: "Rohit Mehta",
        aliases: "R. Mehta",
        category: "Employee",
        riskLevel: "Low",
        status: "Active",
        lastUpdated: "02 May 2026",
        addedBy: "HR System",
        notes: "Senior security officer. Authorised all zones.",
      },
      {
        id: "WL-006",
        photo: null,
        name: "Sanjay Gupta",
        aliases: "S. Gupta",
        category: "Red List",
        riskLevel: "High",
        status: "Inactive",
        lastUpdated: "02 May 2026",
        addedBy: "Admin",
        notes: "Attempted breach on 28 Apr 2026.",
      },
      {
        id: "WL-007",
        photo: null,
        name: "Irfan Khan",
        aliases: "I. Khan",
        category: "Criminal",
        riskLevel: "High",
        status: "Active",
        lastUpdated: "02 May 2026",
        addedBy: "Police Liaison",
        notes: "Interpol notice. High priority.",
      },
      {
        id: "WL-008",
        photo: null,
        name: "Priya Nair",
        aliases: "P. Nair, Priya N.",
        category: "VIP",
        riskLevel: "Low",
        status: "Active",
        lastUpdated: "01 May 2026",
        addedBy: "Protocol Office",
        notes: "State dignitary. VIP escort required.",
      },
      {
        id: "WL-009",
        photo: null,
        name: "Deepak Joshi",
        aliases: "D. Joshi",
        category: "Visitor",
        riskLevel: "Low",
        status: "Active",
        lastUpdated: "01 May 2026",
        addedBy: "Reception",
        notes: "Pre-approved visitor. Expires 10 May 2026.",
      },
      {
        id: "WL-010",
        photo: null,
        name: "Sunita Rao",
        aliases: "S. Rao",
        category: "Missing Person",
        riskLevel: "Medium",
        status: "Active",
        lastUpdated: "30 Apr 2026",
        addedBy: "Police Liaison",
        notes: "Missing since 29 Apr. Last seen North Gate.",
      },
    ],

    totalCount: 5248,
    pageSize: 10,
    currentPage: 1,
    totalPages: 750,

    filterOptions: {
      categories: ["All", "Criminal", "Red List", "Missing Person", "VIP", "Employee", "Visitor"],
      riskLevels: ["All", "High", "Medium", "Low"],
      statuses: ["All", "Active", "Inactive", "Expired"],
    },
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 3. SUSPECT PROFILE PAGE
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  suspectProfile: {
    // Primary subject shown by default
    id: "WL-001",
    name: "Rahul Sharma",
    riskLabel: "High Risk",
    photo: null,

    keyInfo: {
      aliases: "Rahul S., RS, R. Sharma",
      criminalType: "Criminal",
      riskScore: "86 / 100",
      dateOfBirth: "12 July 1987",
      gender: "Male",
      nationality: "Indian",
      watchlistSince: "14 Jan 2024",
    },

    knownVehicles: ["DL8CAF1021", "HR05B1122"],

    associatedIncidents: 12,

    lastSeen: {
      date: "05 May 2026",
      time: "14:20:31",
      camera: "CAM-04",
      location: "Main Gate",
    },

    tabs: {
      movementHistory: [
        { date: "05 May 2026", time: "14:20:31", location: "Main Gate",   camera: "CAM-04", confidence: 93, status: "Matched"  },
        { date: "05 May 2026", time: "14:18:40", location: "Parking Area",camera: "CAM-12", confidence: 89, status: "Matched"  },
        { date: "05 May 2026", time: "14:16:10", location: "North Entry",  camera: "CAM-01", confidence: 91, status: "Matched"  },
        { date: "05 May 2026", time: "14:11:05", location: "Bus Bay",      camera: "CAM-07", confidence: 85, status: "Matched"  },
        { date: "05 May 2026", time: "14:02:18", location: "Cafeteria",    camera: "CAM-09", confidence: 77, status: "Matched"  },
        { date: "04 May 2026", time: "09:44:02", location: "Main Gate",    camera: "CAM-04", confidence: 90, status: "Matched"  },
        { date: "04 May 2026", time: "09:50:33", location: "Admin Block",  camera: "CAM-11", confidence: 82, status: "Matched"  },
      ],

      incidents: [
        { id: "INC-204", date: "05 May 2026", type: "Watchlist Alert",   location: "Main Gate",   severity: "Critical", status: "Open"     },
        { id: "INC-189", date: "03 May 2026", type: "Assault Case",      location: "Parking Area",severity: "High",     status: "Under Review" },
        { id: "INC-174", date: "28 Apr 2026", type: "Trespass Attempt",  location: "North Entry", severity: "High",     status: "Resolved" },
        { id: "INC-160", date: "20 Apr 2026", type: "Suspicious Activity",location: "Bus Bay",    severity: "Medium",   status: "Resolved" },
        { id: "INC-141", date: "10 Apr 2026", type: "Watchlist Alert",   location: "Main Gate",   severity: "High",     status: "Resolved" },
      ],

      associates: [
        { name: "Aman Verma",  relation: "Known associate", riskLevel: "High",   sharedIncidents: 4 },
        { name: "Vikram Singh",relation: "Known associate", riskLevel: "High",   sharedIncidents: 2 },
        { name: "Neha Patel",  relation: "Vehicle link",    riskLevel: "Medium",  sharedIncidents: 1 },
        { name: "Irfan Khan",  relation: "Co-accused",      riskLevel: "High",   sharedIncidents: 3 },
      ],

      vehicles: [
        { plate: "DL8CAF1021", type: "Sedan",  color: "White", make: "Honda City",  lastSeen: "05 May 2026", status: "Flagged"  },
        { plate: "HR05B1122",  type: "SUV",    color: "Black", make: "Mahindra XUV",lastSeen: "03 May 2026", status: "Flagged"  },
      ],

      documents: [
        { name: "Arrest Record 2022.pdf",  type: "PDF", date: "15 Mar 2022", addedBy: "Police Liaison" },
        { name: "Court Order 2023.pdf",    type: "PDF", date: "08 Aug 2023", addedBy: "Legal Team"     },
        { name: "CCTV Evidence Apr26.mp4", type: "Video",date: "28 Apr 2026",addedBy: "Operator"       },
      ],

      notes: [
        { date: "05 May 2026", author: "Sahil A.", text: "Subject re-entered premises. REID tracking activated. Coordinating with patrol." },
        { date: "03 May 2026", author: "Operator", text: "Incident INC-189 linked. Subject fled before apprehension." },
        { date: "28 Apr 2026", author: "Sahil A.", text: "Trespass attempt at North Entry. Denied access via access control." },
      ],
    },

    movementMapPoints: [
      { camera: "CAM-04", location: "Main Gate",    x: 40, y: 70, time: "14:20", status: "Matched"  },
      { camera: "CAM-12", location: "Parking Area", x: 25, y: 50, time: "14:18", status: "Matched"  },
      { camera: "CAM-01", location: "North Entry",  x: 60, y: 30, time: "14:16", status: "Matched"  },
      { camera: "CAM-07", location: "Bus Bay",      x: 70, y: 60, time: "14:11", status: "Matched"  },
      { camera: "CAM-09", location: "Cafeteria",    x: 50, y: 75, time: "14:02", status: "Matched"  },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 4. LIVE REID TRACKING PAGE
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  reidTracking: {
    trackingId: "TRK-2041",
    status: "Active",
    subject: "Rahul Sharma",
    riskLevel: "High Risk",

    currentLocation: {
      camera: "CAM-04",
      name: "Main Gate",
      time: "14:20:31",
      date: "05 May 2026",
      confidence: 92,
      trackingSince: "14:16:22",
      camerasCrossed: 5,
    },

    nextLikelyLocation: {
      location: "Exit Gate B",
      eta: "~3 min Â· 15 sec",
    },

    cameraTrail: [
      { camera: "CAM-01", location: "Main Gate",    time: "14:19:22", confidence: 88, active: false },
      { camera: "CAM-03", location: "Lobby",         time: "14:17:05", confidence: 84, active: false },
      { camera: "CAM-04", location: "Main Gate",    time: "14:18:45", confidence: 92, active: true  },
      { camera: "CAM-07", location: "Bus Bay",       time: "14:20:31", confidence: 89, active: false },
      { camera: "CAM-12", location: "Parking",       time: "14:18:05", confidence: 78, active: false },
    ],

    predictedPath: [
      { camera: "CAM-04", label: "Main Gate",  active: true  },
      { camera: "CAM-07", label: "Exit Gate B",active: false },
    ],

    pathMapPoints: [
      { id: "CAM-04", label: "CAM-04\nMain Gate",  x: 30, y: 40, current: true  },
      { id: "CAM-07", label: "Exit Gate B",         x: 65, y: 70, current: false },
    ],

    alerts: [
      { time: "14:20:31", message: "Subject re-detected at Main Gate", level: "Critical" },
      { time: "14:18:45", message: "REID confidence high â€” tracking stable", level: "Info" },
      { time: "14:16:22", message: "REID tracking activated on face match", level: "High" },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 5. BEHAVIOR INTELLIGENCE PAGE
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  behaviorIntelligence: {
    subject: "Rahul Sharma",

    summary: [
      { label: "Loitering Detected", time: "14:16:00 â€“ 14:20:00", level: "Medium" },
      { label: "Running",            time: "14:14:10 â€“ 14:15:00", level: "High"   },
      { label: "Looking Around",     time: "14:16:10 â€“ 14:16:50", level: "Low"    },
      { label: "Phone Usage",        time: "14:15:00 â€“ 14:16:00", level: "Low"    },
    ],

    behaviorTimeline: [
      { time: "14:12", loitering: 0, running: 0, lookingAround: 0, phoneUsage: 1 },
      { time: "14:13", loitering: 0, running: 0, lookingAround: 1, phoneUsage: 1 },
      { time: "14:14", loitering: 0, running: 1, lookingAround: 0, phoneUsage: 0 },
      { time: "14:15", loitering: 0, running: 1, lookingAround: 1, phoneUsage: 1 },
      { time: "14:16", loitering: 1, running: 0, lookingAround: 1, phoneUsage: 0 },
      { time: "14:17", loitering: 1, running: 0, lookingAround: 1, phoneUsage: 0 },
      { time: "14:18", loitering: 1, running: 0, lookingAround: 0, phoneUsage: 0 },
      { time: "14:19", loitering: 1, running: 0, lookingAround: 1, phoneUsage: 0 },
      { time: "14:20", loitering: 1, running: 1, lookingAround: 1, phoneUsage: 0 },
      { time: "14:21", loitering: 0, running: 1, lookingAround: 0, phoneUsage: 0 },
      { time: "14:22", loitering: 0, running: 0, lookingAround: 0, phoneUsage: 0 },
    ],

    riskScore: 78,
    riskLabel: "High Risk",

    riskIndicators: [
      { label: "Rapid Movement",            active: true  },
      { label: "Frequent Direction Change", active: true  },
      { label: "Loitering in Restricted",   active: true  },
      { label: "Crowd Avoidance",           active: false },
      { label: "Phone Usage Pattern",       active: false },
    ],

    activitySnapshots: [
      { time: "14:15:20", camera: "CAM-04", behavior: "Running",    confidence: 91 },
      { time: "14:16:10", camera: "CAM-04", behavior: "Loitering",  confidence: 87 },
      { time: "14:16:22", camera: "CAM-01", behavior: "Loitering",  confidence: 84 },
      { time: "14:17:00", camera: "CAM-04", behavior: "Looking Around", confidence: 79 },
      { time: "14:18:10", camera: "CAM-04", behavior: "Loitering",  confidence: 88 },
      { time: "14:20:31", camera: "CAM-04", behavior: "Running",    confidence: 93 },
    ],
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 6. RELATIONSHIP GRAPH PAGE
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  relationshipGraph: {
    // Nodes
    nodes: [
      { id: "n1",  label: "Rahul Sharma", type: "person",   riskLevel: "High",   category: "Criminal",    x: 340, y: 280 },
      { id: "n2",  label: "Aman Verma",   type: "person",   riskLevel: "High",   category: "Red List",    x: 160, y: 160 },
      { id: "n3",  label: "Vikram Singh", type: "person",   riskLevel: "High",   category: "Criminal",    x: 520, y: 160 },
      { id: "n4",  label: "Neha Patel",   type: "person",   riskLevel: "Medium", category: "Missing",     x: 520, y: 400 },
      { id: "n5",  label: "Irfan Khan",   type: "person",   riskLevel: "High",   category: "Criminal",    x: 160, y: 400 },
      { id: "v1",  label: "DL8CAF1021",   type: "vehicle",  riskLevel: "High",   category: "Vehicle",     x: 340, y: 460 },
      { id: "v2",  label: "HR05B1122",    type: "vehicle",  riskLevel: "Medium", category: "Vehicle",     x: 200, y: 340 },
      { id: "i1",  label: "Incident #204",type: "incident", riskLevel: "Critical",category:"Incident",    x: 460, y: 320 },
      { id: "i2",  label: "Incident #189",type: "incident", riskLevel: "High",   category: "Incident",   x: 220, y: 480 },
      { id: "l1",  label: "Main Gate",    type: "location", riskLevel: null,     category: "Location",    x: 120, y: 280 },
    ],

    // Edges
    edges: [
      { from: "n1", to: "n2", label: "Known associate",   strength: "strong"  },
      { from: "n1", to: "n3", label: "Known associate",   strength: "strong"  },
      { from: "n1", to: "n5", label: "Co-accused",        strength: "strong"  },
      { from: "n1", to: "v1", label: "Registered vehicle",strength: "strong"  },
      { from: "n1", to: "v2", label: "Seen with",         strength: "medium"  },
      { from: "n1", to: "i1", label: "Linked to",         strength: "strong"  },
      { from: "n1", to: "i2", label: "Linked to",         strength: "strong"  },
      { from: "n2", to: "i2", label: "Linked to",         strength: "medium"  },
      { from: "n5", to: "i1", label: "Linked to",         strength: "medium"  },
      { from: "n4", to: "v1", label: "Vehicle link",      strength: "weak"    },
      { from: "n1", to: "l1", label: "Frequent location", strength: "medium"  },
      { from: "n2", to: "l1", label: "Seen at",           strength: "weak"    },
    ],

    graphTypeOptions: ["All", "Persons", "Vehicles", "Incidents", "Locations"],
    filterOptions:    ["All Connections", "Strong", "Medium", "Weak"],

    summary: {
      totalNodes: 10,
      totalEdges: 12,
      personsLinked: 5,
      vehiclesLinked: 2,
      incidentsLinked: 2,
      locationsLinked: 1,
    },
  },

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 7. FACE SEARCH PAGE
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  faceSearch: {
    searchTabs: ["Upload Face", "Search by Name", "Search by Filters"],

    recentSearches: [
      { query: "Rahul Sharma",  time: "14:18", results: 23 },
      { query: "Unknown male",  time: "13:45", results: 7  },
      { query: "Aman Verma",    time: "12:30", results: 15 },
    ],

    // Results shown after a search
    searchResults: [
      { camera: "CAM-04", date: "05 May 2026", time: "14:30", confidence: 93, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-07", date: "05 May 2026", time: "14:18", confidence: 91, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-01", date: "05 May 2026", time: "14:16", confidence: 90, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-12", date: "05 May 2026", time: "14:15", confidence: 86, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-02", date: "05 May 2026", time: "14:00", confidence: 84, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-09", date: "04 May 2026", time: "09:50", confidence: 82, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-11", date: "04 May 2026", time: "09:44", confidence: 79, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-05", date: "03 May 2026", time: "16:22", confidence: 77, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
      { camera: "CAM-03", date: "03 May 2026", time: "11:05", confidence: 74, matchId: "WL-001", name: "Rahul Sharma", riskLevel: "High"   },
    ],

    filters: {
      dateRange: { from: "01/05/2026", to: "05/05/2026" },
      location: "All Locations",
      minConfidence: 75,
    },

    filterOptions: {
      locations: ["All Locations", "Main Gate", "Parking Area", "Bus Bay", "North Entry", "Cafeteria", "Admin Block"],
    },

    // Name search results
    nameSearchResults: [
      { id: "WL-001", name: "Rahul Sharma", category: "Criminal",      riskLevel: "High",   matchCount: 12, lastSeen: "14:20"  },
      { id: "WL-002", name: "Aman Verma",   category: "Red List",      riskLevel: "High",   matchCount: 8,  lastSeen: "14:18"  },
      { id: "WL-003", name: "Vikram Singh", category: "Criminal",      riskLevel: "High",   matchCount: 6,  lastSeen: "14:16"  },
    ],
  },

};

export default faceWatchlistMockData;
