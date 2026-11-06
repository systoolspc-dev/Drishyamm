"""Frame source for video files and RTSP streams.

Works for both offline datasets (Phase 1) and live RTSP (Phase 4).
"""
from __future__ import annotations

from typing import Iterator

import cv2
import numpy as np


class FrameSource:
    """Yield frames from a video file or RTSP URL at a target sampling rate.

    Parameters
    ----------
    source : str
        Path to a video file or an ``rtsp://`` URL.
    target_fps : float | None
        Approximate frames-per-second to emit. ``None`` yields every frame.
    resize : tuple[int, int] | None
        Optional ``(width, height)`` to resize each frame to.
    """

    def __init__(
        self,
        source: str,
        target_fps: float | None = None,
        resize: tuple[int, int] | None = None,
    ) -> None:
        self.source = source
        self.target_fps = target_fps
        self.resize = tuple(resize) if resize else None

    def __iter__(self) -> Iterator[np.ndarray]:
        cap = cv2.VideoCapture(self.source)
        if not cap.isOpened():
            raise RuntimeError(f"Could not open source: {self.source}")

        src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        stride = 1
        if self.target_fps and src_fps > self.target_fps:
            stride = max(1, round(src_fps / self.target_fps))

        idx = 0
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if idx % stride == 0:
                    if self.resize:
                        frame = cv2.resize(frame, self.resize)
                    yield frame
                idx += 1
        finally:
            cap.release()
