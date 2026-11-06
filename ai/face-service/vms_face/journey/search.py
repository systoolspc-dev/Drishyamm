"""Cross-camera appearance search against Qdrant `vms_appearance`.

Wraps the shared QdrantStore so the route layer stays infra-free. Unlike the
former person-tracker (which post-filtered time in Python because it only had
the ISO string), vms_appearance carries an indexed `occurred_at_ts` integer, so
the time window is a real Qdrant range filter — far cheaper at scale.

Appearance payload (written by services/face_matcher.append_appearance):
    camera_id, event_id, occurred_at (ISO), occurred_at_ts (epoch s),
    person_id?, track_id?, + optional extras (snapshot_uri when present).
"""
from __future__ import annotations

import datetime as dt
import uuid

from qdrant_client.http.models import FieldCondition, MatchAny, Range

from vms_face.infra.qdrant import QdrantStore


async def query_appearance(
    appearance: QdrantStore,
    *,
    tenant_id: uuid.UUID,
    embedding: list[float],
    window_start: dt.datetime,
    window_end: dt.datetime,
    min_similarity: float,
    camera_ids: list[uuid.UUID] | None,
    top_k: int,
) -> list[dict]:
    """Cosine ANN over vms_appearance, filtered by tenant (in QdrantStore),
    time window, and optional camera subset. Returns candidate dicts shaped for
    journey.contracts.Candidate."""
    extra: list[FieldCondition] = [
        FieldCondition(
            key="occurred_at_ts",
            range=Range(gte=int(window_start.timestamp()), lte=int(window_end.timestamp())),
        )
    ]
    if camera_ids:
        extra.append(
            FieldCondition(key="camera_id", match=MatchAny(any=[str(c) for c in camera_ids]))
        )

    raw = await appearance.search(
        tenant_id=tenant_id,
        vector=embedding,
        top_k=top_k,
        score_threshold=min_similarity,
        extra_must=extra,
    )

    out: list[dict] = []
    for r in raw:
        payload = r.get("payload") or {}
        cam = payload.get("camera_id")
        if cam is None:
            continue
        occurred = _coerce_dt(payload.get("occurred_at"), payload.get("occurred_at_ts"))
        if occurred is None:
            continue
        score = float(r.get("score") or 0.0)
        out.append(
            {
                "appearance_id": r["point_id"],
                "camera_id": uuid.UUID(str(cam)),
                "camera_code": payload.get("camera_code"),
                "camera_name": payload.get("camera_name"),
                # event_id links back to detection_events, which carries the
                # snapshot crop the live pipeline does NOT store in the Qdrant
                # payload — the route resolves it (see _attach_camera_codes).
                "event_id": payload.get("event_id"),
                "track_id": payload.get("track_id"),
                "occurred_at": occurred,
                "similarity": score,
                "snapshot_uri": payload.get("snapshot_uri"),
                "face_similarity": score,
                # Clothing attributes (present once live body-logging is on) — read
                # by journey.body.BodyAttributes.from_payload for colour fusion.
                # These are extra keys; the Candidate model ignores them.
                "upper_color": payload.get("upper_color"),
                "lower_color": payload.get("lower_color"),
                "upper_rgb": payload.get("upper_rgb"),
                "lower_rgb": payload.get("lower_rgb"),
                # OSNet body vector + pose/quality for face+body fusion and
                # pose/quality weighting (present on appearances logged with
                # journey_body_logging on). Stripped before the API response.
                "body_vec": payload.get("body_vec"),
                "yaw": payload.get("yaw"),
                "pitch": payload.get("pitch"),
                "quality_score": payload.get("quality_score"),
            }
        )
    return out


def _coerce_dt(iso: object, ts: object) -> dt.datetime | None:
    if isinstance(ts, (int, float)):
        return dt.datetime.fromtimestamp(float(ts), tz=dt.timezone.utc)
    if isinstance(iso, str):
        try:
            parsed = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
        except ValueError:
            return None
    return None
