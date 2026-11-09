# Databases

Drishyam uses five stores. None needs manual setup: schemas are created by
migrations when the services start.

| Store | Image | Database / bucket | Owner | Schema source of truth |
|---|---|---|---|---|
| MySQL 8.4 | `mysql:8.4` | `drishyamvms` | backend | `backend/migrations/*.js` (Sequelize; run on every backend start) + `backend/seeders/` |
| PostgreSQL 16 + pgvector | `pgvector/pgvector:pg16` | `vms_face` | face service | `ai/face-service/vms_face/alembic/versions/` (run by `smart-cam-ai` on start: `alembic upgrade head`) |
| Qdrant 1.12 | `qdrant/qdrant:v1.12.4` | collections `vms_enrolled` (galleries), `vms_appearance` (sightings), `faces` (legacy) | face service | created on first use |
| MinIO | `bitnamilegacy/minio` (MinIO 2024-10-13) | buckets `vms-snapshots`, `vms-enrollments`, `vms-person-tracker` (journey MP4/PDF) | face service | created on first use |
| Redis 7 | `redis:7-alpine` | — | everyone | ephemeral state, no schema |

## What's in this folder

| Path | What |
|---|---|
| `mysql/schema.sql` | Schema-only dump of `drishyamvms` from the working system (2026-11-06), at migration `036`. Reference only — a fresh install gets the same schema from the migrations. |
| `postgres/schema.sql` | Schema-only dump of `vms_face`, at Alembic revision `0006_journey` (head). Reference only. |
| `scripts/backup-databases.sh` | Nightly logical backup of MySQL + Postgres from the running containers, gzipped, with retention. Run from the repo root. Restore steps: [../docs/BACKUP_RESTORE.md](../docs/BACKUP_RESTORE.md). |

Neither dump contains data.

## Migrations

* **MySQL** — 37 migrations, `001-create-users` → `037-create-sync-only-tables`.
  Verified on 2026-11-06 against an empty MySQL 8.4: all 37 apply cleanly, the
  three seeders run, and the result has the same 33 tables and the same
  columns as the working database — plus `camera_groups.settings` (migration
  009), which the older working database happens to be missing.
  `037` exists because four tables (`alert_emails`, `mail_config`,
  `password_resets`, `restricted_zones`) used to be created only by
  `sequelize.sync()`, which the backend runs in development only; without it a
  production boot on a fresh database lacked e-mail alerts, SMTP settings,
  password reset and restricted zones. It is a no-op where they exist.
* Add a migration: `backend/migrations/0NN-<what>.js` (next number), then
  restart the backend or `docker compose exec smart-cam-backend npm run db:migrate`.
* **Postgres** — add an Alembic revision under
  `ai/face-service/vms_face/alembic/versions/`; `smart-cam-ai` applies it on
  start. Only shard 0 (`smart-cam-ai`) runs migrations.

## Useful commands

```bash
# MySQL shell
docker compose exec mysql mysql -uroot drishyamvms
# Postgres shell
docker compose exec postgres psql -U vms -d vms_face
# Migration state
docker compose exec mysql mysql -uroot -N -e "select name from drishyamvms.SequelizeMeta order by name desc limit 3"
docker compose exec postgres psql -U vms -d vms_face -Atc "select version_num from alembic_version"
# Backup (from the repo root)
./db/scripts/backup-databases.sh
```

The Qdrant and MinIO volumes are not covered by the backup script; copy the
`*_qdrant-data` / `*_minio-data` volumes with `tar` when moving a deployment
(see [../docs/SETUP.md §8](../docs/SETUP.md)).
