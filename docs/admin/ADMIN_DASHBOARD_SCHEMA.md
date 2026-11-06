# Drishyam — Admin Dashboard Database Schema

> Single source of truth for the data your admin team will see. Everything
> the dashboard needs already exists in the operational tables (users,
> cameras, ai_events, etc.) — we add a small **admin layer** on top:
> `admin_users`, `admin_audit_log`, `face_uploads`, `support_tickets`, and
> `usage_metrics_daily`.
>
> Hand this whole document to your dashboard team. It includes:
>   1. ERD (table relationships)
>   2. CREATE TABLE statements (MySQL 8.x, utf8mb4_unicode_ci)
>   3. Realistic dummy data (4 customers, 4 sites, ~50 cameras, ~250 events)
>   4. Suggested admin pages and the queries that power them

---

## 1. ERD — table relationships at a glance

```
┌─────────────────┐
│   admin_users   │  ← internal Drishyam staff (separate from customer users)
└────────┬────────┘
         │ acts on (logged in admin_audit_log)
         ▼
┌─────────────────┐         ┌─────────────────┐
│      users      │ 1     N │    sites         │
│  (customers)    │─────────│                  │
└──────┬──────────┘         └────────┬────────┘
       │ 1                           │ 1
       │                             │
       │ N                           │ N
┌──────▼──────────┐         ┌────────▼────────┐
│  subscriptions  │         │ camera_groups   │
│  + payments     │         │  (NVRs/devices) │
└─────────────────┘         └────────┬────────┘
                                     │ 1
       ┌─────────────────────────────┘
       │ N
       ▼
┌─────────────────┐         ┌─────────────────┐
│     cameras     │ 1     N │    ai_events    │
│                 │─────────│                 │
└──────┬──────────┘         └─────────────────┘
       │ N
       │
       │ uploads
       ▼
┌─────────────────┐
│  face_uploads   │  ← face images for human-detection watchlist
└─────────────────┘

┌─────────────────┐
│ support_tickets │ — customer-reported issues (linked to users + cameras)
└─────────────────┘

┌─────────────────────────┐
│ usage_metrics_daily     │ — pre-aggregated daily numbers for dashboards
└─────────────────────────┘
```

---

## 2. Existing tables (already in production)

These are already populated by the application. Admin reads them; admin doesn't write to them directly.

| Table | What it stores | Admin uses it for |
|---|---|---|
| `users` | Customer accounts | Customer list, contact, status, plan |
| `plans` | Subscription tiers | Plan dropdown, pricing |
| `subscriptions` | Active plan per customer | MRR, ARR, churn |
| `payments` | Razorpay/Stripe charges | Invoice list, revenue trends |
| `sites` | Physical locations per customer | Site count per customer, health overview |
| `mediamtx_servers` | Streaming server pool | Infra capacity, server health |
| `camera_groups` | NVR/IP devices | Devices per site |
| `cameras` | Individual camera channels | Per-customer camera count, codec mix |
| `ai_events` | Detected events | Per-customer alert volume, false-positive rate |

Dashboards rarely need to **modify** these — read-only is the default. Any modification (e.g., admin force-deletes a camera) MUST write to `admin_audit_log`.

---

## 3. New tables for admin

### 3.1 `admin_users`

Internal Drishyam staff. **Do NOT reuse the `users` table** — admin accounts have different lifecycle, MFA requirements, and audit guarantees.

```sql
CREATE TABLE admin_users (
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
```

**Roles**
- `superadmin` — full access, can change billing, delete data, manage other admins
- `support` — view + respond to tickets, view customer data, no billing
- `billing` — finance team: invoices, refunds, plan changes
- `readonly` — analyst / leadership: read-only

### 3.2 `admin_audit_log`

Every admin action — non-negotiable for compliance and incident review.

