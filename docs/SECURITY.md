# DrishyamVMS — Security Posture

_Last updated: 2026-07-06. Scope: `smart-cam-backend`, `smart-cam-ai`, the
datastore fleet, and the `docker-compose` deployment surface._

This document is the honest, current state of the system's security — what is
implemented in source, what still requires an operator/organization action, and
the concrete path from "hardened source" to a fully accredited deployment.

> **Reading the score.** Source code can take you to roughly **8–9 / 10**. The
> last points are deployment- and organization-level (a secrets manager, TLS
> everywhere, key rotation, an external penetration test, a DPDP compliance
> review). Those cannot be "committed" — they are operational commitments. This
> doc marks each item as **[code]** (done in the repo) or **[ops]** (yours to do).

---

## 1. Multiple databases — defense in depth

The platform runs six datastores. Every one is **loopback-bound** on the host
(`127.0.0.1:<port>`), so none is reachable from the network directly — app
containers reach them over the private compose network by service name. On top
of that network isolation, each store's **credential is now a single root `.env`
variable** that flows to both the store and all of its consumers, so one strong
value secures the whole fleet with **no code change**.

| Store | Auth mechanism | Env var (root `.env`) | Dev default | Status |
|-------|----------------|-----------------------|-------------|--------|
| MySQL | root password | `MYSQL_ROOT_PASSWORD` + `MYSQL_ALLOW_EMPTY_PASSWORD=no` | empty (off) | **[code]** wired end-to-end |
| PostgreSQL | user/password | `POSTGRES_USER` / `POSTGRES_PASSWORD` | `vms` / `vms` | **[code]** DSNs interpolated for all 3 consumers |
| Redis | `requirepass` | `REDIS_PASSWORD` | empty (off) | **[code]** server + all 4 consumer URLs; verified against a real container |
| Qdrant | API key | `QDRANT_API_KEY` | empty (off) | **[code]** server + Python client sends header (empty → no header) |
| MinIO | root user/secret | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `minioadmin` / `minioadmin` | **[code]** wired to all 3 consumers |
| Kafka | SASL/SCRAM | — | PLAINTEXT | **[ops]** not wired — see §5 |

**How the "one value secures all" wiring works.** In `docker-compose.yml` every
consumer's connection string reads the same variable the datastore is
initialized with, e.g.:

```yaml
REDIS_URL: "redis://${REDIS_PASSWORD:+:${REDIS_PASSWORD}@}redis:6379/0"
#                    └── when REDIS_PASSWORD is set → "redis://:<pw>@redis:6379/0"
#                        when unset (dev)          → "redis://redis:6379/0"
MINIO_ACCESS_KEY: "${MINIO_ROOT_USER:-minioadmin}"
POSTGRES_DSN: "postgresql+asyncpg://${POSTGRES_USER:-vms}:${POSTGRES_PASSWORD:-vms}@postgres:5432/vms_face"
```

This was validated with `docker compose config` in both modes (dev-default and
fully-secured) and, for Redis, against a live `redis:7-alpine` container:
`--requirepass ""` disables auth (dev), a set value enforces it.

**To secure a deployment:** copy [`.env.production.example`](../deploy/.env.production.example)
to `.env`, fill every value, and (for already-initialized volumes) rotate the
in-container credential too — see §4.

---

## 2. Application-layer hardening (backend)  **[code]**

- **Refuse-to-boot on weak secrets.** In production the API will not start with
  dev-default/placeholder secrets — dev `JWT_SECRET`/`JWT_REFRESH_SECRET`,
  matching access/refresh secrets, the sample `MEDIAMTX_API_PASS`, an empty
  `DB_PASSWORD`, or a placeholder Stripe key.
  See `src/config/prodSecretGuard.js` (unit-tested).
- **Security headers** (`src/config/securityHeaders.js`, unit-tested): HSTS
  (1 year, `includeSubDomains`, `preload`), a strict `Content-Security-Policy`
  (`default-src 'none'`, `frame-ancestors 'none'`) suited to a JSON API,
  `Referrer-Policy: no-referrer`, `nosniff`, and `X-Powered-By` stripped.
- **Password hashing** — bcrypt cost **13** (OWASP/NIST floor; up from 12).
  Existing hashes keep their embedded cost and still verify.
- **Audit trail** (`src/utils/audit.js`, unit-tested): a dedicated append-only
  `logs/audit.log` (JSON lines, 20×20MB rotation) records sensitive actions —
  user suspend/activate, password reset, self-service password change — with
  actor, target, IP, user-agent, and outcome. Writes are fire-and-forget and can
  never fail the operation they record. This complements the biometric
  `AuditLog` (Postgres) the AI service already keeps for DPDP-critical ops
  (enroll / 1:N search / erasure).
