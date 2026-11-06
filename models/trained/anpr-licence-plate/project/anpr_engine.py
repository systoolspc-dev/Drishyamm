"""
anpr_engine.py — the ANPR pipeline as a reusable, importable generator.

`anpr_colab.py` keeps the whole detect -> track -> OCR -> vote loop inside its
`main()`, which makes it impossible to drive from anything other than the CLI.
This module exposes the same pipeline as a generator that yields one annotated
frame at a time, so a UI (see `live_dashboard.py`) can render frames as they are
produced instead of waiting for an `output.mp4` at the end.

The detection logic here mirrors `anpr_colab.py` deliberately — same
preprocessing, same OCR candidate handling, same per-track vote threshold — so
what you see in the dashboard matches what the CLI script produces.

Typical use:

    engine = AnprEngine(EngineConfig(min_votes=3))
    for result in engine.run("videos/clip.mp4"):
        show(result.frame)          # BGR, already annotated
        for hit in result.confirmations:
            print(hit.plate, hit.confidence)
"""

from __future__ import annotations

import os

# Must be set before paddle is imported anywhere.
os.environ.setdefault("FLAGS_enable_pir_api", "0")

import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Iterator, Optional

import cv2
import numpy as np
import requests

import config
from plate_rules import validate_or_correct

# COCO class ids the vehicle model should keep, and how we name them.
# NOTE: COCO has no auto-rickshaw, so an auto is reported as car/bike/truck
# depending on the frame. `train_vehicle_detector.py` exists to fix that; until
# it is trained, treat "auto" as unrepresented rather than mis-reported.
VEHICLE_CLASSES = [2, 3, 5, 7]
V_MAP = {2: "car", 3: "bike", 5: "bus", 7: "truck"}

# Slack (pixels) when testing whether a vehicle box contains a plate box. A
# bike's plate sits flush with the bottom edge of its box, so strict containment
# silently dropped those reads.
CONTAINMENT_PAD = 6

BOX_COLOR_VEHICLE = (0, 255, 0)  # green — tracked vehicle
BOX_COLOR_PLATE = (0, 220, 255)  # yellow — detected plate region
BOX_COLOR_CONFIRMED = (255, 120, 0)  # blue — plate that passed the vote


def default_device() -> str | int:
    """Pick a sensible compute device: Apple Silicon GPU if present, else CPU."""
    override = os.getenv("ANPR_DEVICE")
    if override:
        return int(override) if override.isdigit() else override
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


@dataclass
class EngineConfig:
    """Everything the dashboard exposes as a tunable knob."""

    vehicle_conf: float = 0.35
    plate_conf: float = 0.35
    ocr_min_conf: float = 0.55
    min_votes: int = 3
    ocr_every: int = 2
    device: str | int = field(default_factory=default_device)

    # Side effects are opt-in so the dashboard can be used as a dry-run tester
    # without writing rows into the production database.
    post_to_api: bool = False
    save_crops: bool = True
    camera_id: str = "CAM-01-MAIN"

    max_reconnects: int = 30  # RTSP only: ~1 min of dead stream before giving up


@dataclass
class Confirmation:
    """A plate that collected enough votes to be trusted."""

    plate: str
    confidence: float
    vehicle_type: str
    track_id: int
    frame_idx: int
    crop: np.ndarray
    crop_path: Optional[str] = None
    api_status: Optional[str] = None


@dataclass
class FrameResult:
    """One processed frame, ready to display."""

    frame: np.ndarray  # annotated, BGR
    frame_idx: int
    tracked_vehicles: int
    plate_regions: int
    confirmations: list[Confirmation]
    total_confirmed: int
    fps: float
    source_total_frames: int  # 0 when the source is a live stream


_MODEL_CACHE: dict = {}


