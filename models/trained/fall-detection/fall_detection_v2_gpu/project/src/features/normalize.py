"""Turn a (17,3) keypoint array into a fixed-length, camera-invariant feature
vector for one person in one frame.

This module is the core improvement over Alam et al. (2024). Their method used
raw normalized coordinates with HARD-CODED thresholds (a fixed "bed line", a
fixed x-spread), so it broke whenever the camera moved. We instead make the
features invariant to where the person is and how big they appear:

  * TRANSLATION invariant: center all keypoints on the mid-hip.
  * SCALE invariant: divide by torso length (mid-shoulder to mid-hip distance),
    so a person 3m from the camera looks the same as one 8m away.

We deliberately do NOT rotation-normalize: body ORIENTATION (upright vs
horizontal) is exactly the fall signal we want to keep.

We then add a few compact, physically-meaningful features that directly encode
"how horizontal / collapsed is this body", which the temporal model reads over
time to distinguish a fall (fast transition to horizontal, then still) from
deliberately lying down (slow, controlled).
"""
from __future__ import annotations
import math
import numpy as np

import config

KP = config.KP
_L_SH, _R_SH = KP["left_shoulder"], KP["right_shoulder"]
_L_HIP, _R_HIP = KP["left_hip"], KP["right_hip"]
_L_ANK, _R_ANK = KP["left_ankle"], KP["right_ankle"]


def _valid(kp_row: np.ndarray) -> bool:
    return kp_row[2] >= config.KP_CONF_THRESHOLD


def _midpoint(kps: np.ndarray, a: int, b: int) -> np.ndarray | None:
    """Mean (y,x) of two keypoints if either is reliable, else None."""
    va, vb = _valid(kps[a]), _valid(kps[b])
    if va and vb:
        return (kps[a, :2] + kps[b, :2]) / 2.0
    if va:
        return kps[a, :2].copy()
    if vb:
        return kps[b, :2].copy()
    return None


def trunk_angle_deg(kps: np.ndarray) -> float | None:
    """Angle of the torso from vertical, in degrees.

    ~0 = standing upright, ~90 = lying horizontal. Returns None if the torso
    keypoints are not reliable enough to measure. Used both as a feature and
    for the runtime 'stayed-down' confirmation check.
    """
    hip = _midpoint(kps, _L_HIP, _R_HIP)
    sho = _midpoint(kps, _L_SH, _R_SH)
    if hip is None or sho is None:
        return None
    dy = sho[0] - hip[0]   # image y grows downward; upright -> shoulders above hips -> dy<0
    dx = sho[1] - hip[1]
    if dy == 0 and dx == 0:
        return None
    # angle from the vertical axis
    angle = math.degrees(math.atan2(abs(dx), abs(dy)))
    return angle


def is_horizontal(kps: np.ndarray) -> bool:
    a = trunk_angle_deg(kps)
    return a is not None and a >= config.HORIZONTAL_TRUNK_ANGLE


def leg_angle_deg(kps: np.ndarray) -> float | None:
    """Angle of the legs (hip -> ankle) from vertical, in degrees.
    ~0 = legs vertical (standing / bending over on planted feet),
    ~90 = legs horizontal (lying on the ground). Returns None if the leg
    keypoints aren't reliable enough to measure."""
    hip = _midpoint(kps, _L_HIP, _R_HIP)
    ank = _midpoint(kps, _L_ANK, _R_ANK)
    if hip is None or ank is None:
        return None
    dy = ank[0] - hip[0]
    dx = ank[1] - hip[1]
    if dy == 0 and dx == 0:
        return None
    return math.degrees(math.atan2(abs(dx), abs(dy)))


def is_grounded(kps: np.ndarray) -> bool:
    """Is the body actually on the ground (vs standing / bent over)?

    Discriminates a real fall from bending/crouching/shoveling: a fallen person
    has HORIZONTAL legs, while someone bending forward keeps their legs VERTICAL
    (feet planted, hips up). Returns True when the legs are NOT confidently
    vertical — i.e. we only veto a fall when we can clearly see upright legs.
    If the legs can't be measured (occluded), returns True so we don't suppress
    a genuine fall (the classifier still governs)."""
    a = leg_angle_deg(kps)
    if a is None:
        return True
    return a >= config.LEG_VERTICAL_MAX_ANGLE


def _body_center_and_scale(kps: np.ndarray):
    """Return (center_yx, scale). Robust to missing torso keypoints."""
    center = _midpoint(kps, _L_HIP, _R_HIP)
    sho = _midpoint(kps, _L_SH, _R_SH)

    valid = kps[kps[:, 2] >= config.KP_CONF_THRESHOLD][:, :2]
    if center is None:
        center = valid.mean(axis=0) if len(valid) else np.array([0.5, 0.5])

    scale = None
    if sho is not None:
        scale = float(np.linalg.norm(sho - center))
    if not scale or scale < 1e-3:
        # fallback: spread of all valid keypoints
        if len(valid) >= 2:
            scale = float(np.linalg.norm(valid.std(axis=0)) + 1e-3)
        else:
            scale = 1.0
    return center, scale


def extract_features(kps: np.ndarray) -> np.ndarray:
    """(17,3) keypoints -> 1-D feature vector for one person in one frame.

    Layout:
      [0:34]  17 keypoints x (x, y), centered on hip & scaled by torso
      [34]    sin(trunk_angle)   |  orientation, continuous & wrap-safe
      [35]    cos(trunk_angle)   |
      [36]    bbox aspect ratio (width/height of the pose)  -> >1 when lying
      [37]    vertical position of the body center in the frame [0,1]
      [38]    mean keypoint confidence (data-quality signal)
    """
    kps = np.asarray(kps, dtype=np.float32)
    center, scale = _body_center_and_scale(kps)

    # centered + scaled coords, reordered to (x, y) for readability
    rel = (kps[:, :2] - center) / scale          # (17, 2) in (y, x)
    coords = np.empty((config.N_KEYPOINTS, 2), dtype=np.float32)
    coords[:, 0] = rel[:, 1]                      # x
    coords[:, 1] = rel[:, 0]                      # y
    # zero-out unreliable keypoints so garbage detections don't dominate
    unreliable = kps[:, 2] < config.KP_CONF_THRESHOLD
    coords[unreliable] = 0.0
    flat = coords.reshape(-1)                     # (34,)

    angle = trunk_angle_deg(kps)
    if angle is None:
        sin_a = cos_a = 0.0
    else:
        rad = math.radians(angle)
        sin_a, cos_a = math.sin(rad), math.cos(rad)

    valid = kps[kps[:, 2] >= config.KP_CONF_THRESHOLD][:, :2]
    if len(valid):
        ys, xs = valid[:, 0], valid[:, 1]
        height = max(float(ys.max() - ys.min()), 1e-3)
        width = float(xs.max() - xs.min())
        aspect = width / height                  # >1 when lying/wide
        vpos = float(center[0])                  # 0=top of frame, 1=bottom
    else:
        aspect, vpos = 0.0, 0.5

    mean_conf = float(kps[:, 2].mean())

    extra = np.array([sin_a, cos_a, aspect, vpos, mean_conf], dtype=np.float32)
    return np.concatenate([flat, extra]).astype(np.float32)


# Number of features produced per frame (used to shape the model input).
N_FEATURES = 34 + 5
