"""track_links + TimescaleDB hypertable

Revision ID: 0003_track_links_and_timescaledb
Revises: 0002_audit_log
Create Date: 2026-05-08

This migration is intentionally idempotent:
  * `track_links` is created plainly.
  * `detection_events` is converted to a TimescaleDB hypertable ONLY if
    the `timescaledb` extension is already installed in this database.
    On a plain Postgres install the DO block falls through with a NOTICE
    and the table stays a regular Postgres table — the application
    behavior is identical, just slower at very large row counts.

To enable Timescale on Postgres 16:
    CREATE EXTENSION IF NOT EXISTS timescaledb;
Then re-run `alembic upgrade head` (the DO block is idempotent on subsequent
runs because of `if_not_exists => true`).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSON, UUID

revision: str = "0003_track_links_and_timescaledb"
down_revision: Union[str, None] = "0002_audit_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. track_links ────────────────────────────────────────────────────
    op.create_table(
        "track_links",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("a_track_id", sa.String(64), nullable=False),
        sa.Column("a_camera_id", UUID(as_uuid=True), nullable=False),
        sa.Column("a_event_id", UUID(as_uuid=True)),
        sa.Column("a_occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("b_track_id", sa.String(64), nullable=False),
        sa.Column("b_camera_id", UUID(as_uuid=True), nullable=False),
        sa.Column("b_event_id", UUID(as_uuid=True)),
        sa.Column("b_occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("similarity", sa.Float, nullable=False),
        sa.Column("link_kind", sa.String(32), nullable=False, server_default="cosine_face"),
        sa.Column("person_id", UUID(as_uuid=True)),
        sa.Column("metadata", JSON),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "a_track_id", "a_camera_id", "b_track_id", "b_camera_id",
            name="uq_track_link_pair",
        ),
    )
    op.create_index("ix_track_links_tenant_id", "track_links", ["tenant_id"])
    op.create_index("ix_track_links_a_track_id", "track_links", ["a_track_id"])
    op.create_index("ix_track_links_b_track_id", "track_links", ["b_track_id"])
    op.create_index("ix_track_links_a_camera_id", "track_links", ["a_camera_id"])
    op.create_index("ix_track_links_b_camera_id", "track_links", ["b_camera_id"])
    op.create_index("ix_track_links_person_id", "track_links", ["person_id"])
    op.create_index("ix_track_links_a_occurred_at", "track_links", ["a_occurred_at"])
    op.create_index("ix_track_links_b_occurred_at", "track_links", ["b_occurred_at"])

    # ── 2. TimescaleDB hypertable on detection_events (gated) ────────────
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
            -- Convert existing detection_events to a hypertable. migrate_data
            -- moves prior rows into chunks; if_not_exists makes this idempotent.
            PERFORM create_hypertable(
              'detection_events',
              'occurred_at',
              chunk_time_interval => INTERVAL '1 day',
              migrate_data => true,
              if_not_exists => true
            );
            -- 7-day compression policy: rows older than 7 days are columnar
            -- compressed (~10x smaller, slower writes — but old rows aren't
            -- written).
            BEGIN
              PERFORM add_compression_policy('detection_events', INTERVAL '7 days');
            EXCEPTION WHEN duplicate_object THEN
              NULL;
            END;
            -- 90-day retention policy enforced at the chunk level — much
            -- faster than DELETE on a regular table.
            BEGIN
              PERFORM add_retention_policy('detection_events', INTERVAL '90 days');
            EXCEPTION WHEN duplicate_object THEN
              NULL;
            END;
            RAISE NOTICE 'detection_events is now a TimescaleDB hypertable';
          ELSE
            RAISE NOTICE 'timescaledb extension not present; detection_events stays a regular table';
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    # Reverse the hypertable conversion is non-trivial (hypertables become
    # regular tables only via dump/restore). We drop the policies if they
    # exist and leave the storage as-is — the table is still queryable.
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
            BEGIN
              PERFORM remove_retention_policy('detection_events', if_exists => true);
            EXCEPTION WHEN OTHERS THEN NULL;
            END;
            BEGIN
              PERFORM remove_compression_policy('detection_events', if_exists => true);
            EXCEPTION WHEN OTHERS THEN NULL;
            END;
          END IF;
        END $$;
        """
    )
    op.drop_index("ix_track_links_b_occurred_at", table_name="track_links")
    op.drop_index("ix_track_links_a_occurred_at", table_name="track_links")
    op.drop_index("ix_track_links_person_id", table_name="track_links")
    op.drop_index("ix_track_links_b_camera_id", table_name="track_links")
    op.drop_index("ix_track_links_a_camera_id", table_name="track_links")
    op.drop_index("ix_track_links_b_track_id", table_name="track_links")
    op.drop_index("ix_track_links_a_track_id", table_name="track_links")
    op.drop_index("ix_track_links_tenant_id", table_name="track_links")
    op.drop_table("track_links")
