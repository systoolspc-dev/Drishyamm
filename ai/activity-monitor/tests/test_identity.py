"""IdentityProvider.resolve() geometry — pure, no redis/network.

Faces are injected directly into the provider's cache (the Redis subscriber is
exercised only in integration). Body boxes are given in pixels; faces in
normalised [0,1] coords, as they'd be after _ingest().
"""
import time

from activity_monitor.identity import IdentityProvider

BODY = [400, 100, 600, 900]  # on a 1000x1000 frame → normalised x 0.4-0.6, y 0.1-0.9


def _prov():
    return IdentityProvider("redis://localhost:6379/0")


def _faces(prov, cam, faces):
    prov._by_camera[cam] = {"ts": time.time(), "faces": faces}


def test_face_in_upper_region_resolves():
    p = _prov()
    _faces(p, "cam", [{"name": "Pranaya", "cx": 0.5, "cy": 0.15}])
    assert p.resolve("cam", BODY, 1000, 1000) == "Pranaya"


def test_face_outside_box_no_match():
    p = _prov()
    _faces(p, "cam", [{"name": "X", "cx": 0.9, "cy": 0.15}])
    assert p.resolve("cam", BODY, 1000, 1000) is None


def test_face_below_head_region_no_match():
    p = _prov()
    _faces(p, "cam", [{"name": "X", "cx": 0.5, "cy": 0.8}])  # near the feet
    assert p.resolve("cam", BODY, 1000, 1000) is None


def test_stale_faces_ignored():
    p = _prov()
    p._by_camera["cam"] = {"ts": time.time() - 100, "faces": [{"name": "X", "cx": 0.5, "cy": 0.15}]}
    assert p.resolve("cam", BODY, 1000, 1000) is None


def test_nearest_center_wins():
    p = _prov()
    _faces(p, "cam", [{"name": "Far", "cx": 0.42, "cy": 0.15},
                      {"name": "Near", "cx": 0.5, "cy": 0.15}])
    assert p.resolve("cam", BODY, 1000, 1000) == "Near"


def test_unknown_camera_returns_none():
    assert _prov().resolve("nope", BODY, 1000, 1000) is None
