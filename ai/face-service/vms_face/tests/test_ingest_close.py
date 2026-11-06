"""RTSPIngest.close() must never close the PyAV container while the reader
thread is still inside a blocking demux/decode call — that is a
use-after-free in libav and took a shard down with SIGSEGV on a mass stop
(2026-09-21). Deterministic version of that race: a fake container whose
demux blocks until the test releases it."""
from __future__ import annotations

import threading
import time

from vms_face.pipeline.ingest import RTSPIngest


class _BlockingPacketIter:
    """next() blocks until `release` is set, then raises StopIteration (EOS)."""

    def __init__(self, release: threading.Event, entered: threading.Event) -> None:
        self._release = release
        self._entered = entered

    def __iter__(self):
        return self

    def __next__(self):
        self._entered.set()
        self._release.wait(timeout=30)
        raise StopIteration


class _FakeContainer:
    def __init__(self) -> None:
        self.closed = threading.Event()
        self.closed_at: float | None = None

    def close(self) -> None:
        self.closed_at = time.monotonic()
        self.closed.set()


def _armed_ingest(release: threading.Event, entered: threading.Event) -> tuple[RTSPIngest, _FakeContainer]:
    ing = RTSPIngest("rtsp://fake/stream", target_fps=8, camera_label="test")
    container = _FakeContainer()
    ing._container = container
    ing._stream = object()
    ing._packet_iter = _BlockingPacketIter(release, entered)
    ing._frame_iter = None
    ing._reader_stop.clear()
    ing._close_on_reader_exit = False
    ing._reader_thread = threading.Thread(target=ing._reader_loop, name="rtsp-reader-test", daemon=True)
    ing._reader_thread.start()
    return ing, container


def test_close_defers_container_close_to_a_blocked_reader():
    release, entered = threading.Event(), threading.Event()
    ing, container = _armed_ingest(release, entered)
    assert entered.wait(timeout=5), "reader never entered the blocking demux"

    t0 = time.monotonic()
    ing.close()
    took = time.monotonic() - t0

    # close() returned after its bounded join, and did NOT close the container
    # underneath the thread that is still inside "libav".
    assert took < 5.0
    assert not container.closed.is_set()
    assert ing._close_on_reader_exit is True
    assert ing._container is container  # still owned by the reader

    # When the blocking call returns, the reader closes the container itself.
    release.set()
    assert container.closed.wait(timeout=5), "reader exited without closing the container"
    assert ing._container is None


def test_close_closes_immediately_when_reader_exits_in_time():
    release, entered = threading.Event(), threading.Event()
    ing, container = _armed_ingest(release, entered)
    assert entered.wait(timeout=5)
    release.set()  # reader hits EOS and exits on its own
    time.sleep(0.1)

    ing.close()
    assert container.closed.is_set()
    assert ing._close_on_reader_exit is False
    assert ing._container is None


def test_reader_honours_stop_inside_the_demux_loop():
    """A stop request must not wait for the next frame to become due."""
    ing = RTSPIngest("rtsp://fake/stream", target_fps=1, camera_label="test")
    ing._container = _FakeContainer()
    ing._stream = object()
    ing._packet_iter = iter(())   # never yields; the stop check comes first
    ing._reader_stop.set()
    assert ing._read_frame_blocking() is None
