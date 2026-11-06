"""footfall minute buckets

Per-camera, per-minute aggregate of people-counter line crossings (IN, OUT)
and optional fall-detection events. One row per (camera, minute) — the
service UPSERTs into the current minute as crossings happen, so a 24-hour
window on a busy camera is at most 1440 rows.

We deliberately don't use TimescaleDB here. Smart-cam-ai-postgres ships as
vanilla postgres:16-alpine (no Timescale extension), and at ~1440 rows per
camera per day a btree on `bucket_minute` is already fast for the chart
queries we need (1 day, 7 days, 30 days). If volume ever pushes us toward
a hypertable, the schema is hypertable-friendly: bucket_minute is the
obvious time partition column.

Revision ID: 0005_footfall
Revises: 0004_face_learning_samples
Create Date: 2026-05-11
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0005_footfall"
down_revision: Union[str, None] = "0004_face_learning_samples"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "footfall_minute_buckets",
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "camera_id",
            UUID(as_uuid=True),
            sa.ForeignKey("cameras.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Truncated to the minute (no seconds). The service computes this
        # by zeroing out seconds + microseconds before UPSERT, which lets
        # us use ON CONFLICT (camera_id, bucket_minute) DO UPDATE.
        sa.Column("bucket_minute", sa.DateTime(timezone=True), nullable=False),
        sa.Column("in_count",    sa.Integer, nullable=False, server_default="0"),
        sa.Column("out_count",   sa.Integer, nullable=False, server_default="0"),
        sa.Column("falls_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            onupdate=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("camera_id", "bucket_minute", name="pk_footfall_minute_buckets"),
    )
    # Common chart query: "all cameras in this tenant for the last 24h".
    op.create_index(
        "ix_footfall_minute_buckets_tenant_time",
        "footfall_minute_buckets",
        ["tenant_id", "bucket_minute"],
    )
    # Per-camera scan with newest-first ordering for the live row.
    op.create_index(
        "ix_footfall_minute_buckets_camera_time_desc",
        "footfall_minute_buckets",
        ["camera_id", sa.text("bucket_minute DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_footfall_minute_buckets_camera_time_desc",
        table_name="footfall_minute_buckets",
    )
    op.drop_index(
        "ix_footfall_minute_buckets_tenant_time",
        table_name="footfall_minute_buckets",
    )
    op.drop_table("footfall_minute_buckets")
