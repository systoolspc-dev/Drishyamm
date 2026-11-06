"""Async micro-batching primitive for inference dispatch.

The detect/embed hot path today fires one ONNX Runtime call per request. ORT
serializes within a session anyway, so we can collect requests into a small
window and call once with a batch dim populated — 3-5x detect throughput,
~2x embed throughput in our benchmarks. The trade-off is a constant latency
penalty equal to the coalescing window (default 2-3 ms).

The batcher is *async* but the underlying ONNX call runs on a thread (GIL is
fine; the heavy work is C++ inside ORT). Concurrent submitters await their
own future; the first one to fill the window or hit max_size triggers a
flush, every other one waits on the same future.

Generic over input/output types so the same primitive serves SCRFD (image →
list[FaceObservation]) and AdaFace (aligned crop → embedding).
"""
from __future__ import annotations

import asyncio
import time
from concurrent.futures import Executor
from typing import Awaitable, Callable, Generic, TypeVar

from vms_face.core.metrics import BATCH_FLUSHES, BATCH_SIZE, BATCH_WAIT_LATENCY

T_in = TypeVar("T_in")
T_out = TypeVar("T_out")


class _PendingItem(Generic[T_in, T_out]):
    __slots__ = ("payload", "future", "submitted_at")

    def __init__(self, payload: T_in, future: "asyncio.Future[T_out]") -> None:
        self.payload = payload
        self.future = future
        self.submitted_at = time.perf_counter()


class AsyncBatcher(Generic[T_in, T_out]):
    """Submit one item, get one result. Internally batches up to `max_size`
    items or waits up to `window_sec`, then calls `flush_fn(batch)` which
    returns a parallel list of results. Errors propagate to all waiters in
    the batch (they're sharing the same kernel — same fate)."""

    def __init__(
        self,
        flush_fn: Callable[[list[T_in]], list[T_out]],
        *,
        max_size: int,
        window_sec: float,
        stage: str,
        executor: "Executor | None" = None,
    ) -> None:
        # `executor=None` means asyncio's default pool — min(32, cpu+4) threads,
        # which is the wrong shape for inference: the GPU serializes the work
        # anyway, so the extra host threads only contend for the model lock and
        # the GIL. Inference callers should pass the dedicated GPU pool.
        self._executor = executor
        self._flush_fn = flush_fn
        self._max_size = max(1, int(max_size))
        self._window_sec = max(0.0, float(window_sec))
        self._stage = stage
        self._lock = asyncio.Lock()
        self._pending: list[_PendingItem[T_in, T_out]] = []
        self._timer: asyncio.TimerHandle | None = None

    async def submit(self, payload: T_in) -> T_out:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[T_out] = loop.create_future()
        async with self._lock:
            self._pending.append(_PendingItem(payload, fut))
            if len(self._pending) >= self._max_size:
                items = self._take()
                self._cancel_timer()
                # Schedule the flush off the lock so we don't block other
                # submitters during the (fast but not free) flush wrapper.
                loop.create_task(self._do_flush(items, "full"))
            elif self._timer is None:
                # Arm the window timer. Re-arming on every submit gives us a
                # rolling window; we want a fixed window from first-arrival
                # so latency-sensitive callers don't starve under steady load.
                self._timer = loop.call_later(self._window_sec, self._on_window)
        return await fut

    def _take(self) -> list[_PendingItem[T_in, T_out]]:
        items, self._pending = self._pending, []
        return items

    def _cancel_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _on_window(self) -> None:
        # Runs on the event loop. We must not await under a synchronous
        # callback; schedule the async path.
        loop = asyncio.get_running_loop()
        loop.create_task(self._flush_window())

    async def _flush_window(self) -> None:
        async with self._lock:
            if not self._pending:
                self._timer = None
                return
            items = self._take()
            self._timer = None
        await self._do_flush(items, "window")

    async def _do_flush(self, items: list[_PendingItem[T_in, T_out]], trigger: str) -> None:
        if not items:
            return
        BATCH_FLUSHES.labels(stage=self._stage, trigger=trigger).inc()
        BATCH_SIZE.labels(stage=self._stage).observe(len(items))
        now = time.perf_counter()
        for it in items:
            BATCH_WAIT_LATENCY.labels(stage=self._stage).observe(now - it.submitted_at)
        loop = asyncio.get_running_loop()
        try:
            results = await loop.run_in_executor(
                self._executor, self._flush_fn, [it.payload for it in items]
            )
        except Exception as e:
            for it in items:
                if not it.future.done():
                    it.future.set_exception(e)
            return
        if len(results) != len(items):
            err = RuntimeError(
                f"batched {self._stage} returned {len(results)} results for "
                f"{len(items)} inputs — flush_fn must preserve order/length"
            )
            for it in items:
                if not it.future.done():
                    it.future.set_exception(err)
            return
        for it, out in zip(items, results):
            if not it.future.done():
                it.future.set_result(out)


def coroutine_flush(fn: Callable[[list[T_in]], "Awaitable[list[T_out]]"]):
    """Adapter for callers whose flush_fn is itself async. Wraps it so the
    AsyncBatcher.flush_fn (sync, run in an executor) becomes async-friendly."""
    def _sync_wrapper(items: list[T_in]) -> list[T_out]:
        return asyncio.run(fn(items))
    return _sync_wrapper
