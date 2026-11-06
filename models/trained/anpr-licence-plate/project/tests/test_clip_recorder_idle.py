"""ClipRecorder idle capture: an idle scene is captured slower, never stopped."""

import numpy as np

from clip_recorder import ClipRecorder

FRAME = np.zeros((90, 160, 3), np.uint8)


def _push_for(rec: ClipRecorder, seconds: float, idle: bool, t0: float = 1000.0, step: float = 0.04) -> int:
    """Feed frames at 25 fps for `seconds`; return how many were buffered."""
    before = len(rec._buf)
    n = int(round(seconds / step))
    for i in range(n):
        rec.push(FRAME, t0 + i * step, idle=idle)
    return len(rec._buf) - before


def test_busy_scene_captures_at_full_rate():
    rec = ClipRecorder(fps=5, idle_fps=1)
    assert _push_for(rec, 10, idle=False) == 50
    assert rec.idle_skipped == 0


def test_idle_scene_is_slowed_not_stopped():
    rec = ClipRecorder(fps=5, idle_fps=1)
    got = _push_for(rec, 10, idle=True)
    assert 9 <= got <= 11  # ~1 fps: pre-roll footage still exists
    assert rec.idle_skipped > 0


def test_idle_disabled_keeps_old_behaviour():
    rec = ClipRecorder(fps=5)  # idle_fps defaults to 0
    assert _push_for(rec, 10, idle=True) == 50


def test_pending_clip_keeps_full_rate_while_idle():
    rec = ClipRecorder(fps=5, idle_fps=1, post_sec=4)
    rec._pending.append({"t0": 2000.0})  # a clip still collecting its post-roll
    assert _push_for(rec, 2, idle=True) == 10


def test_back_to_full_rate_when_motion_returns():
    rec = ClipRecorder(fps=5, idle_fps=1)
    _push_for(rec, 5, idle=True)
    assert _push_for(rec, 2, idle=False, t0=1005.0) == 10
