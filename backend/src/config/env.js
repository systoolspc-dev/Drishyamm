const dotenv = require('dotenv');
const Joi = require('joi');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(5000),

  // Database
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(3306),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').default(''),

  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  // Shinobi VMS (legacy — kept optional for backward compatibility during migration)
  SHINOBI_URL: Joi.string().uri().optional().default('http://localhost:8443'),
  SHINOBI_API_KEY: Joi.string().optional().default(''),
  SHINOBI_GROUP_KEY: Joi.string().optional().default(''),
  SHINOBI_SUPER_API_KEY: Joi.string().optional().default(''),

  // Stripe
  STRIPE_SECRET_KEY: Joi.string().required(),
  STRIPE_WEBHOOK_SECRET: Joi.string().required(),

  // Razorpay
  RAZORPAY_KEY_ID: Joi.string().required(),
  RAZORPAY_KEY_SECRET: Joi.string().required(),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().required(),

  // CORS
  CORS_ORIGINS: Joi.string().default('http://localhost:5173'),
  FRONTEND_URL: Joi.string().uri().default('http://localhost:5173'),

  // Email (SMTP)
  EMAIL_HOST: Joi.string().optional(),
  EMAIL_PORT: Joi.number().default(587),
  EMAIL_SECURE: Joi.boolean().default(false),
  EMAIL_USER: Joi.string().optional(),
  EMAIL_PASS: Joi.string().optional(),
  EMAIL_FROM: Joi.string().default('noreply@smart-cam.local'),

  // Redis (used for cache + BullMQ queues; graceful fallback if absent)
  REDIS_URL: Joi.string().optional().default('redis://localhost:6379'),

  // Internal service-to-service auth — AI worker → backend ingest, etc.
  // Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  SERVICE_TOKEN: Joi.string().min(32).optional().default(''),

  // smart-cam-ai service base URL — backend proxies face-upload there
  AI_SERVICE_URL: Joi.string().uri().optional().default('http://localhost:8001'),

  // Shared HS256 secret the backend uses to MINT per-organization JWTs the AI
  // verifies (must equal smart-cam-ai's VMS_JWT_SECRET). Carries `tid` = the
  // org's tenant so every face/camera/journey call is tenant-scoped. Falls back
  // to SERVICE_TOKEN/JWT_SECRET so a single-box deploy needs no extra env.
  AI_JWT_SECRET:   Joi.string().min(32).optional().default(''),
  AI_JWT_ISSUER:   Joi.string().optional().default('drisyam-vms'),
  AI_JWT_AUDIENCE: Joi.string().optional().default('drisyam-vms'),

  // activity-monitor service base URL — backend proxies /activity/* there
  ACTIVITY_SERVICE_URL: Joi.string().uri().optional().default('http://activity-monitor:8000'),

  // Stream Service — video data plane (replaces Shinobi)
  MEDIAMTX_API_URL:         Joi.string().uri().optional().default('http://localhost:9997'),
  MEDIAMTX_API_USER:        Joi.string().optional().default('drishyam'),
  MEDIAMTX_API_PASS:        Joi.string().optional().default('drishyam123'),
  // Public URLs: what the BROWSER uses to reach Stream Service (via NGINX in prod)
  MEDIAMTX_WEBRTC_URL:      Joi.string().uri().optional().default('http://localhost:8889'),
  MEDIAMTX_HLS_URL:         Joi.string().uri().optional().default('http://localhost:8888'),
  MEDIAMTX_INTERNAL_HLS_URL: Joi.string().uri().optional(),
  // Internal RTSP egress — what AI workers connect to (never browser-reachable)
  MEDIAMTX_RTSP_HOST:       Joi.string().optional().default('localhost'),
  MEDIAMTX_RTSP_PORT:       Joi.number().optional().default(8554),
  // Host-side path to the Docker bind-mount where Stream Service writes recordings.
  // Stream Service container: /recordings   Host: ./mediamtx-recordings (default)
  MEDIAMTX_RECORDINGS_DIR:  Joi.string().optional().default('./mediamtx-recordings'),
  // Recording segment duration — controls how Stream Service splits MP4 files.
  // Format: Go duration string (e.g. "5m0s", "10m0s", "15m0s"). 10m is a
  // sweet spot — short enough for quick scrubbing, long enough to keep S3
  // object count manageable.
  RECORDING_SEGMENT_DURATION: Joi.string().optional().default('10m0s'),
  // Stitch threshold (seconds) — fragments shorter than this get concatenated
  // before S3 upload, so RTSP reconnect storms don't pollute storage with
  // tiny clips. 0 disables stitching entirely.
  RECORDING_STITCH_BELOW_SEC: Joi.number().integer().min(0).default(120),

  // ── TURN / coturn (Phase 1.4) ───────────────────────────────────────────
  // Operator browsers behind corporate firewalls often fail STUN-only WebRTC.
  // Setting TURN_URI + TURN_SHARED_SECRET wires the backend to mint
  // short-lived REST-API creds (coturn `use-auth-secret` scheme — RFC 7635
  // adjacent). When both are empty, /api/turn/credentials returns 204 and
  // the frontend falls back to STUN-only — current behaviour.
  //
  // Recommended values once coturn ships on 103.109.7.37:
  //   TURN_URI=turn:turn.indyatools.com:3478?transport=udp
  //   TURN_URI_TLS=turns:turn.indyatools.com:5349?transport=tcp
  //   TURN_SHARED_SECRET=<random-32-bytes-base64>
  //   TURN_TTL_SEC=3600
  TURN_URI:           Joi.string().optional().default(''),
  TURN_URI_TLS:       Joi.string().optional().default(''),
  TURN_SHARED_SECRET: Joi.string().optional().default(''),
  TURN_TTL_SEC:       Joi.number().integer().min(60).max(86400).default(3600),

  // ── LiveKit (Phase 4 — SFU) ─────────────────────────────────────────
  // ws/wss URL the SPA uses to connect to the LiveKit server. Dev:
  //   ws://localhost:7880  →  the dev container in docker-compose
  // Prod: wss://livekit.indyatools.com (behind a TLS terminator).
  // Empty disables the LiveKit code path on the SPA.
  LIVEKIT_WS_URL:     Joi.string().optional().default(''),
  // API key + secret pair — must match the LIVEKIT_KEYS env in compose.
  // The backend uses these to sign per-participant JWTs (TTL via
  // LIVEKIT_TOKEN_TTL_SEC).
  LIVEKIT_API_KEY:    Joi.string().optional().default('devkey'),
  LIVEKIT_API_SECRET: Joi.string().optional().default('secret'),
  LIVEKIT_TOKEN_TTL_SEC: Joi.number().integer().min(60).max(86400).default(3600),

  // S3 Object Storage (10PB)
  S3_ENDPOINT: Joi.string().uri().optional(),
  S3_REGION: Joi.string().default('ap-south-1'),
  S3_ACCESS_KEY: Joi.string().optional(),
  S3_SECRET_KEY: Joi.string().optional(),
  S3_BUCKET: Joi.string().optional(),
}).unknown(true);

