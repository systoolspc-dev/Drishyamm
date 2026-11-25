"""Detection zones (services/detection_zones.py) and camera geometry
(services/geometry.py).

Zones decide which faces/people are processed at all, so normalisation of
the operator-drawn shapes and the point-in-zone test must be exact at the
edges (boundary counts as inside, line half-planes, person = foot point).
Geometry back-projects pixels to the ground plane; the rules protected are
the pinhole math on known camera poses and the "no answer" cases (horizon,
behind camera, invalid calibration).

Run inside the ai container:

    cd /srv/app/face_detection && python -m unittest vms_face.tests.test_core_zones_geometry -v
"""
from __future__ import annotations

import math
import unittest

from pydantic import ValidationError

from vms_face.services.detection_zones import (
    _point_in_polygon,
    _point_on_inside_of_line,
    bbox_allowed,
    bbox_zone,
    normalize_zones,
)
from vms_face.services.geometry import (
    CameraCalibration,
    bbox_foot_to_ground,
    image_to_ground,
    load_calibration,
    world_to_image,
)


def pts(*xy):
    return [{"x": x, "y": y} for x, y in xy]


SQUARE = pts((0.2, 0.2), (0.6, 0.2), (0.6, 0.6), (0.2, 0.6))
# A "U" shape: the notch (0.4..0.6, 0.0..0.6) is outside.
U_SHAPE = pts((0.2, 0.0), (0.4, 0.0), (0.4, 0.6), (0.6, 0.6), (0.6, 0.0), (0.8, 0.0), (0.8, 0.8), (0.2, 0.8))


class NormalizeZonesTest(unittest.TestCase):
    def test_non_list_input_gives_no_zones(self):
        for raw in (None, {}, "zones", 3):
            self.assertEqual(normalize_zones(raw), [])

    def test_disabled_and_malformed_zones_are_dropped(self):
        raw = [
            {"enabled": False, "points": SQUARE},
            "not a dict",
            {"points": "nope"},
            {"points": pts((0.1, 0.1), (0.2, 0.2))},              # 2 points: not a polygon
            {"points": SQUARE},
        ]
        z = normalize_zones(raw)
        self.assertEqual(len(z), 1)
        self.assertEqual(z[0]["id"], "zone-5")

    def test_coordinates_are_clamped_and_junk_points_skipped(self):
        raw = [{"points": [{"x": -1, "y": 2}, {"x": "0.5", "y": 0.5}, {"x": float("nan"), "y": 0.1},
                           {"x": None, "y": 0.1}, "pt", {"x": 1.5, "y": 0.0}]}]
        z = normalize_zones(raw)[0]
        self.assertEqual(z["points"], pts((0.0, 1.0), (0.5, 0.5), (1.0, 0.0)))

    def test_at_most_8_zones_and_24_points(self):
        many = [{"points": [{"x": i / 30, "y": (i % 2) / 2} for i in range(30)]} for _ in range(12)]
        z = normalize_zones(many)
        self.assertEqual(len(z), 8)
        self.assertEqual(len(z[0]["points"]), 24)

    def test_line_keeps_two_points_and_a_side(self):
        z = normalize_zones([{"shape": "line", "points": pts((0, 0.5), (1, 0.5), (0.3, 0.3)), "side": "right"}])[0]
        self.assertEqual(z["shape"], "line")
        self.assertEqual(len(z["points"]), 2)
        self.assertEqual(z["side"], "right")

    def test_unknown_side_defaults_to_left(self):
        z = normalize_zones([{"shape": "line", "points": pts((0, 0.5), (1, 0.5)), "side": "up"}])[0]
        self.assertEqual(z["side"], "left")

    def test_unknown_shape_becomes_polygon(self):
        self.assertEqual(normalize_zones([{"shape": "circle", "points": SQUARE}])[0]["shape"], "polygon")

    def test_apply_to_is_filtered_and_defaults_to_both(self):
        cases = [
            (None, ["face", "person"]),
            (["person"], ["person"]),
            (["car", "face", "face"], ["face"]),
            (["car"], ["face", "person"]),
            ("face", ["face", "person"]),
        ]
        for apply_to, want in cases:
            with self.subTest(apply_to=apply_to):
                self.assertEqual(normalize_zones([{"points": SQUARE, "applyTo": apply_to}])[0]["applyTo"], want)

    def test_id_and_name_are_truncated(self):
        z = normalize_zones([{"points": SQUARE, "id": "i" * 100, "name": "n" * 200}])[0]
        self.assertEqual((len(z["id"]), len(z["name"])), (64, 80))


