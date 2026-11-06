"""face learning samples

Revision ID: 0004_face_learning_samples
Revises: 0003_track_links_and_timescaledb
Create Date: 2026-05-09
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSON, UUID

revision: str = "0004_face_learning_samples"
down_revision: Union[str, None] = "0003_track_links_and_timescaledb"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "face_learning_samples",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("persons.id", ondelete="CASCADE"), nullable=False),
        sa.Column("camera_id", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="SET NULL")),
        sa.Column("event_id", UUID(as_uuid=True), sa.ForeignKey("detection_events.id", ondelete="SET NULL"), unique=True),
        sa.Column("track_id", sa.String(64)),
        sa.Column("qdrant_point_id", UUID(as_uuid=True), unique=True),
        sa.Column("snapshot_uri", sa.Text),
        sa.Column("bbox", JSON),
        sa.Column("embedding", JSON, nullable=False),
        sa.Column("similarity", sa.Float),
        sa.Column("det_score", sa.Float),
        sa.Column("quality_score", sa.Float),
        sa.Column("gender", sa.String(16)),
        sa.Column("status", sa.String(24), nullable=False, server_default="pending"),
        sa.Column("reason", sa.String(256)),
        sa.Column("reviewed_by", sa.String(128)),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("metadata", JSON),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_face_learning_samples_tenant_id", "face_learning_samples", ["tenant_id"])
    op.create_index("ix_face_learning_samples_person_id", "face_learning_samples", ["person_id"])
    op.create_index("ix_face_learning_samples_camera_id", "face_learning_samples", ["camera_id"])
    op.create_index("ix_face_learning_samples_track_id", "face_learning_samples", ["track_id"])
    op.create_index("ix_face_learning_samples_status", "face_learning_samples", ["status"])
    op.create_index("ix_face_learning_samples_occurred_at", "face_learning_samples", ["occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_face_learning_samples_occurred_at", table_name="face_learning_samples")
    op.drop_index("ix_face_learning_samples_status", table_name="face_learning_samples")
    op.drop_index("ix_face_learning_samples_track_id", table_name="face_learning_samples")
    op.drop_index("ix_face_learning_samples_camera_id", table_name="face_learning_samples")
    op.drop_index("ix_face_learning_samples_person_id", table_name="face_learning_samples")
    op.drop_index("ix_face_learning_samples_tenant_id", table_name="face_learning_samples")
    op.drop_table("face_learning_samples")
