"""Counting zones: count the room, not the corridor — and don't flicker on the line.

The behaviours locked here are the two the feature exists for:
  * a person OUTSIDE the drawn area must not be counted (that is what makes the
    number mean "this room")
  * a person standing ON the boundary must not toggle the count every frame
    (that is the flicker the feature is meant to remove)
"""
import numpy as np
import pytest

from headcount.zones import Zone, ZoneCounter

W, H = 1280, 720


def box_at(nx, ny, head_px=60):
    """Head box whose BOTTOM-CENTRE sits at normalised (nx, ny)."""
    cx, by = nx * W, ny * H
    return np.array([cx - head_px / 2, by - head_px, cx + head_px / 2, by], dtype=np.float32)


def square(x1, y1, x2, y2, zid="room"):
    return {"id": zid, "name": zid,
            "points": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]}


class TestZoneShape:
    def test_polygon_needs_three_points(self):
        assert Zone.from_config({"id": "z", "points": [[0, 0], [1, 1]]}) is None

    def test_accepts_dict_or_pair_points(self):
        a = Zone.from_config({"id": "a", "points": [[0, 0], [1, 0], [1, 1]]})
        b = Zone.from_config({"id": "b", "points": [{"x": 0, "y": 0}, {"x": 1, "y": 0},
                                                    {"x": 1, "y": 1}]})
        assert a and b and np.allclose(a.points, b.points)

    def test_points_are_clamped_to_the_frame(self):
        z = Zone.from_config({"id": "z", "points": [[-2, 0], [3, 0], [0.5, 2]]})
        assert z.points.min() >= 0.0 and z.points.max() <= 1.0

    def test_contains_uses_the_polygon(self):
        z = Zone.from_config(square(0.2, 0.2, 0.8, 0.8))
        assert z.contains(0.5, 0.5) is True
        assert z.contains(0.05, 0.5) is False


class TestCountingTheRoomNotTheCorridor:
    def test_person_inside_counts(self):
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        assert zc.evaluate("t1", box_at(0.5, 0.6), W, H, 0.0) == "room"

    def test_person_outside_does_not_count(self):
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        assert zc.evaluate("t1", box_at(0.95, 0.5), W, H, 0.0) is None

    def test_no_zones_configured_counts_everyone(self):
        """Opt-in: turning the feature on later must never silently zero a
        camera that was working."""
        zc = ZoneCounter.from_config({"zones": []})
        assert zc.active is False
        assert zc.evaluate("t1", box_at(0.99, 0.99), W, H, 0.0) == "__all__"

    def test_disabled_zone_is_ignored(self):
        z = square(0.2, 0.2, 0.8, 0.9); z["enabled"] = False
        zc = ZoneCounter.from_config({"zones": [z]})
        assert zc.active is False

    def test_anchor_is_bottom_centre_not_middle(self):
        """A head high in frame with feet inside the area must count. Using the
        box centre would wrongly exclude tall/near subjects."""
        zc = ZoneCounter.from_config({"zones": [square(0.0, 0.5, 1.0, 1.0)]})
        b = box_at(0.5, 0.52, head_px=200)      # bottom inside, centre above line
        assert zc.evaluate("t1", b, W, H, 0.0) == "room"

    def test_multiple_zones_report_which_one(self):
        zc = ZoneCounter.from_config({"zones": [square(0.0, 0.0, 0.45, 1.0, "left"),
                                                square(0.55, 0.0, 1.0, 1.0, "right")]})
        assert zc.evaluate("a", box_at(0.2, 0.5), W, H, 0.0) == "left"
        assert zc.evaluate("b", box_at(0.8, 0.5), W, H, 0.0) == "right"


