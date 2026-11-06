"""Camera calibration & pinhole projection helpers.

Two operations matter for multi-camera analytics:

  1. **Image → world (ground plane)**: given a pixel (u, v), where is the
     person standing in 2-D campus coordinates? This unlocks map overlays,
     zone analytics, speed estimation, and is the foundation for cross-
     camera ReID gating ("are these two pixels actually the same person on
     the ground?").

  2. **World → image**: given a world point (X, Y, Z), where does it
     project on each camera's image? Useful for predicted-track
     reconciliation and PTZ pre-aiming.

We follow the standard pinhole camera model with a separate distortion
correction step (OpenCV-compatible 5-parameter Brown-Conrady).

Calibration is stored on `Camera.config_json["calibration"]` as JSON; this
module's `CameraCalibration` Pydantic model validates the schema. No DB
migration needed — `Camera.config_json` already exists.

Math
====

Pinhole projection:
    s · [u v 1]ᵀ = K · [R | t] · [X Y Z 1]ᵀ

Where:
    K = [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]      (intrinsic, 3×3)
    R                                               (3×3 world→camera rotation)
    t                                               (3 world→camera translation)

Ground-plane back-projection (z = ground_z):
    1. ray_cam   = K⁻¹ · [u v 1]ᵀ
    2. ray_world = Rᵀ · ray_cam            (R is orthogonal: R⁻¹ = Rᵀ)
    3. cam_origin_world = -Rᵀ · t
    4. λ = (ground_z - cam_origin_world.z) / ray_world.z
    5. world_xyz = cam_origin_world + λ · ray_world
"""
from __future__ import annotations

from typing import Any

import numpy as np
from pydantic import BaseModel, Field, field_validator


class CameraCalibration(BaseModel):
    """Validated calibration loaded from `Camera.config_json["calibration"]`.

    Run OpenCV's `cv2.calibrateCamera` on a chessboard once per physical
    camera to produce these. For multi-camera campus deployments the
    extrinsic [R|t] is found via `solvePnP` against surveyed marker
    positions (chalk crosses on the ground at known X/Y).
    """

    intrinsic_matrix: list[list[float]] = Field(
        ...,
        description="3x3 K matrix: [[fx,0,cx],[0,fy,cy],[0,0,1]]",
    )
    rotation_matrix: list[list[float]] = Field(
        ...,
        description="3x3 world→camera rotation matrix R",
    )
    translation: list[float] = Field(
        ...,
        description="World→camera translation vector t (length 3)",
    )
    distortion: list[float] | None = Field(
        default=None,
        description="OpenCV distortion coeffs [k1, k2, p1, p2, k3]",
    )
    image_width: int = Field(..., gt=0)
    image_height: int = Field(..., gt=0)
    ground_z: float = Field(0.0, description="Z value of the campus ground plane in world coords")
    units: str = Field("meters", description="Free-form unit label, e.g. meters/feet")

    @field_validator("intrinsic_matrix", "rotation_matrix")
    @classmethod
    def _check_3x3(cls, v: list[list[float]]) -> list[list[float]]:
        if len(v) != 3 or any(len(row) != 3 for row in v):
            raise ValueError("matrix must be 3x3")
        return v

    @field_validator("translation")
    @classmethod
    def _check_t(cls, v: list[float]) -> list[float]:
        if len(v) != 3:
            raise ValueError("translation must be length 3")
        return v

    @field_validator("distortion")
    @classmethod
    def _check_dist(cls, v: list[float] | None) -> list[float] | None:
        if v is None:
            return v
        if len(v) not in (4, 5, 8):
            raise ValueError("distortion coeffs must have 4, 5, or 8 elements")
        return v

    # ── numpy accessors ───────────────────────────────────────────────────
    def K(self) -> np.ndarray:
        return np.asarray(self.intrinsic_matrix, dtype=np.float64)

    def R(self) -> np.ndarray:
        return np.asarray(self.rotation_matrix, dtype=np.float64)

    def t(self) -> np.ndarray:
        return np.asarray(self.translation, dtype=np.float64).reshape(3)

    def K_inv(self) -> np.ndarray:
        return np.linalg.inv(self.K())

    def cam_origin_world(self) -> np.ndarray:
        # cam_origin in world = -Rᵀ t  (since world→cam is x_cam = R x_world + t)
        return -self.R().T @ self.t()


# ── projection helpers ─────────────────────────────────────────────────────


def image_to_ground(
    cal: CameraCalibration,
    u: float,
    v: float,
    ground_z: float | None = None,
) -> tuple[float, float, float] | None:
    """Inverse pinhole projection onto the world ground plane.

    Returns (X, Y, Z) in world coordinates, or None if the ray is parallel
    to the ground (numerically: |ray_world.z| < 1e-9, i.e. the camera is
    looking horizontally at the same height as the ground point — the
    intersection is at infinity)."""
    z_plane = ground_z if ground_z is not None else cal.ground_z

    pixel = np.array([float(u), float(v), 1.0], dtype=np.float64)
    ray_cam = cal.K_inv() @ pixel
    # rotate to world coords
    ray_world = cal.R().T @ ray_cam
    cam_origin = cal.cam_origin_world()

    rz = float(ray_world[2])
    if abs(rz) < 1e-9:
        return None
    lam = (z_plane - float(cam_origin[2])) / rz
    if lam < 0:
        # Intersection is *behind* the camera — pixel is above the horizon.
        return None
    world = cam_origin + lam * ray_world
    return float(world[0]), float(world[1]), float(world[2])


def world_to_image(
    cal: CameraCalibration,
    X: float,
    Y: float,
    Z: float,
) -> tuple[float, float] | None:
    """Forward pinhole projection. Returns (u, v) pixel, or None if the
    point is behind the camera or projects outside the image bounds."""
    p_world = np.array([X, Y, Z], dtype=np.float64)
    p_cam = cal.R() @ p_world + cal.t()
    if p_cam[2] <= 1e-9:
        return None
    pix = cal.K() @ p_cam
    u = float(pix[0] / pix[2])
    v = float(pix[1] / pix[2])
    if u < 0 or v < 0 or u >= cal.image_width or v >= cal.image_height:
        return None
    return u, v


def bbox_foot_to_ground(
    cal: CameraCalibration,
    bbox: list[float] | tuple[float, float, float, float],
) -> tuple[float, float, float] | None:
    """Project the foot point of a face/person bounding box (mid-bottom of
    the box) to the ground plane. This is the most useful single-pixel
    summary for cross-camera person-on-the-map analytics."""
    x1, y1, x2, y2 = bbox
    foot_u = (float(x1) + float(x2)) / 2.0
    foot_v = float(y2)
    return image_to_ground(cal, foot_u, foot_v)


def load_calibration(config_json: dict[str, Any] | None) -> CameraCalibration | None:
    """Pull a `CameraCalibration` from the camera's `config_json`.

    Returns None if the camera has no calibration data — callers must then
    fall back to image-space-only analytics."""
    if not config_json:
        return None
    raw = config_json.get("calibration")
    if not raw:
        return None
    try:
        return CameraCalibration.model_validate(raw)
    except Exception:
        return None
