// Surveillance stills, WebP q82 capped at the stage box (~1014 CSS px) rather
// than shipping the 2.7–3.0 MB source PNGs. Quality stays high and resolution
// absorbs the budget — a plate has to stay readable. Filenames are kebab-case
// because the originals contained spaces, which forced URL encoding on every
// request.
import anprFootage1 from './anpr-footage-1.webp';
import anprFootage2 from './anpr-footage-2.webp';
import anprFootage3 from './anpr-footage-3.webp';
import anprFootage4 from './anpr-footage-4.webp';
import anprFootage5 from './anpr-footage-5.webp';
// The demo clips are large binaries that aren't part of the checkout.
// import.meta.glob resolves one when it is there and yields nothing when it
// isn't, so a missing file degrades to `null` — ANPRMedia then renders the
// poster still — instead of failing the whole module graph at import time.
const demoClips = import.meta.glob('../assets/*.mp4', { eager: true, query: '?url', import: 'default' });
const vehicleDetectionVideo = demoClips['../assets/plate-anpr.mp4'] || null;

// API_BASE from the shared config is already the bare origin (no /api), which
// is what the media URLs below need. Reading the (never-defined) VITE_API_BASE
// meant these assets always pointed at localhost, even in prod.
import { API_BASE as API_ORIGIN } from '@/core/config/endpoints';

const anprVideo = (fileName) => `${API_ORIGIN}/media/anpr/${encodeURIComponent(fileName)}`;

export const anprRecordings = [
  {
    id: 'ANPR-REC-DEMO',
    plate: 'MH14TC0786',
    camera: 'CAM-VID-01',
    location: 'Main Gate Live Lane',
    timestamp: '2026-06-15 14:32:02',
    status: 'watchlist',
    vehicleType: 'SUV',
    color: 'White',
    make: 'Demo Vehicle',
    speed: 31,
    confidence: 0.96,
    poster: anprFootage1,
    video: vehicleDetectionVideo,
  },
  {
    id: 'ANPR-REC-001',
    plate: 'MH12AB1234',
    camera: 'CAM-01',
    location: 'Main Gate',
    timestamp: '2026-05-11 14:22:10',
    status: 'blacklisted',
    vehicleType: 'Sedan',
    color: 'White',
    make: 'Maruti Swift',
    speed: 42,
    confidence: 0.97,
    poster: anprFootage1,
    video: anprVideo('12937540_1920_1080_30fps.mp4'),
  },
  {
    id: 'ANPR-REC-002',
    plate: 'DL8CAF5678',
    camera: 'CAM-03',
    location: 'Parking Area',
    timestamp: '2026-05-11 14:21:44',
    status: 'watchlist',
    vehicleType: 'SUV',
    color: 'Black',
    make: 'Toyota Fortuner',
    speed: 28,
    confidence: 0.94,
    poster: anprFootage2,
    video: anprVideo('14885348_3840_2160_30fps.mp4'),
  },
  {
    id: 'ANPR-REC-003',
    plate: 'KA09MN9012',
    camera: 'CAM-02',
    location: 'North Gate',
    timestamp: '2026-05-11 14:20:55',
    status: 'suspicious',
    vehicleType: 'Truck',
    color: 'Blue',
    make: 'Tata 407',
    speed: 35,
    confidence: 0.91,
    poster: anprFootage3,
    video: anprVideo('15396218_1920_1080_25fps.mp4'),
  },
  {
    id: 'ANPR-REC-004',
    plate: 'TN22CD3456',
    camera: 'CAM-05',
    location: 'East Entry',
    timestamp: '2026-05-11 14:19:30',
    status: 'clear',
    vehicleType: 'Hatchback',
    color: 'Red',
    make: 'Hyundai i20',
    speed: 30,
    confidence: 0.98,
    poster: anprFootage4,
    video: anprVideo('18837240-hd_1920_1080_30fps.mp4'),
  },
  {
    id: 'ANPR-REC-005',
    plate: 'GJ01EF7890',
    camera: 'CAM-04',
    location: 'Bus Bay',
    timestamp: '2026-05-11 14:18:12',
    status: 'blacklisted',
    vehicleType: 'Bike',
    color: 'Silver',
    make: 'Bajaj Pulsar',
    speed: 55,
    confidence: 0.89,
    poster: anprFootage5,
    video: anprVideo('5878095-hd_1920_1080_30fps.mp4'),
  },
];

