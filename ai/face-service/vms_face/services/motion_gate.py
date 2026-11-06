"""Motion-zone gating (DETECTION_STRATEGY.md Phase E.3).

Runs a ~0.2 ms CPU frame-difference check before the SCRFD call and skips
the detect entirely when nothing in the scene changed. On a quiet camera
(empty corridor at night, parking lot between cars) this eliminates the
large majority of detect GPU — the single cheapest compute lever in the
whole pipeline, with zero recall cost when the safety rules below hold.

Safety rules (why this can't lose a face):

  1. Never skip while the tracker has live tracks. A person standing
     perfectly still keeps their track alive through detects, so we only
     gate scenes that are already empty.
  2. Never skip more than `motion_gate_max_skip_frames` in a row. Even if
     the difference check somehow misses sub-threshold motion (someone
     crawling in at 1 px/frame), a full detect runs every ~2 s.
  3. Any measured motion re-enables detection immediately — the check runs
     on every frame, so first-detect latency after motion starts is one
     frame, not one gate interval.

The check: downscale to `motion_gate_downscale_width` grayscale, absdiff
against the previous downscaled frame, count pixels whose delta exceeds
`motion_gate_pixel_delta`, compare the changed fraction to
`motion_gate_min_changed_frac`. Deliberately simpler than MOG2 background
subtraction — no model to warm up, no parameters that rot when lighting
changes slowly (gradual change never exceeds the per-frame delta).
"""
from __future__ import annotations

import cv2
import numpy as np

from vms_face.config import settings


class MotionGate:
    """Per-camera stateful gate. Call `should_detect(frame, active_tracks)`
    once per frame BEFORE the detector; it updates its own reference frame
    either way. Not thread-safe — owned by one orchestrator, called from
    its loop only."""

    __slots__ = ("_prev_small", "_skipped_in_a_row")

    def __init__(self) -> None:
        self._prev_small: np.ndarray | None = None
        self._skipped_in_a_row = 0

    def should_detect(self, frame_bgr: np.ndarray, active_tracks: int) -> bool:
        small = self._downscale(frame_bgr)
        prev = self._prev_small
        self._prev_small = small

        # First frame after (re)open — no reference yet, must detect.
        if prev is None or prev.shape != small.shape:
            self._skipped_in_a_row = 0
            return True

        # Rule 1: live tracks pin the detector on.
        if active_tracks > 0:
            self._skipped_in_a_row = 0
            return True

        # Rule 2: hard ceiling on consecutive skips.
        if self._skipped_in_a_row >= max(1, int(settings.motion_gate_max_skip_frames)):
            self._skipped_in_a_row = 0
            return True

        # Rule 3: measured motion triggers an immediate detect.
        delta = cv2.absdiff(small, prev)
        changed = int(np.count_nonzero(delta > int(settings.motion_gate_pixel_delta)))
        frac = changed / float(delta.size)
        if frac >= float(settings.motion_gate_min_changed_frac):
            self._skipped_in_a_row = 0
            return True

        self._skipped_in_a_row += 1
        return False

    @staticmethod
    def _downscale(frame_bgr: np.ndarray) -> np.ndarray:
        h, w = frame_bgr.shape[:2]
        target_w = max(32, int(settings.motion_gate_downscale_width))
        scale = target_w / max(1, w)
        target_h = max(18, int(round(h * scale)))
        small = cv2.resize(frame_bgr, (target_w, target_h), interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
