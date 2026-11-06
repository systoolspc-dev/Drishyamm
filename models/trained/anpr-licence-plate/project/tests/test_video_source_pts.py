"""video_source.PtsClock and the reader around it: loop points, frame gaps,
forward jumps and the anchor lag, frame by frame with synthetic clocks (no
FFmpeg, no network). Run inside the worker image:

    docker exec -w /srv/anpr trinetra-anpr-worker python -m pytest tests/test_video_source_pts.py -q

The Sentinel rehearsal (2 Oct 2026) these pin down:
  - cam04 / cam05 / cam07 / cam09 loop back to pts 0.0 every ~35 s. The old
    anchor-based test saw the first loop only; every later one returned to the
    anchor's own pts and was re-anchored silently (no new epoch, no tracker
    reset). Every loop must be a cut.
  - cam04 drops 1.55 s of frames every 13 s and holds frames for 1.2 s bursts:
    those are gaps, never cuts, and the timestamp must move by the pts gap.
  - the reader stamped every frame 0.06-2.24 s late, constant per connection:
    pts was anchored when the first frame left the decoder, after av.open()
    had buffered packets.
"""

import time
from types import SimpleNamespace as NS

import pytest

import video_source as vs
from video_source import PtsClock

FPS = 25.0
DT = 1.0 / FPS


def feed(clock, frames):
    """Drive the clock the way _PyAvReader.read() does: a paced reader sleeps
    until a frame is due, so the next frame cannot come out before that; far
    behind re-anchors. frames: [(pts, available_at)] →
    [(pts, arrival, due, cut, hold)]"""
    out, release = [], float("-inf")
    for t, avail in frames:
        arr = max(avail, release)
        due, cut, hold = clock.stamp(t, arr)
        if hold:
            out.append((t, arr, due, cut, True))
            release = arr
            continue
        lag = arr - due
        if lag < -0.005:
            release = due  # slept until due
        else:
            release = arr
            if lag > vs._LAG_REANCHOR_SEC:
                due, c2 = clock.behind(t, arr)
                cut = cut or c2
        out.append((t, arr, due, cut, False))
    return out


def looping(start_wall, loop_s, loops, fps=FPS, first_pts=0.0):
    """A looping feed sent in real time: pts restarts at 0.0 every loop (the
    grid's RTP clock restarts), wall time keeps going. `loops` passes, the
    first one starting at first_pts → loops - 1 loop points. → [(pts, wall)]"""
    out, w, t = [], start_wall, first_pts
    for _ in range(loops):
        while t < loop_s - 1e-9:
            out.append((round(t, 6), w))
            t += 1.0 / fps
            w += 1.0 / fps
        t = 0.0  # loop point
    return out


# ── loop points ──────────────────────────────────────────────────────────────
@pytest.mark.parametrize("edge", [False, True])
def test_every_loop_back_to_the_same_pts_is_a_cut(edge):
    # Join mid-loop (the probe connects at an arbitrary point), then four more
    # loops that all return to pts 0.0: the case the anchor-based test missed.
    frames = looping(1000.0, 35.75, 5, first_pts=17.32)
    clock = PtsClock(live_edge=edge)
    rows = feed(clock, frames)
    idx = [i for i, r in enumerate(rows) if r[3]]
    assert [rows[i][0] for i in idx] == [0.0, 0.0, 0.0, 0.0]
    assert clock.cuts == 4
    assert all(rows[i - 1][0] > 35.0 for i in idx)  # each cut is pts 35.72 -> 0.0


@pytest.mark.parametrize("edge", [False, True])
def test_loop_timestamps_follow_the_wall_clock_and_never_go_back(edge):
    frames = looping(1000.0, 35.75, 4, first_pts=30.0)
    rows = [r for r in feed(PtsClock(live_edge=edge), frames) if not r[4]]
    dues = [r[2] for r in rows]
    assert all(b >= a - 1e-9 for a, b in zip(dues, dues[1:]))
    # sent in real time with no backlog: due == when the frame was sent
    assert max(abs(r[2] - r[1]) for r in rows) < 1e-6


