from __future__ import annotations

from enum import StrEnum


class CameraStatus(StrEnum):
    OFFLINE = "offline"
    ONLINE = "online"
    ERROR = "error"
    PAUSED = "paused"


class PersonRole(StrEnum):
    STUDENT = "student"
    STAFF = "staff"
    FACULTY = "faculty"
    VISITOR = "visitor"
    BLACKLIST = "blacklist"
    UNKNOWN = "unknown"


class EventKind(StrEnum):
    DETECTION = "detection"     # face seen, no match yet
    MATCH = "match"             # face matched a known person
    UNKNOWN = "unknown"         # face seen, no match found
    ALERT = "alert"             # blacklist / zone violation
    HEALTH = "health"           # camera health change


class QualityReject(StrEnum):
    TOO_SMALL = "too_small"
    LOW_DET_SCORE = "low_det_score"
    BLURRY = "blurry"
    EXTREME_POSE = "extreme_pose"
    LOW_BRIGHTNESS = "low_brightness"
