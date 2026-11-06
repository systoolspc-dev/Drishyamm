"""Footfall counting line at any angle — pure tracker logic, fake clock.

Run inside the ai container (no GPU, no Redis, no Postgres needed):

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_footfall_line -v
"""
from __future__ import annotations

import asyncio
import unittest
import uuid
from unittest import mock

from vms_face.services import footfall
from vms_face.services.footfall import FootfallConfig, FootfallRegistry, parse_line

W, H = 1000, 1000
CAM = uuid.uuid4()
TENANT = uuid.uuid4()


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def registry_with(block: dict) -> FootfallRegistry:
    reg = FootfallRegistry()
    cfg = FootfallConfig.from_camera_config({"footfall": {"enabled": True, **block}})
    asyncio.run(reg.configure_camera(CAM, TENANT, cfg))
    return reg


def walk(reg: FootfallRegistry, clock: Clock, path, *, size=(80, 200), anchor="feet", dt=0.2):
    """Feed one person whose anchor point follows `path` (normalised)."""
    w, h = size
    for nx, ny in path:
        px, py = nx * W, ny * H
        if anchor == "feet":
            box = (px - w / 2, py - h, px + w / 2, py, 0.9)
        else:
            box = (px - w / 2, py - h / 2, px + w / 2, py + h / 2, 0.9)
        reg.update(CAM, W, H, [box], anchor=anchor)
        clock.t += dt


def steps(a, b, n=10):
    return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]


def counts(reg: FootfallRegistry) -> tuple[int, int]:
    st = reg._cameras[CAM]
    return st.live_in, st.live_out


class ConfigTest(unittest.TestCase):
    def test_legacy_level_line_reads_as_full_width(self):
        cfg = FootfallConfig.from_camera_config({"footfall": {"line_y_frac": 0.3, "direction": "down_is_in"}})
        self.assertEqual((cfg.ax, cfg.ay, cfg.bx, cfg.by), (0.0, 0.3, 1.0, 0.3))
        self.assertEqual(cfg.direction, "right_is_in")      # below a left->right line
        cfg = FootfallConfig.from_camera_config({"footfall": {"line_y_frac": 0.3, "direction": "up_is_in"}})
        self.assertEqual(cfg.direction, "left_is_in")

    def test_legacy_direction_follows_a_reversed_line(self):
        cfg = FootfallConfig.from_camera_config(
            {"footfall": {"line": {"a": [0.9, 0.5], "b": [0.1, 0.5]}, "direction": "down_is_in"}},
        )
        self.assertEqual(cfg.direction, "left_is_in")       # right->left: below is its left

    def test_default_and_round_trip(self):
        cfg = FootfallConfig.from_camera_config(None)
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.line, {"a": [0.1, 0.6], "b": [0.9, 0.6]})
        again = FootfallConfig.from_camera_config({"footfall": cfg.to_json()})
        self.assertEqual(again.to_json(), cfg.to_json())

    def test_parse_line(self):
        self.assertEqual(parse_line({"a": [-1, 0.2], "b": [2, 0.8]}), (0.0, 0.2, 1.0, 0.8))
        self.assertEqual(parse_line({"x1": 0.1, "y1": 0.1, "x2": 0.5, "y2": 0.9}), (0.1, 0.1, 0.5, 0.9))
        self.assertIsNone(parse_line({"a": [0.5, 0.5], "b": [0.51, 0.5]}))   # too short
        self.assertIsNone(parse_line({"a": [0.5, "x"], "b": [0.6, 0.5]}))
        self.assertIsNone(parse_line(None))


class CrossingTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        patcher = mock.patch.object(footfall.time, "monotonic", self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_diagonal_line_counts_in_and_out_by_side(self):
        # 45-degree line from top-left to bottom-right; its right is below-left.
        line = {"line": {"a": [0.2, 0.2], "b": [0.8, 0.8]}, "direction": "right_is_in"}
        reg = registry_with(line)
        walk(reg, self.clock, steps((0.7, 0.3), (0.3, 0.7)))    # crosses toward the right of a->b
        self.assertEqual(counts(reg), (1, 0))

        reg = registry_with(line)
        walk(reg, self.clock, steps((0.3, 0.7), (0.7, 0.3)))    # the other way
        self.assertEqual(counts(reg), (0, 1))

    def test_swapping_direction_swaps_in_and_out(self):
        reg = registry_with({"line": {"a": [0.2, 0.2], "b": [0.8, 0.8]}, "direction": "left_is_in"})
        walk(reg, self.clock, steps((0.7, 0.3), (0.3, 0.7)))
        self.assertEqual(counts(reg), (0, 1))

    def test_vertical_line(self):
        # Top to bottom: its right (on screen) is the left half of the frame.
        reg = registry_with({"line": {"a": [0.5, 0.1], "b": [0.5, 0.9]}, "direction": "right_is_in"})
        walk(reg, self.clock, steps((0.8, 0.5), (0.2, 0.5), n=12))
        self.assertEqual(counts(reg), (1, 0))

    def test_walking_past_the_end_of_the_segment_does_not_count(self):
        # A short door line on the left; the walker crosses its extension on the right.
        reg = registry_with({"line": {"a": [0.1, 0.5], "b": [0.3, 0.5]}})
        walk(reg, self.clock, steps((0.7, 0.3), (0.7, 0.7)))
        self.assertEqual(counts(reg), (0, 0))

    def test_jitter_on_the_line_does_not_count(self):
        reg = registry_with({"line": {"a": [0.1, 0.5], "b": [0.9, 0.5]}})
        # Box height 200 px -> dead band 16 px; wobble +-10 px around the line.
        walk(reg, self.clock, [(0.5, 0.49), (0.5, 0.51)] * 10)
        self.assertEqual(counts(reg), (0, 0))

    def test_in_then_out_on_one_track_counts_both(self):
        reg = registry_with({"line": {"a": [0.1, 0.5], "b": [0.9, 0.5]}, "direction": "right_is_in"})
        walk(reg, self.clock, steps((0.5, 0.3), (0.5, 0.7)) + steps((0.5, 0.7), (0.5, 0.3)))
        self.assertEqual(counts(reg), (1, 1))

    def test_quick_dither_after_a_count_is_absorbed(self):
        reg = registry_with({"line": {"a": [0.1, 0.5], "b": [0.9, 0.5]}})
        walk(reg, self.clock, steps((0.5, 0.3), (0.5, 0.55), n=5), dt=0.1)   # counts IN at 0.55
        # Step back over the line and forward again inside the cooldown.
        walk(reg, self.clock, [(0.5, 0.5), (0.5, 0.47), (0.5, 0.52), (0.5, 0.56)], dt=0.1)
        self.assertEqual(counts(reg), (1, 0))

    def test_staying_on_the_new_side_counts_once_the_cooldown_ends(self):
        reg = registry_with({"line": {"a": [0.1, 0.5], "b": [0.9, 0.5]}})
        walk(reg, self.clock, steps((0.5, 0.3), (0.5, 0.55), n=5), dt=0.1)
        walk(reg, self.clock, [(0.5, 0.5)] + [(0.5, 0.45)] * 12, dt=0.1)    # really went back out
        self.assertEqual(counts(reg), (1, 1))

    def test_feet_versus_centre_anchor(self):
        # Line at y=0.5. Box 200 px tall whose CENTRE stays above it but whose
        # feet cross: counts with the feet anchor, not with the centre one.
        line = {"line": {"a": [0.1, 0.5], "b": [0.9, 0.5]}}
        path = steps((0.5, 0.35), (0.5, 0.45))   # centre path
        reg = registry_with(line)
        walk(reg, self.clock, path, anchor="center")
        self.assertEqual(counts(reg), (0, 0))
        reg = registry_with(line)
        walk(reg, self.clock, [(x, y + 0.1) for x, y in path], anchor="feet")   # same boxes, feet at y+100 px
        self.assertEqual(counts(reg), (1, 0))

    def test_disabled_gate_counts_nothing(self):
        reg = registry_with({"enabled": False})
        walk(reg, self.clock, steps((0.5, 0.3), (0.5, 0.8)))
        self.assertEqual(counts(reg), (0, 0))


if __name__ == "__main__":
    unittest.main()