def load_models(device: str | int):
    """Load (and memoise) the two YOLO models and the OCR reader.

    Kept module-level so repeated Streamlit reruns reuse the same weights
    instead of paying the multi-second load on every interaction.
    """
    key = str(device)
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    from paddleocr import PaddleOCR
    from ultralytics import YOLO

    vehicle_model = YOLO(config.VEHICLE_MODEL)
    plate_model = YOLO(config.PLATE_MODEL)
    ocr = PaddleOCR(lang="en", enable_mkldnn=False)

    _MODEL_CACHE[key] = (vehicle_model, plate_model, ocr)
    return _MODEL_CACHE[key]


def preprocess(crop: np.ndarray) -> Optional[np.ndarray]:
    """Upscale small crops and equalise lighting before OCR."""
    if crop is None or crop.size == 0:
        return None
    h, w = crop.shape[:2]
    if max(h, w) < 200:
        crop = cv2.resize(crop, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
    elif max(h, w) < 320:
        crop = cv2.resize(crop, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def draw_label(frame, x1, y1, text, color, above=True):
    """Filled label strip so text stays readable over any background."""
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale, thickness = 0.6, 2
    (tw, th), _ = cv2.getTextSize(text, font, scale, thickness)
    y_text = y1 - 8 if above else y1 + th + 8
    cv2.rectangle(frame, (x1, y_text - th - 6), (x1 + tw + 6, y_text + 4), color, -1)
    cv2.putText(frame, text, (x1 + 3, y_text), font, scale, (0, 0, 0), thickness)


class AnprEngine:
    def __init__(self, cfg: Optional[EngineConfig] = None):
        self.cfg = cfg or EngineConfig()
        self.vehicle_model, self.plate_model, self.ocr = load_models(self.cfg.device)

    # -- OCR ---------------------------------------------------------------
    def read_plate(self, crop: np.ndarray) -> tuple[Optional[str], float]:
        """OCR a plate crop, then run it through the Indian-plate rules.

        Handles both the PaddleOCR 3.x dict output and the legacy nested-list
        output, same as the CLI script.
        """
        img = preprocess(crop)
        if img is None:
            return None, 0.0
        try:
            result = self.ocr.predict(img)
        except AttributeError:
            result = self.ocr.ocr(img)
        if not result or not result[0]:
            return None, 0.0

        res = result[0]
        pairs = []
        try:
            for t, s in zip(res["rec_texts"], res["rec_scores"]):
                if t and t.strip() and float(s) >= self.cfg.ocr_min_conf:
                    pairs.append((t, float(s)))
        except (KeyError, TypeError, IndexError):
            if isinstance(res, (list, tuple)):
                for line in res:
                    try:
                        if float(line[1][1]) >= self.cfg.ocr_min_conf:
                            pairs.append((line[1][0], float(line[1][1])))
                    except (IndexError, TypeError):
                        continue

        if not pairs:
            return None, 0.0

        # Best single line, plus the concatenation of all lines (plates are
        # often split across two rows).
        cands = [max(pairs, key=lambda p: p[1])]
        if len(pairs) > 1:
            cands.append(("".join(t for t, _ in pairs), sum(s for _, s in pairs) / len(pairs)))
        fixed = [(validate_or_correct(t), c) for t, c in cands]
        fixed = [(p, c) for p, c in fixed if p]
        if not fixed:
            return None, 0.0
        return max(fixed, key=lambda x: x[1])

    # -- API ---------------------------------------------------------------
    def send_to_api(self, hit: Confirmation) -> str:
        """POST the crop then the detection row. Returns a short status string."""
        base_url = config.API_BASE_URL.rstrip("/")
        headers = {"Bypass-Tunnel-Reminder": "true"}
        evidence_url = None

        try:
            ok, buf = cv2.imencode(".jpg", hit.crop)
            if ok:
                files = {"file": (f"{hit.plate}.jpg", buf.tobytes(), "image/jpeg")}
                r = requests.post(
                    f"{base_url}/api/v1/upload-evidence",
                    files=files,
                    headers=headers,
                    timeout=15,
                )
                if r.status_code == 200:
                    evidence_url = r.json().get("evidence_url")
        except Exception as e:
            return f"crop upload failed: {e}"

        payload = {
            "camera_id": self.cfg.camera_id,
            "plate_number": hit.plate,
            "vehicle_type": hit.vehicle_type,
            "confidence": float(hit.confidence),
            "evidence_url": evidence_url,
        }
        try:
            r = requests.post(
                f"{base_url}/api/v1/detections/add",
                json=payload,
                headers=headers,
                timeout=10,
            )
            return "logged" if r.status_code == 200 else f"API {r.status_code}"
        except requests.RequestException as e:
            return f"unreachable: {e}"

    # -- capture -----------------------------------------------------------
    @staticmethod
    def _is_stream(source) -> bool:
        return isinstance(source, int) or str(source).lower().startswith(("rtsp://", "http://", "https://"))

    def _open(self, source, is_stream: bool):
        if is_stream and not isinstance(source, int):
            cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # latest frame, not a backlog
        else:
            cap = cv2.VideoCapture(source)
        return cap

    # -- main loop ---------------------------------------------------------
    def run(self, source) -> Iterator[FrameResult]:
        """Process `source` frame by frame, yielding an annotated FrameResult.

        `source` may be a file path, an rtsp:// URL, or an int webcam index.
        The caller controls the pace — simply stop iterating to stop the run.
        """
        cfg = self.cfg
        is_stream = self._is_stream(source)

        cap = self._open(source, is_stream)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open source: {source}")

        total_frames = 0 if is_stream else int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        if cfg.save_crops:
            os.makedirs("static/crops", exist_ok=True)

        votes: dict[int, Counter] = defaultdict(Counter)
        # Vehicle class is voted per track, exactly like the plate text. See the
        # note at the attribution site for why a single frame is not enough.
        class_votes: dict[int, Counter] = defaultdict(Counter)
        plate_meta: dict[tuple, dict] = {}
        saved_ids: set[int] = set()
        saved_plates: set[str] = set()
        confirmed_label: dict[int, str] = {}

        frame_idx = 0
        fails = 0
        started = time.time()

        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    if not is_stream:
                        break  # file ended
                    # A dropped packet must not kill the run — reconnect.
                    fails += 1
                    if fails > cfg.max_reconnects:
                        break
                    cap.release()
                    time.sleep(2)
                    cap = self._open(source, is_stream)
                    continue
                fails = 0
                frame_idx += 1

                vres = self.vehicle_model.track(
                    frame,
                    persist=True,
                    classes=VEHICLE_CLASSES,
                    conf=cfg.vehicle_conf,
                    tracker="bytetrack.yaml",
                    device=cfg.device,
                    verbose=False,
                )[0]

                tracks = []
                if vres.boxes is not None and vres.boxes.id is not None:
                    ids = [int(i) for i in vres.boxes.id.tolist()]
                    cls_ids = [int(c) for c in vres.boxes.cls.tolist()]
                    for (x1, y1, x2, y2), cid, cls_id in zip(vres.boxes.xyxy.tolist(), ids, cls_ids):
                        v_class = V_MAP.get(cls_id, "vehicle")
                        tracks.append((x1, y1, x2, y2, cid, v_class))

                        ix1, iy1, ix2, iy2 = map(int, (x1, y1, x2, y2))
                        cv2.rectangle(frame, (ix1, iy1), (ix2, iy2), BOX_COLOR_VEHICLE, 2)
                        if cid in confirmed_label:
                            draw_label(
                                frame, ix1, iy1, f"{confirmed_label[cid]} ({v_class})", BOX_COLOR_CONFIRMED
                            )
                        else:
                            draw_label(frame, ix1, iy1, f"ID {cid} {v_class}", BOX_COLOR_VEHICLE)

                plate_regions = 0
                if frame_idx % cfg.ocr_every == 0 and tracks:
                    pres = self.plate_model(frame, verbose=False, conf=cfg.plate_conf, device=cfg.device)[0]
                    for pb in pres.boxes:
                        px1, py1, px2, py2 = map(int, pb.xyxy[0])
                        plate_regions += 1
                        cv2.rectangle(frame, (px1, py1), (px2, py2), BOX_COLOR_PLATE, 2)

                        # Attribute the plate to the vehicle that contains it.
                        #
                        # This used to take the FIRST containing box (`next(...)`).
                        # In real traffic the vehicle boxes overlap heavily — a car
                        # behind a bike, a bus behind both — so a bike's plate often
                        # landed inside the car's box first and the read was filed
                        # as a car (and the reverse). YOLO returns boxes ordered by
                        # confidence, not by how tightly they fit, so the winner was
                        # effectively arbitrary. That is why plates turned up under
                        # the wrong vehicle-type filter. Take the SMALLEST containing
                        # box instead: the tightest box around a plate is the vehicle
                        # that actually owns it.
                        #
                        # Containment is also no longer strict. A bike's plate sits
                        # on the very bottom edge of its box and often shares a pixel
                        # row with it, which `py2 < y2` rejected outright — the read
                        # was then dropped completely. A few pixels of slack keeps
                        # those, and bikes are exactly the class we were losing.
                        containing = [
                            t
                            for t in tracks
                            if px1 >= t[0] - CONTAINMENT_PAD
                            and py1 >= t[1] - CONTAINMENT_PAD
                            and px2 <= t[2] + CONTAINMENT_PAD
                            and py2 <= t[3] + CONTAINMENT_PAD
                        ]
                        if not containing:
                            continue
                        matched = min(containing, key=lambda t: (t[2] - t[0]) * (t[3] - t[1]))
                        cid, v_class = matched[4], matched[5]
                        if cid in saved_ids:
                            continue

                        crop = frame[max(0, py1 - 5) : py2 + 5, max(0, px1 - 5) : px2 + 5].copy()
                        if crop.size == 0:
                            continue
                        plate, conf = self.read_plate(crop)
                        if not plate:
                            continue

                        votes[cid][plate] += 1
                        # Vote the vehicle class too. It used to be whichever class
                        # the single highest-OCR-confidence frame happened to carry,
                        # but the detector flickers between car / truck / motorcycle
                        # across frames (an auto-rickshaw flickers worst of all), so
                        # one unlucky frame fixed the vehicle type for the whole
                        # track. A majority across the track is far steadier.
                        class_votes[cid][v_class] += 1
                        key = (cid, plate)
                        if key not in plate_meta or conf > plate_meta[key]["conf"]:
                            plate_meta[key] = {
                                "conf": conf,
                                "crop": crop,
                                "v_class": v_class,
                            }

                # Promote any track that has now cleared the vote threshold.
                confirmations: list[Confirmation] = []
                for cid, counter in list(votes.items()):
                    if cid in saved_ids:
                        continue
                    winner, count = counter.most_common(1)[0]
                    if count < cfg.min_votes:
                        continue

                    saved_ids.add(cid)
                    del votes[cid]
                    confirmed_label[cid] = winner
                    if winner in saved_plates:
                        continue
                    saved_plates.add(winner)

                    meta = plate_meta[(cid, winner)]
                    # Majority class over the whole track, falling back to the
                    # frame's own class if nothing was recorded.
                    cvotes = class_votes.get(cid)
                    voted_class = cvotes.most_common(1)[0][0] if cvotes else meta["v_class"]
                    hit = Confirmation(
                        plate=winner,
                        confidence=meta["conf"],
                        vehicle_type=voted_class,
                        track_id=cid,
                        frame_idx=frame_idx,
                        crop=meta["crop"],
                    )
                    if cfg.save_crops:
                        path = os.path.join("static/crops", f"{winner}.jpg")
                        cv2.imwrite(path, hit.crop)
                        hit.crop_path = path
                    if cfg.post_to_api:
                        hit.api_status = self.send_to_api(hit)
                    confirmations.append(hit)

                elapsed = max(time.time() - started, 1e-6)
                yield FrameResult(
                    frame=frame,
                    frame_idx=frame_idx,
                    tracked_vehicles=len(tracks),
                    plate_regions=plate_regions,
                    confirmations=confirmations,
                    total_confirmed=len(saved_plates),
                    fps=frame_idx / elapsed,
                    source_total_frames=total_frames,
                )
        finally:
            cap.release()