```sql
CREATE TABLE admin_audit_log (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_user_id   CHAR(36) NOT NULL,
  action          VARCHAR(64)  NOT NULL,    -- 'user.suspend', 'camera.delete', 'plan.change'
  resource_type   VARCHAR(64)  NOT NULL,    -- 'user', 'camera', 'subscription'
  resource_id     CHAR(36)     NULL,
  payload         JSON         NULL,         -- before/after, reason
  ip              VARCHAR(64)  NULL,
  user_agent      VARCHAR(255) NULL,
  ts              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_admin (admin_user_id, ts),
  KEY idx_audit_resource (resource_type, resource_id),
  KEY idx_audit_action (action, ts),
  CONSTRAINT fk_audit_admin
    FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
    ON DELETE NO ACTION ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.3 `face_uploads`

Tracks every face image uploaded for the human-detection watchlist. Image bytes live on disk (or S3 for production); this table is the index.

```sql
CREATE TABLE face_uploads (
  id                CHAR(36) PRIMARY KEY,
  user_id           CHAR(36) NOT NULL,         -- whose watchlist
  uploaded_by       ENUM('user','admin') NOT NULL DEFAULT 'user',
  uploaded_by_admin CHAR(36) NULL,             -- admin_user_id if admin uploaded on behalf
  display_name      VARCHAR(120) NOT NULL,     -- "Aman Sharma"
  notes             VARCHAR(500) NULL,         -- "Office 12 staff, building access"
  file_path         VARCHAR(500) NOT NULL,     -- 'data/known_faces/<userId>/aman.jpg' or S3 key
  file_size_bytes   INT NOT NULL,
  mime_type         VARCHAR(64) NOT NULL,
  thumbnail_url     VARCHAR(500) NULL,
  encoding_status   ENUM('pending','registered','failed','removed') NOT NULL DEFAULT 'pending',
  encoding_error    VARCHAR(500) NULL,
  match_count       INT NOT NULL DEFAULT 0,    -- how often this face matched in events
  last_matched_at   DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at        DATETIME NULL,             -- soft delete
  KEY idx_face_user (user_id, created_at),
  KEY idx_face_status (encoding_status),
  KEY idx_face_admin (uploaded_by_admin),
  CONSTRAINT fk_face_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_face_admin
    FOREIGN KEY (uploaded_by_admin) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Workflow**
1. Image arrives at `/api/ai/watchlist` (user) or admin form (`uploaded_by='admin'`)
2. Backend writes to `data/known_faces/<userId>/<safe>.jpg`, INSERTs `encoding_status='pending'`
3. AI worker (`smart-cam-ai`) tries to encode the face → updates row to `registered` or `failed`
4. Each time the face matches an `ai_event`, increment `match_count` + bump `last_matched_at`

### 3.4 `support_tickets`

Customer-reported issues. Most admin time goes here — make it searchable and well-indexed.

```sql
CREATE TABLE support_tickets (
  id                CHAR(36) PRIMARY KEY,
  user_id           CHAR(36) NOT NULL,
  subject           VARCHAR(255) NOT NULL,
  body              TEXT NOT NULL,
  category          ENUM('billing','camera_offline','bug','feature_request','other') NOT NULL,
  priority          ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status            ENUM('open','in_progress','waiting_customer','resolved','closed') NOT NULL DEFAULT 'open',
  related_camera_id CHAR(36) NULL,    -- when about a specific camera
  related_site_id   CHAR(36) NULL,
  assigned_to       CHAR(36) NULL,    -- admin_user_id
  first_responded_at DATETIME NULL,
  resolved_at       DATETIME NULL,
  customer_satisfaction TINYINT NULL,  -- 1-5 post-resolution rating
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ticket_user (user_id, created_at),
  KEY idx_ticket_status (status, priority),
  KEY idx_ticket_assigned (assigned_to, status),
  CONSTRAINT fk_ticket_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_camera
    FOREIGN KEY (related_camera_id) REFERENCES cameras(id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_admin
    FOREIGN KEY (assigned_to) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Optional companion table (not strictly needed for v1):

```sql
CREATE TABLE ticket_messages (
  id          CHAR(36) PRIMARY KEY,
  ticket_id   CHAR(36) NOT NULL,
  author_type ENUM('customer','admin') NOT NULL,
  author_id   CHAR(36) NOT NULL,
  body        TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_msg_ticket (ticket_id, created_at),
  CONSTRAINT fk_msg_ticket
    FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 3.5 `usage_metrics_daily`

**Pre-aggregated** per-customer daily numbers. The dashboard reads from this instead of running expensive SUM/COUNT queries on `ai_events` and `cameras` every page load.

A nightly job populates this table at ~2am UTC for the previous day.

```sql
CREATE TABLE usage_metrics_daily (
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
  active_minutes      INT NOT NULL DEFAULT 0,    -- minutes any user opened the app
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_metrics_user_date (user_id, date),
  KEY idx_metrics_date (date),
  CONSTRAINT fk_metrics_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Why pre-aggregate: scanning `ai_events` for "events per customer per day" once is cheap. Doing it on every dashboard load for 100 customers × 90 days = 9,000 group-by passes. Pre-aggregation turns the dashboard query into a single index-seek.

---

## 4. Sample data — paste this in to populate a dev environment

> All UUIDs below are stable mock values. Use `INSERT IGNORE` if you want to
> re-run safely; or wrap in a transaction.

### 4.1 Plans

```sql
INSERT INTO plans (id, name, price_inr, max_cameras, retention_days, features) VALUES
('p-starter',    'Starter',    49900,   25,  7,  '{"ai":["person"],"alerts":["email"]}'),
('p-pro',        'Pro',        149900, 100, 30,  '{"ai":["person","face","crowd"],"alerts":["email","sms","webhook"]}'),
('p-enterprise', 'Enterprise', 499900, 2000, 90, '{"ai":["all"],"alerts":["all"],"sso":true,"sla":"99.9"}');
```

### 4.2 Customers (`users`)

Four customers across different verticals + plans:

```sql
INSERT INTO users (id, name, email, phone, password, role, status, created_at) VALUES
('u-acme-001',      'Acme Corp Pvt Ltd',    'admin@acmecorp.in',     '+91-9876543210', '<bcrypt>', 'user', 'active',    '2026-01-15 09:30:00'),
('u-podar-002',     'Podar School Group',   'it@podarschools.com',   '+91-9988776655', '<bcrypt>', 'user', 'active',    '2026-02-04 11:20:00'),
('u-citymart-003',  'City Mart Retail',     'ops@citymart.in',       '+91-9223344556', '<bcrypt>', 'user', 'active',    '2026-03-12 15:45:00'),
('u-suspended-004', 'Old Trial Account',    'demo@example.com',      '+91-9000000001', '<bcrypt>', 'user', 'suspended', '2025-11-02 10:00:00');
```

### 4.3 Subscriptions

```sql
INSERT INTO subscriptions (id, user_id, plan_id, status, started_at, current_period_end, created_at) VALUES
('s-001', 'u-acme-001',     'p-pro',        'active',    '2026-01-15', '2026-06-15', '2026-01-15 09:31:00'),
('s-002', 'u-podar-002',    'p-enterprise', 'active',    '2026-02-04', '2027-02-04', '2026-02-04 11:21:00'),
('s-003', 'u-citymart-003', 'p-starter',    'active',    '2026-03-12', '2026-06-12', '2026-03-12 15:46:00'),
('s-004', 'u-suspended-004','p-starter',    'cancelled', '2025-11-02', '2025-12-02', '2025-11-02 10:01:00');
```

### 4.4 Sites (4 customers × ~2 sites each)

```sql
INSERT INTO sites (id, user_id, name, slug, address, status, created_at) VALUES
('site-acme-hq',     'u-acme-001',     'Acme HQ',           'acme-hq',           'Bandra Kurla Complex, Mumbai 400051',  'active', '2026-01-16 09:00:00'),
('site-acme-wh',     'u-acme-001',     'Acme Warehouse',    'acme-warehouse',    'Bhiwandi, Maharashtra 421302',         'active', '2026-01-20 10:00:00'),
('site-podar-mum',   'u-podar-002',    'Podar Mumbai',      'podar-mumbai',      'Santacruz East, Mumbai 400055',        'active', '2026-02-05 09:00:00'),
('site-podar-pun',   'u-podar-002',    'Podar Pune',        'podar-pune',        'Hadapsar, Pune 411028',                'active', '2026-02-06 09:00:00'),
('site-citymart-1',  'u-citymart-003', 'CityMart Andheri',  'citymart-andheri',  'Andheri West, Mumbai 400058',          'active', '2026-03-13 10:00:00');
```

### 4.5 Camera groups + cameras

Acme HQ — 16 cameras (one Hikvision NVR), all H.264:

```sql
INSERT INTO camera_groups (id, user_id, site_id, name, host, port, http_port, username, device_type, total_channels, status, s3_folder, created_at) VALUES
('cg-acme-nvr1', 'u-acme-001', 'site-acme-hq', 'Office NVR', '192.168.10.10', 554, 80, 'admin', 'hikvision', 16, 'online', 'recordings/u-acme-001/office-nvr', '2026-01-16 09:30:00');

-- Generate 16 cameras under that group with INSERT...SELECT or insert by hand.
-- Sample of the first 4:
INSERT INTO cameras (id, user_id, group_id, monitor_id, name, host, port, path, channel, type, width, height, fps, status, s3_path, settings, created_at) VALUES
('cam-acme-01', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010101', 'Office Gate',         '192.168.10.10', 554, '/Streaming/Channels/101', 1,  'h264', 1920, 1080, 25, 'online', 'recordings/u-acme-001/office-nvr/cam-01', '{"ai":{"enabled":true,"detectors":["person","face"]}}', '2026-01-16 09:35:00'),
('cam-acme-02', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010102', 'Reception',           '192.168.10.10', 554, '/Streaming/Channels/201', 2,  'h264', 1920, 1080, 25, 'online', 'recordings/u-acme-001/office-nvr/cam-02', '{"ai":{"enabled":true,"detectors":["person","face"]}}', '2026-01-16 09:36:00'),
('cam-acme-03', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010103', 'Lobby',               '192.168.10.10', 554, '/Streaming/Channels/301', 3,  'h264', 1920, 1080, 25, 'online', 'recordings/u-acme-001/office-nvr/cam-03', '{"ai":{"enabled":true,"detectors":["person"]}}',          '2026-01-16 09:37:00'),
('cam-acme-04', 'u-acme-001', 'cg-acme-nvr1', '1a66d1aa01010104', 'Server Room (H.265)', '192.168.10.10', 554, '/Streaming/Channels/401', 4,  'h265', 1280, 1440, 25, 'online', 'recordings/u-acme-001/office-nvr/cam-04', '{"ai":{"enabled":true,"detectors":["person"]}}',          '2026-01-16 09:38:00');
-- ... add 5-16 similarly
```

Podar Mumbai — H.265 dome cameras, 8 channels (transcoder will auto-handle):

```sql
INSERT INTO camera_groups (id, user_id, site_id, name, host, total_channels, device_type, status, s3_folder) VALUES
('cg-podar-mum-1', 'u-podar-002', 'site-podar-mum', 'Mumbai Building NVR', '192.168.20.10', 8, 'hikvision', 'online', 'recordings/u-podar-002/mumbai-nvr');

INSERT INTO cameras (id, user_id, group_id, monitor_id, name, host, channel, type, width, height, status, settings) VALUES
('cam-podar-m-01','u-podar-002','cg-podar-mum-1','aaaa11110001','Main Gate',          '192.168.20.10', 1,'h265',1280,1440,'online','{"ai":{"enabled":true,"detectors":["person","face"]}}'),
('cam-podar-m-02','u-podar-002','cg-podar-mum-1','aaaa11110002','Playground',         '192.168.20.10', 2,'h265',1280,1440,'online','{"ai":{"enabled":true,"detectors":["person","crowd"]}}'),
('cam-podar-m-03','u-podar-002','cg-podar-mum-1','aaaa11110003','Library',            '192.168.20.10', 3,'h265',1280,1440,'online','{"ai":{"enabled":true,"detectors":["person"]}}'),
('cam-podar-m-04','u-podar-002','cg-podar-mum-1','aaaa11110004','Cafeteria (offline)','192.168.20.10', 4,'h265',1280,1440,'offline','{}'),
('cam-podar-m-05','u-podar-002','cg-podar-mum-1','aaaa11110005','Corridor East',      '192.168.20.10', 5,'h265',1280,1440,'online','{"ai":{"enabled":true}}'),
('cam-podar-m-06','u-podar-002','cg-podar-mum-1','aaaa11110006','Corridor West',      '192.168.20.10', 6,'h265',1280,1440,'online','{"ai":{"enabled":true}}'),
('cam-podar-m-07','u-podar-002','cg-podar-mum-1','aaaa11110007','Bus Stand',          '192.168.20.10', 7,'h265',1280,1440,'online','{"ai":{"enabled":true,"detectors":["person","crowd"]}}'),
('cam-podar-m-08','u-podar-002','cg-podar-mum-1','aaaa11110008','Parking',            '192.168.20.10', 8,'h264',1920,1080,'online','{"ai":{"enabled":true,"detectors":["vehicle"]}}');
```

CityMart Andheri — 4 cameras, mix of working/wobbling:

```sql
INSERT INTO camera_groups (id, user_id, site_id, name, host, total_channels, device_type, status, s3_folder) VALUES
('cg-citymart-1', 'u-citymart-003', 'site-citymart-1', 'Store NVR', '192.168.30.10', 4, 'dahua', 'online', 'recordings/u-citymart-003/store-nvr');

INSERT INTO cameras (id, user_id, group_id, monitor_id, name, host, channel, type, width, height, status, settings) VALUES
('cam-cm-01','u-citymart-003','cg-citymart-1','bbbb22220001','Store Entrance', '192.168.30.10', 1,'h264',1920,1080,'online', '{"ai":{"enabled":true,"detectors":["person","crowd"]}}'),
('cam-cm-02','u-citymart-003','cg-citymart-1','bbbb22220002','Checkout Lane',  '192.168.30.10', 2,'h264',1920,1080,'online', '{"ai":{"enabled":true,"detectors":["person"]}}'),
('cam-cm-03','u-citymart-003','cg-citymart-1','bbbb22220003','Aisle 1',        '192.168.30.10', 3,'h264',1920,1080,'offline','{"ai":{"enabled":false}}'),
('cam-cm-04','u-citymart-003','cg-citymart-1','bbbb22220004','Backstore',      '192.168.30.10', 4,'h264',1920,1080,'online', '{"ai":{"enabled":true,"detectors":["person"]}}');
```

### 4.6 AI Events (the noisy ones)

A representative week's worth of events:

```sql
INSERT INTO ai_events (id, user_id, camera_id, monitor_id, event_type, severity, ts, bbox, track_id, confidence, payload, snapshot_key, acknowledged_at) VALUES
-- Acme — typical office activity
('ev-001','u-acme-001','cam-acme-01','1a66d1aa01010101','tripwire.entry','info',     '2026-05-04 09:02:14','[412,180,560,580]', 1, 0.92, '{"matchedName":"Aman Sharma","action":"Entry"}', 'ai/events/u-acme-001/1a66d1aa01010101/2026-05-04T09-02-14.jpg', '2026-05-04 09:05:00'),
('ev-002','u-acme-001','cam-acme-01','1a66d1aa01010101','tripwire.entry','info',     '2026-05-04 09:14:22','[480,210,620,610]', 2, 0.89, '{"matchedName":"Priya Mehta"}',                'ai/events/u-acme-001/1a66d1aa01010101/2026-05-04T09-14-22.jpg', NULL),
('ev-003','u-acme-001','cam-acme-02','1a66d1aa01010102','person.unknown','warning',  '2026-05-04 11:42:01','[300,160,470,580]', 5, 0.81, '{"matchedName":"Unknown"}',                    'ai/events/u-acme-001/1a66d1aa01010102/2026-05-04T11-42-01.jpg', '2026-05-04 11:45:00'),

-- Podar — H.265 cameras, school activity
('ev-101','u-podar-002','cam-podar-m-01','aaaa11110001','tripwire.entry','info',     '2026-05-04 07:40:11','[200,300,380,720]', 11,0.94, '{"matchedName":"Ravi Kumar (Staff)"}',         'ai/events/u-podar-002/aaaa11110001/2026-05-04T07-40-11.jpg', '2026-05-04 07:42:00'),
('ev-102','u-podar-002','cam-podar-m-02','aaaa11110002','crowd.density','warning',   '2026-05-04 12:18:00', NULL,              NULL,NULL, '{"count":58,"threshold":50}',                  'ai/events/u-podar-002/aaaa11110002/2026-05-04T12-18-00.jpg', NULL),
('ev-103','u-podar-002','cam-podar-m-04','aaaa11110004','camera.tampered','critical','2026-05-04 14:05:33', NULL,              NULL,NULL, '{"reason":"frame went black"}',                'ai/events/u-podar-002/aaaa11110004/2026-05-04T14-05-33.jpg', NULL),
('ev-104','u-podar-002','cam-podar-m-07','aaaa11110007','tripwire.exit','info',      '2026-05-04 15:20:45','[500,200,640,600]', 18,0.88, '{"matchedName":"Unknown","action":"Exit"}',    'ai/events/u-podar-002/aaaa11110007/2026-05-04T15-20-45.jpg', '2026-05-04 15:22:00'),

-- CityMart — retail
('ev-201','u-citymart-003','cam-cm-01','bbbb22220001','crowd.density','info',        '2026-05-04 18:30:00', NULL,              NULL,NULL, '{"count":24}',                                 'ai/events/u-citymart-003/bbbb22220001/2026-05-04T18-30-00.jpg', NULL),
('ev-202','u-citymart-003','cam-cm-02','bbbb22220002','queue.long','warning',        '2026-05-04 18:45:12', NULL,              NULL,NULL, '{"queueLength":12,"avgWaitSec":420}',          'ai/events/u-citymart-003/bbbb22220002/2026-05-04T18-45-12.jpg', NULL);
```

(Generate ~250 more events in similar shape with a script for realistic volume.)

### 4.7 Face uploads (the watchlist)

```sql
INSERT INTO face_uploads (id, user_id, uploaded_by, display_name, notes, file_path, file_size_bytes, mime_type, encoding_status, match_count, last_matched_at, created_at) VALUES
-- Acme staff watchlist
('f-acme-1', 'u-acme-001', 'user',  'Aman Sharma',  'CEO',                     'data/known_faces/u-acme-001/aman.jpg',    287_412, 'image/jpeg', 'registered', 142, '2026-05-04 09:02:14', '2026-01-20 10:00:00'),
('f-acme-2', 'u-acme-001', 'user',  'Priya Mehta',  'COO',                     'data/known_faces/u-acme-001/priya.jpg',   294_115, 'image/jpeg', 'registered',  98, '2026-05-04 09:14:22', '2026-01-20 10:05:00'),
('f-acme-3', 'u-acme-001', 'user',  'Rahul Verma',  'Security Lead',           'data/known_faces/u-acme-001/rahul.jpg',   312_980, 'image/jpeg', 'registered',  64, '2026-05-03 18:00:00', '2026-01-21 09:00:00'),
('f-acme-4', 'u-acme-001', 'admin', 'Test Visitor', 'Demo enrolment by admin', 'data/known_faces/u-acme-001/test.jpg',    155_204, 'image/jpeg', 'failed',        0, NULL,                  '2026-04-12 14:00:00'),

-- Podar staff
('f-pod-1',  'u-podar-002', 'user', 'Ravi Kumar (Staff)',    'Security guard, gate 1', 'data/known_faces/u-podar-002/ravi.jpg',   245_980, 'image/jpeg', 'registered', 312, '2026-05-04 07:40:11', '2026-02-08 09:00:00'),
('f-pod-2',  'u-podar-002', 'user', 'Sunita Iyer (Principal)','School principal',      'data/known_faces/u-podar-002/sunita.jpg', 268_402, 'image/jpeg', 'registered',  47, '2026-05-04 08:30:00', '2026-02-08 09:10:00'),
('f-pod-3',  'u-podar-002', 'user', 'Bus Driver A',          'Morning bus pickup',      'data/known_faces/u-podar-002/driver_a.jpg',211_550, 'image/jpeg', 'registered',  88, '2026-05-04 07:15:00', '2026-02-15 06:00:00'),
('f-pod-4',  'u-podar-002', 'user', 'Bus Driver B',          'Afternoon bus drop',      'data/known_faces/u-podar-002/driver_b.jpg',209_882, 'image/jpeg', 'pending',       0, NULL,                  '2026-05-03 18:30:00'),

-- CityMart
('f-cm-1',  'u-citymart-003', 'user', 'Store Manager Anil', 'Manager, key access',     'data/known_faces/u-citymart-003/anil.jpg',  302_115, 'image/jpeg', 'registered',  29, '2026-05-04 09:00:00', '2026-03-15 10:00:00'),
('f-cm-2',  'u-citymart-003', 'user', 'Cashier Deepa',      'Senior cashier',          'data/known_faces/u-citymart-003/deepa.jpg', 287_443, 'image/jpeg', 'registered',  18, '2026-05-04 18:45:12', '2026-03-15 10:15:00');
```

### 4.8 Admin users + sample audit log

```sql
INSERT INTO admin_users (id, email, name, password_hash, role, mfa_enabled, last_login_at, created_at) VALUES
('a-001', 'sahil@drishyam.io',   'Sahil (Tech Lead)',     '<bcrypt>', 'superadmin', 1, '2026-05-04 14:30:00', '2025-08-01 10:00:00'),
('a-002', 'priyanka@drishyam.io','Priyanka (Support)',    '<bcrypt>', 'support',    1, '2026-05-04 13:45:00', '2025-09-15 10:00:00'),
('a-003', 'finance@drishyam.io', 'Finance Team',          '<bcrypt>', 'billing',    1, '2026-05-03 17:00:00', '2025-10-01 10:00:00'),
('a-004', 'analyst@drishyam.io', 'Vikram (Analyst)',      '<bcrypt>', 'readonly',   0, '2026-05-04 11:00:00', '2026-02-10 10:00:00');

INSERT INTO admin_audit_log (admin_user_id, action, resource_type, resource_id, payload, ip, ts) VALUES
('a-001', 'user.suspend',     'user',         'u-suspended-004', '{"reason":"non-payment after 30d","previousStatus":"active"}', '203.0.113.10', '2025-12-02 16:00:00'),
('a-002', 'ticket.respond',   'ticket',       't-101',           '{"messageId":"tm-201"}',                                       '203.0.113.11', '2026-05-04 13:50:00'),
('a-001', 'camera.delete',    'camera',       'cam-cm-99',       '{"reason":"customer requested via ticket t-095","groupId":"cg-citymart-1"}', '203.0.113.10', '2026-04-28 11:15:00'),
('a-003', 'subscription.refund','subscription','s-old-110',     '{"amount_inr":4990,"reason":"prorated upgrade credit"}',       '203.0.113.12', '2026-04-30 15:00:00'),
('a-001', 'face.remove',      'face_upload',  'f-acme-4',        '{"reason":"customer reported wrong person"}',                   '203.0.113.10', '2026-04-12 14:30:00');
```

### 4.9 Support tickets

```sql
INSERT INTO support_tickets (id, user_id, subject, body, category, priority, status, related_camera_id, assigned_to, first_responded_at, resolved_at, created_at) VALUES
('t-101', 'u-podar-002',    'Camera 4 keeps going offline', 'Cafeteria camera shows offline since this morning. Power was checked.', 'camera_offline', 'high',   'in_progress', 'cam-podar-m-04', 'a-002', '2026-05-04 13:50:00', NULL,                  '2026-05-04 12:30:00'),
('t-102', 'u-acme-001',     'Add 8 more cameras',           'Adding new floor — need to provision 8 cameras to existing NVR.',     'feature_request','normal', 'open',         NULL,             NULL,    NULL,                  NULL,                  '2026-05-03 10:15:00'),
('t-103', 'u-citymart-003', 'Footfall report wrong',        'Heatmap shows 0 visitors on Sunday but store was open and busy.',     'bug',            'normal', 'resolved',     'cam-cm-01',      'a-002', '2026-04-29 11:00:00', '2026-05-01 17:30:00', '2026-04-29 09:45:00'),
('t-104', 'u-acme-001',     'Invoice mismatch — April',     'Plan shows ₹14,990 but card was charged ₹49,900.',                    'billing',        'urgent', 'resolved',     NULL,             'a-003', '2026-04-15 10:30:00', '2026-04-15 14:00:00', '2026-04-15 09:00:00'),
('t-105', 'u-podar-002',    'Add SSO with Google',          'Enterprise plan promised SSO. When?',                                  'feature_request','low',    'waiting_customer',NULL,         'a-001', '2026-04-20 16:00:00', NULL,                  '2026-04-18 14:00:00');
```

### 4.10 Daily metrics (last 7 days for u-acme-001)

```sql
INSERT INTO usage_metrics_daily (user_id, date, cameras_total, cameras_online, cameras_offline, events_info, events_warning, events_critical, recording_bytes, faces_total, faces_added_today, active_minutes) VALUES
('u-acme-001', '2026-04-28', 16, 16, 0, 142,  8, 0, 38_452_000_000, 4, 0, 384),
('u-acme-001', '2026-04-29', 16, 16, 0, 156,  6, 0, 39_180_000_000, 4, 0, 412),
('u-acme-001', '2026-04-30', 16, 15, 1, 138, 11, 1, 36_990_000_000, 4, 0, 290),
('u-acme-001', '2026-05-01', 16, 15, 1,  88,  4, 0, 24_120_000_000, 4, 0, 60),     -- weekend
('u-acme-001', '2026-05-02', 16, 16, 0, 102,  3, 0, 22_440_000_000, 4, 0, 30),     -- weekend
('u-acme-001', '2026-05-03', 16, 16, 0, 162,  9, 0, 41_500_000_000, 4, 0, 425),
('u-acme-001', '2026-05-04', 16, 16, 0,  81,  2, 0, 22_900_000_000, 4, 0, 280);    -- partial day

INSERT INTO usage_metrics_daily (user_id, date, cameras_total, cameras_online, cameras_offline, events_info, events_warning, events_critical, recording_bytes, faces_total, faces_added_today, active_minutes) VALUES
('u-podar-002','2026-05-03', 8, 7, 1, 488, 24, 1, 92_300_000_000, 4, 1, 320),
('u-podar-002','2026-05-04', 8, 7, 1, 244, 18, 1, 51_800_000_000, 4, 0, 178);
```

---

## 5. Suggested admin pages

Each page below is a screen in the admin dashboard, with the SQL query that powers it.

### 5.1 `/admin/overview` — landing page

**KPIs across the top (last 30 days):**

```sql
-- Active customers
SELECT COUNT(DISTINCT user_id) FROM subscriptions WHERE status = 'active';

-- MRR (in INR paise)
SELECT SUM(p.price_inr) AS mrr_inr_paise
FROM subscriptions s JOIN plans p ON p.id = s.plan_id
WHERE s.status = 'active';

-- Cameras under management
SELECT COUNT(*) FROM cameras;

-- Events ingested today
SELECT COUNT(*) FROM ai_events WHERE ts >= CURDATE();

-- Open support tickets
SELECT COUNT(*) FROM support_tickets WHERE status IN ('open','in_progress','waiting_customer');

-- Storage used (bytes) across all customers in last 30 days
SELECT SUM(recording_bytes) FROM usage_metrics_daily
WHERE date >= CURDATE() - INTERVAL 30 DAY;
```

**Time-series sparkline (last 30 days, system-wide):**

```sql
SELECT date,
       SUM(events_info)     AS info,
       SUM(events_warning)  AS warning,
       SUM(events_critical) AS critical
FROM usage_metrics_daily
WHERE date >= CURDATE() - INTERVAL 30 DAY
GROUP BY date ORDER BY date;
```

### 5.2 `/admin/customers` — customer list

**Table:** name · plan · cameras · MRR · status · last activity · actions

```sql
SELECT
  u.id, u.name, u.email, u.phone, u.status, u.created_at,
  p.name           AS plan_name,
  p.price_inr      AS mrr_inr_paise,
  COUNT(DISTINCT c.id)                AS cameras_total,
  SUM(CASE WHEN c.status='online' THEN 1 ELSE 0 END) AS cameras_online,
  COUNT(DISTINCT s2.id)               AS sites_count,
  MAX(m.date)                          AS last_active_date,
  COUNT(DISTINCT t.id)                AS open_tickets
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
LEFT JOIN plans p         ON p.id = s.plan_id
LEFT JOIN cameras c       ON c.user_id = u.id
LEFT JOIN sites s2        ON s2.user_id = u.id
LEFT JOIN usage_metrics_daily m ON m.user_id = u.id
LEFT JOIN support_tickets t ON t.user_id = u.id AND t.status IN ('open','in_progress','waiting_customer')
GROUP BY u.id
ORDER BY mrr_inr_paise DESC;
```

### 5.3 `/admin/customers/:id` — single customer

Tabs: Overview · Cameras · Sites · Faces · Events · Tickets · Billing · Audit

**Overview KPIs:**
```sql
SELECT * FROM users WHERE id = ?;

SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active';

SELECT date, cameras_online, events_info+events_warning+events_critical AS events_total,
       recording_bytes
FROM usage_metrics_daily
WHERE user_id = ? AND date >= CURDATE() - INTERVAL 30 DAY
ORDER BY date;
```

**Cameras tab — including codec mix and health:**
```sql
SELECT
  c.id, c.name, c.monitor_id, c.channel, c.status, c.type AS codec,
  c.width, c.height, c.fps, c.s3_path,
  cg.name AS group_name, s.name AS site_name,
  c.settings->>'$.ai.enabled' AS ai_enabled
FROM cameras c
LEFT JOIN camera_groups cg ON cg.id = c.group_id
LEFT JOIN sites s          ON s.id = cg.site_id
WHERE c.user_id = ?
ORDER BY s.name, cg.name, c.channel;
```

### 5.4 `/admin/customers/:id/faces` — face watchlist

```sql
SELECT
  f.id, f.display_name, f.notes, f.file_size_bytes, f.encoding_status, f.encoding_error,
  f.match_count, f.last_matched_at, f.created_at,
  f.uploaded_by, au.name AS uploaded_by_admin_name
FROM face_uploads f
LEFT JOIN admin_users au ON au.id = f.uploaded_by_admin
WHERE f.user_id = ? AND f.removed_at IS NULL
ORDER BY f.match_count DESC, f.created_at DESC;
```

Admin actions:
- **Upload on behalf of customer** → INSERT with `uploaded_by='admin'` + audit log
- **Remove** → soft-delete (`removed_at = NOW()`) + audit log
- **Re-encode** → set `encoding_status='pending'`, AI worker re-tries

### 5.5 `/admin/cameras/health` — fleet health

Same data as the `/api/cameras/health` endpoint we already built; admin sees ALL customers, not just their own.

```sql
SELECT u.name AS customer, c.name AS camera, c.type AS codec,
       c.status, c.width, c.height,
       cg.name AS device, s.name AS site
FROM cameras c
JOIN users u            ON u.id = c.user_id
LEFT JOIN camera_groups cg ON cg.id = c.group_id
LEFT JOIN sites s          ON s.id = cg.site_id
WHERE c.status != 'online'   -- focus on problems
ORDER BY u.name, s.name, c.channel;
```

### 5.6 `/admin/billing` — finance view

```sql
-- This month's revenue
SELECT SUM(amount) FROM payments
WHERE status = 'captured' AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01');

-- Failed payments needing follow-up
SELECT p.*, u.name, u.email
FROM payments p JOIN users u ON u.id = p.user_id
WHERE p.status = 'failed' AND p.created_at >= CURDATE() - INTERVAL 7 DAY
ORDER BY p.created_at DESC;

-- Renewals coming up in next 14 days
SELECT s.id, u.name, u.email, p.name AS plan, p.price_inr, s.current_period_end
FROM subscriptions s
JOIN users u ON u.id = s.user_id
JOIN plans p ON p.id = s.plan_id
WHERE s.status = 'active'
  AND s.current_period_end BETWEEN CURDATE() AND CURDATE() + INTERVAL 14 DAY
ORDER BY s.current_period_end;
```

### 5.7 `/admin/tickets` — support inbox

```sql
SELECT t.id, t.subject, t.priority, t.status, t.created_at, t.first_responded_at,
       u.name AS customer_name,
       au.name AS assigned_to_name,
       c.name AS related_camera_name
FROM support_tickets t
JOIN users u            ON u.id = t.user_id
LEFT JOIN admin_users au ON au.id = t.assigned_to
LEFT JOIN cameras c     ON c.id = t.related_camera_id
WHERE t.status IN ('open','in_progress','waiting_customer')
ORDER BY FIELD(t.priority,'urgent','high','normal','low'),
         t.created_at;
```

### 5.8 `/admin/audit` — what admins did

```sql
SELECT a.ts, au.name AS admin, a.action, a.resource_type, a.resource_id,
       JSON_EXTRACT(a.payload, '$.reason') AS reason, a.ip
FROM admin_audit_log a
JOIN admin_users au ON au.id = a.admin_user_id
ORDER BY a.ts DESC
LIMIT 100;
```

---

## 6. Things to NOT put in the admin schema

To avoid scope creep, NONE of these go in:

- **Live video streams** — admin dashboard never streams cameras directly. If admins need to watch live, they impersonate the customer (separate "view as user" flow that goes through normal stream APIs with audit logging).
- **Raw event bbox bytes / snapshots in DB** — already in S3, only the key is in `ai_events.snapshot_key`.
- **Face encoding vectors** — those live in the `face_embeddings` table (Postgres+pgvector) for forensic search. Admin only sees the `face_uploads` index.
- **MediaMTX path config** — that's runtime state, fetched live from `/v3/paths/list`, never stored.

---

## 7. Migration order

If applying all of this on top of the current schema (migrations 001-012), the order is:

```
013-create-admin-users.js
014-create-admin-audit-log.js
015-create-face-uploads.js
016-create-support-tickets.js
017-create-ticket-messages.js                (optional)
018-create-usage-metrics-daily.js
019-seed-admin-and-plans.sql                  (idempotent INSERT IGNORE)
```

Each new table follows the same pattern as existing migrations:
- Plain `CHAR(36)` (not `BINARY`) for FK columns to match `users.id`
- `charset: 'utf8mb4'`, `collate: 'utf8mb4_unicode_ci'` on `createTable`
- Composite indexes on the columns the admin queries above use most

---

## 8. Implementation checklist for the admin team

- [ ] Stand up a separate Express app or sub-router (`/admin/*`) with admin-only middleware
- [ ] Auth: separate JWT issuer keyed off `admin_users` (not `users`)
- [ ] Every admin action wraps in `auditLog()` middleware that writes to `admin_audit_log`
- [ ] Build the page list in section 5 — start with **Overview → Customers → Customer detail**, then expand
- [ ] Use the queries verbatim — they're indexed-aware
- [ ] Cron job to fill `usage_metrics_daily` nightly at 02:00 UTC (~50 lines of SQL aggregation)
- [ ] Export buttons on each table view (CSV) — sales / finance will ask
- [ ] Read-only "view as customer" mode — opens the regular customer app in an iframe with an admin token, audit-logged

---

*Last updated: 2026-05-04. Schema owner: Drishyam tech lead.*