class PointInZoneTest(unittest.TestCase):
    def test_inside_and_outside_a_square(self):
        self.assertTrue(_point_in_polygon(0.4, 0.4, SQUARE))
        self.assertFalse(_point_in_polygon(0.1, 0.4, SQUARE))
        self.assertFalse(_point_in_polygon(0.7, 0.7, SQUARE))

    def test_boundary_and_vertices_count_as_inside(self):
        for x, y in ((0.2, 0.4), (0.6, 0.4), (0.4, 0.2), (0.4, 0.6), (0.2, 0.2), (0.6, 0.6)):
            with self.subTest(x=x, y=y):
                self.assertTrue(_point_in_polygon(x, y, SQUARE))

    def test_concave_notch_is_outside(self):
        self.assertFalse(_point_in_polygon(0.5, 0.3, U_SHAPE))
        self.assertTrue(_point_in_polygon(0.3, 0.3, U_SHAPE))
        self.assertTrue(_point_in_polygon(0.7, 0.3, U_SHAPE))
        self.assertTrue(_point_in_polygon(0.5, 0.7, U_SHAPE))

    def test_winding_direction_does_not_matter(self):
        rev = list(reversed(SQUARE))
        for x, y in ((0.4, 0.4), (0.1, 0.1), (0.6, 0.3)):
            self.assertEqual(_point_in_polygon(x, y, rev), _point_in_polygon(x, y, SQUARE))

    def test_line_half_planes(self):
        line = pts((0.0, 0.5), (1.0, 0.5))          # a -> b left to right; y grows downward
        self.assertTrue(_point_on_inside_of_line(0.5, 0.8, line, "left"))
        self.assertFalse(_point_on_inside_of_line(0.5, 0.2, line, "left"))
        self.assertTrue(_point_on_inside_of_line(0.5, 0.2, line, "right"))
        self.assertFalse(_point_on_inside_of_line(0.5, 0.8, line, "right"))

    def test_point_on_the_line_is_inside_for_both_sides(self):
        line = pts((0.0, 0.5), (1.0, 0.5))
        self.assertTrue(_point_on_inside_of_line(0.3, 0.5, line, "left"))
        self.assertTrue(_point_on_inside_of_line(0.3, 0.5, line, "right"))

    def test_degenerate_line_matches_nothing(self):
        self.assertFalse(_point_on_inside_of_line(0.5, 0.5, pts((0.1, 0.1)), "left"))


class BboxZoneTest(unittest.TestCase):
    ZONES = normalize_zones([
        {"id": "z-face", "points": SQUARE, "applyTo": ["face"]},
        {"id": "z-any", "points": pts((0.0, 0.0), (1.0, 0.0), (1.0, 0.3), (0.0, 0.3))},
    ])

    def test_no_zones_means_full_frame(self):
        self.assertEqual(bbox_zone([0, 0, 10, 10], 100, 100, [])["id"], "full-frame")
        self.assertTrue(bbox_allowed([0, 0, 10, 10], 0, 0, []))

    def test_bad_frame_size_or_bbox_is_not_allowed(self):
        self.assertIsNone(bbox_zone([0, 0, 10, 10], 0, 100, self.ZONES))
        self.assertIsNone(bbox_zone(["a", 0, 1, 1], 100, 100, self.ZONES))
        self.assertIsNone(bbox_zone(None, 100, 100, self.ZONES))
        self.assertFalse(bbox_allowed(None, 100, 100, self.ZONES))

    def test_face_uses_the_box_centre(self):
        self.assertEqual(bbox_zone([300, 300, 500, 500], 1000, 1000, self.ZONES)["id"], "z-face")
        self.assertIsNone(bbox_zone([800, 800, 900, 900], 1000, 1000, self.ZONES))

    def test_person_uses_the_foot_point(self):
        # Centre (0.4, 0.45) is in z-face, but z-face is face-only; the foot
        # (0.4, 0.9) is outside every zone, the head is in z-any.
        self.assertIsNone(bbox_zone([300, 0, 500, 900], 1000, 1000, self.ZONES, target="person"))
        self.assertEqual(bbox_zone([300, 0, 500, 250], 1000, 1000, self.ZONES, target="person")["id"], "z-any")

    def test_apply_to_limits_the_target(self):
        self.assertFalse(bbox_allowed([300, 400, 500, 500], 1000, 1000, self.ZONES, target="person"))
        self.assertTrue(bbox_allowed([300, 300, 500, 500], 1000, 1000, self.ZONES, target="face"))

    def test_first_matching_zone_wins(self):
        z = normalize_zones([{"id": "a", "points": SQUARE}, {"id": "b", "points": SQUARE}])
        self.assertEqual(bbox_zone([300, 300, 500, 500], 1000, 1000, z)["id"], "a")

    def test_off_frame_points_are_clamped_onto_the_edge(self):
        z = normalize_zones([{"points": pts((0.9, 0.0), (1.0, 0.0), (1.0, 1.0), (0.9, 1.0))}])
        self.assertTrue(bbox_allowed([1100, 400, 1300, 600], 1000, 1000, z))


