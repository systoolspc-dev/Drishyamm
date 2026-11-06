"""Motion-gate unit tests — the static-scene detector that lets stream_worker
skip YOLO inference when the picture hasn't changed."""
import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from headcount.stream_worker import _downscale_gray, _motion_frac, _MOTION_H, _MOTION_W


def _frame(fill=100, w=640, h=360):
    return np.full((h, w, 3), fill, dtype=np.uint8)


def test_identical_frames_have_zero_motion():
    g = _downscale_gray(_frame())
    assert _motion_frac(g, g) == 0.0


def test_sensor_noise_below_delta_is_not_motion():
    a = _frame(100)
    noise = np.random.default_rng(42).integers(-5, 6, a.shape, dtype=np.int16)
    b = np.clip(a.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    frac = _motion_frac(_downscale_gray(a), _downscale_gray(b))
    assert frac < 0.008  # under the default motion_threshold → skipped


def test_person_sized_change_is_motion():
    a = _frame(100)
    b = a.copy()
    b[80:280, 250:350] = 20  # a dark person-ish region appears
    frac = _motion_frac(_downscale_gray(a), _downscale_gray(b))
    assert frac > 0.008  # over the threshold → inference runs


def test_downscale_shape_is_fixed():
    g = _downscale_gray(_frame(w=1920, h=1080))
    assert g.shape == (_MOTION_H, _MOTION_W)


def test_config_defaults_expose_gate_knobs():
    from headcount.config import PipelineConfig
    p = PipelineConfig()
    assert p.motion_gate is True
    assert 0.0 < p.motion_threshold < 0.05
    assert p.idle_infer_interval > 0
    assert p.torch_threads == 0  # default = leave torch alone


def test_nvr_concurrency_caps():
    """18 cameras behind one NVR took every camera offline (twice). The source
    poller must cap what it starts, per-service AND per-host."""
    from headcount.source import _to_streams
    cams = [{"monitorId": f"m{i}", "name": f"cam{i}", "host": "10.0.0.9",
             "rtspSub": f"rtsp://sv:8554/cam_m{i}_sub",
             "settings": {"headcount": {"enabled": True}}} for i in range(18)]
    out = _to_streams(cams, prefer_sub=True, max_streams=8, max_per_host=4)
    assert len(out) == 4                      # per-host cap binds first
    cams += [{"monitorId": f"o{i}", "name": f"other{i}", "host": f"10.0.1.{i}",
              "rtspSub": f"rtsp://sv:8554/cam_o{i}_sub",
              "settings": {"headcount": {"enabled": True}}} for i in range(10)]
    out = _to_streams(cams, prefer_sub=True, max_streams=8, max_per_host=4)
    assert len(out) == 8                      # service cap binds overall