const { error, value: envVars } = envSchema.validate(process.env, {
  abortEarly: false,
  stripUnknown: false,
});

if (error) {
  const missing = error.details.map((d) => d.message).join('\n  - ');
  console.error(`\n❌ Environment validation failed:\n  - ${missing}\n`);
  console.error('Create a .env file based on .env.example\n');
  process.exit(1);
}

// ── Production hardening guard ────────────────────────────────────────────────
// Refuse to boot in production with known dev-default / weak secrets — the last
// line of defense against shipping the sample .env to prod. Logic lives in its
// own module so it can be unit-tested without triggering process.exit here.
const { productionSecretProblems } = require('./prodSecretGuard');

const _secProblems = productionSecretProblems(envVars);
if (_secProblems.length) {
  console.error('\n❌ Refusing to start in production with insecure config:\n  - ' + _secProblems.join('\n  - ') + '\n');
  console.error('Rotate these in the environment (see docs/GO_LIVE.md §2) and restart.\n');
  process.exit(1);
}

const config = Object.freeze({
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  db: {
    host: envVars.DB_HOST,
    port: envVars.DB_PORT,
    name: envVars.DB_NAME,
    user: envVars.DB_USER,
    password: envVars.DB_PASSWORD,
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    expiresIn: envVars.JWT_EXPIRES_IN,
    refreshSecret: envVars.JWT_REFRESH_SECRET,
    refreshExpiresIn: envVars.JWT_REFRESH_EXPIRES_IN,
  },
  // Drishyam Stream Service (the media gateway). New STREAM_SERVICE_* env vars are
  // preferred; the old MEDIAMTX_* names are still honoured as a fallback during the
  // rename so nothing breaks mid-migration.
  streamService: {
    apiUrl:        envVars.STREAM_SERVICE_API_URL      || envVars.MEDIAMTX_API_URL,
    apiUser:       envVars.STREAM_SERVICE_API_USER     || envVars.MEDIAMTX_API_USER,
    apiPass:       envVars.STREAM_SERVICE_API_PASS     || envVars.MEDIAMTX_API_PASS,
    webrtcUrl:     envVars.STREAM_SERVICE_WEBRTC_URL   || envVars.MEDIAMTX_WEBRTC_URL,
    hlsUrl:        envVars.STREAM_SERVICE_HLS_URL      || envVars.MEDIAMTX_HLS_URL,
    internalHlsUrl: envVars.STREAM_SERVICE_INTERNAL_HLS_URL || envVars.MEDIAMTX_INTERNAL_HLS_URL
                    || envVars.STREAM_SERVICE_HLS_URL  || envVars.MEDIAMTX_HLS_URL,
    rtspHost:      envVars.STREAM_SERVICE_RTSP_HOST    || envVars.MEDIAMTX_RTSP_HOST,
    rtspPort:      envVars.STREAM_SERVICE_RTSP_PORT    || envVars.MEDIAMTX_RTSP_PORT,
    recordingsDir: envVars.STREAM_SERVICE_RECORDINGS_DIR || envVars.MEDIAMTX_RECORDINGS_DIR,
    segmentDuration:    envVars.RECORDING_SEGMENT_DURATION,
    stitchBelowSeconds: envVars.RECORDING_STITCH_BELOW_SEC,
  },
  // Legacy Shinobi config — kept so existing .env files don't break on startup.
  // These values are no longer used by any active service.
  shinobi: {
    url:         envVars.SHINOBI_URL,
    apiKey:      envVars.SHINOBI_API_KEY,
    groupKey:    envVars.SHINOBI_GROUP_KEY,
    superApiKey: envVars.SHINOBI_SUPER_API_KEY,
  },
  stripe: {
    secretKey: envVars.STRIPE_SECRET_KEY,
    webhookSecret: envVars.STRIPE_WEBHOOK_SECRET,
  },
  razorpay: {
    keyId: envVars.RAZORPAY_KEY_ID,
    keySecret: envVars.RAZORPAY_KEY_SECRET,
    webhookSecret: envVars.RAZORPAY_WEBHOOK_SECRET,
  },
  cors: {
    origins: envVars.CORS_ORIGINS.split(',').map((s) => s.trim()),
  },
  frontendUrl: envVars.FRONTEND_URL,
  email: {
    host: envVars.EMAIL_HOST || null,
    port: envVars.EMAIL_PORT,
    secure: envVars.EMAIL_SECURE,
    user: envVars.EMAIL_USER || null,
    pass: envVars.EMAIL_PASS || null,
    from: envVars.EMAIL_FROM,
  },
  s3: {
    endpoint: envVars.S3_ENDPOINT || 'https://s3.10pb.com',
    region: envVars.S3_REGION || 'ap-south-1',
    accessKey: envVars.S3_ACCESS_KEY,
    secretKey: envVars.S3_SECRET_KEY,
    bucket: envVars.S3_BUCKET || 'bms-001161',
  },
  redisUrl: envVars.REDIS_URL,
  serviceToken: envVars.SERVICE_TOKEN || null,
  aiServiceUrl: envVars.AI_SERVICE_URL,
  aiJwt: {
    // Prefer a dedicated secret; fall back to SERVICE_TOKEN then JWT_SECRET so
    // the shared secret is guaranteed to exist even without new env wiring.
    secret: envVars.AI_JWT_SECRET || envVars.SERVICE_TOKEN || envVars.JWT_SECRET,
    issuer: envVars.AI_JWT_ISSUER,
    audience: envVars.AI_JWT_AUDIENCE,
  },
  activityServiceUrl: envVars.ACTIVITY_SERVICE_URL,
  turn: {
    uri:    envVars.TURN_URI || '',
    uriTls: envVars.TURN_URI_TLS || '',
    secret: envVars.TURN_SHARED_SECRET || '',
    ttlSec: envVars.TURN_TTL_SEC,
  },
  livekit: {
    wsUrl:     envVars.LIVEKIT_WS_URL || '',
    apiKey:    envVars.LIVEKIT_API_KEY,
    apiSecret: envVars.LIVEKIT_API_SECRET,
    ttlSec:    envVars.LIVEKIT_TOKEN_TTL_SEC,
  },
});

module.exports = config;