export const anprDetections = [
  { id: 'VEH-DEMO-001', plate: 'MH14TC0786', vehicleType: 'SUV', color: 'White', make: 'Demo Vehicle', camera: 'CAM-VID-01', location: 'Main Gate Live Lane', timestamp: '2026-06-15 14:32:02', status: 'watchlist', confidence: 0.96, speed: 31 },
  { id: 'VEH-001', plate: 'MH12AB1234', vehicleType: 'Sedan', color: 'White', make: 'Maruti Swift', camera: 'CAM-01', location: 'Main Gate', timestamp: '2026-05-11 14:22:10', status: 'blacklisted', confidence: 0.97, speed: 42 },
  { id: 'VEH-002', plate: 'DL8CAF5678', vehicleType: 'SUV', color: 'Black', make: 'Toyota Fortuner', camera: 'CAM-03', location: 'Parking Area', timestamp: '2026-05-11 14:21:44', status: 'watchlist', confidence: 0.94, speed: 28 },
  { id: 'VEH-003', plate: 'KA09MN9012', vehicleType: 'Truck', color: 'Blue', make: 'Tata 407', camera: 'CAM-02', location: 'North Gate', timestamp: '2026-05-11 14:20:55', status: 'suspicious', confidence: 0.91, speed: 35 },
  { id: 'VEH-004', plate: 'TN22CD3456', vehicleType: 'Hatchback', color: 'Red', make: 'Hyundai i20', camera: 'CAM-05', location: 'East Entry', timestamp: '2026-05-11 14:19:30', status: 'clear', confidence: 0.98, speed: 30 },
  { id: 'VEH-005', plate: 'GJ01EF7890', vehicleType: 'Bike', color: 'Silver', make: 'Bajaj Pulsar', camera: 'CAM-04', location: 'Bus Bay', timestamp: '2026-05-11 14:18:12', status: 'blacklisted', confidence: 0.89, speed: 55 },
  { id: 'VEH-006', plate: 'RJ14GH2345', vehicleType: 'Van', color: 'White', make: 'Force Traveller', camera: 'CAM-06', location: 'South Gate', timestamp: '2026-05-11 14:17:05', status: 'watchlist', confidence: 0.96, speed: 22 },
  { id: 'VEH-007', plate: 'UP32IJ6789', vehicleType: 'Sedan', color: 'Grey', make: 'Honda City', camera: 'CAM-01', location: 'Main Gate', timestamp: '2026-05-11 14:15:50', status: 'clear', confidence: 0.99, speed: 38 },
  { id: 'VEH-008', plate: 'WB20KL1234', vehicleType: 'SUV', color: 'Black', make: 'Ford Endeavour', camera: 'CAM-03', location: 'Parking Area', timestamp: '2026-05-11 14:14:33', status: 'suspicious', confidence: 0.88, speed: 20 },
];

export const blacklistedVehicles = [
  { id: 'BL-DEMO-001', plate: 'MH14TC0786', reason: 'Vehicle of Interest - Demo ANPR Hit', riskLevel: 'warning', addedDate: '2026-06-15', make: 'Demo Vehicle', color: 'White', category: 'Police Interest' },
  { id: 'BL-001', plate: 'MH12AB1234', reason: 'Stolen Vehicle', riskLevel: 'critical', addedDate: '2026-03-15', make: 'Maruti Swift', color: 'White', category: 'Criminal' },
  { id: 'BL-002', plate: 'GJ01EF7890', reason: 'Wanted - Drug Cartel', riskLevel: 'critical', addedDate: '2026-04-02', make: 'Bajaj Pulsar', color: 'Silver', category: 'Criminal' },
  { id: 'BL-003', plate: 'DL8CAF5678', reason: 'Traffic Warrant', riskLevel: 'warning', addedDate: '2026-04-20', make: 'Toyota Fortuner', color: 'Black', category: 'Warrant' },
  { id: 'BL-004', plate: 'HR26DQ4411', reason: 'Suspected Trafficking', riskLevel: 'critical', addedDate: '2026-05-01', make: 'Bolero', color: 'Grey', category: 'Criminal' },
  { id: 'BL-005', plate: 'RJ14GH2345', reason: 'Overdue Fine > INR 10K', riskLevel: 'warning', addedDate: '2026-04-10', make: 'Force Traveller', color: 'White', category: 'Traffic' },
];

