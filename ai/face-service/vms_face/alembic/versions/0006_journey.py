"""journey reconstruction schema (pgvector)

Centralizes the journey/forensic capability into smart-cam-ai. Reuses the
existing identity backbone — `persons` (Global Person ID), `cameras`,
`detection_events` (sightings), `track_links` (cross-camera ReID edges),
`audit_log` — and adds only what journey reconstruction needs on top:

  * camera spatial topology columns (lat/lng/building/floor/orientation)
  * camera_edges — directed adjacency (transit-time window + prior) for the
    multiplicative time/space gate in fusion
  * embeddings — pgvector mirror of per-detection face/body vectors (Qdrant
    stays the ANN hot path; this gives transactional joins + a rebuild source)
  * journeys / journey_stops — the reconstructed movement + artifact URIs

Requires the `vector` extension. The image runs pgvector/pgvector:pg16, so the
CREATE EXTENSION below succeeds on a fresh or existing volume.

Revision ID: 0006_journey
Revises: 0005_footfall
Create Date: 2026-05-30
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0006_journey"
down_revision: Union[str, None] = "0005_footfall"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FACE_DIM = 512
BODY_DIM = 512


def upgrade() -> None:
    # pgvector extension — needed before any vector() column is created.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # ── camera spatial topology (additive, all nullable) ────────────────────
    op.add_column("cameras", sa.Column("lat", sa.Float(), nullable=True))
    op.add_column("cameras", sa.Column("lng", sa.Float(), nullable=True))
    op.add_column("cameras", sa.Column("building", sa.String(length=128), nullable=True))
    op.add_column("cameras", sa.Column("floor", sa.String(length=64), nullable=True))
    op.add_column("cameras", sa.Column("orientation", sa.Float(), nullable=True))

    # ── camera_edges — directed adjacency graph ─────────────────────────────
    op.create_table(
        "camera_edges",
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("from_camera", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("to_camera", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("t_min_sec", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("t_max_sec", sa.Integer(), nullable=False, server_default="300"),
        sa.Column("prob", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("camera_edges_tenant_idx", "camera_edges", ["tenant_id"])

    # ── embeddings — pgvector mirror keyed by detection ─────────────────────
    op.create_table(
        "embeddings",
        sa.Column("detection_id", UUID(as_uuid=True), sa.ForeignKey("detection_events.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("face_vec", Vector(FACE_DIM), nullable=True),
        sa.Column("body_vec", Vector(BODY_DIM), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("embeddings_tenant_idx", "embeddings", ["tenant_id"])
    # HNSW cosine ANN indexes (pgvector). Qdrant is primary; these back joined
    # similarity + act as the durable rebuild source.
    op.execute("CREATE INDEX embeddings_face_hnsw ON embeddings USING hnsw (face_vec vector_cosine_ops)")
    op.execute("CREATE INDEX embeddings_body_hnsw ON embeddings USING hnsw (body_vec vector_cosine_ops)")

    # ── journeys ────────────────────────────────────────────────────────────
    op.create_table(
        "journeys",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("persons.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=True),
        sa.Column("mode", sa.String(length=16), nullable=False, server_default="forensic"),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("window_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cameras_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("graph", JSONB(), nullable=True),
        sa.Column("video_uri", sa.Text(), nullable=True),
        sa.Column("report_uri", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="building"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("journeys_tenant_idx", "journeys", ["tenant_id"])
    op.create_index("journeys_person_idx", "journeys", ["person_id"])
    op.create_index("journeys_created_idx", "journeys", ["created_at"])

    # ── journey_stops ───────────────────────────────────────────────────────
    op.create_table(
        "journey_stops",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("journey_id", UUID(as_uuid=True), sa.ForeignKey("journeys.id", ondelete="CASCADE"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("camera_id", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("snapshot_uri", sa.Text(), nullable=True),
        sa.Column("detection_count", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("journey_id", "seq", name="uq_journey_stop_seq"),
    )
    op.create_index("journey_stops_journey_idx", "journey_stops", ["journey_id"])


def downgrade() -> None:
    op.drop_index("journey_stops_journey_idx", table_name="journey_stops")
    op.drop_table("journey_stops")
    op.drop_index("journeys_created_idx", table_name="journeys")
    op.drop_index("journeys_person_idx", table_name="journeys")
    op.drop_index("journeys_tenant_idx", table_name="journeys")
    op.drop_table("journeys")
    op.execute("DROP INDEX IF EXISTS embeddings_body_hnsw")
    op.execute("DROP INDEX IF EXISTS embeddings_face_hnsw")
    op.drop_index("embeddings_tenant_idx", table_name="embeddings")
    op.drop_table("embeddings")
    op.drop_index("camera_edges_tenant_idx", table_name="camera_edges")
    op.drop_table("camera_edges")
    op.drop_column("cameras", "orientation")
    op.drop_column("cameras", "floor")
    op.drop_column("cameras", "building")
    op.drop_column("cameras", "lng")
    op.drop_column("cameras", "lat")
    # We deliberately do NOT drop the `vector` extension on downgrade — other
    # schema or future migrations may rely on it, and DROP EXTENSION would fail
    # if any vector column still exists elsewhere.
