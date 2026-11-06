"""End-to-end smoke test WITHOUT real data, models, or a GPU.

Validates that the whole chain wires together correctly:
  synthetic keypoints -> features -> windows -> model forward -> engine state
  machine -> a FALL event fires on a simulated stand->fall->stay-down sequence.

Run:  ./venv/bin/python -m tests.smoke_test
"""
from __future__ import annotations
import numpy as np
import torch

import config
from src.features.normalize import extract_features, is_horizontal, N_FEATURES
from src.features.windows import make_windows
from src.model.model import build_model
from src.engine.detector import FallEngine
from src.pose.base import TrackedPose


def _standing_kps():
    """A crude upright skeleton (y grows downward)."""
    kps = np.zeros((17, 3), dtype=np.float32)
    kps[:, 2] = 0.9
    # nose top, shoulders, hips, knees, ankles going DOWN the frame
    ys = {config.KP["nose"]: 0.15, config.KP["left_shoulder"]: 0.30,
          config.KP["right_shoulder"]: 0.30, config.KP["left_hip"]: 0.55,
          config.KP["right_hip"]: 0.55, config.KP["left_knee"]: 0.75,
          config.KP["right_knee"]: 0.75, config.KP["left_ankle"]: 0.95,
          config.KP["right_ankle"]: 0.95}
    for i, y in ys.items():
        kps[i, 0] = y
        kps[i, 1] = 0.50 + (0.03 if "right" in
                            [k for k, v in config.KP.items() if v == i][0] else -0.03)
    return kps


def _lying_kps():
    """A crude horizontal skeleton: body spread along x, all near same y."""
    kps = np.zeros((17, 3), dtype=np.float32)
    kps[:, 2] = 0.9
    xs = {config.KP["nose"]: 0.20, config.KP["left_shoulder"]: 0.35,
          config.KP["right_shoulder"]: 0.35, config.KP["left_hip"]: 0.60,
          config.KP["right_hip"]: 0.60, config.KP["left_knee"]: 0.78,
          config.KP["right_knee"]: 0.78, config.KP["left_ankle"]: 0.92,
          config.KP["right_ankle"]: 0.92}
    for i, x in xs.items():
        kps[i, 1] = x
        kps[i, 0] = 0.85   # all low in the frame, same height -> horizontal
    return kps


def test_features_and_posture():
    f_stand = extract_features(_standing_kps())
    f_lie = extract_features(_lying_kps())
    assert f_stand.shape == (N_FEATURES,), f_stand.shape
    assert not is_horizontal(_standing_kps()), "standing misread as horizontal"
    assert is_horizontal(_lying_kps()), "lying misread as upright"
    print("  posture + feature extraction OK")


def test_windows():
    feats = np.stack([extract_features(_standing_kps()) for _ in range(50)])
    labels = np.zeros(50); labels[30:] = 1
    w, wl = make_windows(feats, labels)
    assert w.shape[1:] == (config.WINDOW_SIZE, N_FEATURES), w.shape
    assert wl.max() == 1 and wl.min() == 0
    print(f"  windowing OK  ({w.shape[0]} windows of {w.shape[1]}x{w.shape[2]})")


def test_model_forward():
    m = build_model(N_FEATURES).eval()
    x = torch.randn(4, config.WINDOW_SIZE, N_FEATURES)
    with torch.no_grad():
        out = m(x)
    assert out.shape == (4,), out.shape
    print("  model forward OK")


def test_engine_state_machine(tmp_model="/tmp/_smoke_fall.pt"):
    # a model that outputs a big positive logit when the window looks horizontal.
    # we fake it by training-free weight: just save an untrained model and
    # monkey-patch its classify to react to posture, so we test the STATE MACHINE.
    m = build_model(N_FEATURES)
    torch.save({"state_dict": m.state_dict(), "n_features": N_FEATURES}, tmp_model)
    engine = FallEngine(tmp_model, device="cpu")

    # force the classifier to report "fall-ish" whenever the person is horizontal
    def fake_classify(ts):
        if len(ts.window) < config.WINDOW_SIZE:
            return 0.0
        last = ts.window[-1]
        # feature[36] is aspect ratio; >1 => lying
        return 0.9 if last[36] > 1.0 else 0.1
    engine._classify = fake_classify

    fps = config.TARGET_FPS
    fired = []
    # 2s standing, then fall and stay down for 4s
    for k in range(int(6 * fps)):
        t = k / fps
        kps = _standing_kps() if t < 2.0 else _lying_kps()
        pose = TrackedPose(track_id=7, keypoints=kps,
                           bbox=np.array([0.3, 0.3, 0.7, 0.9], np.float32), score=0.9)
        _, events = engine.process([pose], t)
        fired += events
    assert fired, "engine never fired a FALL on a clear fall+stay-down sequence"
    assert fired[0].track_id == 7
    print(f"  engine state machine OK  (FALL fired at t={fired[0].time_sec:.1f}s)")


if __name__ == "__main__":
    print("running smoke test...")
    test_features_and_posture()
    test_windows()
    test_model_forward()
    test_engine_state_machine()
    print("ALL SMOKE TESTS PASSED ✔")
