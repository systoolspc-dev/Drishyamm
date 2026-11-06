from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from pgvector.sqlalchemy import Vector

from vms_face.domain.enums import CameraStatus, EventKind, PersonRole
from vms_face.domain.types import EncryptedString


class Base(DeclarativeBase):
    pass


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Person(Base):
    __tablename__ = "persons"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    external_id: Mapped[str | None] = mapped_column(String(128), index=True)   # e.g. roll number / employee id
    full_name: Mapped[str] = mapped_column(String(256), index=True)
    role: Mapped[PersonRole] = mapped_column(
        SAEnum(PersonRole, name="person_role", values_callable=_enum_values),
        default=PersonRole.UNKNOWN,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    enrollments: Mapped[list["FaceEnrollment"]] = relationship(back_populates="person", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("tenant_id", "external_id", name="uq_person_tenant_external"),
    )


class FaceEnrollment(Base):
    """One image-derived embedding associated with a person.
    Each row corresponds to a vector stored in Qdrant; `qdrant_point_id` is the link."""

    __tablename__ = "face_enrollments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("persons.id", ondelete="CASCADE"), index=True)
    qdrant_point_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, default=_uuid)
    snapshot_uri: Mapped[str | None] = mapped_column(Text)   # MinIO key
    det_score: Mapped[float | None] = mapped_column(Float)
    quality_score: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str | None] = mapped_column(String(64))   # "upload" | "auto-enroll" | "import"
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    person: Mapped[Person] = relationship(back_populates="enrollments")


class FaceLearningSample(Base):
    """Operator-reviewed CCTV crop suggested for gallery enrichment.

    These rows are intentionally separate from FaceEnrollment. A live match can
    propose a cleaner, camera-native sample, but it only becomes trusted gallery
    data after explicit approval.
    """

    __tablename__ = "face_learning_samples"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("persons.id", ondelete="CASCADE"), index=True)
    camera_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id", ondelete="SET NULL"), index=True)
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("detection_events.id", ondelete="SET NULL"), unique=True)
    track_id: Mapped[str | None] = mapped_column(String(64), index=True)
    qdrant_point_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)
    snapshot_uri: Mapped[str | None] = mapped_column(Text)
    bbox: Mapped[list[float] | None] = mapped_column(JSON)
    embedding: Mapped[list[float]] = mapped_column(JSON)
    similarity: Mapped[float | None] = mapped_column(Float)
    det_score: Mapped[float | None] = mapped_column(Float)
    quality_score: Mapped[float | None] = mapped_column(Float)
    gender: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    reason: Mapped[str | None] = mapped_column(String(256))
    reviewed_by: Mapped[str | None] = mapped_column(String(128))
    reviewed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON, default=dict)
    occurred_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Camera(Base):
    __tablename__ = "cameras"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(64), index=True)   # human-readable ID e.g. "GATE-01"
    name: Mapped[str] = mapped_column(String(256))
    # AES-256-GCM at the application layer. Stays plaintext on disk when
    # VMS_CAMERA_CRED_KEY is unset; encrypted when set. See domain/types.py.
    rtsp_url: Mapped[str] = mapped_column(EncryptedString)
    location: Mapped[str | None] = mapped_column(String(256))
    zone: Mapped[str | None] = mapped_column(String(128))
    # Spatial topology — drives the journey fusion space/time gate. Seeded from
    # camera placement, refined from observed transitions into `camera_edges`.
    lat: Mapped[float | None] = mapped_column(Float)
    lng: Mapped[float | None] = mapped_column(Float)
    building: Mapped[str | None] = mapped_column(String(128))
    floor: Mapped[str | None] = mapped_column(String(64))
    orientation: Mapped[float | None] = mapped_column(Float)   # degrees, 0=N
    status: Mapped[CameraStatus] = mapped_column(
        SAEnum(CameraStatus, name="camera_status", values_callable=_enum_values),
        default=CameraStatus.OFFLINE,
    )
    target_fps: Mapped[float] = mapped_column(Float, default=8.0)
    detection_input_size: Mapped[int] = mapped_column(Integer, default=960)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    config_json: Mapped[dict | None] = mapped_column("config", JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("tenant_id", "code", name="uq_camera_tenant_code"),
    )


