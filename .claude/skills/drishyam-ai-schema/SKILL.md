---
name: drishyam-ai-schema
description: Add AI-side storage for the Drishyam investigation toolkit — Alembic migrations (0007+) in ai/face-service/vms_face/alembic, SQLAlchemy models, the new Qdrant vms_tracks collection, MinIO track-crop keys and retention. Use when creating tracks/track_points/activity_buckets tables, a Qdrant collection or payload index, or extending retention_worker in the Drishyamm repo.
---

# AI schema: Postgres (Alembic), Qdrant, MinIO, retention

Root: `ai/face-service/vms_face/`. Read the hub skill `drishyam-investigation` for rules.

## Alembic migration
- Versions in `alembic/versions/`; chain is linear `0001_initial` … `0006_journey` (head). Check head first:
  `grep -h "^revision\|^down_revision" alembic/versions/0*.py`.
- New file `0007_<topic>.py`, copy the shape of `0006_journey.py`: docstring with `Revision ID / Revises / Create Date`,
  `from __future__ import annotations`, typed `revision: str = "0007_<topic>"`, `down_revision: Union[str, None] = "0006_journey"`,
  `branch_labels`/`depends_on = None`.
- Every table: `tenant_id UUID NOT NULL` + `op.create_index("<table>_tenant_idx", …)`; use `UUID(as_uuid=True)`, `JSONB`,
  `server_default=sa.text("gen_random_uuid()")`/`now()` as 0006 does. Raw SQL via `op.execute` for HNSW/GIN/partitioning.
- `downgrade()` drops in exact reverse order. Must be reversible.
- TimescaleDB exists (`0003_track_links_and_timescaledb.py`) — consider a hypertable for `track_points`/`activity_buckets`
  instead of hand-made daily partitions; check how 0003 guards for the extension.
- Add matching ORM classes to `domain/models.py` (env.py uses `Base.metadata`).
- Runs automatically: `alembic upgrade head` on `smart-cam-ai` start (`docker-compose.yml:401`; scale shards skip it).
  Manual: `docker compose run --rm --no-deps smart-cam-ai sh -c 'cd /srv/app/face_detection/vms_face && alembic upgrade head && alembic downgrade -1 && alembic upgrade head'`
  (needs postgres up: `docker compose up -d postgres`).

Starting data model (README §5.1): `tracks(id, tenant_id, camera_id, source, case_id, tracker_id, object_class, first_seen, last_seen,
best_crop_key, best_crop_ts, attributes jsonb, zones text[], appearance_id, body_vector_id, plate, quality, ir)`,
`track_points(track_id, ts, bbox smallint[4] 0–1000)`, `activity_buckets(tenant_id, camera_id, minute, object_class, count)`.
Remember tracker ids are per-process (`services/face_tracker.py:263`) → store `tracker_id` text, use our own uuid PK.

## Qdrant `vms_tracks`
- `infra/qdrant.py:27 QdrantStore(collection)`; singletons via `_get_or_create` (`:300`), e.g. `get_qdrant_appearance()` `:291`.
- Limits to fix in a backward-compatible way: `ensure_collection()` (`:72`) uses the global `settings.qdrant_vector_size` (512) /
  `qdrant_distance` for every collection, no quantisation, and a fixed set of payload indexes (`:90-98`: tenant_id, person_id,
  camera_id, role keyword; occurred_at_ts int). Add optional per-store `vector_size`, `distance`, `payload_indexes`,
  `quantization` (int8 scalar) params with defaults equal to today's behaviour so `vms_appearance`/`vms_enrolled` are unchanged.
- `vms_tracks` payload: `tenant_id` (mandatory filter), `camera_id`, `site_id`, `object_class`, `first_seen_ts` (int index),
  `attr_*`, `source`, `case_id`, `ir`. Index every filtered field.
- Tenant safety: `search()` (`:226`) always adds the tenant filter; `upsert_batch`, `delete_points`, `delete_older_than` (`:189`)
  do NOT — never expose them to request paths without an explicit tenant filter.
- New settings in `config/settings.py` next to `qdrant_collection_appearance` (`:27-39`): e.g.
  `qdrant_collection_tracks: str = "vms_tracks"`, `investigate_index_enabled: bool = False`, `investigate_embed_dim: int`.
- Create at startup only when the flag is on (see `api/main.py:171-174`).

## MinIO
- `infra/minio_store.py:15 ObjectStore`, `get_object_store()` `:99`; `put_bytes(bucket, key, data, content_type)` `:46`
  returns `s3://…`; `get_presigned_url` `:88`; `get_bytes` is sync (use `run_in_executor`). No delete/list helpers.
- Track crops: `<tenant_id>/tracks/<YYYY-MM-DD>/<track_uuid>.jpg` (~10–20 KB). Note journey outputs (`videos/{job}.mp4`) lack a
  tenant prefix — don't copy that for case/evidence objects.

## Retention
- `workers/retention_worker.py` runs in the API lifespan on the primary shard (`api/main.py:217-221`); steps at `:42/55/66/78`
  are global time prunes. Add a step that deletes `tracks`/`track_points`/`activity_buckets`, `vms_tracks` points and crops
  older than the camera's video retention, **skipping rows with a case hold** (`case_id` set or a held-ids list from the backend).
  Wrap it in the same try/except as `_tick` (`:126`).

## Tests
`vms_face/tests/` is `unittest` (no pytest, no DB fixtures). Test pure logic (payload building, filter construction,
retention selection) with fakes; e.g. assert the filter passed to Qdrant always contains `tenant_id`.
Run: `docker compose run --rm --no-deps smart-cam-ai sh -c 'cd /srv/app/face_detection && python -m unittest discover -s vms_face/tests -t .'`
