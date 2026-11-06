# Drishyam — Developer Guides

Everything an engineer needs to work on this codebase: how each subsystem is built, why it is built
that way, and what to do when it breaks. Written from the source, not from memory.

---

## Two ideas explain most of the design

Learn these first and the rest of the system stops looking arbitrary.

**1. The database is the source of truth.** The media server (MediaMTX, rebranded the *Drishyam
Stream Service*) holds no persistent configuration — a restart wipes it. That is by design: MySQL is
authoritative, and background loops continuously re-converge the media server to match it. This is
why the system self-heals after a crash, and why "I changed it in MediaMTX and it reverted" is
expected behaviour rather than a bug.

**2. Video never passes through the backend.** The Node backend moves *configuration*, not frames.
Browsers and phones pull media directly from the stream service; the backend only tells the stream
service which paths should exist. That separation is what lets a single backend serve thousands of
cameras — and it is why access control on video is a signed cookie checked by nginx, not a
middleware in Express.

---

## Start here

New to the codebase? Read in this order:

1. **[00-getting-started.md](./00-getting-started.md)** — get the stack running, understand the
   service map, make one real change.
2. **[../SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md)** — the canonical architecture.
3. The guide for whatever you're about to touch (below).
4. **[06-debugging-runbook.md](./06-debugging-runbook.md)** — skim it now, so you know it exists
   before you need it at 2am.

## The guides

| Guide | Covers | Read it when |
|---|---|---|
| [00-getting-started.md](./00-getting-started.md) | Prerequisites, bringing the stack up, service map, first change, tests, day-one failures | Your first day |
| [01-backend.md](./01-backend.md) | Request lifecycle, boot order, layering, auth, entitlements, background jobs | Touching the API or a service |
| [02-streaming.md](./02-streaming.md) | Path naming, on-demand pulls, camera state machine, reconciliation loops, vendors, recording, retention | Anything video |
| [03-ai-service.md](./03-ai-service.md) | Detection pipeline, workers, tenancy, enrollment, tuning knobs | Anything detection or recognition |
| [04-frontend.md](./04-frontend.md) | Console structure, players, stream registry, state, styling scopes | Working in the operator console |
| [05-data-model.md](./05-data-model.md) | Both databases, ER diagram, table semantics, migrations | Changing schema or writing a query |
| [06-debugging-runbook.md](./06-debugging-runbook.md) | Symptom-first diagnosis and fixes | Something is broken |
| [07-error-case-studies.md](./07-error-case-studies.md) | Write-ups of novel failures: what shipped them, what class they belong to, what guard rail now blocks them | You hit something nobody has seen before — read it, then add yours |

---

## Where do I change X?

| I want to… | Touch | Explained in |
|---|---|---|
| Add or change a REST endpoint | `smart-cam-backend/src/routes/` → `controllers/` → `services/` | [01](./01-backend.md) |
| Add a database column or table | `smart-cam-backend/migrations/` + `src/models/` | [05](./05-data-model.md) |
| Support a new camera brand | `smart-cam-backend/src/services/vendors/index.js` | [02](./02-streaming.md) |
| Change how a camera's RTSP URL is built | `services/vendors/index.js`, `streamRouter.service.js` | [02](./02-streaming.md) |
| Change recording, retention or S3 upload | `recordingRetention.service.js`, `recordingSync.service.js` | [02](./02-streaming.md) |
| Change what makes a camera "online" | `streamSupervisor.service.js`, `cameraReachability.service.js` | [02](./02-streaming.md) |
| Fix a camera that streams but shows black | `recordingSync.service.js` (HLS muxer probe) | [06](./06-debugging-runbook.md) |
| Change H.265 handling / transcoding | `stream.service.js`, `transcoder.service.js`, `core/services/codecSupport.js` | [02 §8.4](./02-streaming.md) |
| Add a page to the console | `smart-cam-app/src/App.jsx` + `src/core/pages/` | [04](./04-frontend.md) |
| Add live video to a page | `src/core/players/DirectStreamPlayer.jsx` | [04](./04-frontend.md) |
| Change live-player or reconnect behaviour | `src/core/services/streamRegistry.js` | [04](./04-frontend.md) |
| Add an AI analytic | `smart-cam-ai/.../services/` + `pipeline/orchestrator.py` | [03](./03-ai-service.md) |
| Tune detection accuracy | `smart-cam-ai/.../config/settings.py` | [03](./03-ai-service.md), [AI tuning](../AI_ACCURACY_AND_TUNING.md) |
| Change when an alert fires | `smart-cam-backend/src/services/alertEngine.js` | [01](./01-backend.md), [policy](../DETECTION_LOGGING_ALERTING_POLICY.md) |
| Gate a feature by plan | `services/entitlements.service.js`, `Plan.aiEnabled` | [01](./01-backend.md) |
| Add a permission / capability | `src/utils/constants.js`, `middleware/requireCapability` | [01](./01-backend.md) |
| Add or change an env variable | `src/config/env.js` (Joi-validated) | [env reference](../07-env-variables.md) |
| Connect cameras behind NAT | `edge-relay/` | [connectivity](../CAMERA_CONNECTIVITY.md) |

---

## Conventions

- **Write from the code.** These docs went stale once because they described a system (Shinobi) that
  had already been replaced. If you change behaviour, update the guide in the same PR.
- **[../SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) is authoritative** for architecture. Update it first,
  then any guide that goes deeper.
- **Never commit real credentials.** Document the *variable name*, never a value. Sweep for
  `rtsp://user:pass@`, `admin@`, API keys and customer IPs before committing.
- **Explain the why.** Much of the odd-looking code here is scar tissue from a real incident. When
  you document a guard, say what failure it prevents — that is the part that stops someone
  "simplifying" it back into an outage.

---

## Status of these documents

Written from the codebase and largely fact-checked against it. Be aware:

- **`03-ai-service.md` and `05-data-model.md`** were reviewed by a second pass that verified their
  claims against the source.
- **The other five guides were written from the source but their automated review pass did not
  complete.** They are believed accurate, and known-stale statements about H.265 handling have been
  corrected by hand — but treat a surprising claim as worth verifying in the code before relying on
  it, and fix it in place when you do.
- The suite does not yet cover: the mobile app, the SFU bridge, deployment/CI, or the marketing
  site. For those, see [../README.md](../README.md).
