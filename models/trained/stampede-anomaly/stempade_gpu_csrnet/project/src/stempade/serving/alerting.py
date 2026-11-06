"""Alert sinks + a manager with per-camera cooldown and rising-edge logic.

Alerts fire only on a transition INTO an alarm level (rising edge) and respect a
cooldown, so a sustained CRITICAL doesn't spam operators — the false-alarm-fatigue
failure mode the research warned about.
"""
from __future__ import annotations

import json
import logging
import urllib.request
from dataclasses import dataclass

from ..fusion import RiskLevel

log = logging.getLogger("stempade.alert")


@dataclass
class Alert:
    camera: str
    level: str
    score: float
    time_s: float


class AlertSink:
    def emit(self, alert: Alert) -> None:  # pragma: no cover - interface
        raise NotImplementedError


class LogSink(AlertSink):
    def emit(self, alert: Alert) -> None:
        log.warning("ALERT %s %s score=%.2f t=%.1fs",
                    alert.camera, alert.level, alert.score, alert.time_s)


class WebhookSink(AlertSink):
    """POST the alert as JSON to a webhook (Slack/ops endpoint/etc.)."""

    def __init__(self, url: str, timeout: float = 5.0) -> None:
        self.url, self.timeout = url, timeout

    def emit(self, alert: Alert) -> None:
        payload = json.dumps(alert.__dict__).encode()
        req = urllib.request.Request(self.url, data=payload,
                                     headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=self.timeout)
        except Exception as e:  # never let alerting crash the pipeline
            log.error("webhook failed: %s", e)


class AlertManager:
    def __init__(self, sinks: list[AlertSink] | None = None,
                 min_level: RiskLevel = RiskLevel.HIGH,
                 cooldown_s: float = 30.0) -> None:
        self.sinks = sinks or [LogSink()]
        self.min_level = min_level
        self.cooldown_s = cooldown_s
        self._last_level: dict[str, RiskLevel] = {}
        self._last_fire_s: dict[str, float] = {}

    def consider(self, camera: str, level: RiskLevel, score: float, time_s: float) -> bool:
        prev = self._last_level.get(camera, RiskLevel.NORMAL)
        self._last_level[camera] = level

        rising = level > prev and level >= self.min_level
        cooled = time_s - self._last_fire_s.get(camera, -1e9) >= self.cooldown_s
        if rising and cooled:
            self._last_fire_s[camera] = time_s
            alert = Alert(camera, level.name, score, time_s)
            for s in self.sinks:
                s.emit(alert)
            return True
        return False
