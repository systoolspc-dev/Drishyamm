# Drishyam documentation

**New here? Read in this order:** [SETUP.md](SETUP.md) (run it) →
[HOW_IT_WORKS.md](HOW_IT_WORKS.md) (the five flows) →
[SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) (canonical design) →
[dev/README.md](dev/README.md) (developer guides).

> **Folder names.** Most documents were written in the original monorepo and
> use its folder names. In this repository they map as follows:
>
> | Docs say | Here |
> |---|---|
> | `smart-cam-backend/` | `backend/` |
> | `smart-cam-app/` | `frontend/` |
> | `drishyam_app/` | `mobile/` |
> | `smart-cam-ai/app/face_detection/vms_face/` | `ai/face-service/vms_face/` |
> | `smart-cam-ai/app/head-count/`, `activity-monitor/`, `facerecounstruct/` | `ai/head-count/`, `ai/activity-monitor/`, `ai/face-reconstruct/` |
> | `smart-cam-ai/app/zone-sim/` | `ai/zone-guard/` |
> | `smart-cam-ai/data/insightface/` | `models/insightface/` |
> | `stream-service/` + `stream-service.yml` | `media/stream-service/` (`mediamtx.yml`) |
> | `smart-cam-transcoder/`, `smart-cam-sfu-bridge/` | `media/transcoder/`, `media/sfu-bridge/` |
> | `edge-relay/`, `gpu-bridge/`, `observability/`, `nginx.conf` | `deploy/…` |
> | `docker-compose.drisyam-original.yml` | `docker-compose.yml` (+ `docker-compose.scale.yml`) |
> | containers `drisyam-original-*` | containers `drishyam-*` (compose **service** names are unchanged) |
>
> Not carried over (legacy or superseded): Shinobi integration docs and
> scripts, DeepStream experiment, the standalone human-detection and footfall
> demo apps, the retired person-tracker service, sales/marketing material.

## Run & operate

| Doc | What it covers |
|---|---|
| [SETUP.md](SETUP.md) | Fresh machine → working console; profiles, scale-out, production hardening, moving data |
| [07-env-variables.md](07-env-variables.md) | Every environment variable and tuning knob |
| [09-troubleshooting.md](09-troubleshooting.md) | Common failures and fixes |
| [BACKUP_RESTORE.md](BACKUP_RESTORE.md) | Backup and restore |
| [GO_LIVE.md](GO_LIVE.md) | Go-live checklist |
| [SECURITY.md](SECURITY.md), [STREAM_SECURITY.md](STREAM_SECURITY.md) | Security posture, media-plane access control |
| [COTURN-DEPLOYMENT.md](COTURN-DEPLOYMENT.md) | TURN server for WebRTC through NAT |
| [../deploy/README.md](../deploy/README.md) | Edge relay, nginx, Cloudflare tunnel, GPU bridge, observability |
| [../db/README.md](../db/README.md) | Datastores, migrations, schema snapshots |

## Architecture

| Doc | What it covers |
|---|---|
| [HOW_IT_WORKS.md](HOW_IT_WORKS.md) | Request, live view, recording, AI→alert, journey — end to end |
| [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) | **Canonical** design: components, data model, streaming, AI, infra, known gaps |
| [01-overview.md](01-overview.md), [TECH-ARCHITECTURE.md](TECH-ARCHITECTURE.md) | Product capabilities, high-level architecture |
| [05-codebase-guide.md](05-codebase-guide.md) | "Where do I change X?" |
| [06-api-reference.md](06-api-reference.md) | REST endpoints, auth planes (also `../backend/docs/openapi.yaml`) |
| [BACKEND-TEMPLATE.md](BACKEND-TEMPLATE.md) | Conventions for Node services |

## Developer guides (`dev/`)

| Doc | What it covers |
|---|---|
| [dev/00-getting-started.md](dev/00-getting-started.md) | Orientation |
| [dev/01-backend.md](dev/01-backend.md) | **Backend flow**: mental model, request lifecycle, boot order, auth, entitlements, events, queues |
| [dev/02-streaming.md](dev/02-streaming.md) | Media plane internals |
| [dev/03-ai-service.md](dev/03-ai-service.md) | vms_face internals |
| [dev/04-frontend.md](dev/04-frontend.md) | Console architecture |
| [dev/05-data-model.md](dev/05-data-model.md) | Every table and how they relate |
| [dev/06-debugging-runbook.md](dev/06-debugging-runbook.md), [dev/07-error-case-studies.md](dev/07-error-case-studies.md) | Debugging, real incidents |

