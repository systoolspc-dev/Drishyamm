"""rehearsal.py T12: the camera side of a plate (docs/govt/API.md §3, §7.4).

A dry check of the parsing only: it never reaches a backend. The rehearsal
itself runs against the live stack, which is main until the government
gateway is merged — do not point it at the worktree.

Run from the anpr_worker folder:  python -m pytest tests/test_rehearsal_t12.py -q
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import rehearsal  # noqa: E402

LISTED = {
    "plate": "GJ01AB1234",
    "record": None,
    "registry": "ask",
    "hotlist": {"onList": True, "category": "stolen", "provenance": "representative",
                "words": "On the representative stolen list (eGujCop, as of 10:02)."},
    "hotlist_state": {"state": "live", "codes": [], "words": "Lists are current."},
    "class_check": {"ok": True, "known": False},
}


def test_listed_plate_passes_and_says_the_list_in_words():
    ok, lines, detail = rehearsal.camera_side_check(200, LISTED)
    assert ok is True
    assert lines[0] == "Hot lists: On the representative stolen list (eGujCop, as of 10:02)."
    assert lines[1] == rehearsal.REGISTRY_ASK and "purpose bar" in lines[1]
    assert "record null" in detail


def test_no_list_loaded_passes_but_is_never_read_as_clean():
    j = {**LISTED, "hotlist": None,
         "hotlist_state": {"state": "empty", "codes": ["GOVT_W_HOTLIST_EMPTY"], "words": "No government lists loaded yet."}}
    ok, lines, detail = rehearsal.camera_side_check(200, j)
    assert ok is True
    assert lines[0] == "Hot lists: No government lists loaded yet. — not a clean result."
    assert "hotlist_state empty" in detail
    # words as a list (the status route's shape) are joined
    j["hotlist_state"]["words"] = ["Using the saved list.", "Gateway unreachable."]
    assert rehearsal.camera_side_check(200, j)[1][0].startswith("Hot lists: Using the saved list. Gateway unreachable.")


def test_a_registry_record_is_a_fail():
    j = {**LISTED, "record": {"owner_name": "R. P."}, "registry": "vahan"}
    ok, lines, detail = rehearsal.camera_side_check(200, j)
    assert ok is False
    assert "registry record came back" in detail and "not 'ask'" in detail
    assert any(line.startswith("PROBLEM:") for line in lines)


def test_neither_hotlist_nor_state_is_a_fail():
    ok, _, detail = rehearsal.camera_side_check(200, {"record": None, "registry": "ask"})
    assert ok is False and "neither a hotlist block nor a hotlist_state" in detail


def test_http_errors_are_a_fail_with_the_status():
    for status, body in ((410, {"code": "GOVT_E_ROUTE_RETIRED"}), (404, None), (502, "<html>")):
        ok, lines, detail = rehearsal.camera_side_check(status, body)
        assert ok is False and detail == f"HTTP {status}" and str(status) in lines[0]


def test_the_call_is_a_post_with_the_plate_in_the_body():
    sent = {}

    class R:
        status_code = 200

        @staticmethod
        def json():
            return LISTED

    class FakeApi:
        def post(self, path, body=None, **params):
            sent.update(path=path, body=body, params=params)
            return R()

        def get(self, *a, **k):  # the old GET must not be used
            raise AssertionError("GET used for the camera side")

    ok, _, _ = rehearsal.camera_side(FakeApi(), "GJ01AB1234")
    assert ok is True
    assert sent == {"path": "/api/ai/anpr/vehicle", "body": {"plate": "GJ01AB1234"}, "params": {}}
    assert "GJ01AB1234" not in sent["path"]
