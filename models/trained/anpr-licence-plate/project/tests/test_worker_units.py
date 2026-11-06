"""worker.py units that need no model, backend or camera: the scene / crop
helpers, the decal filter, model fingerprints, the burn-in displacement rule
and the tier decision (superstring switch, short-plate hold, single-read
possible rule, the 0.9 agreement gate) on a stub CameraWorker."""

import hashlib
import json
import os
import threading
import time
from collections import Counter, deque
from types import SimpleNamespace as NS

import cv2
import numpy as np
import pytest

import model_registry
import worker
from plate_votes import Read, TrackVotes


# ── import + config ──────────────────────────────────────────────────────────
def test_worker_imports_without_models():
    assert worker.DRY_RUN is True
    assert worker.PIPELINE_VERSION == "bytetrack-enhance-v5"
    # code defaults (conftest cleared the container's ANPR_* environment)
    assert worker.MIN_AGREEMENT == 0.9 and worker.MIN_AGREEMENT_SHORT == 0.95
    assert worker.LEN_SWITCH is True and worker.LEN_SWITCH_RATIO == 0.05
    assert worker.SHORT_CONFIRM_READERS_AGREE == 0.9 and worker.SHORT_CONFIRM_MIN_WEIGHT == 0.6
    assert worker.POSSIBLE_SINGLE_STRICT is True and worker.POSSIBLE_SINGLE_MIN_AGREE == 0.95
    assert worker.POSSIBLE_SINGLE_MIN_CONF == 0.8 and worker.POSSIBLE_SINGLE_MIN_WEIGHT == 0.3
    assert worker.STATIC_MAX_MOVE_FRAC == 0.5
    for slot in ("tid", "first_centre", "length_fix", "enh_ms", "ocr_ms", "t_first_read"):
        assert slot in worker.TrackState.__slots__


# ── night gamma ──────────────────────────────────────────────────────────────
def test_night_gamma_bounds_and_monotone():
    assert worker.night_gamma(0) == 0.4 and worker.night_gamma(-5) == 0.4
    assert worker.night_gamma(127.5) == pytest.approx(1.0)
    assert worker.night_gamma(300) == 1.0
    vals = [worker.night_gamma(x) for x in range(1, 255, 3)]
    assert all(0.4 <= v <= 1.0 for v in vals)
    assert vals == sorted(vals)  # darker scene → stronger (smaller) gamma, never brightens a lit one


# ── crop quality ─────────────────────────────────────────────────────────────
def _assess(sharpness=400.0, motion_len=0.0, has_motion=False, sat_frac=0.0):
    return NS(sharpness=sharpness, motion_len=motion_len, has_motion=has_motion, sat_frac=sat_frac)


def test_crop_quality_monotone():
    q = worker.crop_quality
    assert q(_assess(sharpness=100), 80) < q(_assess(sharpness=800), 80)  # sharper is better
    assert q(_assess(), 40) < q(_assess(), 120)  # bigger is better
    assert q(_assess(motion_len=8, has_motion=True), 80) < q(_assess(), 80)  # motion blur hurts
    assert q(_assess(sat_frac=0.3), 80) < q(_assess(), 80)  # glare hurts
    assert q(_assess(sharpness=0), 1) >= 0.02  # floor
    assert q(_assess(sharpness=5000), 500) <= 1.0  # ceiling


