"""Ledger + store: the per-person 'how many times / how long' logic.

Pure stdlib (no YOLO/torch) — drives observe() with a synthetic clock so the
time-in-state accounting and phone-session open/close are deterministic.
"""
from activity_monitor.ledger import ActivityLedger
from activity_monitor.store import ActivityStore

BASE = 1_000_000.0  # fixed clock base — all offsets land in one local day


def _ledger(tmp_path, **kw):
    store = ActivityStore(tmp_path / "activity.db")
    kw.setdefault("min_present_sec", 0.0)   # test raw accumulation, not the display filter
    return ActivityLedger(store, flush_interval=0.0, **kw), store


def test_time_accumulates_and_phone_session(tmp_path):
    led, store = _ledger(tmp_path)
    for t in (0, 1, 2):
        led.observe("cam1", 1, "working", BASE + t)
    for t in (3, 4, 5):
        led.observe("cam1", 1, "on_phone", BASE + t)
    led.observe("cam1", 1, "working", BASE + 6)  # phone put down → close session

    people = led.people(now=BASE + 6)["people"]
    assert len(people) == 1
    p = people[0]
    assert p["phone_sessions"] == 1
    assert 2.9 <= p["state_seconds"]["working"] <= 3.1
    assert 2.9 <= p["state_seconds"]["on_phone"] <= 3.1

    sessions = store.recent_sessions()
    assert len(sessions) == 1
    assert 2.9 <= sessions[0]["duration_sec"] <= 3.1


def test_first_state_on_phone_opens_session(tmp_path):
    led, store = _ledger(tmp_path)
    led.observe("cam1", 2, "on_phone", BASE + 0)
    led.observe("cam1", 2, "on_phone", BASE + 2)
    led.observe("cam1", 2, "working", BASE + 3)  # close
    assert store.recent_sessions()[0]["duration_sec"] >= 2.9


def test_open_session_time_shows_live(tmp_path):
    led, _ = _ledger(tmp_path)
    led.observe("cam1", 4, "on_phone", BASE + 0)
    led.observe("cam1", 4, "on_phone", BASE + 2)
    # session still open — people() must include the live open time
    p = led.people(now=BASE + 5)["people"][0]
    assert p["on_phone_now"] is True
    assert p["on_phone_seconds"] >= 4.9  # 2s accumulated + 3s live


def test_close_stale_closes_hanging_session(tmp_path):
    led, store = _ledger(tmp_path, session_gap=3.0)
    led.observe("cam1", 3, "on_phone", BASE + 0)
    led.observe("cam1", 3, "on_phone", BASE + 1)  # last_seen = BASE+1
    led.close_stale(BASE + 10)                     # gap 9 > 3 → close at last_seen
    sessions = store.recent_sessions()
    assert len(sessions) == 1
    assert sessions[0]["end_ts"] == BASE + 1


def test_name_keys_person(tmp_path):
    led, _ = _ledger(tmp_path)
    led.observe("cam1", 5, "working", BASE + 0, name="Pranaya")
    led.observe("cam1", 5, "working", BASE + 2, name="Pranaya")
    p = led.people(now=BASE + 2)["people"][0]
    assert p["name"] == "Pranaya"
    assert p["key"] == "Pranaya"


def test_resume_from_store_after_restart(tmp_path):
    led, store = _ledger(tmp_path)
    for t in (0, 1, 2, 3):
        led.observe("cam1", 7, "working", BASE + t)
    led.flush()

    led2 = ActivityLedger(store, flush_interval=0.0)   # fresh process, same DB
    led2.observe("cam1", 7, "working", BASE + 4)        # rolls date → loads today
    p = next(x for x in led2.people(now=BASE + 4)["people"] if x["key"] == "cam1#7")
    assert p["state_seconds"]["working"] >= 2.9


def test_unknown_state_is_ignored(tmp_path):
    led, _ = _ledger(tmp_path)
    led.observe("cam1", 8, "unknown", BASE + 0)
    assert led.people(now=BASE + 0)["total"] == 0
