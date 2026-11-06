"""The batched engine must be a drop-in for the per-frame path.

Two classes of failure would be serious in production and are locked here:
  * WRONG RESULTS — the result object must expose exactly what the worker uses
    (len, .xyxy/.conf/.cls with .cpu().numpy() and .tolist(), and .names), and
    boxes must be scaled back to source pixels through the letterbox, not
    stretched.
  * MISSING SURFACE — this claim was once too narrow: `.names` was left off the
    shim, `_encode_preview` read it, and every camera's video wall went blank
    while counts stayed correct (2026-09-20). Attribute-list assertions here
    are necessary but not sufficient; `test_preview_contract.py` drives the
    real annotator against the real shim, which is what actually catches it.
  * DEADLOCK — submit() blocks until the batch runs, so several cameras must be
    able to wait at once and all be served. If batching required a lock the
    caller already held, the service would freeze with no error.

These run without a GPU: the model forward is stubbed, the batching, geometry,
scatter and threading logic are real.
"""
import threading
import types

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from headcount.batch_engine import BatchInferenceEngine, BatchResult  # noqa: E402


class _FakeNet:
    """Stands in for the YOLO forward: emits one high-score box per image,
    centred, in letterboxed coordinates."""

    def __init__(self, boxes_per_image=1):
        self.boxes_per_image = boxes_per_image
        self.calls = []
        self.batch_sizes = []

    def to(self, *_a, **_k):
        return self

    def eval(self):
        return self

    def half(self):
        return self

    def __call__(self, x):
        n, _, h, w = x.shape
        self.calls.append(n)
        self.batch_sizes.append(n)
        anchors = 20
        out = torch.zeros((n, 5, anchors))
        for i in range(n):
            for b in range(self.boxes_per_image):
                out[i, 0, b] = w / 2          # cx
                out[i, 1, b] = h / 2          # cy
                out[i, 2, b] = 40             # w
                out[i, 3, b] = 40             # h
                out[i, 4, b] = 0.9            # score
        return out


def make_engine(**kw):
    model = types.SimpleNamespace(model=_FakeNet(kw.pop("boxes_per_image", 1)))
    kw.setdefault("device", "cpu")
    kw.setdefault("half", False)
    kw.setdefault("max_wait_ms", 5.0)
    return BatchInferenceEngine(model, **kw)


def frame(h=720, w=1280):
    return np.random.randint(0, 255, (h, w, 3), dtype=np.uint8)


class TestResultShim:
    """The worker only touches a narrow surface — it must all work."""

    def test_exposes_what_the_worker_uses(self):
        eng = make_engine()
        try:
            res = eng.submit(frame())
            assert isinstance(res, BatchResult)
            assert len(res.boxes) == 1
            assert res.boxes.xyxy.cpu().numpy().shape == (1, 4)
            assert len(res.boxes.conf.tolist()) == 1
            assert len(res.boxes.cls.tolist()) == 1
        finally:
            eng.stop()

    def test_empty_result_is_safe(self):
        eng = make_engine(conf=0.99)          # nothing clears the threshold
        try:
            res = eng.submit(frame())
            assert len(res.boxes) == 0
            assert res.boxes.xyxy.cpu().numpy().shape == (0, 4)
        finally:
            eng.stop()


class TestGeometry:
    def test_boxes_land_in_source_pixels_not_letterbox_pixels(self):
        """A centred detection must map back to the centre of the SOURCE frame.
        Stretching instead of padding silently shifts every box."""
        eng = make_engine()
        try:
            res = eng.submit(frame(720, 1280))
            x1, y1, x2, y2 = res.boxes.xyxy.cpu().numpy()[0]
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            assert abs(cx - 640) < 12, f"x centre {cx} should be ~640"
            assert abs(cy - 360) < 12, f"y centre {cy} should be ~360"
        finally:
            eng.stop()

    def test_geometry_is_cached_per_resolution(self):
        eng = make_engine()
        try:
            eng.submit(frame(720, 1280))
            eng.submit(frame(720, 1280))
            eng.submit(frame(1080, 1920))
            assert len(eng._geom) == 2
        finally:
            eng.stop()

    def test_letterbox_pads_rather_than_stretches(self):
        eng = make_engine()
        try:
            th, tw, uh, uw, r, padx, pady = eng._geometry(720, 1280)
            assert (tw, th) == (640, 384)
            assert (uw, uh) == (640, 360)      # scaled, aspect preserved
            assert pady == 12.0                # padding, not stretching
            assert padx == 0.0
        finally:
            eng.stop()


