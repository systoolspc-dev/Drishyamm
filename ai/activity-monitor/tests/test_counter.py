import pytest

from activity_monitor.counter import RollingCounter


def test_median_smooths_spike():
    c = RollingCounter(window=5)
    for v in (3, 3, 3, 3):
        c.update(v)
    # A single-frame spike shouldn't move the median.
    assert c.update(30) == 3


def test_window_one_is_passthrough():
    c = RollingCounter(window=1)
    assert c.update(7) == 7
    assert c.update(2) == 2


def test_value_before_any_update_is_zero():
    assert RollingCounter().value == 0


def test_window_must_be_positive():
    with pytest.raises(ValueError):
        RollingCounter(window=0)


def test_reset_clears_history():
    c = RollingCounter(window=3)
    c.update(5)
    c.reset()
    assert c.value == 0
