# Backup & Restore

> DrishyamVMS keeps operational data in **MySQL** (`drishyamvms`) and AI/vector
> data in **PostgreSQL** (`vms_face`). Recordings + snapshots live in object
> storage (MinIO/S3); face vectors live in Qdrant. This doc covers the two SQL
> databases — the ones a `scripts/backup-databases.sh` run captures.

## What's backed up (and what isn't)

| Store | Contains | Backed up by |
|---|---|---|
| MySQL `drishyamvms` | cameras, groups, users, billing, `ai_events` | `backup-databases.sh` (mysqldump) |
| PostgreSQL `vms_face` | detection_events, journeys, embeddings (pgvector) | `backup-databases.sh` (pg_dump -Fc) |
| MinIO / S3 | recording segments, event snapshots | **storage-layer backup / versioning** (not this script) |
| Qdrant | face/body vectors | Qdrant snapshot API (rebuildable from Postgres + re-embed) |

## Nightly backup

```bash
# one-off
./scripts/backup-databases.sh

# cron (2am daily), logging to a file
0 2 * * *  /opt/drisyam/scripts/backup-databases.sh >> /var/log/drisyam-backup.log 2>&1
```

Tunable via env: `BACKUP_DIR` (default `./backups`), `BACKUP_RETENTION_DAYS`
(default 14), and the DB creds (`MYSQL_ROOT_PASSWORD`, `POSTGRES_USER`,
`POSTGRES_DB`, container names). Dumps are gzipped and timestamped in UTC; dumps
older than the retention window are pruned automatically.

> **Prod:** ship the dumps off-box (S3/rsync to another region) — a backup on the
> same host doesn't survive host loss. Test a restore quarterly.

## Restore

### MySQL

```bash
gunzip -c backups/mysql-drishyamvms-<ts>.sql.gz \
  | docker exec -i smart-cam-mysql sh -c 'mysql -uroot ${MYSQL_ROOT_PASSWORD:+-p"$MYSQL_ROOT_PASSWORD"} drishyamvms'
```

### PostgreSQL (custom-format dump → pg_restore)

```bash
gunzip -c backups/postgres-vms_face-<ts>.dump.gz > /tmp/vms_face.dump
docker exec -i smart-cam-ai-postgres pg_restore -U vms -d vms_face --clean --if-exists < /tmp/vms_face.dump
```

> `pgvector` must be installed in the target (the compose image bundles it). The
> `--clean --if-exists` flags drop-and-recreate objects so a restore is repeatable.

## Recovery checklist

1. Bring up datastores only: `docker compose up -d mysql postgres`.
2. Restore MySQL, then PostgreSQL (order doesn't matter — they're independent).
3. Bring up the app: `docker compose up -d`.
4. Recordings/snapshots come from object storage (restore that separately).
5. Qdrant vectors: restore a Qdrant snapshot, or re-enroll/re-embed from
   PostgreSQL `detection_events` if the snapshot is stale.