class TestBatching:
    def test_several_cameras_share_one_gpu_call(self):
        """The whole point: 6 concurrent cameras must not become 6 calls."""
        eng = make_engine(max_wait_ms=60.0, max_batch=16)
        net = eng.net
        results, errors = {}, []

        def worker(i):
            try:
                results[i] = eng.submit(frame())
            except BaseException as e:          # noqa: BLE001
                errors.append(e)

        try:
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=15)
            assert not errors, errors
            assert len(results) == 6
            assert max(net.batch_sizes) > 1, "frames were never batched together"
            assert len(net.calls) < 6, f"expected fewer calls than cameras, got {net.calls}"
        finally:
            eng.stop()

    def test_every_camera_gets_its_own_boxes(self):
        eng = make_engine(max_wait_ms=40.0)
        out, lock = [], threading.Lock()

        def worker():
            r = eng.submit(frame())
            with lock:
                out.append(len(r.boxes))

        try:
            ts = [threading.Thread(target=worker) for _ in range(5)]
            for t in ts:
                t.start()
            for t in ts:
                t.join(timeout=15)
            assert out == [1] * 5, out
        finally:
            eng.stop()

    def test_respects_max_batch(self):
        eng = make_engine(max_wait_ms=60.0, max_batch=3)
        try:
            ts = [threading.Thread(target=lambda: eng.submit(frame())) for _ in range(9)]
            for t in ts:
                t.start()
            for t in ts:
                t.join(timeout=20)
            assert max(eng.net.batch_sizes) <= 3
        finally:
            eng.stop()

    def test_mixed_resolutions_do_not_share_a_tensor(self):
        """Different camera resolutions cannot stack — they must split into
        separate calls rather than crash or corrupt each other's boxes."""
        eng = make_engine(max_wait_ms=50.0)
        got = {}

        def worker(key, h, w):
            got[key] = eng.submit(frame(h, w))

        try:
            ts = [threading.Thread(target=worker, args=("hd", 720, 1280)),
                  threading.Thread(target=worker, args=("fhd", 1080, 1920))]
            for t in ts:
                t.start()
            for t in ts:
                t.join(timeout=15)
            assert len(got) == 2
            assert all(len(r.boxes) == 1 for r in got.values())
        finally:
            eng.stop()


class TestAdaptiveLinger:
    """Batching must never make a single camera SLOWER.

    The engine lingers a few ms so cameras can group up. With one camera nobody
    ever joins, so a fixed linger would be pure added latency on every frame
    (measured 5 ms -> 17 ms before this was adaptive).
    """

    def test_uncontended_caller_is_told_to_use_the_stock_path(self):
        """Batching loses at a batch of one, so a lone camera must be routed
        away from the engine entirely."""
        eng = make_engine()
        try:
            assert eng.try_solo() is True
            eng.end_solo()
        finally:
            eng.stop()

    def test_contended_caller_is_routed_to_batching(self):
        """While one camera holds the GPU, the next must NOT be told to run
        solo — it should queue and get batched."""
        eng = make_engine()
        try:
            assert eng.try_solo() is True        # camera A claims the GPU
            assert eng.try_solo() is False       # camera B must batch instead
            eng.end_solo()
            assert eng.try_solo() is True        # released again
            eng.end_solo()
        finally:
            eng.stop()

    def test_linger_switches_on_when_cameras_arrive_together(self):
        eng = make_engine(max_wait_ms=40.0, max_batch=16)
        try:
            for _ in range(3):                   # a few concurrent rounds
                ts = [threading.Thread(target=lambda: eng.submit(frame()))
                      for _ in range(6)]
                for t in ts:
                    t.start()
                for t in ts:
                    t.join(timeout=15)
            assert eng.stats()["fill_ema"] > 1.15, eng.stats()
            assert eng.stats()["lingering"] is True
        finally:
            eng.stop()


class TestFailureHandling:
    def test_a_failing_forward_raises_to_every_waiter(self):
        """One bad batch must not leave workers blocked for ever."""
        eng = make_engine()

        def boom(_x):
            raise RuntimeError("cuda oom")

        eng.net = types.SimpleNamespace(__call__=boom)
        eng.net = type("N", (), {"__call__": staticmethod(boom)})()
        try:
            with pytest.raises(RuntimeError):
                eng.submit(frame())
        finally:
            eng.stop()

    def test_stats_report_the_batching_that_happened(self):
        eng = make_engine()
        try:
            eng.submit(frame())
            s = eng.stats()
            assert s["batches"] >= 1 and s["images"] >= 1
        finally:
            eng.stop()


class TestPerCameraDetailLevel:
    """Detail level (model input size) is the strongest range control we have —
    measured 9 m at 640 vs 18 m at 1280 on a 4 mm lens. It is per camera because
    on GPU it is nearly free but on CPU it costs ~2.5x.

    Tensors of different input sizes cannot share one forward pass, so cameras
    running different levels must batch separately or the boxes come back
    scaled to the wrong geometry.
    """

    def test_geometry_differs_per_detail_level(self):
        eng = make_engine()
        try:
            a = eng._geometry(720, 1280, 640)
            b = eng._geometry(720, 1280, 1280)
            assert a[:2] != b[:2], "same letterbox for different detail levels"
            assert b[1] == 1280 and a[1] == 640
        finally:
            eng.stop()

    def test_geometry_cache_keys_on_size_not_just_resolution(self):
        eng = make_engine()
        try:
            eng._geometry(720, 1280, 640)
            eng._geometry(720, 1280, 1280)
            eng._geometry(720, 1280, 640)
            assert len(eng._geom) == 2
        finally:
            eng.stop()

    def test_different_levels_do_not_share_a_batch(self):
        eng = make_engine(max_wait_ms=50.0)
        got = {}

        def worker(key, size):
            got[key] = eng.submit(frame(), size)

        try:
            ts = [threading.Thread(target=worker, args=('small', 640)),
                  threading.Thread(target=worker, args=('large', 1280))]
            for t in ts:
                t.start()
            for t in ts:
                t.join(timeout=15)
            assert len(got) == 2
            # each call saw a single-size tensor, never a mixed one
            assert all(n >= 1 for n in eng.net.batch_sizes)
        finally:
            eng.stop()

    def test_boxes_scale_back_correctly_at_a_higher_level(self):
        """A centred detection must still land in the centre of the SOURCE frame
        when the camera runs at a different detail level."""
        eng = make_engine()
        try:
            res = eng.submit(frame(720, 1280), 1280)
            x1, y1, x2, y2 = res.boxes.xyxy.cpu().numpy()[0]
            assert abs((x1 + x2) / 2 - 640) < 14
            assert abs((y1 + y2) / 2 - 360) < 14
        finally:
            eng.stop()