def test_a_loop_after_a_stall_reanchor_is_still_a_cut():
    # A stall (> 3 s behind) re-anchors at "now"; the next loop point must
    # still be a cut: the prev-frame comparison does not care where the anchor sits.
    c = PtsClock(live_edge=False)
    c.stamp(10.0, 100.0)
    c.stamp(10.04, 100.04)
    due, cut, _h = c.stamp(10.08, 105.0)  # 5 s late, pts continuous: a stall, not a cut
    assert not cut and 105.0 - due > vs._LAG_REANCHOR_SEC
    assert c.behind(10.08, 105.0) == (105.0, False)
    _d, cut, _h = c.stamp(0.0, 105.04)  # loop back to 0.0
    assert cut and c.cuts == 1


def test_backwards_reanchor_is_a_cut():
    c = PtsClock(live_edge=False)
    c.stamp(20.0, 100.0)
    c.stamp(20.04, 100.04)
    # pts slips back by less than the per-frame margin, 4 s later: the lag rule
    # re-anchors, and moving the anchor's pts BACKWARDS is a discontinuity
    due, cut, _h = c.stamp(19.9, 104.0)
    assert not cut and 104.0 - due > vs._LAG_REANCHOR_SEC
    assert c.behind(19.9, 104.0) == (104.0, True)
    assert c.cuts == 1


# ── frame gaps (cam04) ───────────────────────────────────────────────────────
@pytest.mark.parametrize("edge", [False, True])
def test_a_155s_gap_is_not_a_cut_and_the_timestamp_moves_by_the_pts_gap(edge):
    c = PtsClock(live_edge=edge)
    frames = [(i * DT, 1000.0 + i * DT) for i in range(100)]
    t_last, a_last = frames[-1]
    # 1.55 s of frames never sent; the next frame arrives on time
    frames += [(t_last + 1.55 + i * DT, a_last + 1.55 + i * DT) for i in range(50)]
    rows = [r for r in feed(c, frames) if not r[4]]
    assert c.cuts == 0
    i = next(k for k in range(1, len(rows)) if rows[k][0] - rows[k - 1][0] > 1.0)
    assert rows[i][2] - rows[i - 1][2] == pytest.approx(rows[i][0] - rows[i - 1][0], abs=1e-6)


@pytest.mark.parametrize("edge", [False, True])
def test_a_gap_delivered_early_in_a_burst_is_not_a_cut(edge):
    # cam04 also holds frames and bursts them out: the gap's far side reached
    # the reader only 0.367-1.065 s after the near side (measured).
    c = PtsClock(live_edge=edge)
    frames = [(i * DT, 1000.0 + i * DT) for i in range(60)]
    t0, a0 = frames[-1]
    frames += [(t0 + 1.55 + i * DT, a0 + 0.367 + i * 0.002) for i in range(30)]
    feed(c, frames)
    assert c.cuts == 0


def test_burst_hold_frames_keep_pts_timestamps_on_the_live_edge():
    # Frames held 1.2 s by the camera and then burst out: late, but stamped by
    # pts (when they were sent), not by when they arrived.
    c = PtsClock(live_edge=True)
    frames = [(i * DT, 1000.0 + i * DT) for i in range(80)]
    t0, a0 = frames[-1]
    frames += [(t0 + (i + 1) * DT, a0 + 1.2 + i * 0.001) for i in range(30)]
    rows = [r for r in feed(c, frames) if not r[4]]
    assert c.cuts == 0
    for t, _arr, due, _cut, _h in rows:
        assert due == pytest.approx(1000.0 + t, abs=1e-6)


# ── forward jumps ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("edge", [False, True])
def test_forward_jump_beyond_the_wall_clock_is_a_cut(edge):
    c = PtsClock(live_edge=edge)
    frames = [(i * DT, 1000.0 + i * DT) for i in range(50)]
    t0, a0 = frames[-1]
    frames += [(t0 + 60.0 + i * DT, a0 + DT + i * DT) for i in range(20)]  # restamp +60 s
    rows = feed(c, frames)
    assert c.cuts == 1
    j = next(k for k, r in enumerate(rows) if r[3])
    assert rows[j][0] == pytest.approx(t0 + 60.0)
    # re-anchored at once: stamped when it arrived, not 60 s in the future
    assert rows[j][2] == pytest.approx(rows[j][1])
    assert max(r[2] - r[1] for r in rows if not r[4]) < 0.006