- **Rate limiting** — per-IP limits on `/api` and a stricter login limiter
  (`src/middleware/rateLimiter.js`).
- **CORS** — explicit origin allowlist from `CORS_ORIGINS` (`src/config/cors.js`).

## 3. Data protection & PII  **[code, partial]**

- **Camera credentials** (RTSP URLs/passwords) — AES-256-GCM at rest in both the
  Node backend (`src/utils/fieldCrypto.js`) and the Python AI service
  (`core/crypto.py`), tagged `enc:v1:`, with a graceful migration window
  (plaintext rows re-encrypt on next save). Requires `CAMERA_CRED_KEY` /
  `VMS_CAMERA_CRED_KEY` to be set — **[ops]**.
- **User passwords** — bcrypt (never stored reversibly).
- **Dependencies** — `npm audit` is **clean (0 vulnerabilities)** for the
  backend as of this writing (was 18; nodemailer bumped to 9.x, `uuid` pinned
  via override, `ws` patched).
- **Retention** — the AI service prunes detection events (90d), snapshots (7d)
  and audit logs (365d); recordings are enforced on the durable 10pb copy by
  `s3Retention.service.js` (dry-run until `S3_RETENTION_DELETE=1`).
- **Known gap — biometric embeddings at rest.** Face/body vectors in Qdrant and
  pgvector are **not** field-encrypted (see §5). Access is gated by the Qdrant
  API key + loopback binding, but the vectors themselves are plaintext.

---

## 4. Rotating a credential on an already-initialized volume  **[ops]**

Setting a password in `.env` only affects a **fresh** volume. For a running
system you must also change it inside the store:

- **MySQL:** `ALTER USER 'root'@'%' IDENTIFIED BY '<new>';` then set
  `MYSQL_ROOT_PASSWORD` + `MYSQL_ALLOW_EMPTY_PASSWORD=no` and recreate the app.
- **PostgreSQL:** `ALTER ROLE vms PASSWORD '<new>';` then set `POSTGRES_PASSWORD`.
- **Redis:** set `REDIS_PASSWORD` and recreate (no data migration needed).
- **Qdrant:** set `QDRANT_API_KEY` and recreate (keys are not stored in data).
- **MinIO:** create a new user/policy via `mc admin user add`, or rotate the root
  secret and set `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.
- **MediaMTX:** MediaMTX does **not** expand `${VAR}` inside `mediamtx.yml`
  (verified against v1.18.1 — it uses `MTX_`-prefix overrides, and a list-index
  override would drop the anonymous `user: any` entry cameras/browsers rely on).
  So rotate in **two** places: the `pass:` field in `mediamtx.yml` **and**
  `MEDIAMTX_API_PASS` in `.env`. The API is loopback-bound, limiting exposure.

---

## 5. Open items — the honest path to 10

| Item | Type | Notes |
|------|------|-------|
| TLS everywhere (in-network) | **[ops]** | Stores speak plaintext on the private compose net. Terminate TLS at nginx (done for north-south); add mTLS or an encrypted overlay for east-west if the network isn't trusted. |
| Kafka SASL/SCRAM + TLS | **[code+ops]** | Currently PLAINTEXT (loopback-bound, internal only). Needs listener reconfig + `security_protocol`/`sasl_*` in 3 Python consumers. |
| Biometric embeddings encryption at rest | **[code+ops]** | Qdrant/pgvector vectors are plaintext. Options: Qdrant storage encryption, pgvector column-level crypto, or full-disk encryption on the data volume. |
| Secrets manager (Vault / SOPS / cloud KMS) | **[ops]** | Today secrets live in a git-ignored `.env`. No rotation schedule or access audit. Move to a managed store with rotation. |
| Key rotation policy | **[ops]** | Define + enforce rotation for JWT secrets, S3 creds, `CAMERA_CRED_KEY`, datastore passwords. |
| httpOnly cookie auth (vs. bearer/query token) | **[code]** | Video endpoints accept `?token=`; migrate stream auth to signed short-TTL tokens / cookies to keep JWTs out of logs. (HMAC stream tokens exist in `streamToken.js`, gated by `STREAM_URL_SECRET`.) |
| External penetration test | **[ops]** | No third-party test on record. |
| DPDP Act 2023 compliance review | **[ops]** | Erasure endpoint + audit logging exist; a formal DPIA/legal review is an org step. |

### What "10" means here
A 10 is not a code state — it is: strong unique secrets in a managed vault with
rotation, TLS on every hop, encryption at rest for biometric data, a passing
third-party pen test, and a signed-off DPDP review. This repo gets you a hardened
**8–9** foundation; the table above is the remaining operator/organization work.

---

## Reporting a vulnerability
Email the maintainer (see repository owner) with steps to reproduce. Do not open
a public issue for security reports.
