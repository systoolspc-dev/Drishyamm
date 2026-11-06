"""Dedicated thread pools so blocking work doesn't starve the event loop.

The default asyncio executor is `min(32, cpu_count + 4)` threads — fine for
a handful of cameras, but at scale RTSP open / frame pulls / MinIO uploads
all share the same pool as the GPU detect/embed dispatch. One slow camera
takes a slot the GPU could have used.

We split into three named pools:
  - ingest_pool : RTSP demux + decode (blocking I/O, can grow large)
  - gpu_pool    : detector / recognizer dispatch (small — GPU isn't
                  parallelized by host threads)
  - io_pool     : MinIO / Postgres / generic blocking I/O

Use them via `loop.run_in_executor(get_io_pool(), fn, *args)`.
"""
from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor

_lock = threading.Lock()
_pools: dict[str, ThreadPoolExecutor] = {}


def _make(name: str, max_workers: int) -> ThreadPoolExecutor:
    with _lock:
        existing = _pools.get(name)
        if existing is not None:
            return existing
        pool = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix=f"vms-{name}",
        )
        _pools[name] = pool
        return pool


def get_ingest_pool() -> ThreadPoolExecutor:
    """Big pool for RTSP I/O. Default sized for ~256 concurrent cameras per
    process; scale via VMS_INGEST_POOL_SIZE."""
    size = int(os.environ.get("VMS_INGEST_POOL_SIZE", "256"))
    return _make("ingest", max(8, size))


def get_gpu_pool() -> ThreadPoolExecutor:
    """Small pool for inference dispatch. GPU work is serialized on the GPU
    itself; more host threads doesn't help and increases lock contention."""
    size = int(os.environ.get("VMS_GPU_POOL_SIZE", "4"))
    return _make("gpu", max(1, size))


def get_io_pool() -> ThreadPoolExecutor:
    """General-purpose blocking I/O (snapshot upload, sync DB calls)."""
    size = int(os.environ.get("VMS_IO_POOL_SIZE", "32"))
    return _make("io", max(4, size))


def shutdown_all(wait: bool = True) -> None:
    with _lock:
        for pool in _pools.values():
            pool.shutdown(wait=wait, cancel_futures=True)
        _pools.clear()