class TrackLink(Base):
    """Cross-camera track association emitted by the ReID worker.

    Each row captures evidence that two tracks (possibly on different
    cameras) likely belong to the same physical person, with the
    similarity score used to decide. We store directed edges (a, b) where
    `a` is the older sighting and `b` is the newer one — when forming a
    transitive global identity from these edges, traverse undirected.
    The pair `(a_track_id, a_camera_id, b_track_id, b_camera_id)` is unique
    so re-emissions are no-ops."""

    __tablename__ = "track_links"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)

    a_track_id: Mapped[str] = mapped_column(String(64), index=True)
    a_camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    a_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    a_occurred_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), index=True)

    b_track_id: Mapped[str] = mapped_column(String(64), index=True)
    b_camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    b_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    b_occurred_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), index=True)

    similarity: Mapped[float] = mapped_column(Float)
    link_kind: Mapped[str] = mapped_column(String(32), default="cosine_face")
    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "a_track_id", "a_camera_id", "b_track_id", "b_camera_id",
            name="uq_track_link_pair",
        ),
    )


class AuditLog(Base):
    """Append-only record of biometric / privacy-relevant operations.

    DPDP Act 2023 (India) classifies face embeddings as Sensitive Personal
    Data. Required: log every 1:N query, every enrollment, and every deletion
    with operator identity, target, and reason. We sample automated 1:N
    queries that produce *hits* (the moment biometric data is bound to an
    identity) and log human-driven searches at 100%."""

    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    actor: Mapped[str] = mapped_column(String(128), index=True)
    actor_kind: Mapped[str] = mapped_column(String(32), index=True)  # "system" | "user"
    action: Mapped[str] = mapped_column(String(64), index=True)       # "search_1n" | "enroll" | "delete_person" | ...
    target_type: Mapped[str | None] = mapped_column(String(64))
    target_id: Mapped[str | None] = mapped_column(String(128), index=True)
    reason: Mapped[str | None] = mapped_column(String(256))
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON, default=dict)
    occurred_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        index=True,
    )


class DetectionEvent(Base):
    """Time-series row, one per emitted detection / match. In Phase 2+ this becomes
    a TimescaleDB hypertable partitioned on `occurred_at`."""

    __tablename__ = "detection_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id", ondelete="CASCADE"), index=True)
    track_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[EventKind] = mapped_column(
        SAEnum(EventKind, name="event_kind", values_callable=_enum_values),
        index=True,
    )

    person_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("persons.id", ondelete="SET NULL"), index=True)
    similarity: Mapped[float | None] = mapped_column(Float)
    det_score: Mapped[float | None] = mapped_column(Float)
    quality_score: Mapped[float | None] = mapped_column(Float)

    bbox: Mapped[list[float] | None] = mapped_column(JSON)   # [x1, y1, x2, y2]
    snapshot_uri: Mapped[str | None] = mapped_column(Text)
    extra: Mapped[dict | None] = mapped_column(JSON, default=dict)

    occurred_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FootfallMinuteBucket(Base):
    """Per-camera, per-minute aggregate of footfall line crossings. The
    StreamOrchestrator counts IN/OUT crossings frame-by-frame in memory and
    flushes the deltas into the bucket for the current wall-clock minute.

    Schema is on `composite primary key (camera_id, bucket_minute)` so writes
    UPSERT with ON CONFLICT DO UPDATE — the service never has to read first.

    Why per-minute granularity? It's the coarsest bucket that still lets us
    render "spike in the last 10 minutes" charts without hammering Postgres,
    and at 100 cameras * 1440 mins/day = 144k rows/day the table stays small
    enough for plain btree indexes (no Timescale needed)."""

    __tablename__ = "footfall_minute_buckets"

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    camera_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cameras.id", ondelete="CASCADE"),
        primary_key=True,
    )
    bucket_minute: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), primary_key=True,
    )
    in_count:    Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    out_count:   Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    falls_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    updated_at:  Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Journey reconstruction (centralized from person-tracker + journey-platform).
