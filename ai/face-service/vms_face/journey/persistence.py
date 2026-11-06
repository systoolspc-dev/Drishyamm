"""Synchronous Postgres persistence of a reconstructed Journey.

Runs from the sync RQ stitch worker (NOT the async pipeline), so it uses its own
small sync engine over settings.postgres_dsn_sync — a dedicated tiny pool so the
stitch worker can never exhaust the connection pool the live face pipeline shares.

Writes, in ONE transaction at end-of-job: resolve/synthesise the Global Person
(role=UNKNOWN when the caller had no identity), the Journey row, and one
JourneyStop per clustered sighting. The Journey/JourneyStop/Person tables already
exist (migration 0006); no new migration is needed."""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.domain.enums import PersonRole
from vms_face.domain.models import Journey, JourneyStop, Person

log = get_logger(__name__)

# Dedicated small sync pool — isolates the stitch worker from the live async pool.
_engine = None
_Session: sessionmaker | None = None


def _session_factory() -> sessionmaker:
    global _engine, _Session
    if _Session is None:
        _engine = create_engine(
            settings.postgres_dsn_sync, pool_size=2, max_overflow=2, pool_pre_ping=True, future=True
        )
        _Session = sessionmaker(bind=_engine, future=True)
    return _Session


def _parse_dt(value: Any) -> dt.datetime | None:
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def persist_journey_sync(
    *,
    tenant_id: str,
    person_id: str | None,
    created_by: str | None,
    job_id: str,
    sightings: list[dict],
    video_uri: str | None,
    report_uri: str | None,
    window_start: Any = None,
    window_end: Any = None,
) -> uuid.UUID:
    """Persist a forensic Journey + its stops. Returns the journey id."""
    tid = uuid.UUID(str(tenant_id))
    ordered = sorted(sightings, key=lambda s: str(s.get("started_at") or ""))

    starts = [_parse_dt(s.get("started_at")) for s in ordered]
    ends = [_parse_dt(s.get("ended_at")) for s in ordered]
    starts = [x for x in starts if x is not None]
    ends = [x for x in ends if x is not None]
    first_seen = min(starts) if starts else None
    last_seen = max(ends) if ends else None
    cameras = {str(s.get("camera_id")) for s in ordered if s.get("camera_id")}
    confidence = max((float(s.get("best_similarity") or 0.0) for s in ordered), default=None)

    graph = {
        "job_id": job_id,
        "nodes": [{"camera_id": str(s.get("camera_id")), "t": s.get("started_at")} for s in ordered],
        "edges": [
            {"from": str(ordered[i].get("camera_id")), "to": str(ordered[i + 1].get("camera_id"))}
            for i in range(len(ordered) - 1)
        ],
    }

    Sess = _session_factory()
    with Sess() as session:  # type: Session
        # 1. Resolve / synthesise the Global Person ID.
        if person_id:
            pid = uuid.UUID(str(person_id))
        else:
            person = Person(
                tenant_id=tid, full_name="Unknown", role=PersonRole.UNKNOWN, is_active=True,
            )
            session.add(person)
            session.flush()
            pid = person.id

        # 2. Journey row.
        journey = Journey(
            tenant_id=tid,
            person_id=pid,
            created_by=created_by,
            mode="forensic",
            window_start=_parse_dt(window_start),
            window_end=_parse_dt(window_end),
            first_seen_at=first_seen,
            last_seen_at=last_seen,
            cameras_count=len(cameras),
            confidence=confidence,
            graph=graph,
            video_uri=video_uri,
            report_uri=report_uri,
            status="ready",
        )
        session.add(journey)
        session.flush()
        jid = journey.id

        # 3. One stop per clustered sighting.
        for seq, s in enumerate(ordered):
            st = _parse_dt(s.get("started_at"))
            en = _parse_dt(s.get("ended_at")) or st
            if st is None:
                continue
            session.add(JourneyStop(
                journey_id=jid,
                seq=seq,
                camera_id=uuid.UUID(str(s["camera_id"])),
                started_at=st,
                ended_at=en,
                confidence=float(s.get("best_similarity") or 0.0),
                snapshot_uri=s.get("best_snapshot_uri"),
                detection_count=int(s.get("candidate_count") or 0),
            ))

        session.commit()
        log.info("persisted journey", journey_id=str(jid), person_id=str(pid), stops=len(ordered))
        return jid