# ── geometry ───────────────────────────────────────────────────────────────

K = [[1000.0, 0.0, 640.0], [0.0, 1000.0, 360.0], [0.0, 0.0, 1.0]]


def overhead(height=5.0) -> CameraCalibration:
    """Camera at (0, 0, height) looking straight down."""
    return CameraCalibration(intrinsic_matrix=K, rotation_matrix=[[1, 0, 0], [0, -1, 0], [0, 0, -1]],
                             translation=[0, 0, height], image_width=1280, image_height=720)


def horizontal(height=2.0) -> CameraCalibration:
    """Camera at (0, 0, height) looking along world +Y, level with the ground."""
    return CameraCalibration(intrinsic_matrix=K, rotation_matrix=[[1, 0, 0], [0, 0, -1], [0, 1, 0]],
                             translation=[0, height, 0], image_width=1280, image_height=720)


class GeometryTest(unittest.TestCase):
    def assertXYZ(self, got, want):
        self.assertIsNotNone(got)
        for g, w in zip(got, want):
            self.assertAlmostEqual(g, w, places=6)

    def test_camera_origin_is_minus_rt_t(self):
        self.assertXYZ(tuple(overhead().cam_origin_world()), (0, 0, 5))
        self.assertXYZ(tuple(horizontal().cam_origin_world()), (0, 0, 2))

    def test_principal_point_of_overhead_camera_hits_the_ground_below(self):
        self.assertXYZ(image_to_ground(overhead(), 640, 360), (0, 0, 0))

    def test_off_centre_pixel_scales_with_height(self):
        self.assertXYZ(image_to_ground(overhead(5.0), 840, 360), (1, 0, 0))
        self.assertXYZ(image_to_ground(overhead(10.0), 840, 360), (2, 0, 0))

    def test_world_to_image_inverts_image_to_ground(self):
        cal = overhead()
        for u, v in ((640, 360), (100, 50), (1200, 700), (840, 160)):
            X, Y, Z = image_to_ground(cal, u, v)
            uv = world_to_image(cal, X, Y, Z)
            self.assertAlmostEqual(uv[0], u, places=4)
            self.assertAlmostEqual(uv[1], v, places=4)

    def test_ground_z_override(self):
        self.assertXYZ(image_to_ground(overhead(5.0), 840, 360, ground_z=2.5), (0.5, 0, 2.5))

    def test_pixels_at_or_above_the_horizon_have_no_ground_point(self):
        cal = horizontal()
        self.assertIsNone(image_to_ground(cal, 640, 360))       # parallel ray
        self.assertIsNone(image_to_ground(cal, 640, 100))       # above horizon -> behind camera
        X, Y, Z = image_to_ground(cal, 640, 560)                # below horizon -> ahead
        self.assertAlmostEqual(Y, 10.0, places=6)               # 2 m * 1000 px / 200 px
        self.assertGreater(Y, 0)

    def test_points_behind_or_outside_the_image_do_not_project(self):
        cal = horizontal()
        self.assertIsNone(world_to_image(cal, 0, -5, 0))        # behind
        self.assertIsNone(world_to_image(cal, 100, 1, 0))       # far off to the side
        self.assertIsNotNone(world_to_image(cal, 0, 10, 0))

    def test_bbox_foot_point_is_bottom_centre(self):
        cal = overhead()
        self.assertXYZ(bbox_foot_to_ground(cal, [740, 0, 940, 360]), image_to_ground(cal, 840, 360))

    def test_invalid_calibrations_are_refused(self):
        good = overhead().model_dump()
        bad = [
            {**good, "intrinsic_matrix": [[1, 0], [0, 1]]},
            {**good, "rotation_matrix": [[1, 0, 0], [0, 1, 0]]},
            {**good, "translation": [0, 0]},
            {**good, "distortion": [0.1] * 6},
            {**good, "image_width": 0},
        ]
        for b in bad:
            with self.assertRaises(ValidationError):
                CameraCalibration.model_validate(b)
        for n in (4, 5, 8):
            CameraCalibration.model_validate({**good, "distortion": [0.0] * n})

    def test_load_calibration_returns_none_for_missing_or_invalid(self):
        self.assertIsNone(load_calibration(None))
        self.assertIsNone(load_calibration({}))
        self.assertIsNone(load_calibration({"calibration": None}))
        self.assertIsNone(load_calibration({"calibration": {"intrinsic_matrix": "x"}}))
        cal = load_calibration({"calibration": overhead().model_dump()})
        self.assertIsInstance(cal, CameraCalibration)
        self.assertFalse(math.isnan(cal.K()[0, 0]))


if __name__ == "__main__":
    unittest.main()
