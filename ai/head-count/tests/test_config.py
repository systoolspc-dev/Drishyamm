import pytest

from headcount.config import load_config


BASE = {
    "detectors": [{"id": "heads", "weights": "models/abel/best.pt"}],
    "streams": [{"id": "cam1", "source": 0}],
}


def _write(tmp_path, data):
    import yaml
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(data))
    return p


def test_loads_minimal_config(tmp_path):
    cfg = load_config(_write(tmp_path, BASE))
    assert cfg.streams[0].id == "cam1"
    assert cfg.detectors[0].label == "heads"   # label defaults to id
    assert cfg.api.port == 8000


def test_rejects_duplicate_detector_ids(tmp_path):
    data = dict(BASE, detectors=[
        {"id": "d", "weights": "a.pt"}, {"id": "d", "weights": "b.pt"},
    ])
    with pytest.raises(Exception):
        load_config(_write(tmp_path, data))


def test_requires_at_least_one_detector(tmp_path):
    with pytest.raises(Exception):
        load_config(_write(tmp_path, dict(BASE, detectors=[])))


def test_requires_at_least_one_stream(tmp_path):
    with pytest.raises(Exception):
        load_config(_write(tmp_path, dict(BASE, streams=[])))


def test_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv("HEADCOUNT_API__PORT", "9999")
    cfg = load_config(_write(tmp_path, BASE))
    assert cfg.api.port == 9999


def test_missing_file_raises():
    with pytest.raises(FileNotFoundError):
        load_config("does-not-exist.yaml")