export const trafficViolations = [
  { id: 'TV-001', plate: 'MH04TY6612', type: 'Signal Jump', camera: 'CAM-02', timestamp: '2026-05-11 14:20:00', fine: 1000, status: 'pending' },
  { id: 'TV-002', plate: 'DL1AB3344', type: 'Speeding (72 kmph)', camera: 'CAM-05', timestamp: '2026-05-11 14:18:45', fine: 2000, status: 'issued' },
  { id: 'TV-003', plate: 'KA01CD5566', type: 'Wrong Lane', camera: 'CAM-01', timestamp: '2026-05-11 14:16:30', fine: 500, status: 'paid' },
  { id: 'TV-004', plate: 'TN07EF7788', type: 'No Helmet', camera: 'CAM-04', timestamp: '2026-05-11 14:14:10', fine: 1500, status: 'pending' },
  { id: 'TV-005', plate: 'GJ05GH9900', type: 'Parking Violation', camera: 'CAM-03', timestamp: '2026-05-11 14:12:55', fine: 500, status: 'issued' },
];

export const parkingZones = [
  { id: 'PZ-A', name: 'Zone A - Main Block', capacity: 120, occupied: 98, reserved: 10, camera: 'CAM-P1', status: 'high' },
  { id: 'PZ-B', name: 'Zone B - Staff Parking', capacity: 60, occupied: 22, reserved: 5, camera: 'CAM-P2', status: 'normal' },
  { id: 'PZ-C', name: 'Zone C - Visitor Bay', capacity: 40, occupied: 40, reserved: 0, camera: 'CAM-P3', status: 'full' },
  { id: 'PZ-D', name: 'Zone D - East Wing', capacity: 80, occupied: 35, reserved: 8, camera: 'CAM-P4', status: 'normal' },
  { id: 'PZ-E', name: 'Zone E - Loading Bay', capacity: 20, occupied: 18, reserved: 2, camera: 'CAM-P5', status: 'high' },
];

export const vehicleJourneyData = [
  {
    plate: 'MH12AB1234',
    entries: [
      { camera: 'CAM-01', location: 'Main Gate', time: '14:18:05', event: 'Entry' },
      { camera: 'CAM-03', location: 'Parking Area', time: '14:19:20', event: 'Parked' },
      { camera: 'CAM-02', location: 'North Gate', time: '14:21:10', event: 'Seen' },
      { camera: 'CAM-05', location: 'East Entry', time: '14:22:45', event: 'Exit' },
    ],
  },
];

export const anprMetrics = {
  totalDetections: 1842,
  blacklistHits: 7,
  watchlistHits: 14,
  violations: 23,
  avgConfidence: 94.3,
  activeCameras: 8,
};

