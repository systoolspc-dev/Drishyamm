"""The preview annotator must survive whatever `infer()` hands it.

Why this file exists
--------------------
On 2026-09-20 the head-count video wall was blank on all 8 cameras while the
counts stayed perfect. Cause: `BatchResult` declared `__slots__ = ("boxes",)`
but `StreamWorker._encode_preview` reads `res.names` to label each box. That
raised `AttributeError` *near the top* of the function, and since the whole
body is wrapped in `try/except`, execution never reached `cv2.imencode` — so
`_latest_jpeg` was never assigned and `/snapshot/{id}` had nothing to serve.
205 failures in 5 minutes, swallowed into the log, service reporting healthy.

`test_batch_engine.py` already claimed to lock "exactly what the worker uses"
but only checked `.xyxy/.conf/.cls`, so the gap shipped. The lesson is that
asserting the shim's *attribute list* is weaker than running the real consumer
against it — a new attribute read is added in the consumer, not the shim.

So the load-bearing test here is `test_preview_encodes_from_batch_result`: it
drives the REAL `_encode_preview` with a REAL `BatchResult` and demands a JPEG.
Any future attribute the annotator starts reading is covered for free.
"""
import threading
import types

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from headcount.batch_engine import BatchResult  # noqa: E402
from headcount.stream_worker import StreamWorker  # noqa: E402


def _det(n=2):
    """(N, 6) detection rows: x1, y1, x2, y2, conf, cls."""
    return np.array(
        [[10 + 20 * i, 10 + 20 * i, 60 + 20 * i, 80 + 20 * i, 0.9 - 0.1 * i, 0.0]
         for i in range(n)],
        dtype=np.float32,
    )


def _worker_stub(jpeg_quality=70, banner=True):
    """The minimal `self` that `_encode_preview` actually touches. Building a
    real StreamWorker would need a model, a camera and a config tree; the
    function under test only needs these seven attributes."""
    det = types.SimpleNamespace(id="d0", label="heads", color=(0, 255, 0))
    return types.SimpleNamespace(
        detectors=[det],
        preview_banner=banner,
        jpeg_quality=jpeg_quality,
        stats=types.SimpleNamespace(name="Cam 1"),
        cfg=types.SimpleNamespace(id="cam0"),
        _jpeg_lock=threading.Lock(),
        _latest_jpeg=None,
    )


def _frame():
    return np.full((360, 640, 3), 40, dtype=np.uint8)


# ── the regression that mattered ──────────────────────────────────────────


def test_preview_encodes_from_batch_result():
    """The real annotator + the real shim must yield a decodable JPEG.

    This is the test that would have caught the outage: before the fix it
    fails because `_latest_jpeg` stays None."""
    me = _worker_stub()
    results = {"d0": BatchResult(_det(2), {0: "head"})}

    StreamWorker._encode_preview(me, _frame(), results, {"heads": 2}, 12.5)

    assert me._latest_jpeg is not None, (
        "no JPEG produced — _encode_preview raised before cv2.imencode and the "
        "exception was swallowed (this is exactly the blank-video-wall bug)"
    )
    decoded = cv2.imdecode(np.frombuffer(me._latest_jpeg, np.uint8), cv2.IMREAD_COLOR)
    assert decoded is not None and decoded.shape == (360, 640, 3)


def test_preview_survives_result_without_names():
    """Defence in depth: a shim missing an attribute must cost a box LABEL,
    never the whole frame. Guards the `getattr(res, "names", None) or {}`."""
    class _NamelessResult:
        __slots__ = ("boxes",)

        def __init__(self, det):
            self.boxes = BatchResult(det).boxes

    me = _worker_stub()
    results = {"d0": _NamelessResult(_det(1))}

    StreamWorker._encode_preview(me, _frame(), results, {"heads": 1}, 9.0)

    assert me._latest_jpeg is not None, "a missing attribute killed the frame again"


def test_preview_handles_zero_detections():
    me = _worker_stub()
    results = {"d0": BatchResult(np.zeros((0, 6), np.float32), {})}

    StreamWorker._encode_preview(me, _frame(), results, {"heads": 0}, 0.0)

    assert me._latest_jpeg is not None


def test_preview_respects_kept_mask():
    """A suppressed static object is neither counted nor drawn — the mask must
    not break encoding."""
    me = _worker_stub()
    results = {"d0": BatchResult(_det(3), {0: "head"})}

    StreamWorker._encode_preview(
        me, _frame(), results, {"heads": 1}, 5.0, {"d0": [True, False, False]}
    )

    assert me._latest_jpeg is not None


# ── the shim's own contract ───────────────────────────────────────────────


def test_batch_result_exposes_names_mapping():
    res = BatchResult(_det(1), {0: "head", 1: "person"})
    assert res.names.get(0) == "head"
    # `_encode_preview` relies on .get()'s default to fall back to det.label.
    assert res.names.get(99, "fallback") == "fallback"


def test_batch_result_names_defaults_to_empty_mapping():
    """Never None: the annotator calls .get() on it unconditionally."""
    res = BatchResult(_det(1))
    assert res.names == {}
    assert res.names.get(0, "heads") == "heads"


def test_batch_result_surface_matches_what_consumers_read():
    """Pins the audited contract: stream_worker reads len(res.boxes),
    .xyxy/.conf/.cls (via .cpu().numpy() on the counting path and .tolist()
    on the preview path) and res.names. Nothing else."""
    res = BatchResult(_det(2), {0: "head"})

    assert len(res.boxes) == 2
    for arr in (res.boxes.xyxy, res.boxes.conf, res.boxes.cls):
        assert arr.cpu().numpy().shape[0] == 2
        assert len(arr.tolist()) == 2
    assert res.boxes.xyxy.cpu().numpy().shape == (2, 4)
    assert isinstance(res.names, dict)
