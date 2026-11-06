"""Background worker: runs the pipeline on one stream in a thread.

Keeps the latest RiskState available for the API and forwards level changes to the
AlertManager. One worker per camera.
"""
from __future__ import annotations

import threading
import time
from dataclasses import asdict

from ..pipeline import StampedePipeline, RiskState
from ..fusion import RiskLevel
from .alerting import AlertManager


class StreamWorker(threading.Thread):
    def __init__(self, name: str, source: str, config: dict,
                 alert_manager: AlertManager,
                 baseline=None, homography=None, reconnect_s: float = 5.0) -> None:
        super().__init__(daemon=True)
        self.camera = name
        self.source = source
        self.config = config
        self.alerts = alert_manager
        self.baseline = baseline
        self.homography = homography
        self.reconnect_s = reconnect_s
        self._stop = threading.Event()
        self.latest: RiskState | None = None

    def stop(self) -> None:
        self._stop.set()

    def status(self) -> dict:
        st = self.latest
        if st is None:
            return {"camera": self.camera, "level": "STARTING", "score": 0.0}
        d = {"camera": self.camera, "level": st.level.name, "score": round(st.score, 3),
             "time_s": round(st.time_s, 1), "people_per_m2": st.people_per_m2,
             "sub_scores": {k: round(v, 3) for k, v in st.sub_scores.items()}}
        return d

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                pipe = StampedePipeline(self.config, baseline=self.baseline,
                                        homography=self.homography)
                for st in pipe.run(self.source):
                    if self._stop.is_set():
                        return
                    self.latest = st
                    self.alerts.consider(self.camera, st.level, st.score, st.time_s)
            except Exception:
                if self._stop.is_set():
                    return
            # stream ended or errored — wait then reconnect (live RTSP)
            time.sleep(self.reconnect_s)
