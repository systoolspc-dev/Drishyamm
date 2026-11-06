"""infra.cuda_gate: one CUDA/NVDEC context creation at a time, re-entrant per
thread, and never a deadlock when the lock file cannot be created."""
from __future__ import annotations

import os
import threading
import time

from vms_face.config import settings
from vms_face.infra import cuda_gate


def _use_temp_lock(tmp_path):
    settings.cuda_init_lock_path = str(tmp_path / "cuda-init.lock")


def test_gate_serialises_threads(tmp_path):
    _use_temp_lock(tmp_path)
    inside = 0
    peak = 0
    lock = threading.Lock()

    def worker():
        nonlocal inside, peak
        with cuda_gate.cuda_init_gate("test"):
            with lock:
                inside += 1
                peak = max(peak, inside)
            time.sleep(0.05)
            with lock:
                inside -= 1

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert peak == 1, f"{peak} threads were inside the gate at once"
    assert os.path.exists(settings.cuda_init_lock_path)


def test_gate_is_reentrant_in_one_thread(tmp_path):
    _use_temp_lock(tmp_path)
    done = threading.Event()

    def worker():
        with cuda_gate.cuda_init_gate("outer"):
            with cuda_gate.cuda_init_gate("inner"):   # must not deadlock
                done.set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    assert done.wait(timeout=5), "nested gate deadlocked"


def test_gate_falls_back_to_process_lock_when_file_unavailable(tmp_path):
    settings.cuda_init_lock_path = str(tmp_path / "no-such-dir" / "deeper" / "x.lock")
    # os.makedirs creates the directory, so make the path unusable instead
    settings.cuda_init_lock_path = "/proc/definitely/not/writable/x.lock"
    done = threading.Event()

    def worker():
        with cuda_gate.cuda_init_gate("fallback"):
            done.set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    assert done.wait(timeout=5), "gate hung without a lock file"
