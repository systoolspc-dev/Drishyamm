"""Analysis heartbeat: error classification and per-minute rows (no camera,
no network). Reason strings are copied from the live worker log (4 Oct 2026),
credentials replaced by ***."""

import threading

import analysis_heartbeat as hb

LOCKOUT = (
    "RuntimeError: no reader could open ://***@<redacted-ip>:8554/stream/cam06 — pyav: "
    "HTTPUnauthorizedError: [Errno 825242872] Server re after 0 frames/6s via pyav"
)
INVALID = (
    "RuntimeError: no reader could open ://***@<redacted-ip>:8554/stream/cam03 — pyav: "
    "InvalidDataError: [Errno 1094995529] Invalid data  after 0 frames/7s via pyav"
)
TIMEOUT = (
    "RuntimeError: no reader could open ://***@<redacted-ip>:8554/stream/cam12 — pyav: "
    "TimeoutError: [Errno 110] Connection timed out: 'r after 0 frames/30s via pyav"
)
EXIT = "ExitError: [Errno 1414092869] Immediate exit requested: 'rtsp://***@h/stream/ after 812 frames/40s via pyav"


def test_classify_real_log_lines():
    assert hb.classify(LOCKOUT) == ("provider_lockout", "401 from provider")
    assert hb.classify(INVALID) == ("camera_down", "no usable video from server")
    assert hb.classify(TIMEOUT) == ("network", "connection timed out")
    assert hb.classify(EXIT) == ("camera_down", "no data after connect")
    assert hb.classify("RuntimeError: stream ended after 1200 frames/60s via ffmpeg")[0] == "camera_down"
    assert hb.classify("ConnectionRefusedError: [Errno 111] Connection refused")[0] == "network"


def test_frame_counts_are_not_status_codes():
    # "after 401 frames" must not read as an HTTP 401
    assert hb.classify("RuntimeError: stream ended after 401 frames/30s via pyav")[0] == "camera_down"
    assert hb.classify("RuntimeError: stream ended after 404 frames/30s via pyav")[0] == "camera_down"


def test_classify_empty_is_unknown():
    assert hb.classify(None) == ("unknown", None)
    assert hb.classify("first connection") == ("unknown", None)


class _Src:
    def __init__(self, decoded=0, reason=None, reason_at=0.0, frame_at=0.0):
        self.frames_decoded = decoded
        self.last_reason = reason
        self.last_reason_at = reason_at
        self.last_frame_wall = frame_at


class _W:
    def __init__(self, code, src, url="rtsp://u:p@10.0.0.1:8554/x", alive=True, stopped=False):
        self.cam = {"monitorId": code}
        self.src = src
        self.url = url
        self.stats = {"frames": 0, "corrupt_frames": 0}
        self._alive = alive
        self._stop_requested = threading.Event()
        if stopped:
            self._stop_requested.set()

    def is_alive(self):
        return self._alive


def _rows(workers, now=1000.0):
    return {r["camera_code"]: r for r in hb.sample_rows(workers, {}, now, now - 60)}


def test_reading_and_lockout_rows():
    rows = _rows(
        [
            _W("a", _Src(decoded=120, frame_at=999.0)),
            _W("b", _Src(decoded=0, reason=LOCKOUT, reason_at=990.0, frame_at=900.0)),
        ]
    )
    assert rows["a"]["state"] == "reading" and rows["a"]["frames"] == 120
    assert rows["b"]["state"] == "not_reading" and rows["b"]["reason"] == "provider_lockout"
    assert "rtsp" not in str(rows["b"]) and "***" not in str(rows["b"])  # no raw error text leaves


def test_stall_without_new_error_is_unknown():
    # the last error is OLDER than the last frame: we do not know why it stopped
    rows = _rows([_W("a", _Src(decoded=0, reason=LOCKOUT, reason_at=800.0, frame_at=990.0))])
    assert rows["a"]["reason"] == "unknown"


def test_console_off_sends_nothing():
    assert _rows([_W("a", _Src(decoded=5), stopped=True)]) == {}


def test_network_on_a_reachable_host_is_camera_down():
    rows = _rows(
        [
            _W("a", _Src(decoded=50)),
            _W("b", _Src(decoded=0, reason=TIMEOUT, reason_at=995.0)),
            _W("c", _Src(decoded=0, reason=TIMEOUT, reason_at=995.0), url="rtsp://other-host/x"),
        ]
    )
    assert rows["b"]["reason"] == "camera_down" and "host reachable" in rows["b"]["detail"]
    assert rows["c"]["reason"] == "network"  # no live camera on that host


def test_invalid_data_during_lockout_is_lockout():
    rows = _rows(
        [
            _W("a", _Src(decoded=0, reason=LOCKOUT, reason_at=995.0)),
            _W("b", _Src(decoded=0, reason=INVALID, reason_at=995.0)),
        ]
    )
    assert rows["b"]["reason"] == "provider_lockout"
    alone = _rows([_W("b", _Src(decoded=0, reason=INVALID, reason_at=995.0))])
    assert alone["b"]["reason"] == "camera_down"


def test_dead_thread_without_reason_is_camera_down():
    rows = _rows([_W("a", _Src(decoded=0), alive=False)])
    assert rows["a"]["reason"] == "camera_down"


def test_intervals_are_contiguous_and_deltas():
    prev = {}
    src = _Src(decoded=100)
    w = _W("a", src)
    r1 = hb.sample_rows([w], prev, 1000.0, 940.0)[0]
    src.frames_decoded = 160
    r2 = hb.sample_rows([w], prev, 1060.0, 940.0)[0]
    assert r1["to_ts"] == r2["from_ts"]
    assert r2["frames"] == 60


def test_reader_errors_never_carry_credentials():
    import video_source

    url = "rtsp://contact%40example.com:SECRET-PASS-1234@10.1.2.3:8554/stream/cam03"
    e = Exception(f"Invalid data found when processing input: '{url}'")
    for n in (40, 60, 80, 120):  # any truncation point
        assert "SECRET" not in video_source._short(e, n)