# ── decal filter ─────────────────────────────────────────────────────────────
def _text_crop(color, bg=(255, 255, 255)):
    img = np.full((48, 180, 3), bg, np.uint8)
    cv2.putText(img, "GJ01AB1234", (4, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, 2, cv2.LINE_AA)
    return img


def test_looks_decal_red_text_yes_black_text_no():
    assert worker._looks_decal(_text_crop((0, 0, 190))) is True  # red lettering: a decal
    assert worker._looks_decal(_text_crop((0, 0, 0))) is False  # black on white: a plate
    assert (
        worker._looks_decal(_text_crop((0, 0, 0), bg=(0, 220, 255))) is False
    )  # black on yellow: commercial plate
    assert worker._looks_decal(_text_crop((255, 255, 0), bg=(40, 40, 40))) is True  # cyan OSD caption
    assert worker._looks_decal(np.zeros((4, 4, 3), np.uint8)) is False  # too small: never a hit
    assert worker._looks_decal(None) is False


# ── model registry ───────────────────────────────────────────────────────────
def test_file_fingerprint(tmp_path):
    p = tmp_path / "w.bin"
    p.write_bytes(b"trinetra-anpr")
    fp = model_registry.file_fingerprint(str(p))
    assert fp == {
        "file": "w.bin",
        "bytes": 13,
        "sha256_12": hashlib.sha256(b"trinetra-anpr").hexdigest()[:12],
    }
    assert model_registry.file_fingerprint(str(p)) == fp  # cached by (path, mtime, size)
    assert model_registry.file_fingerprint(str(tmp_path / "missing")) is None
    assert model_registry.file_fingerprint(None) is None
    p.write_bytes(b"trinetra-anpr!!")  # a retrained file → new hash
    fp2 = model_registry.file_fingerprint(str(p))
    assert fp2["bytes"] == 15 and fp2["sha256_12"] != fp["sha256_12"]


def test_describe_models_filters_registry_to_models_in_use(tmp_path):
    (tmp_path / "v.pt").write_bytes(b"v")
    (tmp_path / "p.pt").write_bytes(b"p")
    reg = {
        "schema": 1,
        "models": {
            "v.pt": {"file": "models/v.pt", "version": "a"},
            "p.pt": {"file": "models/p.pt", "version": "b"},
            "unused.pt": {"file": "models/unused.pt", "version": "c"},
            "cct-s-v2-global-model": {"version": "d"},
        },
    }
    (tmp_path / "reg.json").write_text(json.dumps(reg))
    v = model_registry.describe_models(
        str(tmp_path / "v.pt"),
        str(tmp_path / "p.pt"),
        "cct-s-v2-global-model + cct-xs-v2-global-model",
        str(tmp_path / "cal.json"),
        str(tmp_path / "reg.json"),
        ocr_dir=str(tmp_path / "ocr"),
        hub_dir=str(tmp_path / "hub"),
    )
    assert set(v["registry"]) == {"v.pt", "p.pt", "cct-s-v2-global-model"}
    assert v["vehicle"]["file"] == "v.pt" and v["plate"]["file"] == "p.pt"
    assert v["calibrator"] is None and v["ocr"]["model_onnx"] is None and v["ocr"]["hub"] == {}
    c = model_registry.compact(v)
    assert c["registry"] == {"v.pt": "a", "p.pt": "b", "cct-s-v2-global-model": "d"}
    assert c["vehicle"]["sha256_12"] == hashlib.sha256(b"v").hexdigest()[:12]
    assert "readers" in c["ocr"] and "custom_dir" not in c["ocr"]  # compact: fingerprints, no paths / prose
    assert model_registry.compact(None) is None
    assert "vehicle v.pt@" in model_registry.summary_line(
        v
    ) and "registry 3 entries" in model_registry.summary_line(v)
    # a missing registry file is not an error
    v2 = model_registry.describe_models(
        str(tmp_path / "v.pt"),
        str(tmp_path / "p.pt"),
        "x",
        None,
        str(tmp_path / "nope.json"),
        ocr_dir=str(tmp_path),
        hub_dir=str(tmp_path),
    )
    assert v2["registry"] == {} and v2["calibrator"] is None


# ── burn-in: moving tracks are never evidence ────────────────────────────────
def test_moved_through():
    m = worker._moved_through
    assert m((100, 100), (100, 100), 60, 0.5) is False
    assert m((100, 100), (120, 100), 60, 0.5) is False  # 20 px ≤ 0.5 × 60
    assert m((100, 100), (150, 100), 60, 0.5) is True  # 50 px > 30
    assert m((100, 100), (100, 140), 60, 0.5) is True
    assert m(None, (100, 100), 60, 0.5) is False
    assert m((100, 100), None, 60, 0.5) is False
    assert m((100, 100), (500, 500), 60, 0.0) is False  # disabled


def _cam_worker():
    """A CameraWorker with only the attributes the decision / burn-in paths
    touch — no thread, no source, no models."""
    w = worker.CameraWorker.__new__(worker.CameraWorker)
    threading.Thread.__init__(w, name="test_cam", daemon=True)  # the Thread base only — never started
    w.cam = {"monitorId": "test_cam", "name": "test", "latitude": None, "longitude": None}
    w.models = NS(
        calibrator=None,
        has_auto=False,
        versions={},
        ocr=NS(name="stub-r0 + stub-r1", readers=[object(), object()], gray=True),
    )
    w.backend = None
    w.rec = None
    w._src_w = None
    w.stats = dict(
        static_skipped_moving=0,
        static_zones=0,
        posted=0,
        posted_possible=0,
        posted_lenfix=0,
        posted_night=0,
        verify_held=0,
    )
    w._plate_hist = deque(maxlen=300)
    w._static_zones = []
    w.max_reads = worker.MAX_READS
    w.night, w.ir, w.scene_lum = False, False, 120.0
    w.code_hist = Counter()
    w._last_post = {}
    return w


def _state(**kw) -> worker.TrackState:
    st = worker.TrackState(0, "car", uid=1, now=1000.0, tid=7)
    for k, v in kw.items():
        setattr(st, k, v)
    return st


def _votes(frames: int, text: str, weight: float = 0.9, p: float = 0.9) -> TrackVotes:
    tv = TrackVotes()
    for i in range(frames):
        tv.add_frame(i, [Read(text, [p] * len(text), weight, "base", valid=True, corrected=text)])
    return tv


def test_remember_box_skips_a_track_that_moved(monkeypatch):
    w = _cam_worker()
    moving = _state(best_bbox=[100, 100, 160, 120], first_centre=(130.0, 110.0), last_centre=(300.0, 110.0))
    w._remember_box(moving, now=2000.0)
    assert w.stats["static_skipped_moving"] == 1 and len(w._plate_hist) == 0
    still = _state(best_bbox=[100, 100, 160, 120], first_centre=(130.0, 110.0), last_centre=(140.0, 112.0))
    w._remember_box(still, now=2000.0)
    assert w.stats["static_skipped_moving"] == 1 and len(w._plate_hist) == 1
    monkeypatch.setattr(worker, "STATIC_MAX_MOVE_FRAC", 0.0)  # knob off → the old behaviour
    w._remember_box(moving, now=2000.0)
    assert len(w._plate_hist) == 2


def test_looping_feed_creates_no_zone_but_a_caption_still_does():
    def track(uid, t0, first, last):
        st = worker.TrackState(0, "car", uid=uid, now=t0, tid=uid)
        st.votes = _votes(2, "GJ01AB1234")
        st.best_bbox = [100, 100, 160, 120]
        st.first_centre, st.last_centre = first, last
        return st

    # the same vehicle driving through the same pixels every loop: 3 tracks over 355 s, same read
    w = _cam_worker()
    for uid, t0 in ((1, 1000.0), (2, 1150.0), (3, 1350.0)):
        w._remember_box(track(uid, t0, (60.0, 110.0), (130.0, 110.0)), now=t0 + 5)
    assert w._static_zones == [] and w.stats["static_zones"] == 0 and w.stats["static_skipped_moving"] == 3
    # a burn-in caption sits still: the existing rule still arms a zone
    w = _cam_worker()
    for uid, t0 in ((1, 1000.0), (2, 1150.0), (3, 1350.0)):
        w._remember_box(track(uid, t0, (130.0, 110.0), (131.0, 110.0)), now=t0 + 5)
    assert (
        len(w._static_zones) == 1
        and w._static_zones[0]["text"] == "GJ01AB1234"
        and w.stats["static_zones"] == 1
    )


# ── the tier decision ────────────────────────────────────────────────────────
def _capture(w):
    posted = []

    def fake_post(plate, st, cons, conf=None, feats=None, source="heuristic", tier="confirmed"):
        posted.append({"plate": plate, "tier": tier, "feats": feats, "conf": conf, "source": source})

    w._post = fake_post
    return posted


def _superstring_state(alt_weight: float, raw: str = "GJ11CI758") -> worker.TrackState:
    """Three frames of the 9-char read, one of the valid 10-char read. `raw` is the
    OCR's own output for the short read; the rules correct it to GJ11C1758. The
    default (an 'I' in a digit slot) is NOT format-valid, so the superstring rule
    may switch; a format-valid raw short read is kept (4 Oct 2026 measurement)."""
    st = _state()
    st.votes = TrackVotes()
    for i in range(3):
        st.votes.add_frame(i, [Read(raw, [0.95] * 9, 0.8, "base", valid=True, corrected="GJ11C1758")])
    st.votes.add_frame(
        3, [Read("GJ11CL7580", [0.95] * 10, alt_weight, "base", valid=True, corrected="GJ11CL7580")]
    )
    st.det_confs, st.qualities, st.reader_agree = [0.8] * 4, [0.6] * 4, [1.0] * 4
    return st


def test_length_fix_switches_to_the_valid_superstring():
    w = _cam_worker()
    posted = _capture(w)
    st = _superstring_state(0.43)
    assert w._decide(st, expiring=False) is True
    assert posted[0]["plate"] == "GJ11CL7580" and posted[0]["tier"] == "confirmed"
    assert st.length_fix["from"] == "GJ11C1758" and st.length_fix["to"] == "GJ11CL7580"
    assert st.length_fix["alt_weight"] == 0.43 and st.length_fix["bucket_weight"] == 2.4
    assert st.length_fix["ratio"] == pytest.approx(0.43 / 2.4, abs=1e-3)


def test_length_fix_only_when_raw_read_is_not_format_valid():
    # a format-valid SHORT raw read (single-letter series) is kept: the longer read
    # would insert a letter (measured 4 Oct 2026: 8 of 8 such switches were wrong)
    w = _cam_worker()
    posted = _capture(w)
    st = _superstring_state(0.43, raw="GJ11C1758")
    assert w._decide(st, expiring=True) is True
    assert posted[0]["plate"] == "GJ11C1758" and st.length_fix is None
    # a raw read that is NOT format-valid still switches to the valid superstring
    w = _cam_worker()
    posted = _capture(w)
    st = _superstring_state(0.43, raw="GJ11CI758")
    assert w._decide(st, expiring=False) is True
    assert posted[0]["plate"] == "GJ11CL7580" and st.length_fix["from"] == "GJ11C1758"


def test_length_fix_respects_ratio_and_knob(monkeypatch):
    w = _cam_worker()
    posted = _capture(w)
    st = _superstring_state(0.05)  # ratio 0.02 < 0.05
    assert w._decide(st, expiring=False) is True
    assert posted[0]["plate"] == "GJ11C1758" and st.length_fix is None
    monkeypatch.setattr(worker, "LEN_SWITCH", False)
    w = _cam_worker()
    posted = _capture(w)
    st = _superstring_state(0.43)
    assert w._decide(st, expiring=False) is True
    assert posted[0]["plate"] == "GJ11C1758" and st.length_fix is None


def test_short_plate_needs_reader_agreement_to_be_confirmed():
    w = _cam_worker()
    posted = _capture(w)
    st = _state(det_confs=[0.8] * 3, qualities=[0.6] * 3, reader_agree=[0.6, 0.7, 0.6])  # readers disagreed
    st.votes = _votes(3, "GJ11C1758")
    assert w._decide(st, expiring=False) is False and posted == []  # held: not confirmed while alive
    assert w._decide(st, expiring=True) is True  # …posted as a lead when the track ends
    assert posted[0]["tier"] == "possible" and posted[0]["plate"] == "GJ11C1758"
    assert posted[0]["feats"]["short_held"] == 1 and posted[0]["feats"]["rule"] == "possible"
    # agreeing readers + a heavy vote → confirmed, as before
    w = _cam_worker()
    posted = _capture(w)
    st = _state(det_confs=[0.8] * 3, qualities=[0.6] * 3, reader_agree=[1.0] * 3)
    st.votes = _votes(3, "GJ11C1758")
    assert w._decide(st, expiring=False) is True and posted[0]["tier"] == "confirmed"
    # a light top vote is held even when the readers agree
    w = _cam_worker()
    posted = _capture(w)
    st = _state(det_confs=[0.8] * 3, qualities=[0.6] * 3, reader_agree=[1.0] * 3)
    st.votes = _votes(3, "GJ11C1758", weight=0.15)  # top weight 0.45 < 0.6
    assert w._decide(st, expiring=False) is False
    # a single-reader deployment has no second opinion to ask: weight alone gates it
    w = _cam_worker()
    w.models.ocr.readers = [object()]
    posted = _capture(w)
    st = _state(det_confs=[0.8] * 3, qualities=[0.6] * 3)
    st.votes = _votes(3, "GJ11C1758")
    assert w._decide(st, expiring=False) is True and posted[0]["tier"] == "confirmed"
    # two readers that never both validated a read = disagreement
    w = _cam_worker()
    posted = _capture(w)
    st = _state(det_confs=[0.8] * 3, qualities=[0.6] * 3)
    st.votes = _votes(3, "GJ11C1758")
    assert w._decide(st, expiring=False) is False


def test_full_length_plate_is_not_held():
    w = _cam_worker()
    posted = _capture(w)
    st = _state(det_confs=[0.8] * 3, qualities=[0.6] * 3, reader_agree=[0.5] * 3)
    st.votes = _votes(3, "GJ01AB1234")
    assert w._decide(st, expiring=False) is True and posted[0]["tier"] == "confirmed"


def _single_read_state(text="GJ01AB1234", weight=0.4, p=0.9) -> worker.TrackState:
    st = _state(det_confs=[0.8], qualities=[0.5])
    st.votes = TrackVotes()
    st.votes.add_frame(0, [Read(text, [p] * len(text), weight, "base", valid=True, corrected=text)])
    return st


def test_single_frame_strict_read_posts_as_possible(monkeypatch):
    w = _cam_worker()
    posted = _capture(w)
    st = _single_read_state()
    assert w._decide(st, expiring=False) is False  # never while the track is alive
    assert w._decide(st, expiring=True) is True
    assert posted[0]["tier"] == "possible" and posted[0]["feats"]["rule"] == "possible_single"
    assert posted[0]["plate"] == "GJ01AB1234" and posted[0]["conf"] >= worker.POSSIBLE_MIN_CONF
    # the gates: length, OCR confidence, weight, agreement
    for st in (
        _single_read_state("GJ11C1758"),  # 9 chars
        _single_read_state(p=0.7),  # mean_conf 0.7 < 0.8
        _single_read_state(weight=0.2),
    ):  # weight 0.2 < 0.3
        w = _cam_worker()
        posted = _capture(w)
        assert w._decide(st, expiring=True) is False and posted == []
    bh = _single_read_state("22BH1234AB")  # Bharat series counts as full length
    w = _cam_worker()
    posted = _capture(w)
    assert w._decide(bh, expiring=True) is True and posted[0]["feats"]["rule"] == "possible_single"
    # knob off → the old rule (1 frame needs ≥ 2 reads)
    monkeypatch.setattr(worker, "POSSIBLE_SINGLE_STRICT", False)
    w = _cam_worker()
    posted = _capture(w)
    assert w._decide(_single_read_state(), expiring=True) is False and posted == []


def test_agreement_gate_is_0_9(monkeypatch):
    def state():
        st = _state(det_confs=[0.8] * 5, qualities=[0.6] * 5, reader_agree=[1.0] * 5)
        st.votes = TrackVotes()
        for i in range(3):
            st.votes.add_frame(
                i, [Read("GJ01AB1234", [0.9] * 10, 0.9, "base", valid=True, corrected="GJ01AB1234")]
            )
        for i in range(3, 5):  # three columns disputed → agreement 0.88
            st.votes.add_frame(
                i, [Read("GJ01AB7Z3A", [0.9] * 10, 0.9, "base", valid=True, corrected="GJ01AB7Z3A")]
            )
        return st

    st = state()
    c = st.votes.consensus()
    assert c.text == "GJ01AB1234" and 0.7 <= c.agreement < 0.9
    w = _cam_worker()
    posted = _capture(w)
    assert w._decide(st, expiring=False) is False  # 0.88 < 0.9: not confirmed any more
    assert w._decide(st, expiring=True) is True and posted[0]["tier"] == "possible"
    monkeypatch.setattr(worker, "MIN_AGREEMENT", 0.7)  # the old default confirmed it
    w = _cam_worker()
    posted = _capture(w)
    assert w._decide(state(), expiring=False) is True and posted[0]["tier"] == "confirmed"


# ── the real _post under DRY_RUN: raw, meta.ocr / models / track / latency ──
def test_post_writes_raw_and_metadata_to_the_record():
    w = _cam_worker()
    w.models.versions = {
        "vehicle": {"file": "v.pt", "bytes": 1, "sha256_12": "a" * 12},
        "plate": None,
        "ocr": {"readers": "stub", "model_onnx": None, "hub": {}},
        "calibrator": None,
        "registry": {"v.pt": {"version": "t1"}},
        "libs": {},
    }
    st = _superstring_state(0.43)
    st.best_bbox = [100, 100, 160, 120]
    st.t_first_read = time.time() - 1.5
    st.enh_ms, st.ocr_ms = 12.34, 5.67
    assert w._decide(st, expiring=False) is True
    assert st.posted and st.tier == "confirmed" and w.stats["posted"] == 1 and w.stats["posted_lenfix"] == 1
    day = time.strftime("%Y-%m-%d", time.localtime())
    d = os.path.join(worker.RECORDS_DIR, day, "test_cam")
    rec_path = None
    for _ in range(50):  # the DiskWriter thread writes it
        files = [f for f in os.listdir(d)] if os.path.isdir(d) else []
        js = [f for f in files if f.endswith("_GJ11CL7580.json")]
        if js:
            rec_path = os.path.join(d, js[0])
            break
        time.sleep(0.05)
    assert rec_path, "record JSON was not written"
    with open(rec_path, encoding="utf-8") as fh:
        rec = json.load(fh)
    assert rec["plate"] == "GJ11CL7580"
    assert rec["raw"] == "GJ11CI758"  # the OCR's heaviest UNCORRECTED read
    m = rec["meta"]
    assert m["worker"] == "bytetrack-enhance-v5" and m["pipeline_version"] == "bytetrack-enhance-v5"
    assert m["consensus"] == "GJ11C1758" and m["alternatives"][0][0] == "GJ11CL7580"  # UI fields unchanged
    assert m["ocr"] == {
        "raw_top": "GJ11CI758",
        "raw_alternatives": [["GJ11CL7580", 0.43]],
        "consensus": "GJ11C1758",
        "normalized": "GJ11CL7580",
        "rules_changed": True,
        "vote_alternatives": [["GJ11CL7580", 0.43]],
    }
    assert m["length_fix"]["from"] == "GJ11C1758" and m["length_fix"]["to"] == "GJ11CL7580"
    assert m["features"]["length_fix"] == 1
    assert m["models"]["vehicle"]["sha256_12"] == "a" * 12 and m["models"]["registry"] == {"v.pt": "t1"}
    assert m["track"] == {
        "uid": 1,
        "tracker_id": 7,
        "first_frame": 0,
        "last_frame": 0,
        "orphan": False,
        "merged": 0,
        "n_reads": 4,
    }
    assert 1.4 <= m["latency"]["first_read_to_post_s"] <= 5.0
    assert m["latency"]["enh_ms"] == 12.3 and m["latency"]["ocr_ms"] == 5.7


# ── scene seams: loop point vs reconnect (Sentinel rehearsal, 2 Oct 2026) ────
def _seam_worker(monkeypatch, decide=False):
    w = _cam_worker()
    w.states, w._alias, w._merge_mem = {}, {}, deque(maxlen=128)
    calls = {"review": [], "decide": []}
    monkeypatch.setattr(w, "_review", lambda st, tid: calls["review"].append(tid), raising=False)

    def _decide(st, expiring):
        calls["decide"].append((st.tid, expiring))
        return decide

    monkeypatch.setattr(w, "_decide", _decide, raising=False)
    return w, calls


def _reading_state(tid, text="GJ01AB1234", frames=2):
    st = _state(tid=tid, votes=_votes(frames, text))
    st.last_centre = (100.0, 100.0)
    return st


def test_loop_point_bridges_no_vote(monkeypatch):
    w, calls = _seam_worker(monkeypatch)
    w.states = {7: _reading_state(7), 8: _state(tid=8)}  # 8 never read anything
    old = _reading_state(5, "GJ18CD7788")
    w._merge_mem.append({"st": old, "tid": 5, "text": "GJ18CD7788", "centre": (100.0, 100.0), "t": 999.0, "review": True})
    w._merge_mem.append({"st": old, "tid": 6, "text": "GJ18CD7788", "centre": (100.0, 100.0), "t": 999.0})
    w._drop_states(10, 1000.0, bridge=False)
    assert w.states == {} and w._alias == {}
    assert len(w._merge_mem) == 0  # nothing left for a vehicle after the seam to absorb
    assert calls["decide"] == [(7, True)]  # decided as over, like an expired track
    assert sorted(calls["review"]) == [5, 7]  # the parked entry and the unposted track


def test_loop_point_posts_a_track_that_qualifies_instead_of_reviewing_it(monkeypatch):
    w, calls = _seam_worker(monkeypatch, decide=True)
    w.states = {7: _reading_state(7)}
    w._drop_states(10, 1000.0, bridge=False)
    assert calls["decide"] == [(7, True)] and calls["review"] == []


def test_reconnect_still_parks_votes_for_the_same_vehicle(monkeypatch):
    w, calls = _seam_worker(monkeypatch)
    w.states = {7: _reading_state(7)}
    w._drop_states(10, 1000.0)  # bridge=True: a reconnect, the same scene comes back
    assert w.states == {}
    assert len(w._merge_mem) == 1 and w._merge_mem[0]["review"] is True
    assert calls["review"] == [] and calls["decide"] == []


# ── plate detection skips finished tracks ────────────────────────────────────
class _Pdet:
    """Records what the plate detector is asked to look at."""

    def __init__(self):
        self.full_calls = 0
        self.batch_sizes: list[int] = []

    def __call__(self, frame):
        self.full_calls += 1
        return []

    def batch(self, crops):
        self.batch_sizes.append(len(crops))
        return [[] for _ in crops]


def _detect_worker(states: dict):
    w = _cam_worker()
    w.models.pdet = _Pdet()  # CameraWorker.pdet reads the shared Models
    w.states = states
    w._alias = {}
    w.stats["processed"] = 1
    return w


def _track(tid, x1=100):
    return (x1, 100, x1 + 200, 250, tid, 2, 0.9)  # small vehicle box: gets a native pass when live


def test_native_pass_skips_posted_and_exhausted_tracks():
    frame = np.zeros((1080, 1920, 3), np.uint8)
    live, posted, spent = _state(), _state(posted=True), _state()
    spent.votes = _votes(worker.MAX_READS, "GJ01AB1234")
    w = _detect_worker({1: live, 2: posted, 3: spent})
    w._detect_plates(frame, [_track(1, 100), _track(2, 500), _track(3, 900)])
    assert w.pdet.batch_sizes == [1]  # only the live track is cropped
    assert w.stats["native_skipped"] == 2 and w.stats["native_passes"] == 1
    assert w.pdet.full_calls == 1  # the full-frame pass still runs (default IDLE_FULL_EVERY=1)


def test_native_pass_follows_merged_track_alias():
    frame = np.zeros((1080, 1920, 3), np.uint8)
    w = _detect_worker({5: _state(posted=True)})
    w._alias = {9: 5}  # tracker id 9 was merged into the posted track 5
    w._detect_plates(frame, [_track(9)])
    assert w.pdet.batch_sizes == [] and w.stats["native_skipped"] == 1


def test_all_live_tracks_unchanged():
    frame = np.zeros((1080, 1920, 3), np.uint8)
    w = _detect_worker({1: _state(), 2: _state()})
    w._detect_plates(frame, [_track(1, 100), _track(2, 500)])
    assert w.pdet.batch_sizes == [2] and w.pdet.full_calls == 1
    assert w.stats.get("native_skipped", 0) == 0


def test_idle_full_pass_throttle(monkeypatch):
    frame = np.zeros((1080, 1920, 3), np.uint8)
    monkeypatch.setattr(worker, "IDLE_FULL_EVERY", 3)
    done = {1: _state(posted=True)}
    w = _detect_worker(done)
    for n in range(1, 7):  # all tracks finished: full pass only on processed % 3 == 0
        w.stats["processed"] = n
        w._detect_plates(frame, [_track(1)])
    assert w.pdet.full_calls == 2 and w.stats["full_skipped"] == 4
    w2 = _detect_worker({1: _state(posted=True), 2: _state()})
    w2.stats["processed"] = 1
    w2._detect_plates(frame, [_track(1), _track(2, 500)])  # one live track: always a full pass
    assert w2.pdet.full_calls == 1
    w3 = _detect_worker({})
    w3.stats["processed"] = 1
    w3._detect_plates(frame, [])  # no vehicles at all: orphan plates still searched
    assert w3.pdet.full_calls == 1
