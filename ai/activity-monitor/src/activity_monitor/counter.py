"""Rolling-median smoothing for a noisy per-frame count."""

from __future__ import annotations

import statistics
from collections import deque
from threading import Lock


class RollingCounter:
    """Thread-safe median smoother over the last `window` raw counts."""

    def __init__(self, window: int = 5):
        if window < 1:
            raise ValueError("window must be >= 1")
        self._history: deque[int] = deque(maxlen=window)
        self._lock = Lock()

    def update(self, raw: int) -> int:
        """Add a raw count and return the smoothed (median) value."""
        with self._lock:
            self._history.append(int(raw))
            return int(statistics.median(self._history))

    @property
    def value(self) -> int:
        with self._lock:
            return int(statistics.median(self._history)) if self._history else 0

    def reset(self) -> None:
        with self._lock:
            self._history.clear()
