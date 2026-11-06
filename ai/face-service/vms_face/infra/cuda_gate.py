"""Box-wide serialisation of CUDA / NVDEC context creation.

On this platform (Docker Desktop, WSL2 GPU paravirtualisation) a process that
creates its CUDA context while other processes are creating theirs can die
with SIGSEGV inside the driver — reproduced 2026-09-21 as a shard's reconciler
started 15 `ffmpeg -hwaccel cuda` decoders while the same process built its
first ORT session: software decoders never crashed, NVDEC decoders started one
at a time never crashed, three started together crashed the parent every
time, and a second container starting decoders crashed a first container
building sessions.

So every context creation we control takes this gate: ORT session creation
(inference services, the workers' genderage head, batched detector), and the
start of an ffmpeg NVDEC decoder until it has reported its output stream (by
then its context exists). The gate is a `flock` on a file in a volume that
every AI container mounts (`CUDA_INIT_LOCK_PATH`, compose volume `vms-locks`);
it also serialises within a process, and is re-entrant per thread.
"""
from __future__ import annotations

import contextlib
import os
import threading
import time

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

_process_lock = threading.RLock()
_tls = threading.local()
_warned = False


@contextlib.contextmanager
def cuda_init_gate(what: str = ""):
    global _warned
    depth = getattr(_tls, "depth", 0)
    if depth > 0:                       # re-entrant: already inside the gate
        _tls.depth = depth + 1
        try:
            yield
        finally:
            _tls.depth -= 1
        return
    path = str(settings.cuda_init_lock_path or "")
    fh = None
    if path:
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            fh = open(path, "a+")
        except OSError as e:
            if not _warned:
                _warned = True
                log.warning("cuda init gate: lock file unavailable, serialising within this process only",
                            path=path, err=str(e))
    t0 = time.monotonic()
    with _process_lock:
        if fh is not None:
            import fcntl
            fcntl.flock(fh, fcntl.LOCK_EX)
        waited = time.monotonic() - t0
        if waited > 1.0:
            log.info("cuda init gate waited", what=what, seconds=round(waited, 1))
        _tls.depth = 1
        try:
            yield
        finally:
            _tls.depth = 0
            if fh is not None:
                import fcntl
                try:
                    fcntl.flock(fh, fcntl.LOCK_UN)
                finally:
                    fh.close()
