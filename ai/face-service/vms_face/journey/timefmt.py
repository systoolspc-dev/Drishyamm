"""Local-time formatting for human-readable timestamps baked server-side.

Storage stays UTC everywhere (occurred_at, recording lookup). This formats a
UTC datetime/ISO string into settings.display_timezone for the video overlay,
the PDF report, and any other server-rendered label. The frontend localises its
own ISO timestamps in the browser; this is only for server-baked surfaces."""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from vms_face.config import settings


def _display_tz() -> dt.tzinfo:
    try:
        return ZoneInfo(settings.display_timezone)
    except Exception:
        return dt.timezone.utc


def fmt_local(value: dt.datetime | str | None, fmt: str = "%Y-%m-%d %I:%M:%S %p %Z") -> str:
    """UTC datetime/ISO → string in the configured display timezone. Returns ''
    for None and echoes unparseable input unchanged."""
    if value is None:
        return ""
    if isinstance(value, str):
        try:
            value = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(_display_tz()).strftime(fmt)