class TestNoFlickerOnTheBoundary:
    """The whole point. A person on the line must hold their state."""

    def test_small_wobble_across_the_edge_keeps_counting(self):
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        assert zc.evaluate("t1", box_at(0.5, 0.5), W, H, 0.0) == "room"
        # drift just outside the right edge, well within a head-width
        for i, t in enumerate([0.1, 0.2, 0.3]):
            got = zc.evaluate("t1", box_at(0.805, 0.5), W, H, t)
            assert got == "room", f"flickered out on wobble {i}"

    def test_clearly_leaving_and_staying_out_stops_the_count(self):
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        zc.evaluate("t1", box_at(0.5, 0.5), W, H, 0.0)
        far = box_at(0.98, 0.5)
        assert zc.evaluate("t1", far, W, H, 1.0) == "room"      # grace begins
        assert zc.evaluate("t1", far, W, H, 1.5) == "room"      # not sustained
        assert zc.evaluate("t1", far, W, H, 2.6) is None        # gone for good

    def test_stepping_back_in_cancels_the_exit_timer(self):
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        zc.evaluate("t1", box_at(0.5, 0.5), W, H, 0.0)
        zc.evaluate("t1", box_at(0.98, 0.5), W, H, 1.0)          # heading out
        assert zc.evaluate("t1", box_at(0.5, 0.5), W, H, 1.2) == "room"
        # timer reset — a later brief excursion must not immediately drop
        assert zc.evaluate("t1", box_at(0.98, 0.5), W, H, 1.4) == "room"

    def test_someone_who_never_entered_is_never_granted_grace(self):
        """Grace is for people who WERE inside. A passer-by outside must not be
        counted even once."""
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        for t in (0.0, 0.5, 1.0, 2.0):
            assert zc.evaluate("stranger", box_at(0.95, 0.5), W, H, t) is None

    def test_deadband_scales_with_head_size(self):
        """A distant (small) head needs a smaller absolute move to count as out
        than a near (large) one."""
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        zc.evaluate("near", box_at(0.5, 0.5, head_px=200), W, H, 0.0)
        zc.evaluate("far", box_at(0.5, 0.5, head_px=20), W, H, 0.0)
        just_out = 0.81
        assert zc.evaluate("near", box_at(just_out, 0.5, 200), W, H, 0.1) == "room"
        # same absolute excursion is already beyond the small head's deadband
        assert zc.evaluate("far", box_at(0.9, 0.5, 20), W, H, 0.1) == "room"  # grace
        assert zc.evaluate("far", box_at(0.9, 0.5, 20), W, H, 3.0) is None

    def test_forget_clears_state(self):
        zc = ZoneCounter.from_config({"zones": [square(0.2, 0.2, 0.8, 0.9)]})
        zc.evaluate("t1", box_at(0.5, 0.5), W, H, 0.0)
        zc.forget("t1")
        assert zc.evaluate("t1", box_at(0.95, 0.5), W, H, 0.1) is None


class TestTrackerHonoursZones:
    """End-to-end through the tracker: the published count must drop people who
    are outside the drawn area, without disturbing furniture logic."""

    def _tracker(self, zones=None):
        from headcount.head_tracker import HeadTracker
        t = HeadTracker(frame_w=W, frame_h=H)
        if zones is not None:
            t.zone_counter = ZoneCounter.from_config({"zones": zones})
        return t

    def test_without_zones_everyone_counts(self):
        t = self._tracker()
        inside, outside = box_at(0.5, 0.5), box_at(0.95, 0.5)
        t.update(np.array([inside, outside]), np.array([0.9, 0.9]), 0.0)
        assert t.confirmed_count == 2

    def test_with_a_zone_only_the_inside_person_counts(self):
        t = self._tracker([square(0.2, 0.2, 0.8, 0.9)])
        inside, outside = box_at(0.5, 0.5), box_at(0.95, 0.5)
        t.update(np.array([inside, outside]), np.array([0.9, 0.9]), 0.0)
        assert t.confirmed_count == 1, "person outside the zone was counted"

    def test_zone_breakdown_reports_per_area(self):
        t = self._tracker([square(0.0, 0.0, 0.45, 1.0, "left"),
                           square(0.55, 0.0, 1.0, 1.0, "right")])
        t.update(np.array([box_at(0.1, 0.5), box_at(0.2, 0.5), box_at(0.8, 0.5)]),
                 np.array([0.9, 0.9, 0.9]), 0.0)
        assert t.counts_by_zone == {"left": 2, "right": 1}

    def test_walking_out_of_the_zone_lowers_the_count_only_once_sustained(self):
        t = self._tracker([square(0.2, 0.2, 0.8, 0.9)])
        t.update(np.array([box_at(0.5, 0.5)]), np.array([0.9]), 0.0)
        assert t.confirmed_count == 1
        # steps clearly out — held briefly, then dropped
        t.update(np.array([box_at(0.97, 0.5)]), np.array([0.9]), 0.4)
        assert t.confirmed_count == 1, "dropped instantly — that is the flicker"
        t.update(np.array([box_at(0.97, 0.5)]), np.array([0.9]), 2.2)
        assert t.confirmed_count == 0
