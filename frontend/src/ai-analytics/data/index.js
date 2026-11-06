// â”€â”€â”€ users.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const users = [
  { id: 'u-acme-001',      name: 'Acme Corp',                  email: 'admin@acme.com',    plan: 'Enterprise', cameras: 8, faces: 4, status: 'active',    joined: '2026-01-15', phone: '+91 98200 11111', city: 'Mumbai',  mrr: 49900 },
  { id: 'u-podar-002',     name: 'Podar International School', email: 'it@podar.edu',       plan: 'Enterprise', cameras: 8, faces: 4, status: 'active',    joined: '2026-02-08', phone: '+91 98200 22222', city: 'Mumbai',  mrr: 49900 },
  { id: 'u-citymart-003',  name: 'City Mart Retail',           email: 'sec@citymart.in',    plan: 'Pro',        cameras: 4, faces: 2, status: 'active',    joined: '2026-03-15', phone: '+91 98200 33333', city: 'Andheri', mrr: 14990 },
  { id: 'u-suspended-004', name: 'Sunrise Hotels',             email: 'admin@sunrise.com',  plan: 'Starter',    cameras: 0, faces: 0, status: 'suspended', joined: '2025-12-01', phone: '+91 98200 44444', city: 'Pune',    mrr: 0 },
]