## Streaming, recording, cameras

[04-architecture.md](04-architecture.md) ·
[12-streaming-recording-architecture.md](12-streaming-recording-architecture.md) ·
[STREAMING_SERVICE_DESIGN.md](STREAMING_SERVICE_DESIGN.md) ·
[STREAMING_PIPELINE.md](STREAMING_PIPELINE.md) ·
[PHASE-4-SFU-DESIGN.md](PHASE-4-SFU-DESIGN.md) ·
[CAMERA_CONNECTIVITY.md](CAMERA_CONNECTIVITY.md) ·
[cctv-cameras/](cctv-cameras/README.md) (per-vendor NVR notes: Hikvision, Dahua, CP Plus, Uniview, Axis, Bosch, Hanwha, Honeywell)

## AI

| Doc | What it covers |
|---|---|
| [../models/README.md](../models/README.md) | **Every model**: file, service, accuracy, licence |
| [../ai/README.md](../ai/README.md) | AI services and their conventions; each service has a `MODEL.md` study guide |
| [AI_ACCURACY_AND_TUNING.md](AI_ACCURACY_AND_TUNING.md), [AI_ACCURACY_OPTIMIZATION.md](AI_ACCURACY_OPTIMIZATION.md) | How accuracy is measured, every tuning knob |
| [DETECTION_DECISION_ALERT_FRAMEWORK.md](DETECTION_DECISION_ALERT_FRAMEWORK.md), [DETECTION_LOGGING_ALERTING_POLICY.md](DETECTION_LOGGING_ALERTING_POLICY.md) | Anti-flood doctrine: detect / decide / alert |
| [FACE_SYSTEM_DESIGN.md](FACE_SYSTEM_DESIGN.md) | Face pipeline at scale (TensorRT, NVDEC, sharding, inference service) |
| [FACE_ACCURACY_BENCHMARK.md](FACE_ACCURACY_BENCHMARK.md), [FACE_RECOGNITION_RESEARCH_2026.md](FACE_RECOGNITION_RESEARCH_2026.md) | Benchmarks, model research |
| [FACE_LIGHTWEIGHT_TARGET.md](FACE_LIGHTWEIGHT_TARGET.md), [FACE_EDGE_REALTIME_PLAN.md](FACE_EDGE_REALTIME_PLAN.md) | Cost reduction, edge devices |
| [HEADCOUNT_DEPLOYMENT_SPEC.md](HEADCOUNT_DEPLOYMENT_SPEC.md), [HEADCOUNT_OPTIMIZATION_REPORT.md](HEADCOUNT_OPTIMIZATION_REPORT.md), [OCCUPANCY_LOGIC.md](OCCUPANCY_LOGIC.md) | Head count limits, performance, occupancy fusion |
| [RESTRICTED_ZONE_DETECTION.md](RESTRICTED_ZONE_DETECTION.md) | Zone intrusion |
| [JOURNEY_CENTRALIZATION.md](JOURNEY_CENTRALIZATION.md) | Cross-camera person journey |
| [CAMERA_PLACEMENT_DETECTION_SPECS.md](CAMERA_PLACEMENT_DETECTION_SPECS.md) | Mounting geometry, pixels-on-target |
| [UNDERSTANDING_FRONTEND_AND_AI.md](UNDERSTANDING_FRONTEND_AND_AI.md) | How the console and AI fit together |
| [AI_LICENCE_ENFORCEMENT_PLAN.md](AI_LICENCE_ENFORCEMENT_PLAN.md) | Per-feature licence enforcement |

## Other

[SNAPSHOT_NOTES.md](SNAPSHOT_NOTES.md) (what this snapshot is, what was verified, what was left out) ·
[admin/](admin/ADMIN_DASHBOARD_SCHEMA.md) (operator console schema) ·
[specs/RELAY_BACKFILL_BACKEND_SPEC.md](specs/RELAY_BACKFILL_BACKEND_SPEC.md) (pending backend work) ·
[../frontend/docs/](../frontend/docs/) (frontend context packs) ·
[../backend/docs/](../backend/docs/) (backend architecture, features, onboarding, OpenAPI)