# Reuses the identity backbone above: `persons` = the Global Person ID,
# `cameras` = topology, `detection_events` = per-detection sightings,
# `track_links` = cross-camera ReID edges. These tables add only what journey
# reconstruction needs on top. See docs/JOURNEY_CENTRALIZATION.md.
# ─────────────────────────────────────────────────────────────────────────────

# Embedding dimensions — keep in sync with the Qdrant collections and the
# pgvector columns below. face: ArcFace/AdaFace R100 → 512; body: OSNet x1.0 → 512.
FACE_DIM = 512
BODY_DIM = 512


class CameraEdge(Base):
    """Directed adjacency between two cameras: plausible transit-time window +
    a prior probability. Powers the multiplicative time/space gate in journey
    fusion (a physically impossible transition vetoes a high appearance score).
    Seeded from camera GPS/floor/orientation, refined from observed transitions."""

    __tablename__ = "camera_edges"

    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    from_camera: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cameras.id", ondelete="CASCADE"), primary_key=True
    )
    to_camera: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cameras.id", ondelete="CASCADE"), primary_key=True
    )
    t_min_sec: Mapped[int] = mapped_column(Integer, default=1, server_default="1")     # fastest plausible transit
    t_max_sec: Mapped[int] = mapped_column(Integer, default=300, server_default="300") # slowest plausible transit
    prob: Mapped[float] = mapped_column(Float, default=0.5, server_default="0.5")      # adjacency prior [0,1]
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Embedding(Base):
    """pgvector mirror of the per-detection embeddings. Qdrant remains the ANN
    hot path; this row gives transactional joins against `detection_events` and a
    durable rebuild source. One row per detection; face_vec is null when no face
    was usable in the crop, body_vec carries the OSNet fusion fallback."""

    __tablename__ = "embeddings"

    detection_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("detection_events.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    face_vec: Mapped[list[float] | None] = mapped_column(Vector(FACE_DIM))
    body_vec: Mapped[list[float] | None] = mapped_column(Vector(BODY_DIM))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Journey(Base):
    """A reconstructed cross-camera movement for one (possibly unknown) person.
    Forensic journeys come from an upload→search→fuse run; live journeys are
    folded incrementally from journey.events. The graph + generated artifact URIs
    (stitched MP4 / PDF) are attached so the dashboard can render directly."""

    __tablename__ = "journeys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    person_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("persons.id", ondelete="SET NULL"), index=True
    )
    created_by: Mapped[str | None] = mapped_column(String(128))   # actor (matches audit_log.actor)
    mode: Mapped[str] = mapped_column(String(16), default="forensic", server_default="forensic")  # forensic | live
    window_start: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    window_end: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    first_seen_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    cameras_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    confidence: Mapped[float | None] = mapped_column(Float)
    # Movement graph: {nodes:[{camera_id,t}], edges:[{from,to,prob}]}.
    graph: Mapped[dict | None] = mapped_column(JSONB, default=dict)
    video_uri: Mapped[str | None] = mapped_column(Text)
    report_uri: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="building", server_default="building")  # building|ready|failed
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    stops: Mapped[list["JourneyStop"]] = relationship(back_populates="journey", cascade="all, delete-orphan")


class JourneyStop(Base):
    """One clustered camera visit along a journey (a sighting cluster), ordered
    by `seq`. Carries the best fused score + representative snapshot for the stop."""

    __tablename__ = "journey_stops"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    journey_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("journeys.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer)
    camera_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cameras.id", ondelete="CASCADE"))
    started_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    confidence: Mapped[float | None] = mapped_column(Float)
    snapshot_uri: Mapped[str | None] = mapped_column(Text)
    detection_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    journey: Mapped[Journey] = relationship(back_populates="stops")

    __table_args__ = (
        UniqueConstraint("journey_id", "seq", name="uq_journey_stop_seq"),
    )