// â”€â”€â”€ cameras.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const cameras = [
  { id: 'cam-acme-01',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Main Entrance',  status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.10.11' },
  { id: 'cam-acme-02',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Server Room',    status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.10.12' },
  { id: 'cam-acme-03',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Lobby A',        status: 'online',  resolution: '1440p', codec: 'h265', ip: '192.168.10.13' },
  { id: 'cam-acme-04',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Lobby B',        status: 'online',  resolution: '1440p', codec: 'h265', ip: '192.168.10.14' },
  { id: 'cam-acme-05',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Floor 2 East',   status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.10.15' },
  { id: 'cam-acme-06',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Parking',        status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.10.16' },
  { id: 'cam-acme-07',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Warehouse',      status: 'online',  resolution: '4K',    codec: 'h265', ip: '192.168.10.17' },
  { id: 'cam-acme-08',  userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Exit Gate',      status: 'offline', resolution: '1080p', codec: 'h264', ip: '192.168.10.18' },
  { id: 'cam-podar-01', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Main Gate',      status: 'online',  resolution: '1440p', codec: 'h265', ip: '192.168.20.10' },
  { id: 'cam-podar-02', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Playground',     status: 'online',  resolution: '1440p', codec: 'h265', ip: '192.168.20.11' },
  { id: 'cam-podar-03', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Library',        status: 'online',  resolution: '1080p', codec: 'h265', ip: '192.168.20.12' },
  { id: 'cam-podar-04', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Cafeteria',      status: 'offline', resolution: '1080p', codec: 'h265', ip: '192.168.20.13' },
  { id: 'cam-podar-05', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Bus Bay',        status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.20.14' },
  { id: 'cam-podar-06', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Admin Block',    status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.20.15' },
  { id: 'cam-podar-07', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Science Lab',    status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.20.16' },
  { id: 'cam-podar-08', userId: 'u-podar-002',    customer: 'Podar International School', name: 'Sports Ground',  status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.20.17' },
  { id: 'cam-cm-01',    userId: 'u-citymart-003', customer: 'City Mart Retail',           name: 'Store Entrance', status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.30.10' },
  { id: 'cam-cm-02',    userId: 'u-citymart-003', customer: 'City Mart Retail',           name: 'Checkout Lane',  status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.30.11' },
  { id: 'cam-cm-03',    userId: 'u-citymart-003', customer: 'City Mart Retail',           name: 'Stockroom',      status: 'online',  resolution: '1080p', codec: 'h264', ip: '192.168.30.12' },
  { id: 'cam-cm-04',    userId: 'u-citymart-003', customer: 'City Mart Retail',           name: 'Parking Lot',    status: 'offline', resolution: '1080p', codec: 'h264', ip: '192.168.30.13' },
]

// â”€â”€â”€ faces.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const faces = [
  { id: 'f-acme-1', userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Aman Sharma',        notes: 'CEO',                     status: 'registered', matches: 142, added: '2026-01-20', uploadedBy: 'user'  },
  { id: 'f-acme-2', userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Priya Mehta',        notes: 'COO',                     status: 'registered', matches: 98,  added: '2026-01-20', uploadedBy: 'user'  },
  { id: 'f-acme-3', userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Rahul Verma',        notes: 'Security Lead',           status: 'registered', matches: 64,  added: '2026-01-21', uploadedBy: 'user'  },
  { id: 'f-acme-4', userId: 'u-acme-001',     customer: 'Acme Corp',                 name: 'Test Visitor',       notes: 'Demo enrolment by admin', status: 'failed',     matches: 0,   added: '2026-04-12', uploadedBy: 'admin' },
  { id: 'f-pod-1',  userId: 'u-podar-002',    customer: 'Podar International School', name: 'Ravi Kumar',         notes: 'Security guard, gate 1',  status: 'registered', matches: 312, added: '2026-02-08', uploadedBy: 'user'  },
  { id: 'f-pod-2',  userId: 'u-podar-002',    customer: 'Podar International School', name: 'Sunita Iyer',        notes: 'School Principal',        status: 'registered', matches: 47,  added: '2026-02-08', uploadedBy: 'user'  },
  { id: 'f-pod-3',  userId: 'u-podar-002',    customer: 'Podar International School', name: 'Bus Driver A',       notes: 'Morning bus pickup',      status: 'registered', matches: 88,  added: '2026-02-15', uploadedBy: 'user'  },
  { id: 'f-pod-4',  userId: 'u-podar-002',    customer: 'Podar International School', name: 'Bus Driver B',       notes: 'Afternoon bus drop',      status: 'pending',    matches: 0,   added: '2026-05-03', uploadedBy: 'user'  },
  { id: 'f-cm-1',   userId: 'u-citymart-003', customer: 'City Mart Retail',           name: 'Store Manager Anil', notes: 'Manager, key access',    status: 'registered', matches: 29,  added: '2026-03-15', uploadedBy: 'user'  },
  { id: 'f-cm-2',   userId: 'u-citymart-003', customer: 'City Mart Retail',           name: 'Cashier Deepa',      notes: 'Senior cashier',         status: 'registered', matches: 18,  added: '2026-03-15', uploadedBy: 'user'  },
]

// â”€â”€â”€ events.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const events = [
  { id: 'ev-001', userId: 'u-acme-001',     customer: 'Acme Corp',                 camera: 'Main Entrance', cameraId: 'cam-acme-01',  type: 'tripwire.entry',  severity: 'info',     ts: '2026-05-04 09:02', person: 'Aman Sharma',        confidence: 0.92, acked: true,  payload: { action: 'Entry', matchedName: 'Aman Sharma' } },
  { id: 'ev-002', userId: 'u-acme-001',     customer: 'Acme Corp',                 camera: 'Main Entrance', cameraId: 'cam-acme-01',  type: 'tripwire.entry',  severity: 'info',     ts: '2026-05-04 09:14', person: 'Priya Mehta',        confidence: 0.89, acked: false, payload: { matchedName: 'Priya Mehta' } },
  { id: 'ev-003', userId: 'u-acme-001',     customer: 'Acme Corp',                 camera: 'Server Room',   cameraId: 'cam-acme-02',  type: 'person.unknown',  severity: 'warning',  ts: '2026-05-04 11:42', person: 'Unknown Person',     confidence: 0.81, acked: true,  payload: { matchedName: 'Unknown' } },
  { id: 'ev-101', userId: 'u-podar-002',    customer: 'Podar International School', camera: 'Main Gate',     cameraId: 'cam-podar-01', type: 'tripwire.entry',  severity: 'info',     ts: '2026-05-04 07:40', person: 'Ravi Kumar (Staff)', confidence: 0.94, acked: true,  payload: { matchedName: 'Ravi Kumar (Staff)' } },
  { id: 'ev-102', userId: 'u-podar-002',    customer: 'Podar International School', camera: 'Playground',    cameraId: 'cam-podar-02', type: 'crowd.density',   severity: 'warning',  ts: '2026-05-04 12:18', person: '58 people detected', confidence: null, acked: false, payload: { count: 58, threshold: 50 } },
  { id: 'ev-103', userId: 'u-podar-002',    customer: 'Podar International School', camera: 'Cafeteria',     cameraId: 'cam-podar-04', type: 'camera.tampered', severity: 'critical', ts: '2026-05-04 14:05', person: 'â€”',                  confidence: null, acked: false, payload: { reason: 'Frame went black' } },
  { id: 'ev-104', userId: 'u-podar-002',    customer: 'Podar International School', camera: 'Science Lab',   cameraId: 'cam-podar-07', type: 'tripwire.exit',   severity: 'info',     ts: '2026-05-04 15:20', person: 'Unknown',            confidence: 0.88, acked: true,  payload: { action: 'Exit' } },
  { id: 'ev-201', userId: 'u-citymart-003', customer: 'City Mart Retail',           camera: 'Store Entrance',cameraId: 'cam-cm-01',    type: 'crowd.density',   severity: 'info',     ts: '2026-05-04 18:30', person: '24 people',          confidence: null, acked: false, payload: { count: 24 } },
  { id: 'ev-202', userId: 'u-citymart-003', customer: 'City Mart Retail',           camera: 'Checkout Lane', cameraId: 'cam-cm-02',    type: 'queue.long',      severity: 'warning',  ts: '2026-05-04 18:45', person: 'Queue length: 12',   confidence: null, acked: false, payload: { queueLength: 12, avgWaitSec: 420 } },
]

// â”€â”€â”€ tickets.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const tickets = [
  {
    id: 't-101', userId: 'u-podar-002', customer: 'Podar International School',
    subject: 'Camera 4 keeps going offline',
    body: 'The cafeteria camera (cam-podar-04) shows offline since this morning. Power was checked and is fine. NVR shows the camera as connected. Please investigate.',
    category: 'camera_offline', priority: 'high', status: 'in_progress',
    relatedCamera: 'cam-podar-04', assignee: 'Priyanka (Support)',
    firstRespondedAt: '2026-05-04 13:50', resolvedAt: null, createdAt: '2026-05-04 12:30',
    messages: [
      { from: 'customer', text: 'Cafeteria camera shows offline since this morning. Power was checked.', ts: '2026-05-04 12:30' },
      { from: 'admin',    text: "Thanks for reaching out! I've checked the MediaMTX logs. The RTSP connection is timing out. Could you confirm the NVR IP has not changed recently?", ts: '2026-05-04 13:50' },
      { from: 'customer', text: 'NVR IP is the same: 192.168.20.10. Nothing changed on our end.', ts: '2026-05-04 14:10' },
    ],
  },
  {
    id: 't-102', userId: 'u-acme-001', customer: 'Acme Corp',
    subject: 'Add 8 more cameras',
    body: 'We are adding a new floor to our office. We need to provision 8 more cameras to the existing NVR. What is the process?',
    category: 'feature_request', priority: 'normal', status: 'open',
    relatedCamera: null, assignee: null,
    firstRespondedAt: null, resolvedAt: null, createdAt: '2026-05-03 10:15',
    messages: [
      { from: 'customer', text: 'Adding new floor â€” need to provision 8 cameras to existing NVR.', ts: '2026-05-03 10:15' },
    ],
  },
  {
    id: 't-103', userId: 'u-citymart-003', customer: 'City Mart Retail',
    subject: 'Footfall report wrong',
    body: 'The heatmap shows 0 visitors on Sunday but the store was open and busy. Footfall AI seems broken on cam-cm-01.',
    category: 'bug', priority: 'normal', status: 'resolved',
    relatedCamera: 'cam-cm-01', assignee: 'Priyanka (Support)',
    firstRespondedAt: '2026-04-29 11:00', resolvedAt: '2026-05-01 17:30', createdAt: '2026-04-29 09:45',
    messages: [
      { from: 'customer', text: 'Heatmap shows 0 visitors on Sunday but store was open and busy.', ts: '2026-04-29 09:45' },
      { from: 'admin',    text: 'We identified a bug in the crowd counting pipeline where timezone shifts on Sundays caused a miscalculation. This has been patched in v2.4.1.', ts: '2026-04-29 11:00' },
      { from: 'customer', text: 'Confirmed fixed! Thank you.', ts: '2026-05-01 17:00' },
    ],
  },
  {
    id: 't-104', userId: 'u-acme-001', customer: 'Acme Corp',
    subject: 'Invoice mismatch â€” April',
    body: 'Our plan shows â‚¹14,990/mo but the card was charged â‚¹49,900. Please investigate and refund the difference.',
    category: 'billing', priority: 'urgent', status: 'resolved',
    relatedCamera: null, assignee: 'Finance Team',
    firstRespondedAt: '2026-04-15 10:30', resolvedAt: '2026-04-15 14:00', createdAt: '2026-04-15 09:00',
    messages: [
      { from: 'customer', text: 'Plan shows 14990 but card was charged 49900. Please refund.', ts: '2026-04-15 09:00' },
      { from: 'admin',    text: 'Apologies for the inconvenience. This was a billing system error during the plan upgrade. A prorated refund of â‚¹34,910 has been initiated and will reflect within 5-7 business days.', ts: '2026-04-15 10:30' },
      { from: 'customer', text: 'Refund received. Thank you for the quick resolution.', ts: '2026-04-15 16:00' },
    ],
  },
  {
    id: 't-105', userId: 'u-podar-002', customer: 'Podar International School',
    subject: 'Add SSO with Google',
    body: 'We are on the Enterprise plan which promised SSO support. When can we expect Google SSO integration?',
    category: 'feature_request', priority: 'low', status: 'waiting_customer',
    relatedCamera: null, assignee: 'Sahil (Tech Lead)',
    firstRespondedAt: '2026-04-20 16:00', resolvedAt: null, createdAt: '2026-04-18 14:00',
    messages: [
      { from: 'customer', text: 'Enterprise plan promised SSO. When?', ts: '2026-04-18 14:00' },
      { from: 'admin',    text: "SSO with Google is on our Q2 roadmap. I've added your account to the beta list. Could you share your Google Workspace domain so we can whitelist it?", ts: '2026-04-20 16:00' },
    ],
  },
]

// â”€â”€â”€ auditLogs.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const auditLogs = [
  { id: 'al-001', adminId: 'a-001', adminName: 'Sahil',    adminRole: 'superadmin', action: 'user.suspend',        resourceType: 'user',         resourceId: 'u-suspended-004', description: 'Suspended Sunrise Hotels account',       detail: { reason: 'Non-payment after 30 days', previousStatus: 'active' },             ip: '203.0.113.10', ts: '2025-12-02 16:00' },
  { id: 'al-002', adminId: 'a-002', adminName: 'Priyanka', adminRole: 'support',     action: 'ticket.respond',      resourceType: 'ticket',       resourceId: 't-101',           description: 'Replied to ticket t-101',                detail: { messageId: 'tm-201' },                                                       ip: '203.0.113.11', ts: '2026-05-04 13:50' },
  { id: 'al-003', adminId: 'a-001', adminName: 'Sahil',    adminRole: 'superadmin', action: 'camera.delete',       resourceType: 'camera',       resourceId: 'cam-cm-99',       description: 'Deleted camera cam-cm-99',               detail: { reason: 'Customer requested via ticket t-095' },                             ip: '203.0.113.10', ts: '2026-04-28 11:15' },
  { id: 'al-004', adminId: 'a-003', adminName: 'Finance',  adminRole: 'billing',     action: 'subscription.refund', resourceType: 'subscription', resourceId: 's-old-110',       description: 'Issued prorated refund',                 detail: { amount_inr: 34910, reason: 'Billing system error â€” overcharge on upgrade' }, ip: '203.0.113.12', ts: '2026-04-30 15:00' },
  { id: 'al-005', adminId: 'a-001', adminName: 'Sahil',    adminRole: 'superadmin', action: 'face.remove',         resourceType: 'face_upload',  resourceId: 'f-acme-4',        description: 'Removed face enrolment f-acme-4',       detail: { reason: 'Customer reported wrong person' },                                  ip: '203.0.113.10', ts: '2026-04-12 14:30' },
  { id: 'al-006', adminId: 'a-002', adminName: 'Priyanka', adminRole: 'support',     action: 'ticket.respond',      resourceType: 'ticket',       resourceId: 't-103',           description: 'Replied to ticket t-103',                detail: { messageId: 'tm-105' },                                                       ip: '203.0.113.11', ts: '2026-04-29 11:00' },
  { id: 'al-007', adminId: 'a-001', adminName: 'Sahil',    adminRole: 'superadmin', action: 'user.plan_change',    resourceType: 'user',         resourceId: 'u-podar-002',     description: 'Upgraded Podar to Enterprise',           detail: { from: 'Pro', to: 'Enterprise' },                                             ip: '203.0.113.10', ts: '2026-02-08 09:30' },
  { id: 'al-008', adminId: 'a-003', adminName: 'Finance',  adminRole: 'billing',     action: 'invoice.generate',   resourceType: 'invoice',      resourceId: 'inv-apr-001',     description: 'Generated April invoices (batch)',       detail: { count: 3, total_inr: 114780 },                                               ip: '203.0.113.12', ts: '2026-04-01 00:01' },
  { id: 'al-009', adminId: 'a-001', adminName: 'Sahil',    adminRole: 'superadmin', action: 'admin.login',         resourceType: 'admin_user',   resourceId: 'a-001',           description: 'Admin login',                            detail: { mfa: true },                                                                 ip: '203.0.113.10', ts: '2026-05-04 14:30' },
  { id: 'al-010', adminId: 'a-004', adminName: 'Vikram',   adminRole: 'readonly',    action: 'report.export',       resourceType: 'report',       resourceId: null,              description: 'Exported usage metrics report',          detail: { format: 'csv', dateRange: '2026-04-01 to 2026-04-30' },                     ip: '203.0.113.13', ts: '2026-05-02 11:45' },
]

// â”€â”€â”€ helpers.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function initials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

const AVATAR_COLORS = [
  { bg: '#fff0e6', text: '#0A1F44' },
  { bg: '#eff6ff', text: '#1d4ed8' },
  { bg: '#f0fdf4', text: '#15803d' },
  { bg: '#faf5ff', text: '#7c3aed' },
  { bg: '#EAF0F6', text: '#b45309' },
  { bg: '#fdf2f8', text: '#be185d' },
  { bg: '#f0f9ff', text: '#0369a1' },
]

export function avatarColors(name) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % AVATAR_COLORS.length
  return AVATAR_COLORS[h]
}

export function formatDate(ts) {
  if (!ts) return 'â€”'
  const d = new Date(ts.replace(' ', 'T'))
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(ts) {
  if (!ts) return 'â€”'
  const d = new Date(ts.replace(' ', 'T'))
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
}

export function formatTime(ts) {
  if (!ts) return 'â€”'
  const d = new Date(ts.replace(' ', 'T'))
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

export function formatCurrency(val) {
  return 'â‚¹' + val.toLocaleString('en-IN')
}