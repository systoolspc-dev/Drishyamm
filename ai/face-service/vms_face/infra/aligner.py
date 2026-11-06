from __future__ import annotations

import numpy as np

# insightface ships a battle-tested 5-point landmark aligner that produces
# the exact ArcFace-canonical 112x112 crop. AdaFace was trained on the same
# alignment so we reuse it across recognizers.
try:
    from insightface.utils import face_align as _face_align
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "insightface is required for face alignment. pip install insightface"
    ) from e


def norm_crop(
    frame_bgr: np.ndarray,
    landmarks_5: np.ndarray,
    image_size: int = 112,
) -> np.ndarray:
    """Affine-warp `frame_bgr` so the 5-point landmark configuration is mapped
    to the canonical ArcFace template at `image_size` resolution.

    Inputs:
      frame_bgr   : (H, W, 3) uint8 BGR
      landmarks_5 : (5, 2) float — left_eye, right_eye, nose, left_mouth, right_mouth

    Output:
      (image_size, image_size, 3) uint8 BGR aligned face crop."""
    if landmarks_5 is None or landmarks_5.shape != (5, 2):
        raise ValueError("landmarks_5 must be shape (5, 2)")
    return _face_align.norm_crop(frame_bgr, landmark=landmarks_5, image_size=image_size)