export const anprMockData = {
  stats: {
    vehiclesDetected: 1842,
    uniqueVehicles: 1240,
    blacklisted: 7,
    entryCount: 950,
    exitCount: 892,
    ocrAccuracy: 98.2,
    avgSpeed: 42,
  },
  liveFeed: [
    { id: 'V-DEMO-1', watchlist: 'WATCHLIST', timestamp: '14:32:02', plate: 'DL5CW4277', color: 'White', brand: 'Maruti', model: 'Grand Vitara', state: 'Delhi', zone: 'Main Gate Live Lane', speed: 34, image: anprFootage1, poster: anprFootage1, video: vehicleDetectionVideo, portrait: true,
      // Hardcoded ANPR simulation: one entry per vehicle. Each box tracks its car
      // across keyframes and only shows inside its time window. Coords are % of the
      // portrait video frame (the .portrait media box shows the full frame 1:1).
      // Add more cars here as { plate, confidence, keys: [{t,x,y,w,h}] }.
      plateTracks: [
        { plate: 'DL5CW4277', confidence: 96, keys: [
          { t: 0.4, x: 19, y: 22, w: 12, h: 8 },
          { t: 0.9, x: 33, y: 21, w: 12, h: 8 },
          { t: 1.4, x: 48, y: 21, w: 12, h: 8 },
          { t: 1.9, x: 63, y: 21, w: 12, h: 8 },
        ] },
      ],
    },
    { id: 'V-1', watchlist: 'BLACKLISTED', timestamp: '14:22:10', plate: 'MH12AB1234', color: 'White', brand: 'Maruti', model: 'Swift', state: 'Maharashtra', zone: 'Main Gate', speed: 42, image: anprFootage1, poster: anprFootage1, video: anprRecordings[1].video },
    { id: 'V-2', watchlist: 'SUSPICIOUS', timestamp: '14:21:44', plate: 'DL8CAF5678', color: 'Black', brand: 'Toyota', model: 'Fortuner', state: 'Delhi', zone: 'Parking Area', speed: 28, image: anprFootage2, poster: anprFootage2, video: anprRecordings[2].video },
    { id: 'V-3', watchlist: 'NORMAL', timestamp: '14:20:55', plate: 'KA09MN9012', color: 'Blue', brand: 'Tata', model: '407', state: 'Karnataka', zone: 'North Gate', speed: 35, image: anprFootage3, poster: anprFootage3, video: anprRecordings[3].video },
    { id: 'V-4', watchlist: 'NORMAL', timestamp: '14:19:30', plate: 'TN22CD3456', color: 'Red', brand: 'Hyundai', model: 'i20', state: 'Tamil Nadu', zone: 'East Entry', speed: 30, image: anprFootage4, poster: anprFootage4, video: anprRecordings[4].video },
    { id: 'V-5', watchlist: 'BLACKLISTED', timestamp: '14:18:12', plate: 'UP32IJ6789', color: 'Grey', brand: 'Honda', model: 'City', state: 'Uttar Pradesh', zone: 'Bus Bay', speed: 38, image: anprFootage5, poster: anprFootage5, video: anprRecordings[5].video },
  ],
  activeThreats: [
    { severity: 'HIGH', plate: 'MH14TC0786', type: 'Vehicle of Interest', location: 'Main Gate Live Lane', time: '14:32' },
    { severity: 'CRITICAL', plate: 'MH12AB1234', type: 'Blacklisted Vehicle', location: 'Main Gate', time: '14:22' },
    { severity: 'HIGH', plate: 'GJ01EF7890', type: 'Speeding (55km/h)', location: 'Bus Bay', time: '14:18' },
    { severity: 'NORMAL', plate: 'DL8CAF5678', type: 'Watchlist Match', location: 'Parking Area', time: '14:21' },
  ],
  watchlistSummary: {
    blacklisted: 12,
    stolen: 5,
    vip: 8,
    policeInterest: 14,
  },
  vehicleTimeline: [
    { plate: 'MH14TC0786', action: 'Vehicle of interest detected', gate: 'Main Gate Live Lane', time: '14:32' },
    { plate: 'MH12AB1234', action: 'Entering', gate: 'Main Gate', time: '14:22' },
    { plate: 'KA09MN9012', action: 'Exiting', gate: 'North Gate', time: '14:21' },
    { plate: 'DL8CAF5678', action: 'Seen', gate: 'Parking A', time: '14:19' },
    { plate: 'TN22CD3456', action: 'Entering', gate: 'East Entry', time: '14:18' },
    { plate: 'GJ05GH9900', action: 'Entering', gate: 'Main Gate', time: '14:15' },
  ],
};
