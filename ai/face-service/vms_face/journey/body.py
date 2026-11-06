"""Body signal for journey fusion: clothing appearance (colour) + optional
OSNet ReID embedding.

Face alone under-performs on CCTV (back of head, distance, low light, same face
across many frames). The body signal adds two things:

  1. **Clothing colour attributes** — upper/lower torso dominant colour, derived
     with OpenCV from the person crop. No model required, works immediately. This
     is the "clothes appearance + colour" boost.
  2. **OSNet ReID embedding** — a 512-d appearance vector from an OSNet ONNX model
     (`settings.body_model_path`). OPTIONAL: when the model file is absent the
     embedder returns None and fusion falls back to face + colour only. Drop an
     osnet ONNX into smart-cam-ai/data/models/ to engage it.

Both the forensic query photo and (once live body-logging is on) each detection
are described the same way, so they're directly comparable.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

# Named colour anchors in RGB. Dominant clothing colour snaps to the nearest.
_COLOR_ANCHORS: dict[str, tuple[int, int, int]] = {
    "black": (20, 20, 20),
    "white": (235, 235, 235),
    "grey": (128, 128, 128),
    "red": (200, 40, 40),
    "orange": (230, 140, 40),
    "yellow": (225, 215, 60),
    "green": (50, 160, 70),
    "blue": (45, 80, 200),
    "navy": (25, 35, 90),
    "purple": (120, 55, 160),
    "pink": (225, 130, 170),
    "brown": (110, 75, 45),
    "beige": (200, 185, 150),
}


@dataclass
class BodyAttributes:
    """Clothing colour description of one person crop."""
    upper_color: str | None = None
    lower_color: str | None = None
    upper_rgb: list[int] = field(default_factory=list)
    lower_rgb: list[int] = field(default_factory=list)

    def to_payload(self) -> dict:
        """Flat dict for the Qdrant appearance payload / journey attributes."""
        out: dict = {}
        if self.upper_color:
            out["upper_color"] = self.upper_color
            out["upper_rgb"] = self.upper_rgb
        if self.lower_color:
            out["lower_color"] = self.lower_color
            out["lower_rgb"] = self.lower_rgb
        return out

    @classmethod
    def from_payload(cls, payload: dict) -> "BodyAttributes":
        return cls(
            upper_color=payload.get("upper_color"),
            lower_color=payload.get("lower_color"),
            upper_rgb=list(payload.get("upper_rgb") or []),
            lower_rgb=list(payload.get("lower_rgb") or []),
        )


def _nearest_color(rgb: tuple[int, int, int]) -> str:
    r, g, b = rgb
    best, best_d = "grey", 1e9
    for name, (ar, ag, ab) in _COLOR_ANCHORS.items():
        d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2
        if d < best_d:
            best, best_d = name, d
    return best


def _dominant_rgb(region: np.ndarray) -> tuple[int, int, int] | None:
    """Median RGB of the region's most saturated/bright pixels (ignores washed-out
    background bleed). region is HxWx3 BGR (OpenCV order)."""
    if region is None or region.size == 0 or region.shape[0] < 4 or region.shape[1] < 4:
        return None
    import cv2  # local import: opencv-python-headless, heavy to import at module load

    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    s = hsv[:, :, 1].astype(np.float32)
    v = hsv[:, :, 2].astype(np.float32)
    # Keep reasonably saturated OR clearly dark/bright pixels (so black/white clothes
    # still register); drop mid-grey low-contrast background.
    mask = (s > 40) | (v < 50) | (v > 205)
    pixels = region.reshape(-1, 3)[mask.reshape(-1)]
    if pixels.shape[0] < 16:
        pixels = region.reshape(-1, 3)
    med = np.median(pixels, axis=0)  # BGR
    b, g, r = (int(med[0]), int(med[1]), int(med[2]))
    return (r, g, b)


def extract_clothing(image_bgr: np.ndarray, *, face_bbox: list[float] | None = None,
                     person_bbox: list[float] | None = None) -> BodyAttributes:
    """Derive upper/lower clothing colour from a person crop.

    Prefer an explicit person_bbox; otherwise estimate the torso from the face
    bbox (torso begins just below the chin, ~3× face width, ~3× face height)."""
    if image_bgr is None or image_bgr.size == 0:
        return BodyAttributes()
    h, w = image_bgr.shape[:2]

    if person_bbox is not None:
        x1, y1, x2, y2 = [int(v) for v in person_bbox]
    elif face_bbox is not None:
        fx1, fy1, fx2, fy2 = [float(v) for v in face_bbox]
        fw, fh = (fx2 - fx1), (fy2 - fy1)
        cx = (fx1 + fx2) / 2.0
        x1 = int(cx - 1.5 * fw); x2 = int(cx + 1.5 * fw)
        y1 = int(fy2); y2 = int(fy2 + 3.0 * fh)
    else:
        # No bbox — treat the whole image as the person crop (forensic upload of a
        # cropped full-body photo).
        x1, y1, x2, y2 = 0, 0, w, h

    x1 = max(0, min(x1, w - 1)); x2 = max(x1 + 1, min(x2, w))
    y1 = max(0, min(y1, h - 1)); y2 = max(y1 + 1, min(y2, h))
    torso = image_bgr[y1:y2, x1:x2]
    if torso.size == 0:
        return BodyAttributes()

    th = torso.shape[0]
    upper = torso[: th // 2, :]
    lower = torso[th // 2 :, :]
    attrs = BodyAttributes()
    up = _dominant_rgb(upper)
    if up is not None:
        attrs.upper_rgb = list(up)
        attrs.upper_color = _nearest_color(up)
    lo = _dominant_rgb(lower)
    if lo is not None:
        attrs.lower_rgb = list(lo)
        attrs.lower_color = _nearest_color(lo)
    return attrs


def colour_similarity(a: BodyAttributes, b: BodyAttributes) -> float | None:
    """Agreement in [0,1] between two clothing descriptions, or None when either
    side has no colour data (so fusion can skip the body term cleanly)."""
    parts: list[float] = []
    for a_rgb, b_rgb in ((a.upper_rgb, b.upper_rgb), (a.lower_rgb, b.lower_rgb)):
        if a_rgb and b_rgb:
            d = float(np.linalg.norm(np.array(a_rgb) - np.array(b_rgb)))
            parts.append(max(0.0, 1.0 - d / 441.67))  # 441.67 = max RGB distance
    if not parts:
        return None
    return sum(parts) / len(parts)


def person_bbox_from_face(face_bbox, frame_w: int, frame_h: int) -> list[float]:
    """Estimate a full-person box from a detected FACE box — the detector finds
    faces, not bodies, so body-ReID has to anchor on the face. A standing person
    is roughly ~3.2 face-widths across and extends ~7 face-heights below the face
    top. Clamped to the frame. Imperfect for seated/occluded/partial bodies, but a
    solid anchor that lets OSNet capture clothing + build shape."""
    x1, y1, x2, y2 = [float(v) for v in face_bbox]
    fw = max(1.0, x2 - x1)
    fh = max(1.0, y2 - y1)
    cx = (x1 + x2) / 2.0
    return [
        max(0.0, cx - fw * 1.6),
        max(0.0, y1 - fh * 0.4),
        min(float(frame_w), cx + fw * 1.6),
        min(float(frame_h), y2 + fh * 7.0),
    ]


# ─── OSNet ReID embedding (optional) ─────────────────────────────────────────
class BodyEmbedder:
    """Lazy OSNet ONNX body-embedding runtime. Absent model → disabled (None)."""

    _instance: "BodyEmbedder | None" = None

    def __init__(self) -> None:
        self._session = None
        self._input_name = None
        self._loaded = False

    @classmethod
    def shared(cls) -> "BodyEmbedder":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def enabled(self) -> bool:
        self._ensure_loaded()
        return self._session is not None

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        path = getattr(settings, "body_model_path", "") or ""
        if not path:
            log.info("body OSNet model not configured; clothing-colour fusion only")
            return
        import os
        if not os.path.exists(path):
            log.info("body OSNet model file absent; clothing-colour fusion only", path=path)
            return
        try:
            import onnxruntime as ort
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            self._session = ort.InferenceSession(path, providers=providers)
            self._input_name = self._session.get_inputs()[0].name
            log.info("body OSNet model loaded", path=path)
        except Exception as e:  # pragma: no cover - depends on optional model
            log.warning("body OSNet model failed to load; clothing-colour fusion only", err=str(e))
            self._session = None

    def embed(self, image_bgr: np.ndarray, *, person_bbox: list[float] | None = None) -> list[float] | None:
        """OSNet appearance embedding of the person crop, L2-normalised, or None
        when the model is unavailable / the crop is empty."""
        self._ensure_loaded()
        if self._session is None or image_bgr is None or image_bgr.size == 0:
            return None
        import cv2
        crop = image_bgr
        if person_bbox is not None:
            x1, y1, x2, y2 = [int(v) for v in person_bbox]
            h, w = image_bgr.shape[:2]
            x1 = max(0, min(x1, w - 1)); x2 = max(x1 + 1, min(x2, w))
            y1 = max(0, min(y1, h - 1)); y2 = max(y1 + 1, min(y2, h))
            crop = image_bgr[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        # OSNet standard input: 256x128, RGB, ImageNet-normalised, NCHW.
        img = cv2.resize(crop, (128, 256))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        img = (img - mean) / std
        blob = np.transpose(img, (2, 0, 1))[None, ...].astype(np.float32)
        out = self._session.run(None, {self._input_name: blob})[0][0]
        v = np.asarray(out, dtype=np.float32)
        n = float(np.linalg.norm(v))
        if n == 0.0:
            return None
        return (v / n).tolist()