@pytest.mark.parametrize("edge", [False, True])
def test_a_pause_with_pts_moving_like_the_wall_clock_is_not_a_cut(edge):
    # The provider pauses for 10 s and resumes with pts advanced by the same 10 s
    c = PtsClock(live_edge=edge)
    frames = [(i * DT, 1000.0 + i * DT) for i in range(50)]
    t0, a0 = frames[-1]
    frames += [(t0 + 10.0 + i * DT, a0 + 10.0 + i * DT) for i in range(20)]
    feed(c, frames)
    assert c.cuts == 0


def test_forward_jump_threshold_is_two_seconds_over_the_wall_gap():
    c = PtsClock(live_edge=True)
    feed(c, [(0.0, 1000.0), (0.04, 1000.04), (0.08, 1000.08), (0.12, 1000.12)])
    assert not c.stamp(0.12 + 1.9, 1000.16)[1]  # 1.9 s ahead of a 0.04 s wall gap: a gap
    assert c.stamp(2.02 + 2.2, 1000.20)[1]  # 2.2 s ahead: a cut


# ── the anchor lag ───────────────────────────────────────────────────────────
def _backlogged(backlog_s, decode_s=0.005, frames=160, start=1000.0):
    """The open buffered `backlog_s` of real-time video before the first frame
    could leave the decoder. Buffered frames are available at decode speed;
    the decoder catches up, after that each frame arrives 1 ms after it was
    sent. → [(pts, available_at, sent_at)]"""
    out, prev = [], start + backlog_s - decode_s
    for i in range(frames):
        send = start + i * DT
        avail = max(send + 0.001, prev + decode_s)
        out.append((i * DT, avail, send))
        prev = avail
    return out


def test_live_edge_stamps_the_send_time_not_the_open_time():
    frames = _backlogged(2.24)
    c = PtsClock(live_edge=True)
    rows = feed(c, [(t, a) for t, a, _s in frames])
    assert not c.settling and c.cuts == 0
    # the backlog (2.24 s at 25 fps, plus what arrived while draining) was dropped, not delivered
    assert c.held >= 56
    assert c.backlog_s == pytest.approx(2.24, abs=0.01)
    sent = {t: s for t, _a, s in frames}
    released = [(r[2], sent[r[0]]) for r in rows if not r[4]]
    # every frame that reached the consumer carries its send time (+ 1 ms network)
    assert released and max(abs(d - s) for d, s in released) <= 0.0011


def test_the_old_first_frame_anchor_was_late_by_the_backlog():
    # The paced anchor (old RTSP behaviour, still HLS): the lag the rehearsal
    # measured, constant for the whole connection.
    frames = _backlogged(2.24)
    rows = feed(PtsClock(live_edge=False), [(t, a) for t, a, _s in frames])
    lags = [r[2] - s for r, (_t, _a, s) in zip(rows, frames)]
    assert min(lags) == pytest.approx(2.24, abs=0.01) and max(lags) == pytest.approx(2.24, abs=0.01)


def test_live_edge_without_a_backlog_holds_only_a_few_frames():
    frames = [(i * DT, 1000.0 + i * DT + 0.002) for i in range(50)]
    c = PtsClock(live_edge=True)
    rows = feed(c, frames)
    assert not c.settling and c.held <= vs._EDGE_QUIET
    assert c.backlog_s == pytest.approx(0.0, abs=1e-6)
    assert all(abs(r[2] - r[1]) < 1e-6 for r in rows if not r[4])


def test_live_edge_never_holds_longer_than_the_cap():
    # A decoder that keeps finding an earlier edge (3 ms per frame) never goes
    # quiet: the hold still ends at the cap.
    c = PtsClock(live_edge=True)
    t, arr, released_at = 0.0, 1000.0, None
    for _ in range(1000):
        if not c.stamp(t, arr)[2]:
            released_at = arr
            break
        t += DT
        arr += DT - 0.003
    assert released_at is not None and released_at - 1000.0 <= vs._EDGE_MAX_WAIT + DT


