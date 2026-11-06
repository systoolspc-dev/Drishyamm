"""Phase 3-5 tests: scoring, pipeline end-to-end, learned fusion, alerting, eval."""
import os
import tempfile

import numpy as np
import pytest

from stempade.config import load_config
from stempade.fusion import RiskLevel, Scorer
from stempade.fusion.learned import LearnedFuser
from stempade.serving.alerting import AlertManager


def _write_video(path, n=30, w=160, h=120, accelerate_at=15):
    """A field of dots milling slowly, then rushing fast in one direction (panic)."""
    import cv2

    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), 15, (w, h))
    if not vw.isOpened():
        pytest.skip("no MJPG VideoWriter available")
    rng = np.random.default_rng(0)
    pts = rng.uniform([10, 10], [w - 10, h - 10], size=(30, 2))
    for t in range(n):
        frame = np.zeros((h, w, 3), np.uint8)
        if t < accelerate_at:
            pts += rng.normal(0, 0.5, size=pts.shape)   # slow milling
        else:
            pts[:, 0] += 6.0                             # sustained rush to the right
            pts += rng.normal(0, 0.5, size=pts.shape)
        pts[:, 0] %= w
        pts[:, 1] = np.clip(pts[:, 1], 3, h - 3)
        for x, y in pts:
            cv2.circle(frame, (int(x), int(y)), 3, (255, 255, 255), -1)
        vw.write(frame)
    vw.release()


def test_scorer_sub_scores_in_range():
    s = Scorer()
    feats = {"speed": 5.0, "acceleration": 3.0, "convergence": 0.3,
             "kinetic_energy": 20.0, "angular_entropy": 0.9, "order_parameter": 0.2}
    subs = s.sub_scores(feats)
    assert 0.0 <= subs["motion"] <= 1.0
    assert "rules" in subs


def test_pipeline_runs_end_to_end():
    with tempfile.TemporaryDirectory() as d:
        vid = os.path.join(d, "clip.avi")
        _write_video(vid)
        cfg = load_config()
        cfg["ingestion"]["resize"] = [160, 120]
        cfg["ingestion"]["target_fps"] = 15
        from stempade.pipeline import StampedePipeline
        states = list(StampedePipeline(cfg).run(vid))
        assert len(states) > 10
        # motion sub-score should be higher during the panic rush than while milling
        early = np.mean([s.sub_scores.get("motion", 0) for s in states[3:12]])
        late = np.mean([s.sub_scores.get("motion", 0) for s in states[-8:]])
        assert late > early


def test_learned_fuser_roundtrip():
    rows = [{"motion": 0.1, "rules": 0.0}] * 20 + [{"motion": 0.9, "rules": 0.5}] * 20
    labels = [0] * 20 + [1] * 20
    fuser = LearnedFuser.fit(rows, labels)
    assert fuser.combine({"motion": 0.9, "rules": 0.5}) > fuser.combine({"motion": 0.1})
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "f.joblib")
        fuser.save(p)
        reloaded = LearnedFuser.load(p)
        assert abs(reloaded.combine({"motion": 0.9}) - fuser.combine({"motion": 0.9})) < 1e-9


def test_alert_manager_rising_edge_and_cooldown():
    fired = []
    mgr = AlertManager(sinks=[], min_level=RiskLevel.HIGH, cooldown_s=10.0)
    mgr.sinks = [type("S", (), {"emit": lambda self, a: fired.append(a)})()]
    # rising into HIGH fires once
    assert mgr.consider("cam0", RiskLevel.HIGH, 0.7, time_s=1.0) is True
    # staying HIGH does not re-fire
    assert mgr.consider("cam0", RiskLevel.HIGH, 0.7, time_s=2.0) is False
    # dropping then rising again within cooldown does not fire
    mgr.consider("cam0", RiskLevel.NORMAL, 0.1, time_s=3.0)
    assert mgr.consider("cam0", RiskLevel.CRITICAL, 0.9, time_s=5.0) is False
    # after cooldown it fires
    mgr.consider("cam0", RiskLevel.NORMAL, 0.1, time_s=16.0)
    assert mgr.consider("cam0", RiskLevel.CRITICAL, 0.9, time_s=20.0) is True
    assert len(fired) == 2
