-- ========================================================================
-- Drishyam — Admin Dashboard schema + dummy data
--
-- One file your team can pipe straight into MySQL:
--   mysql -u root -p drishyamvms < admin_schema.sql
--
-- Idempotent: uses CREATE TABLE IF NOT EXISTS and INSERT IGNORE so it can
-- be re-run on an existing dev database without errors.
--
-- Assumes the existing operational tables already exist (users, plans,
-- subscriptions, sites, camera_groups, cameras, ai_events). If your dev
-- DB is fresh, run the regular Sequelize migrations first.
-- ========================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ─── 1. admin_users ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id              CHAR(36) PRIMARY KEY,
  email           VARCHAR(255) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            ENUM('superadmin','support','billing','readonly') NOT NULL DEFAULT 'support',
  mfa_enabled     TINYINT(1) NOT NULL DEFAULT 0,
  mfa_secret      VARCHAR(255) NULL,
  last_login_at   DATETIME NULL,
  last_login_ip   VARCHAR(64) NULL,
  status          ENUM('active','suspended') NOT NULL DEFAULT 'active',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_admin_users_email (email),
  KEY idx_admin_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 2. admin_audit_log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_user_id   CHAR(36)     NOT NULL,
  action          VARCHAR(64)  NOT NULL,
  resource_type   VARCHAR(64)  NOT NULL,
  resource_id     CHAR(36)     NULL,
  payload         JSON         NULL,
  ip              VARCHAR(64)  NULL,
  user_agent      VARCHAR(255) NULL,
  ts              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_admin    (admin_user_id, ts),
  KEY idx_audit_resource (resource_type, resource_id),
  KEY idx_audit_action   (action, ts),
  CONSTRAINT fk_audit_admin
    FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
    ON DELETE NO ACTION ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 3. face_uploads ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS face_uploads (
  id                CHAR(36) PRIMARY KEY,
  user_id           CHAR(36) NOT NULL,
  uploaded_by       ENUM('user','admin') NOT NULL DEFAULT 'user',
  uploaded_by_admin CHAR(36) NULL,
  display_name      VARCHAR(120) NOT NULL,
  notes             VARCHAR(500) NULL,
  file_path         VARCHAR(500) NOT NULL,
  file_size_bytes   INT NOT NULL,
  mime_type         VARCHAR(64) NOT NULL,
  thumbnail_url     VARCHAR(500) NULL,
  encoding_status   ENUM('pending','registered','failed','removed') NOT NULL DEFAULT 'pending',
  encoding_error    VARCHAR(500) NULL,
  match_count       INT NOT NULL DEFAULT 0,
  last_matched_at   DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at        DATETIME NULL,
  KEY idx_face_user   (user_id, created_at),
  KEY idx_face_status (encoding_status),
  KEY idx_face_admin  (uploaded_by_admin),
  CONSTRAINT fk_face_user  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_face_admin FOREIGN KEY (uploaded_by_admin) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 4. support_tickets ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id                    CHAR(36) PRIMARY KEY,
  user_id               CHAR(36) NOT NULL,
  subject               VARCHAR(255) NOT NULL,
  body                  TEXT NOT NULL,
  category              ENUM('billing','camera_offline','bug','feature_request','other') NOT NULL,
  priority              ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status                ENUM('open','in_progress','waiting_customer','resolved','closed') NOT NULL DEFAULT 'open',
  related_camera_id     CHAR(36) NULL,
  related_site_id       CHAR(36) NULL,
  assigned_to           CHAR(36) NULL,
  first_responded_at    DATETIME NULL,
  resolved_at           DATETIME NULL,
  customer_satisfaction TINYINT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ticket_user     (user_id, created_at),
  KEY idx_ticket_status   (status, priority),
  KEY idx_ticket_assigned (assigned_to, status),
  CONSTRAINT fk_ticket_user   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_camera FOREIGN KEY (related_camera_id) REFERENCES cameras(id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_admin  FOREIGN KEY (assigned_to) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_messages (
  id          CHAR(36) PRIMARY KEY,
  ticket_id   CHAR(36) NOT NULL,
  author_type ENUM('customer','admin') NOT NULL,
  author_id   CHAR(36) NOT NULL,
  body        TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_msg_ticket (ticket_id, created_at),
  CONSTRAINT fk_msg_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 5. usage_metrics_daily ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_metrics_daily (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id             CHAR(36) NOT NULL,
  date                DATE NOT NULL,
  cameras_total       INT NOT NULL DEFAULT 0,
  cameras_online      INT NOT NULL DEFAULT 0,
  cameras_offline     INT NOT NULL DEFAULT 0,
  events_info         INT NOT NULL DEFAULT 0,
  events_warning      INT NOT NULL DEFAULT 0,
  events_critical     INT NOT NULL DEFAULT 0,
  events_acknowledged INT NOT NULL DEFAULT 0,
  recording_bytes     BIGINT NOT NULL DEFAULT 0,
  bandwidth_bytes_in  BIGINT NOT NULL DEFAULT 0,
  bandwidth_bytes_out BIGINT NOT NULL DEFAULT 0,
  faces_total         INT NOT NULL DEFAULT 0,
  faces_added_today   INT NOT NULL DEFAULT 0,
  active_minutes      INT NOT NULL DEFAULT 0,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_metrics_user_date (user_id, date),
  KEY idx_metrics_date (date),
  CONSTRAINT fk_metrics_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================================================
-- DUMMY DATA
-- ========================================================================

-- Plans
INSERT IGNORE INTO plans (id, name, price_inr, max_cameras, retention_days, features, created_at) VALUES
('p-starter',    'Starter',     49900,   25,  7, '{"ai":["person"],"alerts":["email"]}',                                              NOW()),
('p-pro',        'Pro',        149900,  100, 30, '{"ai":["person","face","crowd"],"alerts":["email","sms","webhook"]}',               NOW()),
('p-enterprise', 'Enterprise', 499900, 2000, 90, '{"ai":["all"],"alerts":["all"],"sso":true,"sla":"99.9"}',                            NOW());

-- Customers
INSERT IGNORE INTO users (id, name, email, phone, password, role, status, created_at, updated_at) VALUES
('u-acme-001',      'Acme Corp Pvt Ltd',  'admin@acmecorp.in',   '+91-9876543210', '$2a$10$dummybcrypt', 'user', 'active',    '2026-01-15 09:30:00', NOW()),
('u-podar-002',     'Podar School Group', 'it@podarschools.com', '+91-9988776655', '$2a$10$dummybcrypt', 'user', 'active',    '2026-02-04 11:20:00', NOW()),
('u-citymart-003',  'City Mart Retail',   'ops@citymart.in',     '+91-9223344556', '$2a$10$dummybcrypt', 'user', 'active',    '2026-03-12 15:45:00', NOW()),
('u-suspended-004', 'Old Trial Account',  'demo@example.com',    '+91-9000000001', '$2a$10$dummybcrypt', 'user', 'suspended', '2025-11-02 10:00:00', NOW());

-- Subscriptions
INSERT IGNORE INTO subscriptions (id, user_id, plan_id, status, started_at, current_period_end, created_at, updated_at) VALUES
('s-001', 'u-acme-001',     'p-pro',        'active',    '2026-01-15', '2026-06-15', NOW(), NOW()),
('s-002', 'u-podar-002',    'p-enterprise', 'active',    '2026-02-04', '2027-02-04', NOW(), NOW()),
('s-003', 'u-citymart-003', 'p-starter',    'active',    '2026-03-12', '2026-06-12', NOW(), NOW()),
('s-004', 'u-suspended-004','p-starter',    'cancelled', '2025-11-02', '2025-12-02', NOW(), NOW());

-- Sites
INSERT IGNORE INTO sites (id, user_id, name, slug, address, status, created_at, updated_at) VALUES
('site-acme-hq',    'u-acme-001',     'Acme HQ',          'acme-hq',          'Bandra Kurla Complex, Mumbai 400051',  'active', '2026-01-16 09:00:00', NOW()),
('site-acme-wh',    'u-acme-001',     'Acme Warehouse',   'acme-warehouse',   'Bhiwandi, Maharashtra 421302',         'active', '2026-01-20 10:00:00', NOW()),
('site-podar-mum',  'u-podar-002',    'Podar Mumbai',     'podar-mumbai',     'Santacruz East, Mumbai 400055',        'active', '2026-02-05 09:00:00', NOW()),
('site-podar-pun',  'u-podar-002',    'Podar Pune',       'podar-pune',       'Hadapsar, Pune 411028',                'active', '2026-02-06 09:00:00', NOW()),
('site-citymart-1', 'u-citymart-003', 'CityMart Andheri', 'citymart-andheri', 'Andheri West, Mumbai 400058',          'active', '2026-03-13 10:00:00', NOW());

-- Camera groups
INSERT IGNORE INTO camera_groups (id, user_id, site_id, name, host, port, http_port, username, device_type, total_channels, status, s3_folder, created_at, updated_at) VALUES
('cg-acme-nvr1',   'u-acme-001',     'site-acme-hq',    'Acme HQ NVR',          '192.168.10.10', 554, 80, 'admin', 'hikvision', 16, 'online', 'recordings/u-acme-001/acme-hq-nvr',         NOW(), NOW()),
('cg-podar-mum-1', 'u-podar-002',    'site-podar-mum',  'Podar Mumbai NVR',     '192.168.20.10', 554, 80, 'admin', 'hikvision',  8, 'online', 'recordings/u-podar-002/podar-mumbai-nvr',   NOW(), NOW()),
('cg-citymart-1',  'u-citymart-003', 'site-citymart-1', 'CityMart Andheri NVR', '192.168.30.10', 554, 80, 'admin', 'dahua',      4, 'online', 'recordings/u-citymart-003/citymart-andheri',NOW(), NOW());

-- Cameras (representative subset; same pattern repeats for all channels)
INSERT IGNORE INTO cameras (id, user_id, group_id, monitor_id, name, host, port, path, channel, type, width, height, fps, status, s3_path, settings, created_at, updated_at) VALUES
('cam-acme-01', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010101', 'Office Gate',           '192.168.10.10', 554, '/Streaming/Channels/101', 1, 'h264', 1920, 1080, 25, 'online',  'recordings/u-acme-001/acme-hq-nvr/cam-01', '{"ai":{"enabled":true,"detectors":["person","face"]}}', NOW(), NOW()),
('cam-acme-02', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010102', 'Reception',             '192.168.10.10', 554, '/Streaming/Channels/201', 2, 'h264', 1920, 1080, 25, 'online',  'recordings/u-acme-001/acme-hq-nvr/cam-02', '{"ai":{"enabled":true,"detectors":["person","face"]}}', NOW(), NOW()),
('cam-acme-03', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010103', 'Lobby',                 '192.168.10.10', 554, '/Streaming/Channels/301', 3, 'h264', 1920, 1080, 25, 'online',  'recordings/u-acme-001/acme-hq-nvr/cam-03', '{"ai":{"enabled":true,"detectors":["person"]}}',          NOW(), NOW()),
('cam-acme-04', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010104', 'Server Room',           '192.168.10.10', 554, '/Streaming/Channels/401', 4, 'h265', 1280, 1440, 25, 'online',  'recordings/u-acme-001/acme-hq-nvr/cam-04', '{"ai":{"enabled":true,"detectors":["person"]}}',          NOW(), NOW()),
('cam-podar-m-01','u-podar-002','cg-podar-mum-1','aaaa11110001','Main Gate',              '192.168.20.10', 554, '/Streaming/Channels/101', 1, 'h265', 1280, 1440, 25, 'online',  'recordings/u-podar-002/podar-mumbai-nvr/cam-01', '{"ai":{"enabled":true,"detectors":["person","face"]}}', NOW(), NOW()),
('cam-podar-m-02','u-podar-002','cg-podar-mum-1','aaaa11110002','Playground',             '192.168.20.10', 554, '/Streaming/Channels/201', 2, 'h265', 1280, 1440, 25, 'online',  'recordings/u-podar-002/podar-mumbai-nvr/cam-02', '{"ai":{"enabled":true,"detectors":["person","crowd"]}}', NOW(), NOW()),
('cam-podar-m-03','u-podar-002','cg-podar-mum-1','aaaa11110003','Library',                '192.168.20.10', 554, '/Streaming/Channels/301', 3, 'h265', 1280, 1440, 25, 'online',  'recordings/u-podar-002/podar-mumbai-nvr/cam-03', '{"ai":{"enabled":true,"detectors":["person"]}}',          NOW(), NOW()),
('cam-podar-m-04','u-podar-002','cg-podar-mum-1','aaaa11110004','Cafeteria',              '192.168.20.10', 554, '/Streaming/Channels/401', 4, 'h265', 1280, 1440, 25, 'offline', 'recordings/u-podar-002/podar-mumbai-nvr/cam-04', '{}',                                                       NOW(), NOW()),
('cam-cm-01',     'u-citymart-003','cg-citymart-1','bbbb22220001','Store Entrance',       '192.168.30.10', 554, '/cam/realmonitor?channel=1&subtype=0', 1, 'h264', 1920, 1080, 25, 'online', 'recordings/u-citymart-003/citymart-andheri/cam-01', '{"ai":{"enabled":true,"detectors":["person","crowd"]}}', NOW(), NOW()),
('cam-cm-02',     'u-citymart-003','cg-citymart-1','bbbb22220002','Checkout Lane',        '192.168.30.10', 554, '/cam/realmonitor?channel=2&subtype=0', 2, 'h264', 1920, 1080, 25, 'online', 'recordings/u-citymart-003/citymart-andheri/cam-02', '{"ai":{"enabled":true,"detectors":["person"]}}',          NOW(), NOW());

-- Admin users
INSERT IGNORE INTO admin_users (id, email, name, password_hash, role, mfa_enabled, last_login_at, status, created_at, updated_at) VALUES
('a-001', 'sahil@drishyam.io',    'Sahil (Tech Lead)',  '$2a$10$dummybcrypt', 'superadmin', 1, '2026-05-04 14:30:00', 'active', '2025-08-01 10:00:00', NOW()),
('a-002', 'priyanka@drishyam.io', 'Priyanka (Support)', '$2a$10$dummybcrypt', 'support',    1, '2026-05-04 13:45:00', 'active', '2025-09-15 10:00:00', NOW()),
('a-003', 'finance@drishyam.io',  'Finance Team',       '$2a$10$dummybcrypt', 'billing',    1, '2026-05-03 17:00:00', 'active', '2025-10-01 10:00:00', NOW()),
('a-004', 'analyst@drishyam.io',  'Vikram (Analyst)',   '$2a$10$dummybcrypt', 'readonly',   0, '2026-05-04 11:00:00', 'active', '2026-02-10 10:00:00', NOW());

-- Admin audit log
INSERT IGNORE INTO admin_audit_log (admin_user_id, action, resource_type, resource_id, payload, ip, ts) VALUES
('a-001', 'user.suspend',         'user',         'u-suspended-004', '{"reason":"non-payment after 30d","previousStatus":"active"}', '203.0.113.10', '2025-12-02 16:00:00'),
('a-002', 'ticket.respond',       'ticket',       't-101',           '{"messageId":"tm-201"}',                                       '203.0.113.11', '2026-05-04 13:50:00'),
('a-001', 'camera.delete',        'camera',       'cam-cm-99',       '{"reason":"customer requested via ticket t-095"}',             '203.0.113.10', '2026-04-28 11:15:00'),
('a-003', 'subscription.refund',  'subscription', 's-old-110',       '{"amount_inr":4990,"reason":"prorated upgrade credit"}',       '203.0.113.12', '2026-04-30 15:00:00'),
('a-001', 'face.remove',          'face_upload',  'f-acme-4',        '{"reason":"customer reported wrong person"}',                  '203.0.113.10', '2026-04-12 14:30:00');

-- Face uploads (the watchlist)
INSERT IGNORE INTO face_uploads (id, user_id, uploaded_by, uploaded_by_admin, display_name, notes, file_path, file_size_bytes, mime_type, encoding_status, encoding_error, match_count, last_matched_at, created_at, updated_at) VALUES
('f-acme-1', 'u-acme-001', 'user',  NULL,    'Aman Sharma',  'CEO',                     'data/known_faces/u-acme-001/aman.jpg',   287412, 'image/jpeg', 'registered', NULL,                       142, '2026-05-04 09:02:14', '2026-01-20 10:00:00', NOW()),
('f-acme-2', 'u-acme-001', 'user',  NULL,    'Priya Mehta',  'COO',                     'data/known_faces/u-acme-001/priya.jpg',  294115, 'image/jpeg', 'registered', NULL,                        98, '2026-05-04 09:14:22', '2026-01-20 10:05:00', NOW()),
('f-acme-3', 'u-acme-001', 'user',  NULL,    'Rahul Verma',  'Security Lead',           'data/known_faces/u-acme-001/rahul.jpg',  312980, 'image/jpeg', 'registered', NULL,                        64, '2026-05-03 18:00:00', '2026-01-21 09:00:00', NOW()),
('f-acme-4', 'u-acme-001', 'admin', 'a-002', 'Test Visitor', 'Demo enrolment by admin', 'data/known_faces/u-acme-001/test.jpg',   155204, 'image/jpeg', 'failed',     'No face found in image.',     0, NULL,                  '2026-04-12 14:00:00', NOW()),
('f-pod-1',  'u-podar-002', 'user', NULL,    'Ravi Kumar (Staff)',     'Security guard, gate 1', 'data/known_faces/u-podar-002/ravi.jpg',     245980, 'image/jpeg', 'registered', NULL, 312, '2026-05-04 07:40:11', '2026-02-08 09:00:00', NOW()),
('f-pod-2',  'u-podar-002', 'user', NULL,    'Sunita Iyer (Principal)','School principal',       'data/known_faces/u-podar-002/sunita.jpg',   268402, 'image/jpeg', 'registered', NULL,  47, '2026-05-04 08:30:00', '2026-02-08 09:10:00', NOW()),
('f-pod-3',  'u-podar-002', 'user', NULL,    'Bus Driver A',           'Morning bus pickup',      'data/known_faces/u-podar-002/driver_a.jpg', 211550, 'image/jpeg', 'registered', NULL,  88, '2026-05-04 07:15:00', '2026-02-15 06:00:00', NOW()),
('f-pod-4',  'u-podar-002', 'user', NULL,    'Bus Driver B',           'Afternoon bus drop',      'data/known_faces/u-podar-002/driver_b.jpg', 209882, 'image/jpeg', 'pending',    NULL,   0, NULL,                  '2026-05-03 18:30:00', NOW()),
('f-cm-1',   'u-citymart-003', 'user', NULL, 'Store Manager Anil', 'Manager, key access', 'data/known_faces/u-citymart-003/anil.jpg',  302115, 'image/jpeg', 'registered', NULL, 29, '2026-05-04 09:00:00', '2026-03-15 10:00:00', NOW()),
('f-cm-2',   'u-citymart-003', 'user', NULL, 'Cashier Deepa',      'Senior cashier',      'data/known_faces/u-citymart-003/deepa.jpg', 287443, 'image/jpeg', 'registered', NULL, 18, '2026-05-04 18:45:12', '2026-03-15 10:15:00', NOW());

-- Support tickets
INSERT IGNORE INTO support_tickets (id, user_id, subject, body, category, priority, status, related_camera_id, assigned_to, first_responded_at, resolved_at, created_at, updated_at) VALUES
('t-101', 'u-podar-002',    'Camera 4 keeps going offline', 'Cafeteria camera shows offline since this morning. Power was checked.', 'camera_offline', 'high',   'in_progress',     'cam-podar-m-04', 'a-002', '2026-05-04 13:50:00', NULL,                  '2026-05-04 12:30:00', NOW()),
('t-102', 'u-acme-001',     'Add 8 more cameras',           'Adding new floor — need to provision 8 cameras to existing NVR.',     'feature_request','normal', 'open',            NULL,             NULL,    NULL,                  NULL,                  '2026-05-03 10:15:00', NOW()),
('t-103', 'u-citymart-003', 'Footfall report wrong',        'Heatmap shows 0 visitors on Sunday but store was open and busy.',     'bug',            'normal', 'resolved',        'cam-cm-01',      'a-002', '2026-04-29 11:00:00', '2026-05-01 17:30:00', '2026-04-29 09:45:00', NOW()),
('t-104', 'u-acme-001',     'Invoice mismatch — April',     'Plan shows 14990 but card was charged 49900.',                        'billing',        'urgent', 'resolved',        NULL,             'a-003', '2026-04-15 10:30:00', '2026-04-15 14:00:00', '2026-04-15 09:00:00', NOW()),
('t-105', 'u-podar-002',    'Add SSO with Google',          'Enterprise plan promised SSO. When?',                                  'feature_request','low',    'waiting_customer',NULL,             'a-001', '2026-04-20 16:00:00', NULL,                  '2026-04-18 14:00:00', NOW());

-- AI events (representative subset for two customers)
INSERT IGNORE INTO ai_events (id, user_id, camera_id, monitor_id, event_type, severity, ts, bbox, track_id, confidence, payload, snapshot_key, acknowledged_at, created_at, updated_at) VALUES
('ev-001','u-acme-001',  'cam-acme-01','1a66d1aa01010101','tripwire.entry','info',     '2026-05-04 09:02:14','[412,180,560,580]', 1, 0.92,'{"matchedName":"Aman Sharma","action":"Entry"}','ai/events/u-acme-001/1a66d1aa01010101/2026-05-04T09-02-14.jpg','2026-05-04 09:05:00', NOW(), NOW()),
('ev-002','u-acme-001',  'cam-acme-01','1a66d1aa01010101','tripwire.entry','info',     '2026-05-04 09:14:22','[480,210,620,610]', 2, 0.89,'{"matchedName":"Priya Mehta"}',                  'ai/events/u-acme-001/1a66d1aa01010101/2026-05-04T09-14-22.jpg', NULL,                  NOW(), NOW()),
('ev-003','u-acme-001',  'cam-acme-02','1a66d1aa01010102','person.unknown','warning',  '2026-05-04 11:42:01','[300,160,470,580]', 5, 0.81,'{"matchedName":"Unknown"}',                      'ai/events/u-acme-001/1a66d1aa01010102/2026-05-04T11-42-01.jpg','2026-05-04 11:45:00', NOW(), NOW()),
('ev-101','u-podar-002', 'cam-podar-m-01','aaaa11110001','tripwire.entry','info',     '2026-05-04 07:40:11','[200,300,380,720]',11, 0.94,'{"matchedName":"Ravi Kumar (Staff)"}',          'ai/events/u-podar-002/aaaa11110001/2026-05-04T07-40-11.jpg','2026-05-04 07:42:00', NOW(), NOW()),
('ev-102','u-podar-002', 'cam-podar-m-02','aaaa11110002','crowd.density','warning',   '2026-05-04 12:18:00', NULL,             NULL, NULL,'{"count":58,"threshold":50}',                    'ai/events/u-podar-002/aaaa11110002/2026-05-04T12-18-00.jpg', NULL,                  NOW(), NOW()),
('ev-103','u-podar-002', 'cam-podar-m-04','aaaa11110004','camera.tampered','critical','2026-05-04 14:05:33', NULL,             NULL, NULL,'{"reason":"frame went black"}',                  'ai/events/u-podar-002/aaaa11110004/2026-05-04T14-05-33.jpg', NULL,                  NOW(), NOW()),
('ev-104','u-podar-002', 'cam-podar-m-07','aaaa11110007','tripwire.exit','info',      '2026-05-04 15:20:45','[500,200,640,600]',18, 0.88,'{"matchedName":"Unknown","action":"Exit"}',     'ai/events/u-podar-002/aaaa11110007/2026-05-04T15-20-45.jpg','2026-05-04 15:22:00', NOW(), NOW()),
('ev-201','u-citymart-003','cam-cm-01','bbbb22220001','crowd.density','info',         '2026-05-04 18:30:00', NULL,             NULL, NULL,'{"count":24}',                                   'ai/events/u-citymart-003/bbbb22220001/2026-05-04T18-30-00.jpg', NULL,                  NOW(), NOW()),
('ev-202','u-citymart-003','cam-cm-02','bbbb22220002','queue.long','warning',         '2026-05-04 18:45:12', NULL,             NULL, NULL,'{"queueLength":12,"avgWaitSec":420}',            'ai/events/u-citymart-003/bbbb22220002/2026-05-04T18-45-12.jpg', NULL,                  NOW(), NOW());

-- Daily metrics
INSERT IGNORE INTO usage_metrics_daily (user_id, date, cameras_total, cameras_online, cameras_offline, events_info, events_warning, events_critical, events_acknowledged, recording_bytes, faces_total, faces_added_today, active_minutes) VALUES
('u-acme-001',     '2026-04-28', 16, 16, 0, 142,  8, 0, 132, 38452000000, 4, 0, 384),
('u-acme-001',     '2026-04-29', 16, 16, 0, 156,  6, 0, 144, 39180000000, 4, 0, 412),
('u-acme-001',     '2026-04-30', 16, 15, 1, 138, 11, 1, 122, 36990000000, 4, 0, 290),
('u-acme-001',     '2026-05-01', 16, 15, 1,  88,  4, 0,  76, 24120000000, 4, 0,  60),
('u-acme-001',     '2026-05-02', 16, 16, 0, 102,  3, 0,  90, 22440000000, 4, 0,  30),
('u-acme-001',     '2026-05-03', 16, 16, 0, 162,  9, 0, 150, 41500000000, 4, 0, 425),
('u-acme-001',     '2026-05-04', 16, 16, 0,  81,  2, 0,  64, 22900000000, 4, 0, 280),
('u-podar-002',    '2026-05-03',  8,  7, 1, 488, 24, 1, 410, 92300000000, 4, 1, 320),
('u-podar-002',    '2026-05-04',  8,  7, 1, 244, 18, 1, 212, 51800000000, 4, 0, 178),
('u-citymart-003', '2026-05-03',  4,  3, 1,  72,  4, 0,  62, 12400000000, 2, 0, 145),
('u-citymart-003', '2026-05-04',  4,  3, 1,  38,  2, 0,  30,  6800000000, 2, 0,  92);

-- ========================================================================
-- DONE — verify with:
--   SELECT COUNT(*) AS customers FROM users WHERE role='user';
--   SELECT name, email FROM admin_users;
--   SELECT user_id, COUNT(*) FROM face_uploads WHERE removed_at IS NULL GROUP BY user_id;
-- ========================================================================