def test_live_edge_timestamps_never_go_backwards_while_draining():
    frames = _backlogged(1.3, decode_s=0.03)
    c = PtsClock(live_edge=True)
    dues = [r[2] for r in feed(c, [(t, a) for t, a, _s in frames]) if not r[4]]
    assert all(b >= a - 1e-9 for a, b in zip(dues, dues[1:]))


# ── the reader around the clock ──────────────────────────────────────────────
class _FakeTime:
    def __init__(self, t):
        self.t = t

    def time(self):
        return self.t

    def sleep(self, s):
        self.t += max(0.0, s)


def _reader(edge, frames, clock):
    """A _PyAvReader without FFmpeg: _next_frame hands out `frames`
    [(pts_ticks, packet_arrival)] and moves the fake clock past each arrival
    by a 4 ms decode."""
    r = vs._PyAvReader.__new__(vs._PyAvReader)
    r._tb = 1 / 90000
    r.clock = PtsClock(live_edge=edge)
    r._pkt_wall = {}
    r._damaged_at = 0.0
    r.corrupt_frames = 0
    r.last_frame_time = 0.0
    it = iter(frames)

    def nxt():
        try:
            ticks, arr = next(it)
        except StopIteration:
            return None
        if edge:
            r._pkt_wall[ticks] = max(arr, clock.t)  # what _next_frame records at demux time
        clock.t = max(clock.t, arr) + 0.004
        return NS(pts=ticks, is_corrupt=False, key_frame=False)

    r._next_frame = nxt
    return r


def test_reader_drops_the_backlog_and_stamps_from_the_packet_arrival(monkeypatch):
    clock = _FakeTime(0.0)
    monkeypatch.setattr(vs, "time", clock)
    frames = [(int(round(t * 90000)), a) for t, a, _s in _backlogged(1.0)]
    r = _reader(True, frames, clock)
    got = []
    while (f := r.read()) is not None:
        got.append((f.pts / 90000, r.last_frame_time))
    assert r.clock.held >= 25  # a second of backlog never reached the consumer
    # stamped from the packet's arrival (send + 1 ms), not from the decode (+ 4 ms)
    assert got and all(abs(ft - (1000.0 + t + 0.001)) < 1e-5 for t, ft in got)


def test_reader_counts_every_loop_point(monkeypatch):
    clock = _FakeTime(0.0)
    monkeypatch.setattr(vs, "time", clock)
    frames = [(int(round(t * 90000)), w) for t, w in looping(1000.0, 35.75, 4, first_pts=30.0)]
    for edge in (False, True):
        clock.t = 0.0
        r = _reader(edge, frames, clock)
        while r.read() is not None:
            pass
        assert r.pts_cuts == 3, edge


def test_videosource_starts_a_new_epoch_at_every_cut(monkeypatch):
    """VideoSource turns each reader cut into a new epoch (the worker resets
    its tracker on it) without a reconnect."""
    cuts_at = {30, 60, 90}

    class Fake:
        name, codec, decode_errors, last_error = "fake", "h264", 0, None

        def __init__(self, _url):
            self.n = 0
            self.pts_cuts = 0
            self.last_frame_time = 0.0
            self.last_corrupt = False

        def read(self):
            if self.n >= 120:
                return None
            self.n += 1
            if self.n in cuts_at:
                self.pts_cuts += 1
            self.last_frame_time = 1000.0 + self.n
            time.sleep(0.002)
            return object()

        def close(self):
            pass

    monkeypatch.setitem(vs._READERS, "pyav", Fake)
    src = vs.VideoSource("rtsp://example/stream", prefer="pyav", max_reconnects=1)
    deadline = time.time() + 15
    while src.alive and time.time() < deadline:
        time.sleep(0.05)
    src.close()
    # two connections (one reconnect, then it gives up), three loop points each
    assert src.cuts == 6
    assert src.epoch == 2 + 6


def test_module_defaults():
    assert vs._PTS_JUMP_SEC == 2.0 and vs._PTS_BACK_SEC == 0.25 and vs._LAG_REANCHOR_SEC == 3.0
    assert vs._LIVE_EDGE is True
