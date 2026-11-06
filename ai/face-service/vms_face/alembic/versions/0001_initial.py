"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-07
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ENUM, UUID

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


person_role_enum = ENUM(
    "student", "staff", "faculty", "visitor", "blacklist", "unknown",
    name="person_role",
    create_type=False,
)
camera_status_enum = ENUM(
    "offline", "online", "error", "paused",
    name="camera_status",
    create_type=False,
)
event_kind_enum = ENUM(
    "detection", "match", "unknown", "alert", "health",
    name="event_kind",
    create_type=False,
)


def upgrade() -> None:
    person_role_enum.create(op.get_bind(), checkfirst=True)
    camera_status_enum.create(op.get_bind(), checkfirst=True)
    event_kind_enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "tenants",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(128), unique=True, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        "persons",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("external_id", sa.String(128)),
        sa.Column("full_name", sa.String(256), nullable=False),
        sa.Column("role", person_role_enum, nullable=False, server_default="unknown"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("metadata", sa.JSON),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("tenant_id", "external_id", name="uq_person_tenant_external"),
    )
    op.create_index("ix_persons_tenant_id", "persons", ["tenant_id"])
    op.create_index("ix_persons_external_id", "persons", ["external_id"])
    op.create_index("ix_persons_full_name", "persons", ["full_name"])

    op.create_table(
        "face_enrollments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("persons.id", ondelete="CASCADE"), nullable=False),
        sa.Column("qdrant_point_id", UUID(as_uuid=True), unique=True, nullable=False),
        sa.Column("snapshot_uri", sa.Text),
        sa.Column("det_score", sa.Float),
        sa.Column("quality_score", sa.Float),
        sa.Column("source", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_face_enrollments_person_id", "face_enrollments", ["person_id"])

    op.create_table(
        "cameras",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("rtsp_url", sa.Text, nullable=False),
        sa.Column("location", sa.String(256)),
        sa.Column("zone", sa.String(128)),
        sa.Column("status", camera_status_enum, nullable=False, server_default="offline"),
        sa.Column("target_fps", sa.Float, nullable=False, server_default="8.0"),
        sa.Column("detection_input_size", sa.Integer, nullable=False, server_default="960"),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("config", sa.JSON),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("tenant_id", "code", name="uq_camera_tenant_code"),
    )
    op.create_index("ix_cameras_tenant_id", "cameras", ["tenant_id"])
    op.create_index("ix_cameras_code", "cameras", ["code"])

    op.create_table(
        "detection_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("camera_id", UUID(as_uuid=True), sa.ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False),
        sa.Column("track_id", sa.String(64), nullable=False),
        sa.Column("kind", event_kind_enum, nullable=False),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("persons.id", ondelete="SET NULL")),
        sa.Column("similarity", sa.Float),
        sa.Column("det_score", sa.Float),
        sa.Column("quality_score", sa.Float),
        sa.Column("bbox", sa.JSON),
        sa.Column("snapshot_uri", sa.Text),
        sa.Column("extra", sa.JSON),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_detection_events_tenant_id", "detection_events", ["tenant_id"])
    op.create_index("ix_detection_events_camera_id", "detection_events", ["camera_id"])
    op.create_index("ix_detection_events_track_id", "detection_events", ["track_id"])
    op.create_index("ix_detection_events_person_id", "detection_events", ["person_id"])
    op.create_index("ix_detection_events_kind", "detection_events", ["kind"])
    op.create_index("ix_detection_events_occurred_at", "detection_events", ["occurred_at"])


def downgrade() -> None:
    op.drop_table("detection_events")
    op.drop_table("cameras")
    op.drop_table("face_enrollments")
    op.drop_table("persons")
    op.drop_table("tenants")
    event_kind_enum.drop(op.get_bind(), checkfirst=True)
    camera_status_enum.drop(op.get_bind(), checkfirst=True)
    person_role_enum.drop(op.get_bind(), checkfirst=True)
