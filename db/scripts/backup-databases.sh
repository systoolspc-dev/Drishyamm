#!/usr/bin/env bash
#
# backup-databases.sh — nightly logical backup of the DrishyamVMS datastores.
#
# Dumps MySQL (operational: cameras/users/billing/ai_events) and PostgreSQL
# (vms_face: vectors/journeys/detection_events) from their compose containers,
# gzips each with a UTC timestamp, and prunes dumps older than RETENTION_DAYS.
#
# Usage:   ./db/scripts/backup-databases.sh   (run from the repo root)
# Cron:    0 2 * * *  cd /path/to/drishyam && ./db/scripts/backup-databases.sh >> /var/log/drisyam-backup.log 2>&1
# Restore: see docs/BACKUP_RESTORE.md
#
# Config via env (falls back to compose defaults):
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

MYSQL_CONTAINER="${MYSQL_CONTAINER:-drishyam-mysql}"
MYSQL_DB="${MYSQL_DB:-drishyamvms}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-}"      # empty in dev; set for prod

PG_CONTAINER="${PG_CONTAINER:-drishyam-postgres}"
PG_DB="${POSTGRES_DB:-vms_face}"
PG_USER="${POSTGRES_USER:-vms}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

echo "[backup] $ts → $BACKUP_DIR"

# ── MySQL ─────────────────────────────────────────────────────────────────────
# --single-transaction = consistent dump without locking (InnoDB).
mysql_pw_arg=()
[ -n "$MYSQL_PWD" ] && mysql_pw_arg=(-p"$MYSQL_PWD")
if docker exec "$MYSQL_CONTAINER" sh -c "mysqldump --single-transaction --routines --triggers -u'$MYSQL_USER' ${MYSQL_PWD:+-p'$MYSQL_PWD'} '$MYSQL_DB'" \
      | gzip > "$BACKUP_DIR/mysql-${MYSQL_DB}-${ts}.sql.gz"; then
  echo "[backup] mysql OK  ($(du -h "$BACKUP_DIR/mysql-${MYSQL_DB}-${ts}.sql.gz" | cut -f1))"
else
  echo "[backup] mysql FAILED" >&2
fi

# ── PostgreSQL ────────────────────────────────────────────────────────────────
if docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$PG_DB" \
      | gzip > "$BACKUP_DIR/postgres-${PG_DB}-${ts}.dump.gz"; then
  echo "[backup] postgres OK ($(du -h "$BACKUP_DIR/postgres-${PG_DB}-${ts}.dump.gz" | cut -f1))"
else
  echo "[backup] postgres FAILED" >&2
fi

# ── Prune old dumps ───────────────────────────────────────────────────────────
find "$BACKUP_DIR" -type f -name '*.gz' -mtime +"$RETENTION_DAYS" -print -delete || true

echo "[backup] done. kept last ${RETENTION_DAYS}d."
echo "[backup] NOTE: object storage (MinIO/S3 recordings + snapshots) and Qdrant"
echo "[backup]       vectors are NOT dumped here — back those up at the storage layer."
