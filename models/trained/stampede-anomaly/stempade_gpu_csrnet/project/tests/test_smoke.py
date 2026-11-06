"""Phase 0 smoke tests — verify the scaffold imports and core logic runs."""
import numpy as np

from stempade.config import load_config
from stempade.motion import farneback_flow, motion_features
from stempade.fusion import RiskFuser, RiskLevel


def test_config_loads():
    cfg = load_config()
    assert "fusion" in cfg and "motion" in cfg


def test_motion_features_on_synthetic_flow():
    # uniform rightward flow -> nonzero speed, ~zero divergence
    flow = np.zeros((32, 32, 2), dtype=np.float32)
    flow[..., 0] = 1.0
    feats = motion_features(flow, prev_speed=0.0)
    assert feats["speed"] > 0.9
    assert feats["acceleration"] > 0.9  # 0 -> ~1
    assert feats["divergence"] < 1e-5


def test_farneback_runs_on_two_frames():
    a = np.zeros((64, 64), dtype=np.uint8)
    b = np.zeros((64, 64), dtype=np.uint8)
    b[:, 5:] = a[:, :-5]  # shift
    flow = farneback_flow(a, b)
    assert flow.shape == (64, 64, 2)


def test_risk_fuser_persistence_gates_alarms():
    fuser = RiskFuser(
        weights={"motion": 0.5, "density": 0.5},
        thresholds={"moderate": 0.35, "high": 0.60, "critical": 0.80},
        persistence_frames=3,
    )
    # a single high frame should NOT trip the alarm (not yet sustained)
    _, level = fuser.update({"motion": 0.9, "density": 0.9})
    assert level == RiskLevel.NORMAL
    # sustained high across the window -> emitted
    fuser.update({"motion": 0.9, "density": 0.9})
    _, level = fuser.update({"motion": 0.9, "density": 0.9})
    assert level == RiskLevel.CRITICAL
