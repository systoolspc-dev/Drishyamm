"""PlateOcr holds its reader lock only around the ONNX run, not the prep."""

import threading
from types import SimpleNamespace as NS

import numpy as np

from plate_ocr import PlateOcr

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
SLOTS = 10


def _reader(seen: dict) -> PlateOcr:
    r = PlateOcr.__new__(PlateOcr)
    r._lock = threading.Lock()
    r.alphabet, r.pad, r.slots, r.constrained = ALPHABET, "_", SLOTS, True
    r._out_name = "plate"
    r._ocr = NS(config=NS())

    def load(batch, cfg):
        seen["load_locked"] = r._lock.locked()
        return np.stack(batch)

    def prep(x):
        seen["prep_locked"] = r._lock.locked()
        return x.astype(np.uint8)

    def run(names, feeds):
        seen["run_locked"] = r._lock.locked()
        n = feeds["input"].shape[0]
        out = np.full((n, SLOTS, len(ALPHABET)), 1.0 / len(ALPHABET), np.float32)
        out[:, :, 1] += 0.5  # every slot: '1' most likely
        return [out / out.sum(2, keepdims=True)]

    r._load, r._prep_fn, r._sess = load, prep, NS(run=run)
    return r


def test_lock_only_around_the_model_run():
    seen: dict = {}
    P = _reader(seen)._distributions([np.zeros((64, 128, 1), np.uint8)] * 3)
    assert seen == {"load_locked": False, "prep_locked": False, "run_locked": True}
    assert P.shape == (3, SLOTS, len(ALPHABET))
    assert (P.argmax(2) == 1).all() and np.allclose(P.sum(2), 1.0)


def test_prep_is_not_blocked_by_another_cameras_run():
    seen: dict = {}
    r = _reader(seen)
    with r._lock:  # another camera is inside the model run
        done = threading.Event()

        def prep_only():
            r._prep_fn(r._load([np.zeros((64, 128, 1), np.uint8)], r._ocr.config))
            done.set()

        t = threading.Thread(target=prep_only)
        t.start()
        assert done.wait(2.0)  # preparation went ahead without the lock
    t.join()


def test_failed_head_still_falls_back_under_the_lock():
    seen: dict = {}
    r = _reader(seen)
    r._sess = NS(run=lambda *a: (_ for _ in ()).throw(RuntimeError("bad head")))
    assert r._distributions([np.zeros((64, 128, 1), np.uint8)]) is None
    assert not r._lock.locked()  # an exception never leaves the lock held
