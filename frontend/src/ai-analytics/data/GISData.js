export const gisMockData = {
  mapConfig: {
    center: [28.6139, 77.2090], // Delhi
    zoom: 16,

    organization: {
      name: "DRISHYAM AI Railway Command Center",
      type: "Railway Station",
      city: "New Delhi"
    }
  },

  cameras: [
    {
      id: "CAM-01",
      name: "North Gate Camera",
      type: "PTZ",
      status: "ONLINE",
      position: { lat: 28.6145, lng: 77.2082 },
      rotation: 45,
      fov: 70,
      aiEnabled: true,
      health: { fps: 30, uptime: "99.2%", streamHealth: "GOOD" },
      liveFeed: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3"
    },
    {
      id: "CAM-02",
      name: "Parking Surveillance",
      type: "Fixed",
      status: "LOW FPS",
      position: { lat: 28.6152, lng: 77.2110 },
      rotation: 120,
      fov: 60,
      aiEnabled: true,
      health: { fps: 12, uptime: "94.5%", streamHealth: "DEGRADED" },
      liveFeed: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7"
    },
    {
      id: "CAM-03",
      name: "Platform A Camera",
      type: "Dome",
      status: "ONLINE",
      position: { lat: 28.6130, lng: 77.2105 },
      rotation: 180,
      fov: 90,
      aiEnabled: true,
      health: { fps: 28, uptime: "98.8%", streamHealth: "GOOD" },
      liveFeed: "https://images.unsplash.com/photo-1509099836639-18ba1795216d"
    },
    {
      id: "CAM-04",
      name: "Main Concourse Face Match",
      type: "Dome",
      status: "ONLINE",
      position: { lat: 28.6138, lng: 77.2092 },
      rotation: 20,
      fov: 85,
      aiEnabled: true,
      health: { fps: 29, uptime: "99.0%", streamHealth: "GOOD" },
      liveFeed: "https://images.unsplash.com/photo-1517048676732-d65bc937f952"
    },
    {
      id: "CAM-05",
      name: "Maintenance Corridor",
      type: "Fixed",
      status: "ONLINE",
      position: { lat: 28.6150, lng: 77.2078 },
      rotation: 270,
      fov: 55,
      aiEnabled: true,
      health: { fps: 26, uptime: "97.8%", streamHealth: "GOOD" },
      liveFeed: "https://images.unsplash.com/photo-1497366754035-f200968a6e72"
    },
    {
      id: "CAM-06",
      name: "Bus Bay Watch",
      type: "PTZ",
      status: "ONLINE",
      position: { lat: 28.6127, lng: 77.2087 },
      rotation: 315,
      fov: 95,
      aiEnabled: true,
      health: { fps: 30, uptime: "98.6%", streamHealth: "GOOD" },
      liveFeed: "https://images.unsplash.com/photo-1544620347-c4fd4a3d5957"
    },
    {
      id: "CAM-07",
      name: "Exit Gate B Camera",
      type: "Fixed",
      status: "ONLINE",
      position: { lat: 28.6124, lng: 77.2119 },
      rotation: 90,
      fov: 65,
      aiEnabled: true,
      health: { fps: 27, uptime: "96.9%", streamHealth: "GOOD" },
      liveFeed: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee"
    },
    {
      id: "CAM-08",
      name: "Taxi Stand ANPR",
      type: "ANPR",
      status: "ONLINE",
      position: { lat: 28.6147, lng: 77.2121 },
      rotation: 135,
      fov: 75,
      aiEnabled: true,
      health: { fps: 25, uptime: "95.4%", streamHealth: "GOOD" },
      liveFeed: "https://images.unsplash.com/photo-1502877338535-766e1452684a"
    },
    {
      id: "CAM-09",
      name: "Food Court Atrium",
      type: "Dome",
      status: "LOW FPS",
      position: { lat: 28.6133, lng: 77.2080 },
      rotation: 210,
      fov: 70,
      aiEnabled: true,
      health: { fps: 14, uptime: "91.2%", streamHealth: "DEGRADED" },
      liveFeed: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5"
    }
  ],

  liveIncidents: [
    {
      id: "INC_101",
      type: "Weapon Detection",
      severity: "CRITICAL",
      title: "Armed Suspect Detected",
      description: "Weapon detected near North Corridor",
      position: { lat: 28.6140, lng: 77.2094 },
      timestamp: "14:20:31",
      linkedCamera: "CAM-01",
      threatRadius: 50,
      status: "ACTIVE",
      suspectId: "SUS_201"
    },
    {
      id: "INC_102",
      type: "Crowd Panic",
      severity: "HIGH",
      title: "Panic Movement Detected",
      description: "Chaotic crowd behavior identified near Platform A",
      position: { lat: 28.6131, lng: 77.2108 },
      timestamp: "14:18:12",
      linkedCamera: "CAM-03",
      threatRadius: 80,
      status: "ACTIVE"
    },
    {
      id: "INC_103",
      type: "Restricted Access",
      severity: "MEDIUM",
      title: "Unauthorized Entry",
      description: "Restricted maintenance corridor breached",
      position: { lat: 28.6150, lng: 77.2078 },
      timestamp: "14:14:55",
      linkedCamera: "CAM-05",
      threatRadius: 25,
      status: "UNDER REVIEW"
    },
    {
      id: "INC_104",
      type: "ANPR Watchlist",
      severity: "HIGH",
      title: "Stolen Vehicle Loitering",
      description: "Stolen vehicle flagged near taxi stand and parking exit",
      position: { lat: 28.6148, lng: 77.2117 },
      timestamp: "14:12:40",
      linkedCamera: "CAM-08",
      threatRadius: 45,
      status: "ACTIVE",
      vehicleId: "VH_104"
    },
    {
      id: "INC_105",
      type: "Unattended Object",
      severity: "MEDIUM",
      title: "Bag Left Near Food Court",
      description: "Unattended object observed for 07 minutes near atrium seating",
      position: { lat: 28.6134, lng: 77.2081 },
      timestamp: "14:09:18",
      linkedCamera: "CAM-09",
      threatRadius: 30,
      status: "UNDER REVIEW"
    },
    {
      id: "INC_106",
      type: "Person Collapse",
      severity: "LOW",
      title: "Medical Assistance Required",
      description: "Person collapsed near Bus Bay entry; crowd flow slowing",
      position: { lat: 28.6128, lng: 77.2088 },
      timestamp: "14:06:52",
      linkedCamera: "CAM-06",
      threatRadius: 20,
      status: "RESPONDING"
    }
  ],

  suspects: [
    {
      id: "SUS_201",
      name: "Rahul Sharma",
      watchlist: "BLACKLISTED",
      threatLevel: "HIGH",
      confidence: 0.94,
      currentPosition: { lat: 28.6140, lng: 77.2094 },
      lastSeenCamera: "CAM-01",
      movementPath: [[28.6145, 77.2082], [28.6142, 77.2088], [28.6140, 77.2094]],
      predictedRoute: "Exit Gate B",
      image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e"
    },
    {
      id: "SUS_202",
      name: "Aman Verma",
      watchlist: "BLACKLISTED",
      threatLevel: "HIGH",
      confidence: 0.88,
      currentPosition: { lat: 28.6129, lng: 77.2090 },
      lastSeenCamera: "CAM-06",
      movementPath: [[28.6138, 77.2092], [28.6134, 77.2090], [28.6129, 77.2090]],
      predictedRoute: "Bus Bay",
      image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d"
    },
    {
      id: "SUS_203",
      name: "Vikram Singh",
      watchlist: "PERSON OF INTEREST",
      threatLevel: "MEDIUM",
      confidence: 0.91,
      currentPosition: { lat: 28.6135, lng: 77.2082 },
      lastSeenCamera: "CAM-09",
      movementPath: [[28.6127, 77.2087], [28.6130, 77.2084], [28.6135, 77.2082]],
      predictedRoute: "Food Court Atrium",
      image: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d"
    },
    {
      id: "SUS_204",
      name: "Neha Patel",
      watchlist: "MISSING PERSON",
      threatLevel: "MEDIUM",
      confidence: 0.85,
      currentPosition: { lat: 28.6125, lng: 77.2116 },
      lastSeenCamera: "CAM-07",
      movementPath: [[28.6131, 77.2108], [28.6128, 77.2112], [28.6125, 77.2116]],
      predictedRoute: "South Exit Route",
      image: "https://images.unsplash.com/photo-1494790108377-be9c29b29330"
    }
  ],

  vehicles: [
    {
      id: "VH_101",
      plate: "DL8CAF1021",
      type: "SUV",
      brand: "Toyota",
      model: "Fortuner",
      color: "Black",
      watchlist: "BLACKLISTED",
      currentPosition: { lat: 28.6155, lng: 77.2109 },
      movementPath: [[28.6149, 77.2088], [28.6152, 77.2097], [28.6155, 77.2109]],
      speed: 42,
      direction: "East Corridor",
      linkedSuspect: "Rahul Sharma",
      image: "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7"
    },
    {
      id: "VH_102",
      plate: "MH12AB3456",
      type: "Sedan",
      brand: "Honda",
      model: "City",
      color: "White",
      watchlist: "SUSPICIOUS",
      currentPosition: { lat: 28.6146, lng: 77.2117 },
      movementPath: [[28.6152, 77.2110], [28.6149, 77.2114], [28.6146, 77.2117]],
      speed: 28,
      direction: "Taxi Stand",
      linkedSuspect: "Aman Verma",
      image: "https://images.unsplash.com/photo-1503376780353-7e6692767b70"
    },
    {
      id: "VH_103",
      plate: "HR26DK4567",
      type: "Hatchback",
      brand: "Maruti",
      model: "Swift",
      color: "Red",
      watchlist: "NORMAL",
      currentPosition: { lat: 28.6138, lng: 77.2079 },
      movementPath: [[28.6127, 77.2087], [28.6132, 77.2084], [28.6138, 77.2079]],
      speed: 18,
      direction: "Service Road",
      linkedSuspect: null,
      image: "https://images.unsplash.com/photo-1542282088-fe8426682b8f"
    },
    {
      id: "VH_104",
      plate: "PB10FG6789",
      type: "SUV",
      brand: "Hyundai",
      model: "Creta",
      color: "Silver",
      watchlist: "STOLEN",
      currentPosition: { lat: 28.6149, lng: 77.2119 },
      movementPath: [[28.6154, 77.2109], [28.6152, 77.2115], [28.6149, 77.2119]],
      speed: 12,
      direction: "Parking Exit Hold",
      linkedSuspect: "Unknown Driver",
      image: "https://images.unsplash.com/photo-1579399788041-f1f0e8c4c4d0"
    },
    {
      id: "VH_105",
      plate: "UP32KQ1001",
      type: "SUV",
      brand: "Mahindra",
      model: "Scorpio",
      color: "White",
      watchlist: "NORMAL",
      currentPosition: { lat: 28.6126, lng: 77.2085 },
      movementPath: [[28.6140, 77.2094], [28.6133, 77.2089], [28.6126, 77.2085]],
      speed: 22,
      direction: "Bus Bay Drop-off",
      linkedSuspect: null,
      image: "https://images.unsplash.com/photo-1511919884226-fd3cad34687c"
    }
  ],

  crowdHeatmap: [
    { lat: 28.6130, lng: 77.2108, intensity: 0.9,  crowdCount: 324, risk: "HIGH"   },
    { lat: 28.6142, lng: 77.2090, intensity: 0.7,  crowdCount: 214, risk: "MEDIUM" },
    { lat: 28.6151, lng: 77.2115, intensity: 0.4,  crowdCount: 102, risk: "LOW"    },
    { lat: 28.6128, lng: 77.2089, intensity: 0.62, crowdCount: 188, risk: "MEDIUM" },
    { lat: 28.6135, lng: 77.2082, intensity: 0.55, crowdCount: 151, risk: "MEDIUM" },
    { lat: 28.6148, lng: 77.2118, intensity: 0.48, crowdCount: 126, risk: "LOW"    },
    { lat: 28.6124, lng: 77.2117, intensity: 0.74, crowdCount: 236, risk: "HIGH"   }
  ],

  restrictedZones: [
    {
      id: "ZONE_01",
      name: "Control Room",
      type: "HIGH SECURITY",
      coordinates: [[28.6148, 77.2075], [28.6150, 77.2075], [28.6150, 77.2079], [28.6148, 77.2079]],
      status: "SECURED",
      accessLevel: "LEVEL-5"
    },
    {
      id: "ZONE_02",
      name: "Server Room",
      type: "RESTRICTED",
      coordinates: [[28.6135, 77.2085], [28.6138, 77.2085], [28.6138, 77.2089], [28.6135, 77.2089]],
      status: "MONITORED",
      accessLevel: "LEVEL-4"
    },
    {
      id: "ZONE_03",
      name: "Parcel Screening Bay",
      type: "CONTROLLED",
      coordinates: [[28.6128, 77.2079], [28.6131, 77.2079], [28.6131, 77.2083], [28.6128, 77.2083]],
      status: "MONITORED",
      accessLevel: "LEVEL-3"
    },
    {
      id: "ZONE_04",
      name: "Trackside Staff Access",
      type: "HIGH SECURITY",
      coordinates: [[28.6122, 77.2109], [28.6125, 77.2109], [28.6125, 77.2114], [28.6122, 77.2114]],
      status: "SECURED",
      accessLevel: "LEVEL-5"
    }
  ],

  patrolUnits: [
    {
      id: "PATROL_01",
      officer: "Unit Alpha",
      status: "RESPONDING",
      currentPosition: { lat: 28.6149, lng: 77.2086 },
      assignedIncident: "INC_101",
      eta: "01:32",
      vehicle: "Police SUV"
    },
    {
      id: "PATROL_02",
      officer: "Unit Bravo",
      status: "PATROLLING",
      currentPosition: { lat: 28.6134, lng: 77.2101 },
      assignedIncident: null,
      eta: null,
      vehicle: "Foot Patrol"
    },
    {
      id: "PATROL_03",
      officer: "Unit Charlie",
      status: "RESPONDING",
      currentPosition: { lat: 28.6145, lng: 77.2114 },
      assignedIncident: "INC_104",
      eta: "02:05",
      vehicle: "Interceptor Bike"
    },
    {
      id: "PATROL_04",
      officer: "Medical Team Delta",
      status: "RESPONDING",
      currentPosition: { lat: 28.6125, lng: 77.2091 },
      assignedIncident: "INC_106",
      eta: "00:48",
      vehicle: "Medical Cart"
    },
    {
      id: "PATROL_05",
      officer: "Unit Echo",
      status: "PATROLLING",
      currentPosition: { lat: 28.6151, lng: 77.2079 },
      assignedIncident: null,
      eta: null,
      vehicle: "Foot Patrol"
    }
  ],

  evacuationRoutes: [
    {
      id: "EVAC_01",
      name: "South Exit Route",
      status: "SAFE",
      estimatedTime: "03:12",
      path: [[28.6131, 77.2108], [28.6128, 77.2112], [28.6124, 77.2118]]
    },
    {
      id: "EVAC_02",
      name: "North Corridor",
      status: "BLOCKED",
      estimatedTime: null,
      path: [[28.6140, 77.2094], [28.6144, 77.2099], [28.6148, 77.2105]]
    },
    {
      id: "EVAC_03",
      name: "Bus Bay Relief Route",
      status: "SAFE",
      estimatedTime: "04:05",
      path: [[28.6134, 77.2082], [28.6130, 77.2085], [28.6126, 77.2088], [28.6122, 77.2092]]
    },
    {
      id: "EVAC_04",
      name: "Platform Service Corridor",
      status: "MONITORED",
      estimatedTime: "05:40",
      path: [[28.6130, 77.2108], [28.6127, 77.2106], [28.6124, 77.2109], [28.6122, 77.2114]]
    }
  ],

  floorplan: {
    image: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab",
    sections: [
      { id: "SEC_01", name: "Platform A",       occupancy: 324, status: "HIGH DENSITY"    },
      { id: "SEC_02", name: "Main Lobby",        occupancy: 182, status: "NORMAL"          },
      { id: "SEC_03", name: "Security Control",  occupancy: 12,  status: "RESTRICTED"      },
      { id: "SEC_04", name: "Food Court",        occupancy: 151, status: "WATCH"           },
      { id: "SEC_05", name: "Bus Bay",           occupancy: 188, status: "MEDICAL RESPONSE" }
    ]
  },

  mapLayers: [
    { id: "LAYER_01", name: "Cameras",        enabled: true },
    { id: "LAYER_02", name: "Vehicles",       enabled: true },
    { id: "LAYER_03", name: "Suspects",       enabled: true },
    { id: "LAYER_04", name: "Crowd Heatmap",  enabled: true },
    { id: "LAYER_05", name: "Restricted Zones", enabled: true },
    { id: "LAYER_06", name: "Patrol Units",   enabled: true }
  ],

  analytics: {
    activeIncidents: 10,
    onlineCameras: 34,
    activeTracking: 23,
    highRiskZones: 5,
    avgResponseTime: "01:58",
    crowdDensityScore: 82
  },

  incidentTimeline: [
    { timestamp: "14:20:31", event: "Weapon detected at North Corridor",        severity: "CRITICAL" },
    { timestamp: "14:21:02", event: "Crowd panic triggered",                    severity: "HIGH"     },
    { timestamp: "14:21:42", event: "Patrol Unit Alpha dispatched",             severity: "INFO"     },
    { timestamp: "14:22:15", event: "Evacuation route activated",               severity: "MEDIUM"   },
    { timestamp: "14:23:04", event: "ANPR confirmed stolen vehicle near taxi stand", severity: "HIGH" },
    { timestamp: "14:23:36", event: "Unit Charlie assigned to vehicle intercept", severity: "INFO"   },
    { timestamp: "14:24:10", event: "Medical Team Delta reached Bus Bay",       severity: "LOW"      }
  ],

  aiNarrative: {
    summary: "Armed suspect detected near North Corridor while two additional watchlist persons are being tracked through the Bus Bay and Food Court. Crowd pressure is highest at Platform A and South Exit. ANPR has flagged a blacklisted SUV and a stolen Creta near the parking exit. Patrol Units Alpha and Charlie are responding while Medical Team Delta handles a Bus Bay collapse. South Exit and Bus Bay Relief remain the safest evacuation paths."
  }
}
