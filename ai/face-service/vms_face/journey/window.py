"""Window / duration parsing. ISO timestamps for explicit overrides; shorthand
like '24h', '7d', '30m' for the default window. Ported from person-tracker."""
from __future__ import annotations

import datetime as dt
import re

_SHORTHAND = re.compile(r"^\s*(\d+)\s*([smhdw])\s*$", re.IGNORECASE)
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def parse_duration(s: str) -> dt.timedelta:
    m = _SHORTHAND.match(s)
    if not m:
        raise ValueError(f"unrecognised duration {s!r}; use e.g. '24h', '7d', '30m'")
    return dt.timedelta(seconds=int(m.group(1)) * _UNITS[m.group(2).lower()])


def _parse_iso(s: str) -> dt.datetime:
    # Tolerate the 'Z' suffix that JS Date.toISOString() produces.
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def parse_window_or_default(
    start_str: str | None,
    end_str: str | None,
    default_window: str,
) -> tuple[dt.datetime, dt.datetime]:
    """Returns (start, end), both tz-aware UTC. If neither given, end=now and
    start = end - default_window."""
    end = _parse_iso(end_str) if end_str else dt.datetime.now(dt.timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=dt.timezone.utc)
    if start_str:
        start = _parse_iso(start_str)
        if start.tzinfo is None:
            start = start.replace(tzinfo=dt.timezone.utc)
    else:
        start = end - parse_duration(default_window)
    if start >= end:
        raise ValueError("window_start must be before window_end")
    return start, end
