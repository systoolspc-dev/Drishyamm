"""
worker.py — live ANPR worker: detect → track → ENHANCE → multi-hypothesis OCR
→ character-level temporal vote → sighting.

Runs on the live CCTV feeds and feeds CONFIRMED plates into Trinetra's existing
sighting -> watchlist -> alert -> Find-a-Vehicle spine.

Pipeline, per camera (one thread each):
    HLS/RTSP (read server-side)                                  [OpenCV/FFMPEG]
      -> fps cap + motion gate (skip static frames)              R10
      -> vehicle detect (YOLOv8n) + ByteTrack persistent ids     [Detector + bytetrack_lite]
      -> plate detect on the same frame (best.pt)                [Detector]
      -> plate crop → ASSESS (blur/night/glare) → restore        [plate_enhance]   R2/R3
         variants: gamma/log/CLAHE, retinex, black-hat, Wiener,
         RL-TV, blind RL, optional Real-ESRGAN
      -> OCR every variant in one batch, per-char confidences    [plate_ocr]
      -> Indian-plate rules: validate + correct each read        [plate_rules]
      -> per-track CHARACTER vote, confidence-weighted           [plate_votes]     R4/R5
      -> confirm when >= MIN_VOTES frames AND agreement >= MIN_AGREEMENT
      -> POST /api/ai/anpr/sighting {plate, camera, coords, ts, confidence,
                                     snapshot (vehicle crop), bbox, meta}
      -> unresolved tracks → data/review/ (human relabel queue)  R13

Two inference engines, chosen automatically (ANPR_ENGINE=auto|torch|onnx):
    torch : ultralytics YOLO on CUDA — the GPU worker image
    onnx  : onnxruntime on the exported .onnx — runs on the plain AI image (CPU)
Tracking is the same bytetrack_lite in both, so behaviour is identical.

Config (all via env, sensible demo defaults):
    ANPR_BACKEND_URL     base URL of the Node backend           (http://trinetra-backend:5000)
    ANPR_EMAIL / ANPR_PASSWORD   operator login the sightings belong to
    ANPR_CAMERAS         csv of monitorIds, or "" = every camera with ANPR on
    ANPR_CAMERA_PREFIXES csv monitorId prefixes to restrict to ("" = no fence)
    ANPR_MAX_CAMERAS     cap concurrent feeds (GPU budget)       (3)
    ANPR_SOURCES         csv name=url overrides (file/rtsp/hls) for cameras (testing)
    ANPR_DEVICE          "0" (GPU) | "cpu"                       (0)
    ANPR_ENGINE          auto | torch | onnx                     (auto)
    ANPR_TARGET_FPS      process at most this many fps/camera    (8)
    ANPR_MOTION_GATE     1 = skip frames without motion          (1)
    ANPR_MIN_VOTES       frames that must contribute reads       (3)
    ANPR_MIN_AGREEMENT   per-character agreement to confirm      (0.9)
    ANPR_MIN_AGREEMENT_SHORT   …for 8-char plates                (0.95)
    ANPR_OCR_EVERY       run plate detect+OCR every Nth processed frame (1)
    ANPR_VEHICLE_CONF / ANPR_PLATE_CONF                          detection thresholds
    ANPR_ORPHAN_PLATES   1 = read plates even with no vehicle box (bikes yolov8n misses)
    ANPR_TRACK_TTL       frames without a detection before a track is finalised (25)
    ANPR_REPOST_SECS     re-post the same plate on a camera at most this often (120)
    ANPR_SAVE_CROPS      1 = write confirmed/review crops under ANPR_DATA_DIR
    ANPR_SR_URL          Real-ESRGAN endpoint for tiny crops (blank = off)
    ANPR_ENH_*           see plate_enhance.py
    ANPR_VEHICLE_CONF_MIN / ANPR_MOTO_CONF / ANPR_AUTO_CONF   per-class vehicle floors (vehicle_types.py)
    ANPR_MAX_ASPECT_MOTO plate aspect ceiling for motorcycle tracks           (7.0)
    ANPR_NIGHT_LUM / ANPR_NIGHT_DET_ENHANCE   night scene threshold + detector pre-pass
    ANPR_PLATE_MAX_SAT / ANPR_STATIC_TTL      coloured-text and burn-in plate filters
    ANPR_POSSIBLE / ANPR_POSSIBLE_MIN_* / ANPR_CONFIRM_2FRAME_* / ANPR_MERGE_WINDOW   recall tiers + merging
    ANPR_SENDER_QUEUE / ANPR_OUTBOX_MAX_ATTEMPTS   sender thread + outbox
    ANPR_WRITE_QUEUE     DiskWriter queue depth (one writer thread per process)   (512)
    ANPR_REVIEW_POLICY   valid | sample | all — which rejected tracks get a review file (valid)
    ANPR_REVIEW_MIN_WEIGHT / ANPR_REVIEW_SAMPLE / ANPR_REVIEW_MAX_PER_DAY   (0.3 / 20 / 4000)
    ANPR_DECODE_ERRORS_MAX   consecutive bad packets before a reconnect (video_source.py) (25)
    ANPR_HALF            1 = FP16 for the torch detectors on CUDA                 (1)
    ANPR_ROI_FILE / ANPR_ROI   per-camera plate region {"<monitorId>": [x0,y0,x1,y1]} as
                         fractions of the frame; file data/calibration/roi.json is re-read
                         within 30 s of an edit (no restart). Detectors only; evidence untouched.
    ── audit 2026-09-02 (120 posted + 48 rejected reads relabelled from the crops) ──
    ANPR_LEN_SWITCH      1 = superstring rule: a VALID read one char longer than a short
                         consensus replaces it (the OCR drops a char on ~7 px/char crops
                         far more often than Gujarat issues 9-char plates)          (1)
    ANPR_LEN_SWITCH_RATIO   min weight of that longer read as a fraction of the winning
                         bucket's weight (lowest correct case measured 0.101)       (0.05)
    ANPR_SHORT_CONFIRM_READERS_AGREE / ANPR_SHORT_CONFIRM_MIN_WEIGHT
                         a < 10-char read is CONFIRMED only when both readers agree this
                         well and the top vote weighs this much; else 'possible'    (0.9 / 0.6)
    ANPR_POSSIBLE_SINGLE_STRICT   1 = a single-frame strict-valid full-length read may be
                         posted as 'possible' when the track ends                   (1)
    ANPR_POSSIBLE_SINGLE_MIN_AGREE / _MIN_CONF / _MIN_WEIGHT   its gates    (0.95 / 0.8 / 0.3)
    ANPR_STATIC_MAX_MOVE_FRAC   a track whose plate moved more than this × its box width
                         between first and last read is never burn-in evidence      (0.5)
    ANPR_MODEL_REGISTRY  models/MODEL_REGISTRY.json — what the shipped weights are
    ANPR_OCR_HUB_DIR     fast-plate-ocr download cache, fingerprinted into meta.models
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import math
import os
import queue
import re
import shutil
import threading
import time
import urllib.parse
from collections import deque

# Thread budget BEFORE numpy/torch/cv2 import: one process runs ~30 camera
# threads, and every BLAS/FFT/OpenCV/torch call would otherwise spin up its own
# machine-sized pool → measured 1000 %+ CPU with the GPU at 17 %.
for _v in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_v, os.getenv("ANPR_MATH_THREADS", "2"))

import cv2
import numpy as np
import requests
from collections import Counter

cv2.setNumThreads(int(os.getenv("ANPR_CV_THREADS", "2")))

import model_registry
import plate_enhance as enh
import plate_verify
import vehicle_types
from bytetrack_lite import ByteTrackLite
from calibrator import Calibrator
from clip_recorder import ClipRecorder
from plate_ocr import PlateOcrEnsemble
from plate_rules import (
    TEMPLATE_PRIOR,
    code_log_prior,
    code_of,
    hamming,
    is_bh_plate,
    is_valid_plate,
    template_of,
    validate_or_correct,
)
from plate_votes import TrackVotes
from video_source import VideoSource, frame_size, redact_url, to_bgr

# ── config ───────────────────────────────────────────────────────────────────
BACKEND = os.getenv("ANPR_BACKEND_URL", "http://trinetra-backend:5000").rstrip("/")
EMAIL = os.getenv("ANPR_EMAIL", "<redacted>")
PASSWORD = os.getenv("ANPR_PASSWORD", "<redacted>")
CAMERAS_ENV = os.getenv("ANPR_CAMERAS", "").strip()
SOURCES_ENV = os.getenv("ANPR_SOURCES", "").strip()
# Which console cameras this worker may read, by monitorId prefix (csv).
# Empty = every camera with plate reading switched on. This used to be a
# hard-coded `corp8_` filter, which meant any camera onboarded from another
# grid — the Sentinel finale feeds included — was silently never read. The
# per-camera ANPR switch (cameras.anpr_enabled) is the real control; the
# prefix list is only a fence for boxes where some recorders must never be
# pulled permanently (a wedged NVR).
CAMERA_PREFIXES = tuple(p.strip() for p in os.getenv("ANPR_CAMERA_PREFIXES", "").split(",") if p.strip())
# Live boxes for the console's Live Plate Reading page (3 Sep 2026). Each
# camera thread hands the vehicles it is tracking — and the plate it has read
# for each — to one OverlayPublisher, which POSTs them to
# /api/internal/ai/overlay: the same ephemeral, service-token channel the face
# service uses (the backend fans it out on the 'ai.live' socket and forgets
# it). Nothing is stored and a dropped frame is just a skipped redraw, so the
# queue is small and overflow is dropped rather than ever slowing a reader.
# Off when there is no SERVICE_TOKEN: the route would only 401.
OVERLAY_ENABLED = os.getenv("ANPR_OVERLAY", "1") == "1" and bool(os.getenv("SERVICE_TOKEN"))
OVERLAY_INTERVAL = float(os.getenv("ANPR_OVERLAY_INTERVAL", "0.33"))  # s between frames, per camera
OVERLAY_MAX_BOXES = 40
SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")
OVERLAY = None  # OverlayPublisher, created per shard next to its Backend
MAX_CAMERAS = int(os.getenv("ANPR_MAX_CAMERAS", "3"))
DEVICE = os.getenv("ANPR_DEVICE", "0")
ENGINE = os.getenv("ANPR_ENGINE", "auto").lower()
TARGET_FPS = float(os.getenv("ANPR_TARGET_FPS", "8"))
MOTION_GATE = os.getenv("ANPR_MOTION_GATE", "1") == "1"
MOTION_MIN = float(os.getenv("ANPR_MOTION_MIN", "1.0"))
# Mean grey-level change (0-255) between consecutive DETECTION thumbnails
# that means a different scene, not a moving vehicle: the loop point of a
# looping feed whose gateway keeps stream time running. 0 disables.
SCENE_CUT_DIFF = float(os.getenv("ANPR_SCENE_CUT_DIFF", "45"))
MIN_VOTES = int(os.getenv("ANPR_MIN_VOTES", "3"))
# 0.7 → 0.9 (audit 2026-09-02, 120 posted reads relabelled from the crops):
# reads confirmed by the MIN_VOTES=3 rule were 20/40 correct, while 10-char
# reads with agreement ≥ 0.95 were 51/59 (86 %), 0.90–0.95 7/11 and
# 0.85–0.90 0/7. Agreement below 0.9 is where the wrong confirmed reads live.
MIN_AGREEMENT = float(os.getenv("ANPR_MIN_AGREEMENT", "0.9"))
# Short (8-char) plates are the shape OCR noise most easily fakes — demand
# stronger agreement before posting one (0.8 → 0.95 with the same audit:
# the 8-char posted reads were 0/4 correct).
MIN_AGREEMENT_SHORT = float(os.getenv("ANPR_MIN_AGREEMENT_SHORT", "0.95"))
# A read SHORTER than the standard 10-char plate (and not Bharat-series) is
# CONFIRMED only when the two OCR readers agreed (mean per-frame character
# agreement ≥ SHORT_CONFIRM_READERS_AGREE) AND the top whole-string vote
# weighs ≥ SHORT_CONFIRM_MIN_WEIGHT; otherwise it waits for the track to end
# and is posted as 'possible' when those rules pass. Measured: 9-char
# confirmed reads were 39 % correct (10-char: 75 %) and agreement alone does
# not separate the two.
SHORT_CONFIRM_READERS_AGREE = float(os.getenv("ANPR_SHORT_CONFIRM_READERS_AGREE", "0.9"))
SHORT_CONFIRM_MIN_WEIGHT = float(os.getenv("ANPR_SHORT_CONFIRM_MIN_WEIGHT", "0.6"))
# SUPERSTRING / length-ambiguity rule (plate_votes.Consensus.longer). The
# voter's per-length buckets let a 9-char bucket win on total weight when the
# OCR dropped ONE character on a ~7 px/char crop — which happens far more
# often than Gujarat issues single-letter-series plates. If a VALID read one
# character longer exists that equals the consensus with a single insertion
# (look-alike aware) and weighs ≥ LEN_SWITCH_RATIO × the winning bucket, the
# longer read is posted instead. Measured on the audit set: GJ11C1758→
# GJ11CL7580 (alt weight 0.43), GJ27E6741→GJ27EC7416 (0.699), GJ01R5592→
# GJ01RS5926 (0.101), GJ24A4516→GJ24AA5169 (0.287), GJ18B8744→GJ18BB7442
# (0.565), GJ18E4884→GJ18EA8844 (0.222): all six fixed, no correct read
# broken at any ratio — 0.05 sits below the lowest correct case (0.101).
LEN_SWITCH = os.getenv("ANPR_LEN_SWITCH", "1") == "1"
LEN_SWITCH_RATIO = float(os.getenv("ANPR_LEN_SWITCH_RATIO", "0.05"))
# Calibrated confidence floor for POSTING (agreement × √OCR-conf × evidence).
# Below it the track is still recorded — into data/review, not the console:
# a 7-px-per-character plate that "agrees" on garbage is not a lead.
MIN_CONF = float(os.getenv("ANPR_MIN_CONF", "0.7"))
MIN_CONF_SHORT = float(os.getenv("ANPR_MIN_CONF_SHORT", "0.8"))
# Render-and-compare VERIFIER (plate_verify.py): the consensus string is
# rendered as a synthetic plate and correlated with the real crop. Below
# VERIFY_MIN the read is not posted (review instead); a valid alternative
# that matches the pixels better by VERIFY_MARGIN replaces the consensus
# when the voter was not sure itself. 0 disables.
VERIFY_MIN = float(os.getenv("ANPR_VERIFY_MIN", str(plate_verify.MIN_SCORE)))
VERIFY_MARGIN = float(os.getenv("ANPR_VERIFY_MARGIN", "0.10"))
# Horizontal sharding across CONTAINERS: "k/n" → this replica owns every
# n-th camera (sorted by id) starting at k. Stack replicas to cover a district.
SHARD = os.getenv("ANPR_SHARD", "0/1")
# BEST-FRAME BUDGET. The first FAST_READS crops of a track are read at once
# (fast vehicles still post); after that, crops are ranked by a quality score
# (sharpness, size, blur, glare) and only the best are read — DRAIN_PER_FRAME
# per frame once the track is MATURE_FRAMES old, the rest when it ends. Same
# OCR budget, strictly better inputs.
FAST_READS = int(os.getenv("ANPR_FAST_READS", "3"))
MATURE_FRAMES = int(os.getenv("ANPR_MATURE_FRAMES", "4"))
DRAIN_PER_FRAME = int(os.getenv("ANPR_DRAIN_PER_FRAME", "1"))
MAX_PENDING = int(os.getenv("ANPR_MAX_PENDING", "8"))
# NATIVE-RESOLUTION plate detection: the plate detector sees a 640-px
# letterbox of a 1080p frame, i.e. a third of the pixels. For vehicle boxes
# narrower than NATIVE_MAX_FRAC × frame width, run it again on the vehicle
# crop at native resolution (batched) — distant traffic gets 2–3× the pixels.
NATIVE_RES_DET = os.getenv("ANPR_NATIVE_RES_DET", "1") == "1"
NATIVE_MAX_FRAC = float(os.getenv("ANPR_NATIVE_MAX_FRAC", "0.30"))
# When every vehicle in view is finished (posted, or out of reads), run the
# full-frame plate pass only on every Nth processed frame. 1 = every frame.
# The full-frame pass is the only one that finds ORPHAN plates (no vehicle
# box — mostly bikes, ~26 % of reads), so measure orphan reads before raising.
IDLE_FULL_EVERY = max(1, int(os.getenv("ANPR_IDLE_FULL_EVERY", "1")))
# A track whose plate detections were weak on average is probably a badge,
# grille or sticker the detector half-liked (seen live: a Tata grille read as
# "GJ18ZT1580" for 3 frames). Below this mean detector confidence it is
# reviewed, not posted — and the officer's "Not a plate" trains the detector.
MIN_DET_CONF = float(os.getenv("ANPR_MIN_DET_CONF", "0.45"))
# Learned confidence (calibrator.py) — replaces the hand formula when present.
CALIBRATOR_PATH = os.getenv(
    "ANPR_CALIBRATOR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "calibrator.json")
)
# Save the full frame (downscaled) with every confirmed plate: that is the
# detector's training image (plate bbox in the JSON) — the OCR trains on the
# plate crop, the detector needs the scene.
SAVE_FRAMES = os.getenv("ANPR_SAVE_FRAMES", "1") == "1"
FRAME_WIDTH = int(os.getenv("ANPR_FRAME_WIDTH", "1280"))
OCR_EVERY = int(os.getenv("ANPR_OCR_EVERY", "1"))
VEHICLE_CONF = float(os.getenv("ANPR_VEHICLE_CONF", "0.35"))
PLATE_CONF = float(os.getenv("ANPR_PLATE_CONF", "0.30"))
ORPHAN_PLATES = os.getenv("ANPR_ORPHAN_PLATES", "1") == "1"
# Geometry sanity for a plate DETECTION (before any OCR). Seen live: the
# camera's OSD caption ("O.N.G.C. Office BS-103_B1", 600×110 px at the top of
# the frame) and Gujarati shop signs are detected as plates. Real plates are
# 1.3:1 (two-row bike) to ~5.5:1 (single row); the OSD lives in the top band.
MAX_ASPECT = float(os.getenv("ANPR_MAX_ASPECT", "6.5"))
MIN_ASPECT = float(os.getenv("ANPR_MIN_ASPECT", "1.2"))
OSD_BAND = float(os.getenv("ANPR_OSD_BAND", "0.07"))  # fraction of frame height
MAX_PLATE_FRAC = float(
    os.getenv("ANPR_MAX_PLATE_FRAC", "0.35")
)  # plate wider than this × frame = not a plate
TRACK_TTL = int(os.getenv("ANPR_TRACK_TTL", "25"))
# Per-track OCR budget (in FRAMES read). A static false detection (sign, OSD,
# parked plate the rules keep rejecting) would otherwise be enhanced + OCR'd
# on EVERY frame forever (seen live: 324 reads of one object). After MAX_READS
# frames without a confirmation the track only waits for its TTL; after
# MAX_TRACK_AGE frames it is finalised regardless of still being seen.
MAX_READS = int(os.getenv("ANPR_MAX_READS", "12"))
MAX_TRACK_AGE = int(os.getenv("ANPR_MAX_TRACK_AGE", "240"))
# Camera sharding across PROCESSES. One Python process is GIL-bound at ~30-40
# ultralytics predicts/s regardless of core count; 30 cameras × 3 fps needs 90.
# Each process owns cams[i::N], its own models (≈300 MB VRAM each) and OCR.
PROCESSES = int(os.getenv("ANPR_PROCESSES", "1"))
# How often to re-read which cameras have plate reading switched ON in the
# console (cameras.anpr_enabled, migration 035). This is what lets an officer
# turn a junction on without an engineer restarting the worker. 0 disables the
# polling and pins the camera set to whatever it was at start-up.
REFRESH_SECS = float(os.getenv("ANPR_CAMERA_REFRESH_SECS", "45"))
REPOST_SECS = int(os.getenv("ANPR_REPOST_SECS", "120"))
MAX_RECONNECTS = int(os.getenv("ANPR_MAX_RECONNECTS", "30"))
SAVE_CROPS = os.getenv("ANPR_SAVE_CROPS", "1") == "1"
DATA_DIR = os.getenv("ANPR_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
# Evidence records: every CONFIRMED plate → data/records/<date>/<camera>/
#   <HHMMSS>_<plate>.jpg (vehicle), _plate.jpg (crop), .json (all metadata),
#   .mp4 (CLIP_PRE s before → CLIP_POST s after, H.264, browser-playable).
# The same files are uploaded to MinIO through the backend so the Find-a-
# Vehicle page can show them; the folder is the offline / forensic copy.
RECORDS_DIR = os.getenv("ANPR_RECORDS_DIR", os.path.join(DATA_DIR, "records"))
CLIPS = os.getenv("ANPR_CLIPS", "1") == "1"

# Per-camera plate region (day-one calibration kit, 13 Sep 2026). A JSON object
# {"<monitorId>": [x0, y0, x1, y1]} in FRACTIONS of the frame (0–1), from
# data/calibration/roi.json (ANPR_ROI_FILE) or the ANPR_ROI env (same JSON,
# wins when set). Everything OUTSIDE the box is blacked out for the DETECTORS
# only — the evidence frame, the crops and every box coordinate stay in the
# full frame — so a camera that also sees a footpath, a shop front or the
# opposite carriageway stops producing vehicle/plate boxes there and the OCR
# budget goes to the lane that matters. The file is re-read within 30 s of an
# edit, no restart. An entry that is not four numbers or covers < 5 % of the
# frame is ignored (logged once).
ROI_PATH = os.getenv("ANPR_ROI_FILE", os.path.join(DATA_DIR, "calibration", "roi.json"))


class RoiTable:
    def __init__(self):
        self._env = os.getenv("ANPR_ROI", "").strip()
        self._table: dict = {}
        self._mtime = object()  # sentinel ≠ any real value → first get() loads
        self._checked = 0.0
        self._bad: set = set()

    def _load(self):
        raw = self._env
        if not raw and os.path.exists(ROI_PATH):
            try:
                with open(ROI_PATH, "r", encoding="utf-8") as f:
                    raw = f.read()
            except OSError as e:
                log(f"plate regions: cannot read {ROI_PATH}: {e}")
                raw = ""
        table = {}
        if raw:
            try:
                d = json.loads(raw)
            except Exception as e:  # noqa: BLE001
                log(f"plate regions: {'ANPR_ROI' if self._env else ROI_PATH} is not JSON ({e}); ignored")
                d = {}
            for cam, box in (d or {}).items():
                try:
                    x0, y0, x1, y1 = [min(1.0, max(0.0, float(v))) for v in box]
                except Exception:  # noqa: BLE001
                    if cam not in self._bad:
                        log(
                            f"plate regions: {cam}: expected [x0, y0, x1, y1] fractions, got {box!r}; ignored"
                        )
                        self._bad.add(cam)
                    continue
                if (x1 - x0) * (y1 - y0) < 0.05:
                    if cam not in self._bad:
                        log(f"plate regions: {cam}: box {box!r} covers < 5 % of the frame; ignored")
                        self._bad.add(cam)
                    continue
                table[str(cam)] = (x0, y0, x1, y1)
        self._table = table
        src = "ANPR_ROI" if self._env else ROI_PATH
        log(
            f"plate regions: {len(table)} camera(s) from {src}"
            if table
            else f"plate regions: none ({src}) — full frame everywhere"
        )

    def get(self, monitor_id):
        now = time.time()
        if now - self._checked >= 30.0:
            self._checked = now
            try:
                m = "env" if self._env else (os.path.getmtime(ROI_PATH) if os.path.exists(ROI_PATH) else None)
            except OSError:
                m = None
            if m != self._mtime:
                self._mtime = m
                self._load()
        return self._table.get(str(monitor_id))


ROI = RoiTable()
CLIP_FPS = float(os.getenv("ANPR_CLIP_FPS", "5"))
CLIP_PRE = float(os.getenv("ANPR_CLIP_PRE", "6"))
CLIP_POST = float(os.getenv("ANPR_CLIP_POST", "4"))
# 1280 wide, not 640: the provider cameras are 1080p and every clip was being
# thrown away at 360p, which is what "the pixels are so low" means (measured on
# the clips on disk, 3 Sep 2026). The ring holds JPEGs, so this is ~4x the
# buffer memory per camera (still single-digit MB) and one bigger JPEG encode
# per captured frame at 1-2 fps. Never upscales: a 640-wide source stays 640.
CLIP_WIDTH = int(os.getenv("ANPR_CLIP_WIDTH", "1280"))
# q80, not 90: the ring JPEG is an intermediate the clip re-encodes with
# H.264, and at 1280 px q80 is ~30 % smaller per frame (measured 0.68-0.70
# of q90 on photographs) at PSNR > 42 dB — no visible loss in the clip.
CLIP_JPEG_Q = int(os.getenv("ANPR_CLIP_JPEG_Q", "80"))
# Playback rate of the written file. The camera yields 1-2 fps; a file encoded
# at 1 fps is valid H.264 that browsers scrub and stall on. Writing constant
# 25 fps and holding each frame for its real duration keeps identical evidence
# and length while playing smoothly. 0 = encode at the capture rate (old way).
CLIP_PLAY_FPS = float(os.getenv("ANPR_CLIP_PLAY_FPS", "25"))
# Idle scene (no tracked vehicle and no motion for CLIP_IDLE_AFTER s): the
# clip ring captures at CLIP_IDLE_FPS instead of CLIP_FPS. Slowed, not
# stopped, so a pre-roll reaching back before a vehicle appeared still has
# footage; motion or a track switches back to full rate. 0 = never slow down.
CLIP_IDLE_FPS = float(os.getenv("ANPR_CLIP_IDLE_FPS", "1"))
CLIP_IDLE_AFTER = float(os.getenv("ANPR_CLIP_IDLE_AFTER", "3"))
CLIP_CRF = int(os.getenv("ANPR_CLIP_CRF", "20"))
STATS_EVERY = float(os.getenv("ANPR_STATS_EVERY", "30"))
DRY_RUN = os.getenv("ANPR_DRY_RUN", "0") == "1"  # no backend: log only
# CLIP POLICY — which confirmed plates get an evidence clip:
#   all    every confirmed plate (demo default: the 30-cam wall records everything)
#   hits   only watchlist hits / near-match alerts (the scale default: clips are
#          the dominant storage cost; a hit is the read an officer will replay)
#   review hits — see CameraWorker._post: a below-floor read is finalised only
#          after TRACK_TTL frames without the vehicle, by which time the clip
#          ring (CLIP_PRE+CLIP_POST+2 s) no longer holds it, so 'review' cannot
#          clip the review queue without a much larger ring; it behaves as 'hits'.
CLIP_POLICY = os.getenv("ANPR_CLIP_POLICY", "all").strip().lower() or "all"
if CLIP_POLICY not in ("all", "hits", "review"):
    CLIP_POLICY = "all"
# Camera health report → POST /api/ai/anpr/camera-health every HEALTH_EVERY s
# (one batch per process) and pursuit priority poll (GET /api/ai/anpr/priority)
# every PRIORITY_POLL s. Both run on ONE aggregator thread per process and
# never touch the frame loops.
HEALTH_EVERY = float(os.getenv("ANPR_HEALTH_EVERY", "60"))
PRIORITY_POLL = float(os.getenv("ANPR_PRIORITY_POLL", "30"))
# While a camera is boosted (pursuit cone): detection fps ×2 capped here,
# FAST_READS+2, MAX_READS+6, DRAIN_PER_FRAME+1.
BOOST_FPS_CAP = float(os.getenv("ANPR_BOOST_FPS_CAP", "6"))
# ── Indian vehicles (vehicles-spec §1): model-driven classes, per-class conf ──
# The vehicle detector runs at VEHICLE_CONF_MIN and the worker filters AFTER
# inference per CANONICAL class (vehicle_types.py): car/bus/truck keep
# VEHICLE_CONF; two-wheelers — distant bikes score 0.2–0.4 on COCO — MOTO_CONF;
# autorickshaw / e-rickshaw / tractor / 'vehicle' AUTO_CONF. Every kept
# detection goes to ByteTrack, whose low-score second pass is what keeps a
# flickery bike attached to its track. track_thresh is unchanged.
VEHICLE_CONF_MIN = float(os.getenv("ANPR_VEHICLE_CONF_MIN", "0.15"))
MOTO_CONF = float(os.getenv("ANPR_MOTO_CONF", "0.18"))
AUTO_CONF = float(os.getenv("ANPR_AUTO_CONF", "0.25"))
# bike front strip 28.5 × 4.5 cm ≈ 6.3:1 — wider than MAX_ASPECT allows
MAX_ASPECT_MOTO = float(os.getenv("ANPR_MAX_ASPECT_MOTO", "7.0"))
# ── Night (vehicles-spec §5) — scene luminance on the motion-gate thumbnail ──
# night = EMA(mean lum) < NIGHT_LUM; when night and DET_ENHANCE both detectors
# see a gamma+CLAHE corrected COPY of the frame; plate crops always come from
# the ORIGINAL frame (the OCR stack does its own lighting work).
NIGHT_LUM = float(os.getenv("ANPR_NIGHT_LUM", "60"))
NIGHT_DET_ENHANCE = os.getenv("ANPR_NIGHT_DET_ENHANCE", "1") == "1"
# ── Not-a-plate filters (vehicles-spec §5b) ──
# Coloured lettering (cyan OSD caption "DELIGHT…", red "BUGATTI" decal) is
# never a plate: plates are black glyphs on white/yellow. Mean HSV saturation
# of the glyph pixels above PLATE_MAX_SAT (and not yellow) → rejected_decal.
PLATE_MAX_SAT = float(os.getenv("ANPR_PLATE_MAX_SAT", "0.45"))
# Burn-in suppressor: a plate box recurring at the same position (IoU ≥
# STATIC_IOU) across ≥ STATIC_MIN_TRACKS distinct tracks over ≥ STATIC_MIN_SPAN
# s with the same read is an OSD caption / decal / railing; with NO valid read
# the match must be tighter (IoU ≥ STATIC_IOU_UNREAD — burn-in is pixel-
# identical, vehicles queuing at a stop line are not). Detections there are
# ignored for STATIC_TTL s. The suppressed detections do NOT refresh a zone
# (a chokepoint would become a permanent blind spot): it expires and only
# fresh recurrence evidence younger than STATIC_TTL re-creates it.
STATIC_TTL = float(os.getenv("ANPR_STATIC_TTL", "1800"))
STATIC_IOU = float(os.getenv("ANPR_STATIC_IOU", "0.6"))
STATIC_IOU_UNREAD = float(os.getenv("ANPR_STATIC_IOU_UNREAD", "0.85"))
STATIC_MIN_TRACKS = int(os.getenv("ANPR_STATIC_MIN_TRACKS", "3"))
STATIC_MIN_SPAN = float(os.getenv("ANPR_STATIC_MIN_SPAN", "300"))
# A vehicle that MOVED through the frame is never burn-in. On a looping
# source (the demo file; Sentinel's government feeds loop too) the same
# vehicle passes the same pixels every loop and _remember_box took that
# recurrence for burn-in — measured on camera demo_recorded: 42 static-text
# zones and 667 suppressed detections. A track whose plate centre travelled
# more than STATIC_MAX_MOVE_FRAC × its box width between its first and last
# read leaves no burn-in evidence (0 disables the check).
STATIC_MAX_MOVE_FRAC = float(os.getenv("ANPR_STATIC_MAX_MOVE_FRAC", "0.5"))
# ── Recall (vehicles-spec §7): two tiers + cross-fragment vote merging ──
# confirmed = today's gates, plus: 2 frames AND agreement ≥ CONFIRM_2FRAME_AGREE
#             AND top vote weight ≥ CONFIRM_2FRAME_WEIGHT (strict-format consensus).
# possible  = strict-format consensus AND top weight ≥ POSSIBLE_MIN_WEIGHT AND
#             ((≥ 2 frames, agreement ≥ 0.7) OR (1 frame, ≥ 2 reads, agreement ≥ 0.8))
#             AND confidence ≥ POSSIBLE_MIN_CONF → posted with meta.tier='possible'.
#             A possible read is a LEAD in the records, never an alert on its own.
POSSIBLE = os.getenv("ANPR_POSSIBLE", "1") == "1"
POSSIBLE_MIN_CONF = float(os.getenv("ANPR_POSSIBLE_MIN_CONF", "0.55"))
POSSIBLE_MIN_WEIGHT = float(os.getenv("ANPR_POSSIBLE_MIN_WEIGHT", "0.5"))
POSSIBLE_MIN_AGREE = float(os.getenv("ANPR_POSSIBLE_MIN_AGREE", "0.7"))
POSSIBLE_MIN_AGREE_1F = float(os.getenv("ANPR_POSSIBLE_MIN_AGREE_1F", "0.8"))
CONFIRM_2FRAME_WEIGHT = float(os.getenv("ANPR_CONFIRM_2FRAME_WEIGHT", "0.9"))
CONFIRM_2FRAME_AGREE = float(os.getenv("ANPR_CONFIRM_2FRAME_AGREE", "0.9"))
# Single-read recall (audit 2026-09-02): rejected tracks written to
# data/review with reason 'valid' (strict-format consensus, top weight ≥ 0.3)
# were 27/46 CORRECT — mostly 1-frame reads with agreement ≈ 1.0 that failed
# the 'possible' rule only because it wants ≥ 2 reads. That is the precision
# the possible tier already posts at, so the rule lost recall for nothing.
# A 1-frame, strict-valid, full-length (≥ 10 chars or Bharat-series)
# consensus with agreement ≥ POSSIBLE_SINGLE_MIN_AGREE and OCR confidence ≥
# POSSIBLE_SINGLE_MIN_CONF is posted as 'possible' (rule possible_single)
# when the track ends. Its weight floor is the review threshold that defined
# the measured population (0.3), not POSSIBLE_MIN_WEIGHT.
POSSIBLE_SINGLE_STRICT = os.getenv("ANPR_POSSIBLE_SINGLE_STRICT", "1") == "1"
POSSIBLE_SINGLE_MIN_AGREE = float(os.getenv("ANPR_POSSIBLE_SINGLE_MIN_AGREE", "0.95"))
POSSIBLE_SINGLE_MIN_CONF = float(os.getenv("ANPR_POSSIBLE_SINGLE_MIN_CONF", "0.8"))
POSSIBLE_SINGLE_MIN_WEIGHT = float(os.getenv("ANPR_POSSIBLE_SINGLE_MIN_WEIGHT", "0.3"))
# ByteTrack fragments a vehicle into several ids; the reads of a new track
# whose first read is Hamming ≤ 1 from a recent track's consensus (within
# MERGE_WINDOW s, box centre within MERGE_DIAG_FRAC of the frame diagonal)
# are MERGED into one vote — fragments of one vehicle become one sighting.
MERGE_WINDOW = float(os.getenv("ANPR_MERGE_WINDOW", "4"))
MERGE_DIAG_FRAC = float(os.getenv("ANPR_MERGE_DIAG_FRAC", "0.25"))
# ── Ingestion reliability (vehicles-spec §6) ──
# Camera threads never talk to the API: _post writes the record and hands the
# payload to ONE sender thread (bounded queue). Any failure to obtain a
# sighting_id lands in data/outbox/ (validation 4xx → outbox/rejected, poison
# files → outbox/failed after OUTBOX_MAX_ATTEMPTS); the flusher patches the
# record JSON's sighting_id on delivery so disk and DB agree.
SENDER_QUEUE = int(os.getenv("ANPR_SENDER_QUEUE", "500"))
OUTBOX_MAX_ATTEMPTS = int(os.getenv("ANPR_OUTBOX_MAX_ATTEMPTS", "10"))
OUTBOX_FLUSH_SECS = float(os.getenv("ANPR_OUTBOX_FLUSH_SECS", "45"))
# ── Storage & performance (storage-perf spec §A) ──
# Every evidence / review file write leaves the camera thread: cv2.imencode
# there (cheap), the bytes go to ONE DiskWriter thread per process with a
# bounded queue (a Windows bind mount measured 26 ms per small file — 5 files
# per posted read was 130 ms of the frame loop). Records / outbox items are
# never dropped (block ≤ WRITE_INLINE_S, then written on the caller's thread
# and counted io_inline); review / confirmed crops are dropped when the queue
# is full (io_dropped_review).
WRITE_QUEUE = int(os.getenv("ANPR_WRITE_QUEUE", "512"))
WRITE_INLINE_S = float(os.getenv("ANPR_WRITE_INLINE_SECS", "2"))
# Review policy — which rejected tracks leave a crop + json in data/review/<date>/:
#   valid   consensus is strict-format valid AND top vote weight ≥ REVIEW_MIN_WEIGHT,
#           plus 1 in REVIEW_SAMPLE of everything else (the trainer still sees junk)
#   sample  1 in REVIEW_SAMPLE of all rejected tracks
#   all     every rejected track (the old behaviour: ~14k files/day)
# REVIEW_MAX_PER_DAY caps the fleet (split evenly across the shard processes; 0 = no cap).
REVIEW_POLICY = os.getenv("ANPR_REVIEW_POLICY", "valid").strip().lower() or "valid"
if REVIEW_POLICY not in ("valid", "sample", "all"):
    REVIEW_POLICY = "valid"
REVIEW_MIN_WEIGHT = float(os.getenv("ANPR_REVIEW_MIN_WEIGHT", "0.3"))
REVIEW_SAMPLE = int(os.getenv("ANPR_REVIEW_SAMPLE", "20"))
REVIEW_MAX_PER_DAY = int(os.getenv("ANPR_REVIEW_MAX_PER_DAY", "4000"))
# FP16 inference for both torch detectors on CUDA (ultralytics predict(half=True)).
HALF = os.getenv("ANPR_HALF", "1") == "1"

HERE = os.path.dirname(os.path.abspath(__file__))
VEHICLE_PT = os.getenv("ANPR_VEHICLE_MODEL", os.path.join(HERE, "models", "yolov8n.pt"))
PLATE_PT = os.getenv("ANPR_PLATE_MODEL", os.path.join(HERE, "models", "best.pt"))
# A fine-tuned OCR (train_ocr.py output) lives here as model.onnx + plate_config.yaml
OCR_MODEL_DIR = os.getenv("ANPR_OCR_MODEL_DIR", os.path.join(HERE, "models", "ocr"))
# What the shipped weights ARE (source, training data, known issues):
# models/MODEL_REGISTRY.json. Its version tags and the file fingerprints of
# the weights in use travel with every sighting (meta.models) — audit
# 2026-09-02: sightings carried no model versions, no track id, no latency.
REGISTRY_PATH = os.getenv("ANPR_MODEL_REGISTRY", os.path.join(HERE, "models", "MODEL_REGISTRY.json"))
# v5: raw OCR output kept beside the normalised plate, superstring rule,
# recalibrated confirm / possible gates, model + track + latency metadata.
PIPELINE_VERSION = "bytetrack-enhance-v5"

# COCO fallback only — the live maps are built from the model's own names
# (Models.__init__ → vehicle_types.trackable_ids / from_detector).
VEHICLE_CLASSES = [2, 3, 5, 7]
# People visible (4 Oct 2026, forensic search): the vehicle detector also runs
# its "person" class (measured 30.3 → 31.8 ms per frame); person boxes are
# COUNTED per detection frame and never tracked, cropped or stored. They are
# dropped from the vehicle path by the per-class floor table (unknown id =
# floor 9.0), so vehicle tracking is unchanged. ANPR_PEOPLE=0 turns it off.
PEOPLE = os.getenv("ANPR_PEOPLE", "1") == "1"
# 0.20: measured 4 Oct on 20 frames (corp8_06 day, corp8_07 night IR) against a
# count by eye: MAE 0.85 people per frame, bias -0.65 (0.35 gave 1.25 / -1.15).
# Chosen on those same 20 frames, so the number is optimistic.
PERSON_CONF = float(os.getenv("ANPR_PERSON_CONF", "0.20"))
# Ceiling on one frame's area-weighted class vote (see the vote site below).
MAX_CLASS_VOTE = 12


def class_floor(canon: str | None) -> float:
    """Per-class post-inference confidence floor (vehicles-spec §1)."""
    if canon in ("car", "bus", "truck"):
        return VEHICLE_CONF
    if canon == "motorcycle":
        return MOTO_CONF
    return AUTO_CONF


def _iou(a, b) -> float:
    iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / union) if union > 0 else 0.0


def _moved_through(first_centre, last_centre, box_w: float, frac: float = STATIC_MAX_MOVE_FRAC) -> bool:
    """Did the plate travel between the track's first and last read? True
    when the two centres are more than frac × the plate box width apart —
    a vehicle that moved through the frame, which is never burn-in (an OSD
    caption, a decal on a parked bus, a railing all sit still). False when
    either centre is unknown or the check is disabled (frac ≤ 0)."""
    if frac <= 0 or first_centre is None or last_centre is None:
        return False
    d = math.hypot(
        float(last_centre[0]) - float(first_centre[0]), float(last_centre[1]) - float(first_centre[1])
    )
    return d > frac * max(1.0, float(box_w))


def _looks_decal(crop: np.ndarray, max_sat: float = PLATE_MAX_SAT) -> bool:
    """Coloured lettering is not a plate (vehicles-spec §5b). Glyph pixels =
    the Otsu minority class of the value channel inside the crop's centre
    (the detector box is padded — the car body around the plate must not
    vote); if their mean saturation exceeds max_sat and their hue is not
    yellow (OpenCV hue 10–40 ≈ 20–80°: commercial plates read orange-yellow
    under warm light), the candidate is a decal / OSD caption. Black-on-
    white, black-on-yellow, white-on-black (inverted), white-on-green (EV)
    and yellow-on-black (rental) plates all pass: their glyphs are
    unsaturated or yellow. Two measured exemptions keep real plates safe:
    the white field of a plate on the colour cameras (corp8_06/10/30) is
    rendered light BLUE at saturation ≈ 0.5 (hue 101–111) — that band never
    counts — and a decal is ONE colour (≥ 80 % of glyph hues within ±12 of
    the median), a cast is not. On 288 confirmed crops this flags the red
    'BUGATTI' decal and the cyan 'DELIGHT' caption and no real plate."""
    try:
        if crop is None or crop.ndim != 3 or crop.shape[0] < 8 or crop.shape[1] < 16:
            return False
        h, w = crop.shape[:2]
        core = crop[
            int(h * 0.15) : max(int(h * 0.15) + 4, int(h * 0.85)),
            int(w * 0.08) : max(int(w * 0.08) + 8, int(w * 0.92)),
        ]
        hsv = cv2.cvtColor(core, cv2.COLOR_BGR2HSV)
        _, m = cv2.threshold(hsv[:, :, 2], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        mask = m > 0
        if mask.mean() > 0.5:
            mask = ~mask
        if int(mask.sum()) < 20:
            return False
        sat = float(hsv[:, :, 1][mask].mean()) / 255.0
        if sat <= max_sat:
            return False
        hue = hsv[:, :, 0][mask]
        med = float(np.median(hue))
        if 8 <= med <= 40 or float(((hue >= 8) & (hue <= 40)).mean()) >= 0.35:
            return False  # yellow / orange: a commercial plate
        if 95 <= med <= 125:
            return False  # blue cast on a white plate (camera white balance)
        d = np.minimum(np.abs(hue - med), 180 - np.abs(hue - med))
        return float((d <= 12).mean()) >= 0.8  # one colour → decal / caption
    except Exception:  # noqa: BLE001 — a filter must never cost a read
        return False


def night_gamma(scene_lum: float) -> float:
    """γ = clamp(log(0.5) / log(scene_lum / 255), 0.4, 1.0): pulls a dark
    scene's mean toward mid-grey, never brightens a lit one (γ ≤ 1)."""
    lum = min(254.0, max(1.0, float(scene_lum)))
    return float(np.clip(math.log(0.5) / math.log(lum / 255.0), 0.4, 1.0))


def night_enhance(frame: np.ndarray, scene_lum: float) -> np.ndarray:
    """Detector pre-pass for dark scenes (vehicles-spec §5): gamma LUT on the
    whole frame, then CLAHE on the luma channel. Returns a NEW image — the
    caller keeps cropping plates from the original frame. YCrCb instead of
    Lab: measured 38 ms vs 78 ms per 1080p frame on the loaded host (the Lab
    round-trip is the expensive part; CLAHE itself is ~12 ms)."""
    gamma = night_gamma(scene_lum)
    lut = ((np.arange(256) / 255.0) ** gamma * 255.0).astype(np.uint8)
    out = cv2.LUT(frame, lut)
    ycc = cv2.cvtColor(out, cv2.COLOR_BGR2YCrCb)
    ycc[:, :, 0] = enh.clahe(ycc[:, :, 0])
    return cv2.cvtColor(ycc, cv2.COLOR_YCrCb2BGR)


def log(*a):
    print(time.strftime("%H:%M:%S"), "[anpr-worker]", *a, flush=True)


def _clip_epoch(ts, fallback: float) -> float:
    """Epoch seconds for the clip recorder from whatever best_ts holds - an
    ISO string (the sighting timestamp), an epoch number, or nothing."""
    if isinstance(ts, (int, float)) and not isinstance(ts, bool):
        return float(ts)
    if isinstance(ts, str) and ts:
        try:
            from datetime import datetime, timezone

            d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return d.timestamp()
        except ValueError:
            pass
    return float(fallback)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def utc_day(ts: float | None = None) -> str:
    """UTC date folder name (records use the container clock, which is UTC)."""
    return time.strftime("%Y-%m-%d", time.gmtime(ts if ts is not None else time.time()))


# ── disk writer (storage-perf spec §A.1) ─────────────────────────────────────
class DiskWriter:
    """ONE thread per process that performs every evidence / review file
    write. Producers hand over (path, payload) where payload is bytes (an
    encoded JPEG), str (JSON text) or a callable(path) (the sender thread's
    record patch — same queue, so it lands AFTER the record it patches).

    put(droppable=False) blocks up to WRITE_INLINE_S when the queue is full,
    then writes on the caller's thread (io_inline) — records / outbox are
    never lost. put(droppable=True) drops on a full queue (io_dropped) and
    logs the drop count at most once a minute."""

    def __init__(self, maxsize: int = WRITE_QUEUE):
        self._q: queue.Queue = queue.Queue(maxsize=max(16, maxsize))
        self._lock = threading.Lock()
        self.dropped = 0  # droppable items discarded (review / confirmed crops)
        self.inline = 0  # must-write items written on the caller's thread
        self.written = 0
        self.errors = 0
        self._drop_log_t = 0.0
        self._drop_log_n = 0
        self._thread = threading.Thread(target=self._loop, daemon=True, name="disk-writer")
        self._thread.start()

    @property
    def qsize(self) -> int:
        return self._q.qsize()

    def put(self, path: str, data, *, droppable: bool = False, timeout: float | None = None):
        item = (path, data)
        if droppable:
            try:
                self._q.put_nowait(item)
            except queue.Full:
                self._dropped_one()
            return
        try:
            self._q.put(item, timeout=WRITE_INLINE_S if timeout is None else timeout)
        except queue.Full:
            with self._lock:
                self.inline += 1
            self._write(path, data)

    def _dropped_one(self):
        with self._lock:
            self.dropped += 1
            self._drop_log_n += 1
            now = time.time()
            due = now - self._drop_log_t >= 60.0
            if due:
                n, self._drop_log_n, self._drop_log_t = self._drop_log_n, 0, now
        if due:
            log(
                f"disk-writer: queue full ({self._q.maxsize}) — dropped {n} review/confirmed file(s) "
                f"in the last minute (total {self.dropped}); records are never dropped"
            )

    def _loop(self):
        while True:
            path, data = self._q.get()
            self._write(path, data)

    def _write(self, path: str, data):
        try:
            if callable(data):
                data(path)
            else:
                binary = isinstance(data, (bytes, bytearray, memoryview))
                try:
                    self._open_write(path, data, binary)
                except FileNotFoundError:
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    self._open_write(path, data, binary)
            with self._lock:
                self.written += 1
        except Exception as e:  # noqa: BLE001 — one failed file must never stop the writer
            with self._lock:
                self.errors += 1
                n = self.errors
            if n <= 5 or n % 100 == 0:
                log(
                    f"disk-writer: write failed #{n} ({os.path.basename(str(path))}): {e.__class__.__name__}: {e}"
                )

    @staticmethod
    def _open_write(path: str, data, binary: bool):
        if binary:
            with open(path, "wb") as f:
                f.write(data)
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(data)


_WRITER: DiskWriter | None = None
_WRITER_LOCK = threading.Lock()


def writer() -> DiskWriter:
    """The process-wide DiskWriter, started on first use (each spawned shard
    imports this module afresh and gets its own)."""
    global _WRITER
    if _WRITER is None:
        with _WRITER_LOCK:
            if _WRITER is None:
                _WRITER = DiskWriter()
    return _WRITER


def _jpeg_bytes(img: np.ndarray | None, quality: int | None = None) -> bytes | None:
    """cv2.imencode on the caller's thread (≈1 ms for a crop) — the WRITE is what blocks."""
    if img is None or img.size == 0:
        return None
    params = [cv2.IMWRITE_JPEG_QUALITY, int(quality)] if quality else []
    ok, buf = cv2.imencode(".jpg", img, params)
    return buf.tobytes() if ok else None


class _ReviewBudget:
    """Per-process daily cap on review files (spec §A.2)."""

    def __init__(self, per_day: int):
        self.per_day = per_day
        self.day: str | None = None
        self.n = 0
        self._lock = threading.Lock()

    def take(self, day: str) -> bool:
        with self._lock:
            if day != self.day:
                self.day, self.n = day, 0
            if self.per_day > 0 and self.n >= self.per_day:
                return False
            self.n += 1
            return True


# the cap is fleet-wide; each shard process owns cams[i::N] so it gets 1/N of it
_REVIEW_CAP_PER_PROC = max(1, REVIEW_MAX_PER_DAY // max(1, PROCESSES)) if REVIEW_MAX_PER_DAY > 0 else 0
_REVIEW_BUDGET = _ReviewBudget(_REVIEW_CAP_PER_PROC)


# ── detection engine ─────────────────────────────────────────────────────────
class Detector:
    """One object detector, torch (ultralytics/CUDA) or onnx (onnxruntime).
    Shared by every camera thread; inference is serialised by a lock (the GPU
    serialises it anyway, and ultralytics predictors are not thread-safe)."""

    def __init__(self, pt_path: str, *, conf: float, classes: list[int] | None, label: str):
        self.conf = conf
        self.classes = classes
        self.label = label
        self._lock = threading.Lock()
        self.kind = None
        self.half = False  # FP16 on CUDA (ANPR_HALF) — torch engine only
        self._prec: dict = {}  # predict() kwargs that select FP16 ({} = FP32)
        self.names: dict[int, str] | None = None  # id → class name (model-driven; None = unknown)
        onnx_path = os.path.splitext(pt_path)[0] + ".onnx"
        if ENGINE in ("auto", "torch"):
            try:
                import torch
                from ultralytics import YOLO

                torch.set_num_threads(int(os.getenv("ANPR_TORCH_THREADS", "4")))
                use_gpu = DEVICE != "cpu" and torch.cuda.is_available()
                if use_gpu or ENGINE == "torch":
                    self.model = YOLO(pt_path)
                    self.device = (int(DEVICE) if DEVICE.isdigit() else DEVICE) if use_gpu else "cpu"
                    self.kind = "torch"
                    self.half = bool(use_gpu and HALF)
                    self.names = self._names_of(getattr(self.model, "names", None))
                    # ultralytics ≥ 8.4 spells FP16 `quantize=16` and warns on
                    # every call about the old `half=`; older releases only know half=
                    if self.half:
                        try:
                            from ultralytics.cfg import DEFAULT_CFG_DICT

                            self._prec = (
                                {"quantize": 16} if "quantize" in DEFAULT_CFG_DICT else {"half": True}
                            )
                        except Exception:  # noqa: BLE001
                            self._prec = {"half": True}
                    # the predictor is built on the FIRST call and keeps its
                    # fp16 setting — the warm-up must already carry it
                    self.model.predict(
                        np.zeros((640, 640, 3), np.uint8), device=self.device, verbose=False, **self._prec
                    )  # warm-up
            except Exception as e:  # noqa: BLE001 — fall through to onnx
                if ENGINE == "torch":
                    raise
                log(f"{label}: torch engine unavailable ({e.__class__.__name__}: {e}); trying onnx")
        if self.kind is None:
            from yolo_onnx import YoloOnnx

            self.model = YoloOnnx(onnx_path, conf=conf, classes=classes, device=DEVICE)
            self.kind = f"onnx/{self.model.provider}"
            self.names = self._names_of(getattr(self.model, "names", None))
        if not self.names:
            # a fine-tune exported with a sidecar (train_vehicle_detector.py writes <model>.names.json)
            side = os.path.splitext(pt_path)[0] + ".names.json"
            if os.path.exists(side):
                try:
                    with open(side, encoding="utf-8") as fh:
                        self.names = self._names_of(json.load(fh))
                except Exception as e:  # noqa: BLE001
                    log(f"{label}: cannot read {os.path.basename(side)}: {e}")
        log(
            f"{label}: engine={self.kind}"
            + (f" half={int(self.half)} (ANPR_HALF={int(HALF)})" if self.kind == "torch" else "")
        )

    @staticmethod
    def _names_of(nm) -> dict[int, str] | None:
        """ultralytics `model.names` (dict id→name), a list, or a JSON sidecar
        ({"0": "car", …} / ["car", …]) → {int id: name}; None when absent."""
        try:
            if isinstance(nm, dict) and nm:
                return {int(k): str(v) for k, v in nm.items()}
            if isinstance(nm, (list, tuple)) and nm:
                return {i: str(v) for i, v in enumerate(nm)}
        except Exception:  # noqa: BLE001
            pass
        return None

    def set_classes(self, classes: list[int] | None):
        """Restrict inference to these class ids (both engines)."""
        self.classes = [int(c) for c in classes] if classes else None
        if self.kind != "torch":
            self.model.classes = set(self.classes) if self.classes else None

    @staticmethod
    def _from_result(r) -> np.ndarray:
        if r.boxes is None or len(r.boxes) == 0:
            return np.zeros((0, 6), np.float32)
        xyxy = r.boxes.xyxy.cpu().numpy().astype(np.float32)
        sc = r.boxes.conf.cpu().numpy().astype(np.float32)[:, None]
        cl = r.boxes.cls.cpu().numpy().astype(np.float32)[:, None]
        return np.concatenate([xyxy, sc, cl], 1)

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        if self.kind == "torch":
            with self._lock:
                r = self.model.predict(
                    frame,
                    conf=self.conf,
                    classes=self.classes,
                    device=self.device,
                    verbose=False,
                    **self._prec,
                )[0]
            return self._from_result(r)
        return self.model(frame)

    def batch(self, images: list[np.ndarray]) -> list[np.ndarray]:
        """Several images in ONE call (torch batches them on the GPU)."""
        if not images:
            return []
        if self.kind == "torch":
            with self._lock:
                rs = self.model.predict(
                    images,
                    conf=self.conf,
                    classes=self.classes,
                    device=self.device,
                    verbose=False,
                    **self._prec,
                )
            return [self._from_result(r) for r in rs]
        return [self.model(im) for im in images]


# ── backend client ───────────────────────────────────────────────────────────
class Backend:
    """Thin authenticated client. Logs in as the operator so every sighting
    lands in that operator's org tenant — the same tenant the console reads.

    SENDER THREAD (vehicles-spec §6): camera threads never call the API for a
    sighting. `submit()` drops the payload on a bounded queue; one sender
    thread per process does login / retry / outbox. A frame loop therefore
    never stalls while the backend restarts.

    OUTBOX: on ANY failure to obtain a sighting_id (connection error, 5xx,
    413 even after slimming, 401 twice, queue full) the payload is written to
    data/outbox/ and re-sent by the flusher until it lands. Validation errors
    (400/422) go to outbox/rejected with the response body and are never
    retried; a file that fails OUTBOX_MAX_ATTEMPTS times moves to
    outbox/failed. When the row exists but the media upload failed, only the
    media is queued (`_media_only`). After delivery the matching record JSON
    (`_record`, written by the camera thread before submit) gets its
    sighting_id patched so disk and DB agree. Keys starting with '_' are
    private bookkeeping and are stripped before the POST."""

    def __init__(self, start_threads: bool = True, token: str | None = None):
        # `token` lets a shard process REUSE the token the parent already
        # obtained instead of logging in again. The backend rate limits
        # /api/auth/login to 10 per 15 minutes in production, and every
        # container shares one Docker-network IP, so N shards each logging in
        # burned N of a very small shared budget on every restart — enough to
        # lock the whole worker out of its own backend.
        self._token = token
        self.user_id: str | None = (
            None  # from the login reply: the overlay's owner for feeds with no camera row
        )
        self._lock = threading.Lock()
        self._outbox_dir = os.path.join(DATA_DIR, "outbox")
        self._rejected_dir = os.path.join(self._outbox_dir, "rejected")
        self._failed_dir = os.path.join(self._outbox_dir, "failed")
        for d in (self._outbox_dir, self._rejected_dir, self._failed_dir):
            os.makedirs(d, exist_ok=True)
        self._cnt = threading.Lock()
        self.post_ok = 0
        self.post_failed = 0  # posts that had to go to the outbox (any reason)
        self.post_rejected = 0  # validation 4xx → outbox/rejected
        self.outbox_delivered = 0
        self._pending_n = 0
        self._pending_t = 0.0
        self._q: queue.Queue = queue.Queue(maxsize=SENDER_QUEUE)
        if start_threads:
            self._unclaim_stale()
            threading.Thread(target=self._sender_loop, daemon=True, name="sender").start()
            threading.Thread(target=self._flush_outbox_loop, daemon=True, name="outbox").start()

    # ── counters ──
    def _bump(self, name: str, n: int = 1):
        with self._cnt:
            setattr(self, name, getattr(self, name) + n)

    @property
    def outbox_pending(self) -> int:
        """Files waiting in the outbox (counted at most every 10 s)."""
        now = time.time()
        if now - self._pending_t > 10.0:
            self._pending_t = now
            self._pending_n = self._count_outbox()
        return self._pending_n

    def _count_outbox(self) -> int:
        try:
            return sum(
                1 for f in os.listdir(self._outbox_dir) if f.endswith(".json") or f.endswith(".sending")
            )
        except Exception:  # noqa: BLE001
            return 0

    def _unclaim_stale(self):
        """A previous process died mid-flush: give its claimed files back."""
        try:
            for fn in os.listdir(self._outbox_dir):
                if fn.endswith(".json.sending"):
                    os.rename(os.path.join(self._outbox_dir, fn), os.path.join(self._outbox_dir, fn[:-8]))
        except Exception:  # noqa: BLE001
            pass

    # ── outbox files ──
    def enqueue(self, payload: dict, reason: str = ""):
        try:
            payload.setdefault("_queued_at", now_iso())
            payload.setdefault("_attempts", 0)
            fn = os.path.join(self._outbox_dir, f"{int(time.time()*1000)}_{payload.get('plate','x')}.json")
            with open(fn, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            log(
                f"outbox: queued {payload.get('plate')} ({payload.get('camera_code')})"
                + (f" — {reason}" if reason else "")
            )
        except Exception as e:  # noqa: BLE001
            log(f"outbox: write failed: {e}")

    def _reject_to_disk(self, payload: dict, status: int, body: str):
        try:
            payload["_response"] = {"status": status, "body": body[:2000], "at": now_iso()}
            fn = os.path.join(self._rejected_dir, f"{int(time.time()*1000)}_{payload.get('plate','x')}.json")
            with open(fn, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            log(
                f"outbox: REJECTED {payload.get('plate')} ({payload.get('camera_code')}) HTTP {status}: {body[:160]!r} → outbox/rejected"
            )
        except Exception as e:  # noqa: BLE001
            log(f"outbox: rejected write failed: {e}")

    @staticmethod
    def _move(path: str, dest_dir: str, name: str):
        try:
            shutil.move(path, os.path.join(dest_dir, name))
        except Exception as e:  # noqa: BLE001
            log(f"outbox: move {name} → {os.path.basename(dest_dir)} failed: {e}")

    @staticmethod
    def _patch_record(path: str | None, sid: str | None, watch_hit: bool):
        """Write the sighting_id (and watch_hit) into the evidence record on
        disk — spec §6 (3): a delivered outbox item must not leave a null.
        Runs on the DiskWriter thread (same queue as the record write, so it
        cannot overtake it — storage-perf spec §A.1); the sender thread waits
        up to 30 s for a queue slot rather than racing the writer inline."""
        if not path or not sid:
            return
        writer().put(path, lambda p: Backend._patch_record_file(p, sid, watch_hit), timeout=30.0)

    @staticmethod
    def _patch_record_file(path: str, sid: str, watch_hit: bool):
        try:
            with open(path, encoding="utf-8") as f:
                rec = json.load(f)
            if rec.get("sighting_id") == sid:
                return
            rec["sighting_id"] = sid
            rec["watch_hit"] = bool(watch_hit)
            rec["delivered_at"] = now_iso()
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(rec, f, ensure_ascii=False, indent=1)
            os.replace(tmp, path)
        except FileNotFoundError:
            pass
        except Exception as e:  # noqa: BLE001
            log(f"outbox: record patch failed ({os.path.basename(path)}): {e}")

    # ── sender thread ──
    def submit(self, payload: dict, on_done=None):
        """Hand a sighting to the sender thread. Never blocks: a full queue
        (backend down for a long time) spills straight to the outbox."""
        try:
            self._q.put_nowait((payload, on_done))
        except queue.Full:
            self._bump("post_failed")
            self.enqueue(payload, "sender queue full")
            if on_done is not None:
                try:
                    on_done(None, False, None, "sender queue full → outbox")
                except Exception as e:  # noqa: BLE001
                    log(f"sender: callback failed: {e}")

    def _sender_loop(self):
        while True:
            payload, on_done = self._q.get()
            try:
                res, err, _kind = self._deliver(payload, from_outbox=False)
            except Exception as e:  # noqa: BLE001 — must never die
                res, err = None, f"{e.__class__.__name__}: {e}"
                self._bump("post_failed")
                self.enqueue(payload, err)
            if on_done is not None:
                try:
                    on_done((res or {}).get("sighting_id"), bool((res or {}).get("watch_hit")), res, err)
                except Exception as e:  # noqa: BLE001
                    log(f"sender: callback failed: {e}")

    def _deliver(self, payload: dict, *, from_outbox: bool):
        """POST one sighting → (res, err, kind) with kind ∈ ok | retry | rejected.
        Not from the outbox: every non-ok outcome is written to the outbox /
        rejected dir here. From the outbox: the flusher owns the file."""
        body = {k: v for k, v in payload.items() if not k.startswith("_")}
        url = f"{BACKEND}/api/ai/anpr/sighting"
        tries = 1 if from_outbox else 2
        attempt = 0
        relogged = False
        while True:
            attempt += 1
            try:
                r = requests.post(url, headers=self._headers(), json=body, timeout=30)
            except requests.RequestException as e:
                if attempt < tries:
                    time.sleep(2.0)
                    continue
                return self._fail(payload, f"{e.__class__.__name__}: {str(e)[:160]}", from_outbox, down=True)
            if r.status_code == 401 and not relogged:
                relogged = True
                try:
                    with self._lock:
                        self.login()
                except Exception as e:  # noqa: BLE001
                    return self._fail(payload, f"login failed: {e.__class__.__name__}: {e}", from_outbox)
                attempt -= 1
                continue
            if r.status_code == 413 and any(k.endswith("_b64") for k in body):
                # gateway body limit: post the row without images, attach them as media
                slim = {k: v for k, v in body.items() if not k.endswith("_b64")}
                try:
                    r = requests.post(url, headers=self._headers(), json=slim, timeout=30)
                except requests.RequestException as e:
                    return self._fail(payload, f"413 slim: {e.__class__.__name__}", from_outbox, down=True)
                if r.ok:
                    res = r.json()
                    return self._ok(payload, res, self._upload_media_for(res.get("sighting_id"), payload))
            if r.status_code >= 500 or r.status_code in (408, 425, 429):
                if attempt < tries:
                    time.sleep(2.0)
                    continue
                return self._fail(payload, f"HTTP {r.status_code}", from_outbox)
            if r.status_code in (400, 422):
                return self._reject(payload, r.status_code, r.text, from_outbox)
            if r.status_code >= 400:
                return self._fail(payload, f"HTTP {r.status_code}: {r.text[:160]!r}", from_outbox)
            try:
                res = r.json()
            except ValueError:
                return self._fail(payload, "non-JSON response", from_outbox)
            if not res.get("sighting_id"):
                return self._fail(payload, f"no sighting_id in response: {str(res)[:160]}", from_outbox)
            return self._ok(payload, res, None)

    def _ok(self, payload: dict, res: dict, media_err: str | None):
        self._bump("post_ok")
        self._patch_record(payload.get("_record"), res.get("sighting_id"), bool(res.get("watch_hit")))
        if media_err and res.get("sighting_id"):
            # the row exists — only the images need another try
            self._bump("post_failed")
            self.enqueue(
                {
                    "_media_only": True,
                    "sighting_id": res.get("sighting_id"),
                    "plate": payload.get("plate"),
                    "camera_code": payload.get("camera_code"),
                    "snapshot_b64": payload.get("snapshot_b64"),
                    "plate_b64": payload.get("plate_b64"),
                },
                f"media upload failed: {media_err}",
            )
        return res, None, "ok"

    def _fail(self, payload: dict, err: str, from_outbox: bool, down: bool = False):
        """kind 'down' = no HTTP answer at all (API unreachable) — the flusher
        does not count that against the file; 'retry' = an HTTP failure."""
        self._bump("post_failed")
        if not from_outbox:
            self.enqueue(payload, err)
        return None, err, ("down" if down else "retry")

    def _reject(self, payload: dict, status: int, body: str, from_outbox: bool):
        self._bump("post_rejected")
        self._reject_to_disk(dict(payload), status, body)
        return None, f"HTTP {status} rejected", "rejected"

    def _upload_media_for(self, sid: str | None, payload: dict) -> str | None:
        """Snapshot + plate crop as multipart media for an existing row → error text or None."""
        if not sid:
            return "no sighting_id"
        errs = []
        for kind, key in (("snapshot", "snapshot_b64"), ("plate", "plate_b64")):
            if not payload.get(key):
                continue
            try:
                self.upload_media_bytes(sid, base64.b64decode(payload[key]), kind)
            except Exception as e:  # noqa: BLE001
                errs.append(f"{kind}: {e.__class__.__name__}")
        return "; ".join(errs) if errs else None

    # ── outbox flusher ──
    def _flush_outbox_loop(self):
        while True:
            time.sleep(OUTBOX_FLUSH_SECS)
            try:
                self._flush_outbox()
            except Exception as e:  # noqa: BLE001 — never stop flushing
                log(f"outbox: flush error: {e.__class__.__name__}: {e}")

    def _flush_outbox(self):
        try:
            files = sorted(f for f in os.listdir(self._outbox_dir) if f.endswith(".json"))[:50]
        except Exception:  # noqa: BLE001
            return
        if not files:
            self._pending_n, self._pending_t = 0, time.time()
            return
        ok = fail = rej = poison = skipped = 0
        now = time.time()
        for fn in files:
            path = os.path.join(self._outbox_dir, fn)
            claim = path + ".sending"
            try:
                os.rename(path, claim)  # claim it — another shard process may be flushing too
            except OSError:
                continue
            try:
                with open(claim, encoding="utf-8") as f:
                    payload = json.load(f)
                if not isinstance(payload, dict):
                    raise ValueError("not an object")
            except Exception as e:  # noqa: BLE001 — unreadable file = poison
                log(f"outbox: {fn} unreadable ({e}) → outbox/failed")
                self._move(claim, self._failed_dir, fn)
                poison += 1
                continue
            # three shard flushers share this directory: a file tried by another
            # process moments ago is left alone until the next round
            if now - float(payload.get("_last_attempt", 0) or 0) < OUTBOX_FLUSH_SECS * 0.8:
                try:
                    os.rename(claim, path)
                except OSError:
                    pass
                skipped += 1
                continue
            payload["_last_attempt"] = now
            attempts = int(payload.get("_attempts", 0) or 0)
            res, err, kind = None, None, "retry"
            try:
                if payload.get("_media_only"):
                    err = self._upload_media_for(payload.get("sighting_id"), payload)
                    kind = "ok" if err is None else "retry"
                else:
                    res, err, kind = self._deliver(payload, from_outbox=True)
            except Exception as e:  # noqa: BLE001
                err, kind = f"{e.__class__.__name__}: {e}", "retry"
            if kind != "down":
                attempts += 1  # an unreachable API is not the file's fault
            payload["_attempts"] = attempts
            if kind == "ok":
                ok += 1
                self._bump("outbox_delivered")
                try:
                    os.remove(claim)
                except OSError:
                    pass
                if res:
                    self._after_outbox_delivery(payload, res)
                log(
                    f"outbox: delivered {payload.get('plate')} ({payload.get('camera_code')}) after {attempts} attempt(s)"
                )
            elif kind == "rejected":
                rej += 1
                try:
                    os.remove(claim)  # _reject wrote it to outbox/rejected
                except OSError:
                    pass
            else:
                fail += 1
                if attempts >= OUTBOX_MAX_ATTEMPTS:
                    log(f"outbox: {fn} → outbox/failed after {attempts} attempts ({err})")
                    self._move(claim, self._failed_dir, fn)
                    poison += 1
                else:
                    try:
                        with open(claim, "w", encoding="utf-8") as f:
                            json.dump(payload, f)
                        os.rename(claim, path)  # back in the queue with the attempt count
                    except Exception as e:  # noqa: BLE001
                        log(f"outbox: requeue {fn} failed: {e}")
        self._pending_n, self._pending_t = self._count_outbox(), time.time()
        if ok or fail or rej or poison:
            log(
                f"outbox: flush ok={ok} failed={fail} rejected={rej} poison={poison} skipped={skipped} pending={self._pending_n}"
            )

    def _after_outbox_delivery(self, payload: dict, res: dict):
        """The record JSON is patched by _ok; a clip that was cut while the
        API was down is still on disk next to it — attach it now."""
        rec = payload.get("_record")
        sid = res.get("sighting_id")
        if not rec or not sid:
            return
        mp4 = rec[:-5] + ".mp4" if rec.endswith(".json") else None
        if mp4 and os.path.exists(mp4):
            try:
                self.upload_media(sid, mp4, "clip")
            except Exception as e:  # noqa: BLE001
                log(f"outbox: clip upload failed for {payload.get('plate')}: {e.__class__.__name__}")

    def login(self, attempts: int = 0):
        """Log in, retrying on the failures that are known to be TEMPORARY.

        This used to be a single attempt whose exception propagated out of
        main(), so the container died and was restarted by Docker — which
        immediately logged in again. Two ways that bites in production:

          * 429. Every shard process logs in separately, and the backend rate
            limits /api/auth/login (harder since NODE_ENV=production). A restart
            storm, or simply enough shards starting at once, trips the limit —
            and the crash-loop then hammers the very endpoint that is asking us
            to slow down, so it never recovers on its own. ANPR stays down.
          * 502/503/connection refused. A backend restart is routine; plate
            reading should ride through it, not die.

        Backs off 2s, 4s, 8s … capped at 60s, so a limiter has time to reopen.
        A 401 is NOT retried: wrong credentials will never fix themselves.

        attempts=0 means RETRY FOREVER, and that is the default on purpose. A
        finite cap still ends in an unhandled exception, the container exits,
        Docker restarts it, and the fresh process immediately spends another
        round of attempts on the endpoint that is rate limiting us — each
        restart making the limiter angrier. Waiting patiently inside one process
        is the only thing that actually breaks that spiral.
        """
        delay = 2.0
        attempt = 0
        while True:
            attempt += 1
            try:
                r = requests.post(
                    f"{BACKEND}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20
                )
                if r.status_code in (401, 403):
                    raise RuntimeError(
                        f"login rejected ({r.status_code}) for {EMAIL} — check ANPR_EMAIL / ANPR_PASSWORD"
                    )
                if r.status_code == 429 or r.status_code >= 500:
                    raise requests.HTTPError(f"{r.status_code}", response=r)
                r.raise_for_status()
                body = r.json()
                self._token = body.get("token")
                self.user_id = (body.get("user") or {}).get("id") or self.user_id
                if not self._token:
                    raise RuntimeError("login returned no token")
                log(f"logged in as {EMAIL}" + (f" (after {attempt} attempts)" if attempt > 1 else ""))
                return
            except RuntimeError:
                raise
            except Exception as e:  # noqa: BLE001 — transport or retryable status
                if attempts and attempt >= attempts:
                    raise
                why = getattr(getattr(e, "response", None), "status_code", None) or e.__class__.__name__
                # Quiet down once it is clearly a wait, not a blip: the first few
                # attempts log, then every tenth, so a 15-minute rate-limit
                # window does not bury the rest of the log.
                if attempt <= 3 or attempt % 10 == 0:
                    log(
                        f"login failed ({why}); retrying in {delay:.0f}s "
                        f"[attempt {attempt}{f'/{attempts}' if attempts else ''}]"
                    )
                time.sleep(delay)
                delay = min(delay * 2, 60.0)

    def _headers(self):
        return {"Authorization": f"Bearer {self._token}"}

    def cameras(self):
        """The camera list, with ONE re-login on 401.

        Without this the refresh loop dies quietly after the access token
        expires (~2 h) and never comes back: every poll 401s, the worker keeps
        whatever cameras it already had, and a camera switched on in the console
        is simply never picked up. Observed in the wild — a worker up 12 hours
        logging `camera refresh failed … 401` every 45 s.

        The shards share the parent's token (see Backend.__init__ on the login
        rate limit), so they all expire at roughly the same moment; each one
        recovers on its own here rather than needing a restart.
        """
        # compact=1&anprOnly=1: ask for the five fields this worker actually
        # reads, from only the cameras that have plate reading switched on.
        # The full response carries fourteen fields for the operator map and
        # measured 23.74 MB at 80,000 cameras — which, polled once a minute by
        # each shard, is ~100 GB/day of internal traffic to answer "which
        # cameras are mine?". Both flags are additive; an older backend that
        # does not know them simply returns the full payload and the code below
        # still works.
        for attempt in (1, 2):
            r = requests.get(
                f"{BACKEND}/api/cameras/geo",
                params={"compact": "1", "anprOnly": "1"},
                headers=self._headers(),
                timeout=20,
            )
            if r.status_code == 401 and attempt == 1:
                with self._lock:
                    self.login()
                continue
            r.raise_for_status()
            cams = r.json().get("cameras", [])
            if not CAMERA_PREFIXES:
                return cams
            return [c for c in cams if str(c.get("monitorId", "")).startswith(CAMERA_PREFIXES)]
        return []

    def grid_sources(self) -> dict:
        """RTSP addresses of cameras imported from a grid catalogue, from their
        camera rows: {monitorId: {"rtsp", "credentials", "gridId"}}.

        Service-token route (/api/internal/grid-sources), so camera addresses
        never ride in the operator-facing camera list. Best effort: on any
        failure the grid cameras are still read, through the media server's
        cam_<monitorId> path (stream_for's fallback), and this says so once.
        """
        if not SERVICE_TOKEN:
            if not getattr(self, "_grid_warned", False):
                self._grid_warned = True
                log("grid sources: no SERVICE_TOKEN - grid cameras are read through the media server")
            return {}
        try:
            r = requests.get(
                f"{BACKEND}/api/internal/grid-sources",
                headers={"X-Service-Token": SERVICE_TOKEN},
                timeout=15,
            )
            r.raise_for_status()
            return r.json().get("sources", {}) or {}
        except Exception as e:  # noqa: BLE001 — never stop the reads over this
            if not getattr(self, "_grid_warned", False):
                self._grid_warned = True
                log(f"grid sources: {e.__class__.__name__} - grid cameras are read through the media server")
            return {}

    def _json_request(self, method: str, path: str, body=None, timeout: float = 15.0):
        """Small authenticated JSON call (health report, priority poll). One
        401 re-login, no retries, NO outbox — these are periodic, the next tick
        sends fresh data. Raises on failure; callers decide how loudly to log."""
        url = f"{BACKEND}{path}"
        for attempt in (1, 2):
            r = requests.request(method, url, headers=self._headers(), json=body, timeout=timeout)
            if r.status_code == 401 and attempt == 1:
                with self._lock:
                    self.login()
                continue
            r.raise_for_status()
            return r.json() if r.content else {}
        return {}

    def post_json(self, path: str, body: dict, timeout: float = 15.0):
        return self._json_request("POST", path, body, timeout)

    def get_json(self, path: str, timeout: float = 15.0):
        return self._json_request("GET", path, None, timeout)

    def post_sighting(self, payload, from_outbox: bool = False):
        """Synchronous POST (tests / scripts). The live path is submit() →
        sender thread. Raises when no sighting_id could be obtained; the
        payload is then already in the outbox (unless from_outbox)."""
        res, err, _kind = self._deliver(payload, from_outbox=from_outbox)
        if err:
            raise RuntimeError(err)
        return res

    def upload_media_bytes(self, sighting_id: str, data: bytes, kind: str):
        ctype = "video/mp4" if kind == "clip" else "image/jpeg"
        name = f"{kind}.mp4" if kind == "clip" else f"{kind}.jpg"
        for attempt in (1, 2):
            r = requests.post(
                f"{BACKEND}/api/ai/anpr/sighting/{sighting_id}/media",
                headers=self._headers(),
                data={"kind": kind},
                files={"file": (name, data, ctype)},
                timeout=90,
            )
            if r.status_code == 401 and attempt == 1:
                with self._lock:
                    self.login()
                continue
            r.raise_for_status()
            return r.json()

    def upload_media(self, sighting_id: str, path: str, kind: str = "clip"):
        """Attach a clip / extra snapshot to an existing sighting (multipart)."""
        with open(path, "rb") as fh:
            data = fh.read()
        return self.upload_media_bytes(sighting_id, data, kind)


# The provider grid, as published in Sentinel's own integrator guide
# (cctv.corp8.cloud/resource). Overridable, because this is the second endpoint
# they have issued and it will not be the last.
CORP8_RTSP_HOST = os.getenv("CORP8_RTSP_HOST", "<redacted-ip>")
CORP8_RTSP_PORT = os.getenv("CORP8_RTSP_PORT", "8554")
# 4 Sep 2026: the grid's RTSP server started answering DESCRIBE with 401 (it
# was open on 2 Sep). When set, these ride in the URL as user:password@ — the
# values come from the same .env entries the backend uses for the portal, and
# redact_url() keeps them out of every log line.
CORP8_RTSP_USER = os.getenv("CORP8_RTSP_USER", "")
CORP8_RTSP_PASS = os.getenv("CORP8_RTSP_PASS", "")
# 8 Sep 2026: read the grid THROUGH the media server instead of straight from
# the provider. The media server already pulls every camera an operator is
# watching; the worker's 31 permanent pulls then double the load on the
# provider's link (the real ceiling on this deployment, not our CPU). With
# ANPR_SOURCE_VIA_MEDIAMTX=1 the worker opens rtsp://<media server>/cam_<id>,
# the raw (un-transcoded) passthrough path: the same RTP packets, the same
# losses, one provider pull per camera shared by the worker and every viewer.
# Side effect worth having: the worker's permanent read keeps every raw path
# warm, so an operator's first WHEP no longer waits for a cold source. Costs a
# hop through the media server (a restart there reconnects the reader). Off by
# default until the read-rate numbers are re-measured on this path.
ANPR_SOURCE_VIA_MEDIAMTX = os.getenv("ANPR_SOURCE_VIA_MEDIAMTX", "0") == "1"
MEDIAMTX_RTSP_BASE = os.getenv("MEDIAMTX_RTSP_BASE", "rtsp://trinetra-stream:8554")


def _with_provider_auth(url: str) -> str:
    """The corp8 grid account on a URL for the provider's RTSP host only (the
    backend's buildRtspUrl does the same: those camera rows carry no login)."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    if u.hostname != CORP8_RTSP_HOST or u.username or not (CORP8_RTSP_USER or CORP8_RTSP_PASS):
        return url
    auth = f"{urllib.parse.quote(CORP8_RTSP_USER, safe='')}:{urllib.parse.quote(CORP8_RTSP_PASS, safe='')}@"
    return urllib.parse.urlunsplit((u.scheme, auth + u.netloc, u.path, u.query, u.fragment))


def stream_for(monitor_id: str, cam: dict | None = None) -> str | None:
    """Stream URL for a camera. corp8_07 -> cam07; a grid camera -> its row.

    GRID CAMERAS (imported from a catalogue, 2 Oct 2026) carry their own RTSP
    address in the camera row, delivered as cam["gridRtsp"] by _enabled_cams.
    That address is used as-is: no monitor-id convention. RTSP is forced over
    TCP by VideoSource for every rtsp:// URL. A grid row that needs a login is
    read through our media server instead (it holds the login; the worker never
    sees it), as is every grid camera when ANPR_SOURCE_VIA_MEDIAMTX=1.

    RTSP, NOT HLS, and that is the whole point of this change.

    The old endpoint was https://live.corp8.cloud/live/stream/<n>/index.m3u8 and
    we were forced onto HLS because that host sat behind a CDN that only proxied
    :443 — RTSP and WHEP timed out. It then returned HTTP 502 for several days
    and every camera went dark.

    The replacement grid publishes RTSP on a direct public IP with 8554 open, so
    the CDN constraint is gone. Three things get better at once:

      - no session cookie. HLS on the new host sits behind the access password;
        RTSP does not, so the worker needs no login and no cookie refresh.
      - 1920x1080 instead of 640x360. Measured on the new endpoint. Plate height
        is what decides whether a read is possible at all, and the old feed was
        the reason recorded clips produced no confirmed reads.
      - RTSP is what OpenCV and MediaMTX actually want; HLS forced a segment
        muxer in front of every reader.
    """
    grid = (cam or {}).get("gridRtsp")
    if grid and not monitor_id.startswith("corp8_"):
        if grid.get("rtsp") and not grid.get("credentials") and not ANPR_SOURCE_VIA_MEDIAMTX:
            return _with_provider_auth(grid["rtsp"])
        return f"{MEDIAMTX_RTSP_BASE.rstrip('/')}/cam_{monitor_id}"
    if not monitor_id.startswith("corp8_"):
        # Any other console camera: read it through the media server's raw
        # passthrough path, the same `cam_<monitorId>` every other reader
        # uses (the backend watchdog registers it for every camera). One pull
        # from the source, shared with viewers — which is also the only
        # polite way to read a consume-only government gateway.
        return f"{MEDIAMTX_RTSP_BASE.rstrip('/')}/cam_{monitor_id}"
    if ANPR_SOURCE_VIA_MEDIAMTX:
        # Raw passthrough path name = cam_<monitorId>, registered by the backend.
        return f"{MEDIAMTX_RTSP_BASE.rstrip('/')}/cam_{monitor_id}"
    try:
        n = int(monitor_id.split("_", 1)[1])
    except ValueError:
        return None
    auth = ""
    if CORP8_RTSP_USER or CORP8_RTSP_PASS:
        auth = (
            f"{urllib.parse.quote(CORP8_RTSP_USER, safe='')}:{urllib.parse.quote(CORP8_RTSP_PASS, safe='')}@"
        )
    return f"rtsp://{auth}{CORP8_RTSP_HOST}:{CORP8_RTSP_PORT}/stream/cam{n:02d}"


def parse_sources(env: str) -> dict[str, str]:
    out = {}
    for item in env.split(","):
        if "=" in item:
            k, v = item.split("=", 1)
            out[k.strip()] = v.strip()
    return out


# ── per-track state ──────────────────────────────────────────────────────────
class OverlayPublisher(threading.Thread):
    """Live boxes → POST /api/internal/ai/overlay, one message per camera frame.

    The console's player draws whatever arrives on the 'ai.live' socket for the
    camera it is showing (AIOverlay.jsx), so this is what puts a box around
    every tracked vehicle on the Live Plate Reading page, with the plate text
    once it is read. The backend needs the OWNER of the camera (userId) to pick
    the socket room: that comes from /api/internal/cameras, refreshed every two
    minutes, and for a feed with no camera row (the recorded demo source) it
    falls back to the account this worker logged in as.

    Best effort by design: a full queue drops the frame, a failed POST is a
    skipped redraw, and a rejection is logged once per status, not per frame.
    """

    REFRESH_SEC = 120.0

    def __init__(self, backend: "Backend"):
        super().__init__(daemon=True, name="overlay")
        self.backend = backend
        self.q: "queue.Queue[dict]" = queue.Queue(maxsize=64)
        self.session = requests.Session()
        self._owner: dict[str, str] = {}
        self._owner_at = 0.0
        self.sent = 0
        self.dropped = 0
        self.rejected = 0
        self.skipped = 0  # no owner known — nobody to draw for
        self._warned: set[str] = set()
        self._last_report = time.time()
        self.start()

    def offer(self, frame: dict) -> None:
        try:
            self.q.put_nowait(frame)
        except queue.Full:
            self.dropped += 1

    def _warn_once(self, key: str, msg: str) -> None:
        if key not in self._warned:
            self._warned.add(key)
            log("overlay: " + msg)

    def _owners(self) -> dict[str, str]:
        if time.time() - self._owner_at < self.REFRESH_SEC:
            return self._owner
        self._owner_at = time.time()
        try:
            r = self.session.get(
                BACKEND + "/api/internal/cameras", headers={"X-Service-Token": SERVICE_TOKEN}, timeout=10
            )
            if r.ok:
                cams = r.json()
                if isinstance(cams, dict):
                    cams = cams.get("cameras", [])
                self._owner = {
                    c["monitorId"]: str(c["userId"]) for c in cams if c.get("monitorId") and c.get("userId")
                }
            else:
                self._warn_once(
                    "cams:%d" % r.status_code,
                    "camera owners refused (%d) — check SERVICE_TOKEN" % r.status_code,
                )
        except Exception as e:  # noqa: BLE001
            self._warn_once("cams:err", "camera owners unavailable: %s" % e)
        return self._owner

    def run(self) -> None:
        while True:
            f = self.q.get()
            uid = self._owners().get(f["monitorId"]) or self.backend.user_id
            if not uid:
                self.skipped += 1
                continue
            try:
                r = self.session.post(
                    BACKEND + "/api/internal/ai/overlay",
                    headers={"X-Service-Token": SERVICE_TOKEN},
                    json={"userId": uid, **f},
                    timeout=3,
                )
                if r.status_code < 300:
                    self.sent += 1
                    if self.sent == 1:
                        log(
                            "overlay: first frame accepted (%s, %d boxes)" % (f["monitorId"], len(f["boxes"]))
                        )
                else:
                    self.rejected += 1
                    self._warn_once(
                        "post:%d" % r.status_code, "rejected (%d): %s" % (r.status_code, r.text[:120])
                    )
            except Exception as e:  # noqa: BLE001
                self.rejected += 1
                self._warn_once("post:err", "POST failed: %s" % e)
            if time.time() - self._last_report > 300:
                self._last_report = time.time()
                log(
                    "overlay: sent %d  dropped %d  rejected %d  no-owner %d"
                    % (self.sent, self.dropped, self.rejected, self.skipped)
                )


class TrackState:
    __slots__ = (
        "plate_box",
        "votes",
        "best_q",
        "best_plate",
        "best_vehicle",
        "best_bbox",
        "best_vehicle_box",
        "best_plate_box",
        "best_ts",
        "best_assess",
        "best_frame",
        "first_seen",
        "last_seen",
        "posted",
        "vtype",
        "variants",
        "verify",
        "reader_agree",
        "pending",
        "qualities",
        "orphan",
        "colour",
        "two_row",
        "det_confs",
        "uid",
        "t_first",
        "ts_first",
        "last_read_t",
        "last_centre",
        "merged",
        "tier",
        "vclass_votes",
        "tid",
        "first_centre",
        "length_fix",
        "enh_ms",
        "ocr_ms",
        "t_first_read",
    )

    def __init__(
        self,
        frame_idx: int,
        vtype: str,
        orphan: bool = False,
        uid: int = 0,
        now: float | None = None,
        tid: int = 0,
    ):
        self.votes = TrackVotes()
        self.verify = None
        self.det_confs: list[float] = []  # plate-detector confidence of every crop read
        self.reader_agree: list[float] = []  # per frame: char agreement between the two readers' best reads
        self.pending: list[dict] = []  # crops waiting for the best-frame budget, best quality first
        self.qualities: list[float] = []  # quality of every crop actually read
        self.orphan = orphan
        self.colour = None
        self.two_row = False
        self.best_q = -1.0
        self.best_plate = None
        self.best_vehicle = None
        self.best_bbox = None
        # frame-pixel rectangles of the crops kept as evidence, so the console can
        # draw the plate bbox on the snapshot it is shown (meta.snapshot_box).
        self.best_vehicle_box = None
        self.best_plate_box = None
        self.plate_box = (
            None  # (x1, y1, x2, y2, frame_idx): the plate box seen most recently, for the live overlay
        )
        self.best_frame = None
        self.best_ts = None
        self.best_assess = None
        self.first_seen = frame_idx
        self.last_seen = frame_idx
        self.posted = False
        self.vtype = vtype  # canonical (vehicle_types): car, motorcycle, autorickshaw, …
        # Class votes across the track's life. `vtype` used to be frozen at the
        # single frame that happened to create the state, so one flickered
        # detection (COCO swaps car/truck/motorcycle constantly, and has no
        # auto-rickshaw at all) fixed the vehicle type for the whole vehicle —
        # which is how a car's plate ended up under the "bike" filter. Votes are
        # weighted by how large the vehicle box was: a nearby, big box is a far
        # more reliable classification than a distant few-pixel one.
        self.vclass_votes: Counter = Counter()
        self.variants: dict[str, int] = {}
        self.uid = uid  # per-camera track INSTANCE id (tracker ids and orphan cells repeat)
        self.t_first = now if now is not None else time.time()
        self.ts_first: str | None = None  # ISO ts of the earliest read (merged fragments keep the earliest)
        self.last_read_t = 0.0  # epoch of the last crop read (merge window)
        self.last_centre: tuple[float, float] | None = None  # centre of the last plate box read
        self.merged = 0  # fragments folded into this track (spec §7b)
        self.tier: str | None = None  # 'confirmed' | 'possible' once posted
        self.tid = tid  # tracker id (negative = orphan cell) → meta.track
        self.first_centre: tuple[float, float] | None = (
            None  # centre of the FIRST plate box read (burn-in: did it move?)
        )
        self.length_fix: dict | None = None  # superstring switch applied by _decide → meta.length_fix
        self.enh_ms = 0.0  # this track's share of enhancement time → meta.latency
        self.ocr_ms = 0.0  # …and of OCR time
        self.t_first_read: float | None = None  # epoch of the first tallied read


def crop_quality(a, w_px: int) -> float:
    """How much a plate crop is worth reading, 0..1: sharp, big, unblurred,
    not blown out. Drives best-frame selection AND the vote weight."""
    s = min(1.0, a.sharpness / 800.0) ** 0.5
    size = min(1.0, w_px / 120.0)
    blur = 1.0 / (1.0 + (a.motion_len / 8.0 if a.has_motion else 0.0))
    glare = max(0.2, 1.0 - 2.0 * a.sat_frac)
    return float(max(0.02, s * size * blur * glare))


_COLOURS = [
    ("white", 0, 0, 200),
    ("silver", 0, 0, 150),
    ("grey", 0, 0, 95),
    ("black", 0, 0, 40),
    ("red", 0, 1, 1),
    ("orange", 15, 1, 1),
    ("yellow", 28, 1, 1),
    ("green", 65, 1, 1),
    ("blue", 110, 1, 1),
    ("brown", 12, 0.6, 0.5),
]


def dominant_colour(bgr: np.ndarray | None) -> str | None:
    """Cheap vehicle appearance: dominant body colour from the centre of the
    vehicle crop (HSV vote). Used to keep cross-camera votes honest."""
    if bgr is None or bgr.size == 0:
        return None
    h, w = bgr.shape[:2]
    if h < 16 or w < 16:
        return None
    roi = bgr[int(h * 0.25) : int(h * 0.7), int(w * 0.2) : int(w * 0.8)]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(np.float32)
    sat, val, hue = hsv[:, 1], hsv[:, 2], hsv[:, 0]
    votes = {}
    chroma = sat > 70
    if chroma.mean() < 0.25:
        v = np.median(val[~chroma]) if (~chroma).any() else np.median(val)
        return "white" if v > 185 else "silver" if v > 130 else "grey" if v > 70 else "black"
    hh = hue[chroma]
    for name, hc in (("red", 0), ("orange", 15), ("yellow", 28), ("green", 65), ("blue", 110), ("red", 175)):
        d = np.minimum(np.abs(hh - hc), 180 - np.abs(hh - hc))
        votes[name] = votes.get(name, 0) + int((d < 12).sum())
    best = max(votes.items(), key=lambda kv: kv[1])
    return best[0] if best[1] > 0 else None


def _jpeg_b64(img: np.ndarray, max_w: int = 640, q: int = 85) -> str | None:
    if img is None or img.size == 0:
        return None
    h, w = img.shape[:2]
    if w > max_w:
        img = cv2.resize(img, (max_w, int(h * max_w / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


# ── per-camera pipeline ──────────────────────────────────────────────────────
class Models:
    """Shared model set for one process. The trainer promotes a better OCR /
    detector into models/; `watch()` notices and swaps them in WITHOUT a
    restart (attribute assignment is atomic — camera threads pick up the new
    object on their next frame). That is the last step of the automation loop."""

    def __init__(self, tag: str = ""):
        self.tag = tag
        # Vehicle detector at the LOW floor; per-class floors applied after
        # inference (filter_vehicle_dets). The plate detector is a separate
        # instance with its own PLATE_CONF — untouched by any of this.
        self.vdet = Detector(
            VEHICLE_PT, conf=VEHICLE_CONF_MIN, classes=VEHICLE_CLASSES, label=f"{tag}vehicle-detector"
        )
        names = self.vdet.names
        src = "model"
        if not names:
            names = dict(vehicle_types.COCO_IDS)
            src = "COCO fallback"
        ids = vehicle_types.trackable_ids(names) or list(VEHICLE_CLASSES)
        self.vdet.set_classes(ids)
        # people counts: the detector's own "person" id, if it has one
        self.person_id = (
            next((int(i) for i, n in names.items() if str(n).lower() == "person"), None) if PEOPLE else None
        )
        if self.person_id is not None and self.person_id not in ids:
            self.vdet.set_classes(list(ids) + [self.person_id])
        self.vnames = {int(i): str(names[i]) for i in ids if i in names}
        self.vcanon: dict[int, str] = {
            int(i): (vehicle_types.from_detector(int(i), names) or "vehicle") for i in ids
        }
        self.vfloor: dict[int, float] = {i: class_floor(c) for i, c in self.vcanon.items()}
        # Can this detector actually NAME an auto-rickshaw? Stock COCO cannot,
        # and it does not abstain - it returns the nearest class it owns, so
        # every auto comes back as car/bus/truck. When this is False the three
        # classes an auto hides in are reported as the honest "vehicle" instead
        # (vehicle_types.shown); the raw guess is still kept in the record.
        self.has_auto = vehicle_types.detector_has_auto(self.vnames)
        self._floor_lut = np.full(max(ids + [0]) + 1, 9.0, np.float32)  # class id → floor (unknown = never)
        for i, fl in self.vfloor.items():
            self._floor_lut[i] = fl
        log(
            f"{tag}vehicle classes: {ids} names: {self.vnames} ({src}; detector conf {VEHICLE_CONF_MIN:g}; "
            f"floors car/bus/truck {VEHICLE_CONF:g}, motorcycle {MOTO_CONF:g}, auto/e-rickshaw/tractor/other {AUTO_CONF:g}; "
            f"never tracked: {', '.join(vehicle_types.NON_VEHICLE)}; "
            f"auto-rickshaw class: {'yes' if self.has_auto else 'NO - car/bus/truck reported as vehicle'})"
        )
        self.pdet = Detector(PLATE_PT, conf=PLATE_CONF, classes=None, label=f"{tag}plate-detector")
        self.ocr = PlateOcrEnsemble.from_env()
        self.calibrator = Calibrator.load(CALIBRATOR_PATH)
        if self.calibrator is not None:
            log(
                f"{tag}confidence calibrator loaded ({self.calibrator.meta.get('n', '?')} labels, cv_auc {self.calibrator.meta.get('cv_auc', '?')})"
            )
        self.versions = self._describe()
        log(
            f"{tag}model versions: {model_registry.summary_line(self.versions)} — pipeline {PIPELINE_VERSION}"
        )
        self._sig = self._signature()
        self.reloads = 0

    def _describe(self) -> dict:
        """Fingerprints + registry entries of the weights in use (meta.models)."""
        try:
            return model_registry.describe_models(
                VEHICLE_PT, PLATE_PT, self.ocr.name, CALIBRATOR_PATH, REGISTRY_PATH, ocr_dir=OCR_MODEL_DIR
            )
        except Exception as e:  # noqa: BLE001 — metadata must never stop a read
            log(f"{self.tag}model registry: {e.__class__.__name__}: {e}")
            return {}

    def canon_of(self, cls: int) -> str:
        """Detector class id → canonical vehicle type ('vehicle' when unknown)."""
        return self.vcanon.get(int(cls), "vehicle")

    def filter_vehicle_dets(self, dets: np.ndarray) -> np.ndarray:
        """Per-class confidence floors AFTER inference (spec §1). Classes that
        are not vehicles we track (bicycle, person, rider, animal) never get
        here — set_classes() keeps them out of the detector — but an unknown
        id would be dropped too (floor 9.0)."""
        if dets is None or len(dets) == 0:
            return np.zeros((0, 6), np.float32)
        cls = np.clip(dets[:, 5].astype(np.int64), 0, len(self._floor_lut) - 1)
        floors = self._floor_lut[cls]
        floors = np.where(dets[:, 5].astype(np.int64) < len(self._floor_lut), floors, 9.0)
        return dets[dets[:, 4] >= floors]

    @staticmethod
    def _signature():
        ocr_dir = OCR_MODEL_DIR
        sig = []
        for p in (
            os.path.join(ocr_dir, "model.onnx"),
            os.path.join(ocr_dir, "plate_config.yaml"),
            PLATE_PT,
            CALIBRATOR_PATH,
        ):
            try:
                sig.append((p, os.path.getmtime(p), os.path.getsize(p)))
            except OSError:
                sig.append((p, None, None))
        return tuple(sig)

    def watch(self, every: float = 60.0):
        def loop():
            while True:
                time.sleep(every)
                try:
                    sig = self._signature()
                    if sig == self._sig:
                        continue
                    log(f"{self.tag}models changed on disk — reloading")
                    changed = {p for (p, m, s), (p2, m2, s2) in zip(sig, self._sig) if (m, s) != (m2, s2)}
                    if CALIBRATOR_PATH in changed and len(changed) == 1:
                        self.calibrator = Calibrator.load(CALIBRATOR_PATH)
                        log(
                            f"{self.tag}calibrator reloaded ({(self.calibrator.meta if self.calibrator else {}).get('n', '?')} labels)"
                        )
                    else:
                        new_ocr = PlateOcrEnsemble.from_env()
                        new_pdet = Detector(
                            PLATE_PT, conf=PLATE_CONF, classes=None, label=f"{self.tag}plate-detector"
                        )
                        self.ocr, self.pdet = new_ocr, new_pdet
                        self.calibrator = Calibrator.load(CALIBRATOR_PATH)
                        log(
                            f"{self.tag}models reloaded: OCR {new_ocr.name}; detector {os.path.basename(PLATE_PT)}"
                        )
                    self._sig = sig
                    self.reloads += 1
                    self.versions = self._describe()  # the next sighting names the new weights
                    log(f"{self.tag}model versions: {model_registry.summary_line(self.versions)}")
                except Exception as e:  # noqa: BLE001 — keep the old models
                    log(f"{self.tag}model reload failed (keeping current): {e}")

        threading.Thread(target=loop, daemon=True, name="model-watch").start()


class CameraWorker(threading.Thread):
    def __init__(self, cam: dict, url: str, models: Models, backend: Backend | None):
        super().__init__(daemon=True, name=cam["monitorId"])
        self.cam = cam
        self._overlay_last = 0.0  # when this camera last sent overlay boxes (per-camera throttle)
        self._overlay_live = False  # boxes are on screen — send one empty frame to clear them when tracks end
        self.url = url
        self.models = models
        self.backend = backend
        # Set when an operator turns plate reading OFF for this camera in the
        # console. The read loop checks it once per frame and exits cleanly, so
        # the decoder is released and the GPU budget goes back to the cameras
        # that are still enabled.
        #
        # NOT named `_stop`: threading.Thread already has a private `_stop()`
        # METHOD, and `is_alive()` calls it internally. Shadowing it with an
        # Event makes `is_alive()` raise "Event object is not callable" and kills
        # the whole shard process the first time anything checks a thread.
        self._stop_requested = threading.Event()
        self.tracker = ByteTrackLite(track_thresh=max(0.5, VEHICLE_CONF), lost_buffer=TRACK_TTL, min_hits=2)
        self.states: dict[int, TrackState] = {}
        self._last_post: dict[str, tuple[float, str]] = {}  # plate → (epoch, tier)
        self.code_hist: Counter = Counter()  # confirmed registration codes on THIS camera → decode prior
        self.plate_heights: deque = deque(maxlen=200)  # (vtype, plate px height) of every crop read
        self.plateless: Counter = Counter()  # vehicle tracks that expired without a single plate, by type
        self._uid = 0  # track-instance counter (TrackState.uid)
        self._alias: dict[int, int] = {}  # tracker id merged away → surviving id (spec §7b)
        self._merge_mem: deque = deque(maxlen=128)  # expired unposted states still inside MERGE_WINDOW
        self._review_seen = 0  # rejected tracks seen (review sampling counters)
        self._review_rest = 0  # ...of which not strict-valid (policy 'valid': 1 in N of these)
        self._static_zones: list[dict] = []  # burn-in boxes: {box, until, hits, text}
        self._plate_hist: deque = deque(maxlen=300)  # finished tracks' plate boxes → burn-in detection
        self._diag: float | None = None  # frame diagonal (merge distance)
        self.scene_lum: float | None = None  # EMA of the thumbnail's mean luminance
        self._quiet_since: float | None = None  # first motion-gated frame of the current quiet spell
        self.night = False
        self.ir = False
        self.rec = (
            ClipRecorder(
                fps=CLIP_FPS,
                pre_sec=CLIP_PRE,
                post_sec=CLIP_POST,
                width=CLIP_WIDTH,
                jpeg_q=CLIP_JPEG_Q,
                play_fps=CLIP_PLAY_FPS,
                crf=CLIP_CRF,
                idle_fps=CLIP_IDLE_FPS if MOTION_GATE else 0.0,
            )
            if CLIPS
            else None
        )
        self._src_w = None  # source frame width (for bbox scaling in records)
        self.src: VideoSource | None = None  # set in run(); health reads backend/codec/alive
        self.stats = dict(
            frames=0,
            processed=0,
            skipped_motion=0,
            plates=0,
            ocr_ms=0.0,
            enh_ms=0.0,
            posted=0,
            review=0,
            reconnects=0,
            clips=0,
            posted_possible=0,
            merged_tracks=0,
            frames_night=0,
            night_enhanced=0,
            posted_night=0,
            review_night=0,
            rejected_decal=0,
            rejected_static=0,
            static_zones=0,
            static_skipped_moving=0,
            corrupt_frames=0,
            posted_lenfix=0,
            review_saved=0,
            review_capped=0,
            decode_errors=0,
            errors=0,
        )
        self._stats_t = time.time()
        # PER-INSTANCE budget knobs (module constants are the baseline). A
        # pursuit boost (priority poll → boost_until) raises them for this
        # camera only; _apply_boost restores them when the window ends.
        self.target_fps = TARGET_FPS
        self.fast_reads = FAST_READS
        self.max_reads = MAX_READS
        self.drain_per_frame = DRAIN_PER_FRAME
        self.mature_frames = MATURE_FRAMES
        self.boost_until = 0.0  # epoch seconds; written by the priority poll thread
        self._boosted = False
        self._boost_logged_until = 0.0
        # health sample (spec §7 camera-health): deltas between stats ticks
        self._stats_prev = dict(self.stats)
        self._stats_prev_t = self._stats_t
        self.health: dict | None = None
        self.health_seq = 0  # bumps on every new sample → the aggregator sends each once
        # people visible: cumulative frames / sum; max since the analysis
        # heartbeat last took it (analysis_heartbeat resets it)
        self.people_frames = 0
        self.people_sum = 0
        self.people_max = 0

    # always the CURRENT models (hot-reloaded by Models.watch)
    @property
    def vdet(self):
        return self.models.vdet

    @property
    def pdet(self):
        return self.models.pdet

    @property
    def ocr(self):
        return self.models.ocr

    # ── capture ──
    def run(self):
        try:
            src = VideoSource(self.url, max_reconnects=MAX_RECONNECTS)
        except Exception as e:  # noqa: BLE001
            log(f"{self.name}: cannot open {redact_url(self.url)}: {e}")
            return
        self.src = src
        log(f"{self.name}: streaming  ({self.cam.get('name')})  {redact_url(self.url)}")
        frame_idx = 0
        prev_small = None
        next_due = 0.0
        det_due = 0.0
        epoch = None  # first frame sets it; later changes are reconnects
        seen_cuts = 0  # src.cuts at the last epoch change
        cut_prev = None  # last detection thumbnail, for the scene-cut check
        try:
            while True:
                if self._stop_requested.is_set():
                    log(f"{self.name}: plate reading turned off for this camera, stopping")
                    break
                # raw: the rate check below drops most frames, so convert to
                # BGR (a full-frame colour conversion) only the ones it keeps.
                got = src.read(timeout=60, raw=True)
                if got is None:
                    log(f"{self.name}: source ended / dead, stopping")
                    break
                frame, f_ts, ep = got
                if frame is None:
                    log(
                        f"{self.name}: no frame for 60 s (reconnecting: {src.reconnects}; last: {src.last_reason})"
                    )
                    self._maybe_stats()  # keep the health sample flowing while stalled
                    continue
                fw, fh = frame_size(frame)
                self._src_w = fw
                if self._diag is None:
                    self._diag = math.hypot(fw, fh)
                now = time.time()
                if ep != epoch:
                    if epoch is None:
                        log(
                            f"{self.name}: decoding via {src.backend} ({src.codec}) {fw}x{fh}"
                            + (f" — {src.open_note}" if src.open_note else "")
                        )
                    elif src.cuts != seen_cuts:
                        # Loop point inside one connection (stream time jumped).
                        self.stats["scene_cuts"] = self.stats.get("scene_cuts", 0) + 1
                        log(f"{self.name}: stream time jumped (loop point) — tracker reset")
                        self.tracker.reset()
                        self._drop_states(frame_idx, now, bridge=False)  # no vote crosses a loop point
                        cut_prev = None
                        prev_small = None
                    else:
                        self.stats["reconnects"] += 1
                        # once per reconnect: backend now in use + why the previous connection ended (spec §A.4)
                        log(
                            f"{self.name}: reconnected #{self.stats['reconnects']} via {src.backend} ({src.codec})"
                            f" — {src.last_reason}" + (f"; {src.open_note}" if src.open_note else "")
                        )
                        self.tracker.reset()  # never bridge ids across a reconnect
                        self._drop_states(
                            frame_idx, now
                        )  # tracks end; votes with reads wait in the merge memory
                    epoch = ep
                    seen_cuts = src.cuts
                self._apply_boost(now)
                # Health/stats tick BEFORE any of the gates below `continue`:
                # a static scene (motion gate) or a rate-limited loop must
                # still produce a sample every STATS_EVERY s, or the fleet
                # view shows a perfectly healthy quiet camera as dead.
                self._maybe_stats()
                if getattr(src, "last_corrupt", False):
                    # Decoder concealment in progress (lost packets on a stream
                    # with no key frames): the picture is a smear of stale
                    # references. Not evidence, not worth an OCR pass, and a
                    # tracker fed melted pixels invents vehicles. Skip it.
                    n = self.stats["corrupt_frames"] = self.stats.get("corrupt_frames", 0) + 1
                    if n in (1, 100, 1000) or n % 5000 == 0:
                        log(
                            f"{self.name}: smeared picture from the stream (lost packets, no key frame) — "
                            f"{n} frame(s) skipped so far; not saved as evidence, not read"
                        )
                    continue
                # The loop runs at the clip rate (so the evidence buffer is smooth)
                # and detection at target_fps — the GPU sees only what it needs to.
                # Recomputed every frame: a pursuit boost changes target_fps live.
                loop_fps = max(self.target_fps, CLIP_FPS if self.rec else 0.0, 0.5)
                if src.live:
                    if now < next_due:
                        continue  # newest frame only
                    next_due = now + 1.0 / loop_fps
                frame = to_bgr(frame)
                if self.rec is not None:
                    idle = self._quiet_since is not None and now - self._quiet_since >= CLIP_IDLE_AFTER
                    self.rec.push(frame, f_ts or now, idle=idle)
                if src.live and now < det_due:
                    continue  # buffer only; no detection this frame
                det_due = now + 1.0 / max(self.target_fps, 0.5)
                frame_idx += 1
                self.stats["frames"] += 1
                ts = dt.datetime.fromtimestamp(f_ts, dt.timezone.utc).isoformat() if f_ts else now_iso()

                # scene thumbnail: motion gate + night / IR measurement (spec §5)
                thumb = cv2.resize(frame, (160, 90), interpolation=cv2.INTER_AREA)
                small = cv2.cvtColor(thumb, cv2.COLOR_BGR2GRAY)
                self._scene(thumb, small)
                if SCENE_CUT_DIFF and cut_prev is not None:
                    cut = float(np.abs(small.astype(np.int16) - cut_prev.astype(np.int16)).mean())
                    if cut >= SCENE_CUT_DIFF:
                        # Whole picture changed between two detection frames:
                        # a loop that kept stream time running. Never let a
                        # track id or a plate vote bridge two scenes.
                        self.stats["scene_cuts"] = self.stats.get("scene_cuts", 0) + 1
                        log(f"{self.name}: scene cut (mean change {cut:.0f}) — tracker reset")
                        self.tracker.reset()
                        self._drop_states(frame_idx, now, bridge=False)
                        prev_small = None
                cut_prev = small
                if MOTION_GATE:
                    if prev_small is not None:
                        diff = float(np.abs(small.astype(np.int16) - prev_small.astype(np.int16)).mean())
                        if diff < MOTION_MIN and not self.states:
                            prev_small = small
                            self.stats["skipped_motion"] += 1
                            if self._quiet_since is None:
                                self._quiet_since = now
                            continue
                    prev_small = small
                self._quiet_since = None

                try:
                    self._process(frame, frame_idx, ts)
                    self._finalize(frame_idx, frame)
                except Exception as e:  # noqa: BLE001 — one bad frame must never kill a camera
                    self.stats["errors"] = self.stats.get("errors", 0) + 1
                    if self.stats["errors"] <= 5 or self.stats["errors"] % 100 == 0:
                        import traceback

                        log(
                            f"{self.name}: frame error #{self.stats['errors']}: {e.__class__.__name__}: {e}\n"
                            + traceback.format_exc(limit=4)
                        )
        finally:
            src.close()

    # ── pursuit boost (priority poll → boost_until) ──
    def _apply_boost(self, now: float):
        """Raise / restore this camera's fps + reads budget. Cheap: one float
        compare per frame; logs once when a window starts and once when it ends."""
        on = now < self.boost_until
        if on == self._boosted:
            if on and self.boost_until - self._boost_logged_until > 60:
                self._boost_logged_until = self.boost_until
                log(
                    f"{self.name}: pursuit boost extended until {time.strftime('%H:%M', time.localtime(self.boost_until))}"
                )
            return
        self._boosted = on
        if on:
            self.target_fps = max(TARGET_FPS, min(BOOST_FPS_CAP, TARGET_FPS * 2.0))
            self.fast_reads = FAST_READS + 2
            self.max_reads = MAX_READS + 6
            self.drain_per_frame = DRAIN_PER_FRAME + 1
            self._boost_logged_until = self.boost_until
            log(
                f"{self.name}: pursuit boost ON until {time.strftime('%H:%M', time.localtime(self.boost_until))} "
                f"(fps {self.target_fps:g}, reads {self.fast_reads}/{self.max_reads}, drain {self.drain_per_frame}) "
                f"— a match here is a lead for an officer, not a verdict"
            )
        else:
            self.target_fps = TARGET_FPS
            self.fast_reads = FAST_READS
            self.max_reads = MAX_READS
            self.drain_per_frame = DRAIN_PER_FRAME
            log(
                f"{self.name}: pursuit boost OFF (fps {self.target_fps:g}, reads {self.fast_reads}/{self.max_reads})"
            )

    def _drop_states(self, frame_idx: int, now: float | None = None, bridge: bool = True):
        """Every track is over. Tracker ids never bridge.

        bridge=True (a reconnect: the same scene comes back): tracks that
        already carry reads are NOT reviewed at once — their votes wait in the
        merge memory for MERGE_WINDOW s so the same vehicle, re-detected after
        the reconnect, absorbs them and can still reach MIN_VOTES (storage-perf
        spec §A.4); whatever is not merged by then is reviewed when the window
        closes (_expire_merge_mem).

        bridge=False (a loop point or scene cut: a DIFFERENT scene follows):
        no vote may cross it. Each track is decided as over, exactly as if it
        had expired, and reviewed if it did not post; the merge memory is
        flushed too, so a vehicle after the seam can never absorb votes cast
        before it (Sentinel rehearsal, 2 Oct 2026)."""
        now = time.time() if now is None else now
        if not bridge:
            for tid, st in list(self.states.items()):
                if st.posted or st.votes.reads == 0:
                    continue
                if st.votes.n_frames > 0 and self._decide(st, True):
                    continue  # posted on what it read before the seam
                self._review(st, tid)
            self.states.clear()
            self._alias.clear()
            self._flush_merge_mem()
            return
        for tid, st in list(self.states.items()):
            if st.posted or st.votes.reads == 0:
                continue
            c = st.votes.consensus() if (MERGE_WINDOW > 0 and st.last_centre is not None) else None
            if c is not None:
                self._mem_push(
                    {"st": st, "tid": tid, "text": c.text, "centre": st.last_centre, "t": now, "review": True}
                )
            else:
                self._review(st, tid)
        self.states.clear()
        self._alias.clear()
        # _merge_mem deliberately survives a reconnect; entries expire by time

    def _flush_merge_mem(self):
        """Empty the merge memory at a scene seam: entries still owed a review
        (parked by a reconnect) get it now, nothing is absorbed across."""
        while self._merge_mem:
            e = self._merge_mem.popleft()
            if e.get("review"):
                self._review(e["st"], e.get("tid", 0))

    def _mem_push(self, entry: dict):
        """Append to the merge memory; an entry evicted by the size cap that
        still owes a review gets it now (nothing is lost silently)."""
        if len(self._merge_mem) >= (self._merge_mem.maxlen or 0):
            old = self._merge_mem.popleft()
            if old.get("review"):
                self._review(old["st"], old.get("tid", 0))
        self._merge_mem.append(entry)

    def _expire_merge_mem(self, now: float):
        """Close the merge window: entries older than MERGE_WINDOW leave; those
        parked by _drop_states (reconnect) that no fragment absorbed are reviewed."""
        mem = self._merge_mem
        while mem and now - mem[0]["t"] > MERGE_WINDOW:
            e = mem.popleft()
            if e.get("review"):
                self._review(e["st"], e.get("tid", 0))

    def _new_state(
        self, frame_idx: int, vtype: str, now: float, orphan: bool = False, tid: int = 0
    ) -> TrackState:
        self._uid += 1
        return TrackState(frame_idx, vtype, orphan=orphan, uid=self._uid, now=now, tid=tid)

    # ── scene: night / IR (spec §5) ──
    def _scene(self, thumb: np.ndarray, small: np.ndarray):
        lum = float(small.mean())
        self.scene_lum = lum if self.scene_lum is None else 0.9 * self.scene_lum + 0.1 * lum
        self.night = self.scene_lum < NIGHT_LUM
        # IR illuminator → effectively greyscale frame
        self.ir = (
            float(np.abs(thumb[:, :, 0].astype(np.int16) - thumb[:, :, 2].astype(np.int16)).mean()) < 6.0
        )
        if self.night:
            self.stats["frames_night"] += 1

    def _det_frame(self, frame: np.ndarray) -> np.ndarray:
        """What the DETECTORS see: the frame itself by day; at night a gamma +
        CLAHE corrected copy (a dark vehicle is otherwise never boxed, so no
        crop ever reaches the OCR's own night stack). Crops are always taken
        from the original frame at the same boxes — never double-processed."""
        if not (self.night and NIGHT_DET_ENHANCE) or self.scene_lum is None:
            return frame
        self.stats["night_enhanced"] += 1
        return night_enhance(frame, self.scene_lum)

    def _apply_roi(self, det_frame: np.ndarray, is_evidence: bool, roi) -> np.ndarray:
        """Black out everything outside this camera's plate region for the
        detectors (see RoiTable). Copies first when det_frame is still the
        evidence frame, so records and crops are never masked."""
        h, w = det_frame.shape[:2]
        x0, y0 = int(roi[0] * w), int(roi[1] * h)
        x1, y1 = max(x0 + 1, int(roi[2] * w)), max(y0 + 1, int(roi[3] * h))
        out = det_frame.copy() if is_evidence else det_frame
        out[:y0, :] = 0
        out[y1:, :] = 0
        out[:, :x0] = 0
        out[:, x1:] = 0
        n = self.stats.get("roi_masked", 0)
        if n == 0:
            log(
                f"{self.name}: plate region {[round(v, 3) for v in roi]} → detectors see {x0},{y0}–{x1},{y1} of {w}x{h}"
            )
        self.stats["roi_masked"] = n + 1
        return out

    # ── burn-in suppressor (spec §5b) ──
    def _in_static_zone(self, box, now: float) -> bool:
        """True when a plate box sits in a live burn-in zone. A hit is counted
        but does NOT refresh the zone: a stop line / toll gate / lane sweet-spot
        produces plate boxes at the same spot all day, and refreshing on them
        made a zone born from three unreadable night plates permanent. Zones
        expire after STATIC_TTL; only _remember_box (fresh recurrence
        evidence) creates or re-arms one."""
        if not self._static_zones:
            return False
        live, hit = [], False
        for z in self._static_zones:
            if z["until"] < now:
                x1, y1, x2, y2 = z["box"]
                log(
                    f"{self.name}: static text zone at {x1},{y1},{x2 - x1}x{y2 - y1} — {(z['text'] or 'unreadable')!r} "
                    f"expired after {z['hits']} suppressed detection(s)"
                )
                continue  # expired — dropped below
            live.append(z)
            if not hit and _iou(box, z["box"]) >= STATIC_IOU:
                z["hits"] += 1
                hit = True
        if len(live) != len(self._static_zones):
            self._static_zones = live
        return hit

    def _remember_box(self, st: TrackState, now: float):
        """A finished track leaves its plate box behind. The same box recurring
        across ≥ STATIC_MIN_TRACKS distinct tracks over ≥ STATIC_MIN_SPAN s
        (all within the last STATIC_TTL s) with the same read is burn-in: an
        OSD caption, a decal on a parked bus, a railing. With NO valid read the
        boxes must match tighter (IoU ≥ STATIC_IOU_UNREAD): burn-in is
        pixel-identical frame after frame, vehicles queuing at a stop line or
        toll gate are not. Evidence older than STATIC_TTL is forgotten, so an
        expired zone needs fresh recurrence to come back. A parked car's plate
        is suppressed after 5 min (it was read when it arrived) — documented
        and accepted. A track whose plate MOVED between its first and last
        read (_moved_through) leaves no evidence at all: on a looping source
        the same vehicle drives through the same pixels every loop, and that
        recurrence is not burn-in (config block STATIC_MAX_MOVE_FRAC)."""
        if STATIC_TTL <= 0 or st.best_bbox is None:
            return
        if _moved_through(
            st.first_centre, st.last_centre, st.best_bbox[2] - st.best_bbox[0], STATIC_MAX_MOVE_FRAC
        ):
            self.stats["static_skipped_moving"] += 1
            return
        text = None
        if st.votes.reads > 0:
            c = st.votes.consensus()
            text = validate_or_correct(c.text) if c else None
        box = tuple(int(v) for v in st.best_bbox)
        self._plate_hist.append({"box": box, "uid": st.uid, "t0": st.t_first, "t1": now, "text": text})
        while self._plate_hist and self._plate_hist[0]["t1"] < now - STATIC_TTL:
            self._plate_hist.popleft()  # stale evidence never re-arms a zone
        same = [e for e in self._plate_hist if _iou(box, e["box"]) >= STATIC_IOU]
        texts = {e["text"] for e in same}
        if len(texts) == 1 and text is not None:
            evidence = same  # the same string read again and again
        elif texts == {None}:
            evidence = [e for e in same if _iou(box, e["box"]) >= STATIC_IOU_UNREAD]
        else:
            return  # different vehicles read there — a real lane, not burn-in
        uids = {e["uid"] for e in evidence}
        if len(uids) < STATIC_MIN_TRACKS:
            return
        span = max(e["t1"] for e in evidence) - min(e["t0"] for e in evidence)
        if span < STATIC_MIN_SPAN:
            return
        for z in self._static_zones:
            if _iou(box, z["box"]) >= STATIC_IOU:
                z["until"] = now + STATIC_TTL  # fresh evidence (not a mere hit) re-arms it
                return
        x1, y1, x2, y2 = box
        self._static_zones.append({"box": box, "until": now + STATIC_TTL, "hits": 0, "text": text})
        self.stats["static_zones"] += 1
        log(
            f"{self.name}: static text zone at {x1},{y1},{x2 - x1}x{y2 - y1} — {(text or 'unreadable')!r} "
            f"({len(uids)} tracks over {span:.0f}s); plate detections there ignored for {STATIC_TTL:.0f}s"
        )

    # ── cross-fragment vote merging (spec §7b) ──
    def _try_merge(self, st: TrackState, job: dict, reads: list):
        """First read of a track: if another recent track (still alive and
        unposted, or expired within MERGE_WINDOW) read a plate within Hamming
        1 near this box, fold its votes into this track — ByteTrack's
        fragments of one vehicle become one sighting."""
        best = None
        for r in reads:
            if r and r.vote_text and (best is None or (r.valid, r.weight) > (best.valid, best.weight)):
                best = r
        if best is None:
            return
        text = best.vote_text
        px1, py1, px2, py2 = job["box"]
        cx, cy = (px1 + px2) / 2.0, (py1 + py2) / 2.0
        now = time.time()
        max_d = MERGE_DIAG_FRAC * (self._diag or 1500.0)
        my_tid = job["tid"]
        src, src_tid = None, None
        for tid, other in self.states.items():
            if (
                other is st
                or other.posted
                or other.votes.reads == 0
                or now - other.last_read_t > MERGE_WINDOW
            ):
                continue
            if (
                other.last_centre is None
                or math.hypot(other.last_centre[0] - cx, other.last_centre[1] - cy) > max_d
            ):
                continue
            oc = other.votes.consensus()
            if oc is None or hamming(oc.text, text) > 1:
                continue
            src, src_tid = other, tid
            break
        if src is None:
            for e in list(self._merge_mem):
                if now - e["t"] > MERGE_WINDOW:
                    continue
                if (
                    math.hypot(e["centre"][0] - cx, e["centre"][1] - cy) > max_d
                    or hamming(e["text"], text) > 1
                ):
                    continue
                src = e["st"]
                self._merge_mem.remove(e)
                break
        if src is None:
            return
        # absorb: votes, evidence, budgets — this track carries on with everything the fragment knew
        st.votes = src.votes
        st.det_confs = src.det_confs + st.det_confs
        st.qualities = src.qualities + st.qualities
        st.reader_agree = src.reader_agree + st.reader_agree
        for k, v in src.variants.items():
            st.variants[k] = st.variants.get(k, 0) + v
        st.two_row = st.two_row or src.two_row
        st.pending = sorted(src.pending + st.pending, key=lambda jb: -jb["q"])[:MAX_PENDING]
        if src.best_q > st.best_q:
            st.best_q, st.best_plate, st.best_vehicle, st.best_bbox = (
                src.best_q,
                src.best_plate,
                src.best_vehicle,
                src.best_bbox,
            )
            st.best_ts, st.best_assess, st.best_frame = src.best_ts, src.best_assess, src.best_frame
        if st.colour is None:
            st.colour = src.colour
        if st.first_centre is None:
            st.first_centre = src.first_centre  # the vehicle's path starts where the fragment first read it
        st.enh_ms += src.enh_ms
        st.ocr_ms += src.ocr_ms
        if src.t_first_read and (st.t_first_read is None or src.t_first_read < st.t_first_read):
            st.t_first_read = src.t_first_read
        if src.ts_first and (st.ts_first is None or src.ts_first < st.ts_first):
            st.ts_first = src.ts_first
        st.first_seen = min(st.first_seen, src.first_seen)
        if st.vtype == "vehicle" and src.vtype != "vehicle":
            st.vtype = src.vtype
        st.merged += 1 + src.merged
        if src_tid is not None:
            del self.states[src_tid]
            if src_tid > 0 and my_tid > 0:  # tracker ids only; orphan cells simply re-form
                for k, v in list(self._alias.items()):
                    if v == src_tid:
                        self._alias[k] = my_tid
                self._alias[src_tid] = my_tid
        self.stats["merged_tracks"] += 1

    def _plate_h_by_type(self) -> dict[str, int]:
        by: dict[str, list[int]] = {}
        for vt, hh in self.plate_heights:
            by.setdefault(vt, []).append(int(hh))
        return {vt: int(np.median(v)) for vt, v in sorted(by.items())}

    # ── one frame ──
    def _publish_overlay(self, tracks, frame, frame_idx, now) -> None:
        """One overlay frame for the console: a box per tracked vehicle, labelled
        with the plate once that read has been posted (else just the vehicle type),
        plus a thin outline where the plate itself was last seen."""
        pub = OVERLAY
        if pub is None or now - self._overlay_last < OVERLAY_INTERVAL:
            return
        if not tracks and not self._overlay_live:
            return
        self._overlay_last = now
        h, w = frame.shape[:2]
        boxes = []
        for x1, y1, x2, y2, tid, _cls, sc in tracks:
            tid = self._alias.get(tid, tid)
            st = self.states.get(tid)
            if st is None:
                continue
            # Only a plate the pipeline has actually POSTED (tier set) goes on the
            # video, derived the way the posting path derives it. The interim vote
            # text is exactly the half-read ("GJ111111") that must never be shown
            # as if it were read; a possible-tier plate carries a "?" and stays blue.
            plate = None
            if st.tier:
                c = st.votes.consensus()
                if c:
                    plate = validate_or_correct(c.text) or validate_or_correct(c.top_whole[0])
            vt = "auto-rickshaw" if st.vtype == "autorickshaw" else (st.vtype or "vehicle")
            shown = (plate + (" ?" if st.tier != "confirmed" else "")) if plate else None
            boxes.append(
                {
                    "bbox": [int(x1), int(y1), int(x2), int(y2)],
                    "trackId": int(tid),
                    "kind": "vehicle",
                    "name": plate if st.tier == "confirmed" else None,
                    "label": (shown + " · " + vt) if shown else vt.capitalize(),
                    "conf": round(float(sc), 2),
                    "tier": st.tier,
                }
            )
            pb = st.plate_box
            if pb and frame_idx - pb[4] <= OCR_EVERY * 3:
                boxes.append(
                    {"bbox": [int(v) for v in pb[:4]], "trackId": "%dp" % tid, "kind": "plate", "label": ""}
                )
            if len(boxes) >= OVERLAY_MAX_BOXES:
                break
        self._overlay_live = bool(boxes)
        pub.offer(
            {
                "monitorId": self.cam["monitorId"],
                "ts": int(now * 1000),
                "frameW": w,
                "frameH": h,
                "boxes": boxes,
            }
        )

    def _process(self, frame, frame_idx, ts):
        self.stats["processed"] += 1
        now = time.time()
        det_frame = self._det_frame(frame)  # night: corrected COPY for the detectors only
        roi = ROI.get(self.cam["monitorId"])  # per-camera plate region (calibration kit)
        if roi is not None:
            det_frame = self._apply_roi(det_frame, det_frame is frame, roi)
        raw = self.vdet(det_frame)
        pid = self.models.person_id
        if pid is not None:
            # count only: people visible in this detection frame (no box kept)
            n = int(((raw[:, 5] == pid) & (raw[:, 4] >= PERSON_CONF)).sum()) if len(raw) else 0
            self.people_frames += 1
            self.people_sum += n
            if n > self.people_max:
                self.people_max = n
        dets = self.models.filter_vehicle_dets(raw)  # per-class floors (spec §1); drops person boxes
        tracks = self.tracker.update(dets)
        for x1, y1, x2, y2, tid, cls, sc in tracks:
            tid = self._alias.get(tid, tid)
            st = self.states.get(tid)
            canon = self.models.canon_of(cls)
            if st is None:
                st = self.states[tid] = self._new_state(frame_idx, canon, now, tid=tid)
            # Re-vote the vehicle class on EVERY frame this track is seen, rather
            # than freezing whatever the state was created with. The detector
            # flickers between car / truck / motorcycle from frame to frame (and
            # COCO has no auto-rickshaw at all), so a single unlucky frame used to
            # decide the vehicle type for the entire vehicle — which is how a car
            # ended up filed under "bike". Votes are weighted by box area (~1k px
            # units): a close, large, unambiguous box counts for far more than a
            # distant few-pixel one.
            if canon and canon != "vehicle":
                # Weight by box area, but CAP it. Uncapped, a vehicle filling
                # the frame scores ~1,300 against a distant frame's 1, so a
                # single close-up decides the whole track - and a close-up is
                # exactly when the class is least reliable, because the box is
                # cropped by the frame edge and carries no surrounding context
                # for scale. 12 keeps "near beats far" while still needing a
                # near-frame to be outvoted by a handful of others.
                area_k = (x2 - x1) * (y2 - y1) / 1000
                st.vclass_votes[canon] += min(MAX_CLASS_VOTE, max(1, int(area_k)))
                st.vtype = st.vclass_votes.most_common(1)[0][0]
            st.last_seen = frame_idx
        self._publish_overlay(tracks, frame, frame_idx, now)
        if self.stats["processed"] % OCR_EVERY != 0:
            return
        if not tracks and not ORPHAN_PLATES:
            return
        plates = self._detect_plates(det_frame, tracks)
        if len(plates) == 0:
            self._drain(frame, frame_idx, ts, [])
            return
        h, w = frame.shape[:2]
        # ── phase 1: every plate in the frame becomes a job (4 cars abreast = 4 jobs) ──
        jobs = []
        for px1, py1, px2, py2, pconf, _ in plates:
            px1, py1, px2, py2 = int(px1), int(py1), int(px2), int(py2)
            pw_, ph_ = px2 - px1, py2 - py1
            if pw_ < 12 or ph_ < 6:
                continue
            aspect = pw_ / max(1, ph_)
            if aspect < MIN_ASPECT or pw_ > MAX_PLATE_FRAC * w or py2 < OSD_BAND * h:
                continue  # OSD caption / signboard / not plate-shaped
            if self._in_static_zone((px1, py1, px2, py2), now):
                self.stats["rejected_static"] += 1  # burn-in caption / decal zone (spec §5b)
                continue
            cx, cy = (px1 + px2) / 2, (py1 + py2) / 2
            owner = None
            for t in tracks:
                if t[0] <= cx <= t[2] and t[1] <= cy <= t[3]:
                    if owner is None or (t[2] - t[0]) * (t[3] - t[1]) < (owner[2] - owner[0]) * (
                        owner[3] - owner[1]
                    ):
                        owner = t
            if owner is not None:
                tid = self._alias.get(owner[4], owner[4])
                st = self.states.get(tid)
                owner_canon = self.models.canon_of(owner[5])
                if st is None:
                    st = self.states[tid] = self._new_state(frame_idx, owner_canon, now, tid=tid)
                # NOTE: the class vote happens once per frame in the track loop
                # above, so deliberately do not vote again here — this branch can
                # run several times per frame (one per plate) and would let a
                # multi-plate frame outvote the rest of the track.
                # plate aspect ceiling per vehicle type: a bike's front strip is ~6.3:1
                if aspect > (MAX_ASPECT_MOTO if st.vtype == "motorcycle" else MAX_ASPECT):
                    continue
                vx1, vy1, vx2, vy2 = (int(v) for v in owner[:4])
                st.plate_box = (px1, py1, px2, py2, frame_idx)
            elif ORPHAN_PLATES:
                if aspect > MAX_ASPECT:
                    continue
                # pseudo-track keyed by where the plate is (80 px cells): the
                # same bike passing the same spot over a few frames votes together
                tid = -(1 + int(cx // 80) * 1000 + int(cy // 80))
                st = self.states.get(tid)
                if st is None:
                    st = self.states[tid] = self._new_state(frame_idx, "vehicle", now, orphan=True, tid=tid)
                pw, ph = px2 - px1, py2 - py1
                vx1, vy1 = max(0, int(px1 - pw * 1.5)), max(0, int(py1 - ph * 4))
                vx2, vy2 = min(w, int(px2 + pw * 1.5)), min(h, int(py2 + ph * 2))
                st.plate_box = (px1, py1, px2, py2, frame_idx)
            else:
                continue
            # A posted ORPHAN cell must not stay alive forever on the spot it
            # was seen (that would blind the cell to the next bike): let its
            # TTL run out; REPOST_SECS dedups the same plate if it re-forms.
            if not (st.posted and tid < 0):
                st.last_seen = frame_idx
            if self._done(st):
                continue
            pad_x, pad_y = int((px2 - px1) * 0.06) + 2, int((py2 - py1) * 0.12) + 2
            # crops from the ORIGINAL frame — never from the night-corrected copy
            crop = frame[max(0, py1 - pad_y) : min(h, py2 + pad_y), max(0, px1 - pad_x) : min(w, px2 + pad_x)]
            if crop.size == 0:
                continue
            if PLATE_MAX_SAT > 0 and _looks_decal(crop, PLATE_MAX_SAT):
                self.stats["rejected_decal"] += 1  # coloured lettering is not a plate (spec §5b)
                continue
            self.plate_heights.append((st.vtype, py2 - py1))
            a = enh.assess(crop)
            q = crop_quality(a, px2 - px1)
            job = {
                "st": st,
                "tid": tid,
                "pconf": float(pconf),
                "crop": crop.copy(),
                "box": (px1, py1, px2, py2),
                "vehicle": frame[vy1:vy2, vx1:vx2].copy() if (vy2 > vy1 and vx2 > vx1) else None,
                "vehicle_box": (vx1, vy1, vx2, vy2) if (vy2 > vy1 and vx2 > vx1) else None,
                "plate_crop_box": (
                    max(0, px1 - pad_x),
                    max(0, py1 - pad_y),
                    min(w, px2 + pad_x),
                    min(h, py2 + pad_y),
                ),
                "a": a,
                "q": q,
                "ts": ts,
                "frame_idx": frame_idx,
                "frame": None,
            }
            # BEST-FRAME BUDGET: the first reads go straight to OCR; later crops
            # queue by quality and only the best of them get read (see _drain)
            if st.votes.n_frames + sum(1 for jb in jobs if jb["st"] is st) < self.fast_reads:
                jobs.append(job)
            else:
                st.pending.append(job)
                st.pending.sort(key=lambda jb: -jb["q"])
                del st.pending[MAX_PENDING:]
        self._drain(frame, frame_idx, ts, jobs)

    def _drain(self, frame, frame_idx, ts, jobs: list[dict]):
        """Add the best pending crops of mature tracks to this frame's OCR
        batch (within each track's budget), then read the whole batch."""
        touched = {id(j["st"]): j["st"] for j in jobs}
        for st in list(self.states.values()):
            if not st.pending or st.posted:
                continue
            if frame_idx - st.first_seen < self.mature_frames:
                continue
            budget = self.max_reads - st.votes.n_frames - sum(1 for j in jobs if j["st"] is st)
            for _ in range(min(self.drain_per_frame, max(0, budget))):
                if not st.pending:
                    break
                jobs.append(st.pending.pop(0))
                touched[id(st)] = st
        if jobs:
            self._ocr_jobs(frame, frame_idx, jobs)

    def _ocr_jobs(self, frame, frame_idx, jobs: list[dict]):
        h, w = frame.shape[:2]
        self.stats["plates"] += len(jobs)
        self.stats["max_plates_frame"] = max(self.stats.get("max_plates_frame", 0), len(jobs))
        frame_small = None
        if SAVE_FRAMES:
            sc = min(1.0, FRAME_WIDTH / max(1, w))
            frame_small = (
                cv2.resize(frame, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
                if sc < 1.0
                else frame
            )

        # ── phase 2: enhance every crop, OCR ALL of them in ONE batched call ──
        # A busy junction must not serialise: with N plates in the frame each
        # gets a smaller variant budget and the recogniser sees one batch of
        # N×variants images instead of N round-trips.
        cap = enh.MAX_VARIANTS if len(jobs) <= 2 else max(3, enh.MAX_VARIANTS - (len(jobs) - 2))
        t0 = time.perf_counter()
        images, variants, priors = [], [], []
        for j, job in enumerate(jobs):
            # Scene flag from the motion-gate thumbnail (spec §5b): night=False
            # switches the IR-bloom path off by day — a motion-blurred daytime
            # plate has thin strokes too and would otherwise trip the gate and
            # evict the deblur variants. None (no thumbnail yet) = strict gate.
            cands, a = enh.candidates(
                job["crop"],
                max_variants=cap,
                assessment=job["a"],
                night=(self.night if self.scene_lum is not None else None),
            )
            job["cands"] = cands
            job["rows"] = enh.split_two_line(enh.to_gray(cands[0].image), a.inverted) if cands else None
            for c in cands:
                images.append(c.image)
                variants.append(f"{c.name}#{j}")  # '#j' routes the read back to its plate
                priors.append(c.prior)
        t1 = time.perf_counter()
        all_reads = self.ocr.read_many(images, variants, priors, det_conf=1.0, code_prior=self.code_prior())
        by_job: dict[int, list] = {j: [] for j in range(len(jobs))}
        for r in all_reads:
            m = re.search(r"#(\d+)", r.variant)
            if not m:
                continue
            j = int(m.group(1))
            r.variant = re.sub(r"#\d+", "", r.variant)
            # QUALITY-WEIGHTED VOTE: a sharp 80-px crop outvotes a smeared 40-px one
            r.weight *= max(0.2, jobs[j]["pconf"]) * (0.3 + 0.7 * jobs[j]["q"])
            by_job[j].append(r)
        for j, job in enumerate(jobs):
            if job["rows"] is not None:  # two-row plates (bikes / trucks)
                r2 = self.ocr.read_two_line(job["rows"][0], job["rows"][1], det_conf=job["pconf"])
                if r2 is not None:
                    r2.weight *= 0.3 + 0.7 * job["q"]
                    by_job[j].append(r2)
                job["st"].two_row = True
        t2 = time.perf_counter()
        self.stats["enh_ms"] += (t1 - t0) * 1000
        self.stats["ocr_ms"] += (t2 - t1) * 1000
        # per-track latency (meta.latency): the batch's time split equally across its jobs
        enh_share = (t1 - t0) * 1000 / max(1, len(jobs))
        ocr_share = (t2 - t1) * 1000 / max(1, len(jobs))

        # ── phase 3: votes, reader agreement, best evidence — per plate ──
        for j, job in enumerate(jobs):
            st, a, reads = job["st"], job["a"], by_job[j]
            px1, py1, px2, py2 = job["box"]
            if st.votes.n_frames == 0 and MERGE_WINDOW > 0 and reads:
                self._try_merge(st, job, reads)  # fragment of a vehicle already being read? (spec §7b)
            st.last_read_t = time.time()
            st.last_centre = ((px1 + px2) / 2.0, (py1 + py2) / 2.0)
            if st.first_centre is None:
                st.first_centre = st.last_centre  # where this vehicle was FIRST read (burn-in: did it move?)
            st.enh_ms += enh_share
            st.ocr_ms += ocr_share
            if st.ts_first is None or (job["ts"] and job["ts"] < st.ts_first):
                st.ts_first = job["ts"]
            st.qualities.append(job["q"])
            st.det_confs.append(job["pconf"])
            primary = st.votes.add_frame(job["frame_idx"], reads)
            if primary is not None:
                st.variants[primary.variant] = st.variants.get(primary.variant, 0) + 1
                if st.t_first_read is None:
                    st.t_first_read = st.last_read_t
            # do the two readers agree? (best valid read of each, char-by-char)
            best_by_reader: dict[str, object] = {}
            for r in reads:
                key = r.variant.split("@")[1] if "@" in r.variant else "r0"
                if r.valid and (key not in best_by_reader or r.weight > best_by_reader[key].weight):
                    best_by_reader[key] = r
            if len(best_by_reader) >= 2:
                ra, rb = list(best_by_reader.values())[:2]
                ta, tb = ra.vote_text, rb.vote_text
                if len(ta) == len(tb):
                    st.reader_agree.append(sum(x == y for x, y in zip(ta, tb)) / len(ta))
                else:
                    st.reader_agree.append(0.0)
            # keep the best evidence crop: sharp, large, and read something valid
            q = job["q"] * (1.5 if primary and primary.valid else 1.0)
            if q > st.best_q:
                st.best_q = q
                st.best_plate = job["crop"]
                st.best_vehicle = job["vehicle"]
                st.best_vehicle_box = job.get("vehicle_box")
                st.best_plate_box = job.get("plate_crop_box")
                st.best_bbox = [px1, py1, px2, py2]
                st.best_ts = job["ts"]
                st.best_assess = a.as_dict()
                if st.colour is None:
                    st.colour = dominant_colour(job["vehicle"])
                # the frame is only at hand for reads done in the frame they came from
                st.best_frame = (
                    frame_small.copy()
                    if (frame_small is not None and job["frame_idx"] == frame_idx)
                    else None
                )

    # ── detection at native resolution ──
    def _done(self, st: TrackState | None) -> bool:
        """Posted, or out of reads: a plate found on this track is discarded."""
        return st is not None and (st.posted or st.votes.n_frames >= self.max_reads)

    def _track_done(self, t) -> bool:
        return self._done(self.states.get(self._alias.get(t[4], t[4])))

    def _detect_plates(self, frame, tracks) -> np.ndarray:
        """Full-frame plate pass (large vehicles, orphans) PLUS a native-
        resolution pass on small vehicle boxes, batched. Duplicates merged.
        Finished tracks get no native pass: their plates would be discarded."""
        H, W = frame.shape[:2]
        if (
            IDLE_FULL_EVERY > 1
            and tracks
            and self.stats["processed"] % IDLE_FULL_EVERY
            and all(self._track_done(t) for t in tracks)
        ):
            self.stats["full_skipped"] = self.stats.get("full_skipped", 0) + 1
            out = []
        else:
            out = [list(r) for r in self.pdet(frame)]
        if NATIVE_RES_DET and tracks:
            crops, offs = [], []
            for t in tracks:
                x1, y1, x2, y2 = (int(v) for v in t[:4])
                bw, bh = x2 - x1, y2 - y1
                if bw < 40 or bh < 30 or bw > NATIVE_MAX_FRAC * W:
                    continue
                mx, my = int(bw * 0.12) + 4, int(bh * 0.12) + 4
                cx1, cy1, cx2, cy2 = max(0, x1 - mx), max(0, y1 - my), min(W, x2 + mx), min(H, y2 + my)
                if cx2 - cx1 < 48 or cy2 - cy1 < 32:
                    continue
                if self._track_done(t):
                    self.stats["native_skipped"] = self.stats.get("native_skipped", 0) + 1
                    continue
                crops.append(frame[cy1:cy2, cx1:cx2])
                offs.append((cx1, cy1))
            if crops:
                self.stats["native_passes"] = self.stats.get("native_passes", 0) + len(crops)
                for det, (ox, oy) in zip(self.pdet.batch(crops), offs):
                    for d in det:
                        out.append([d[0] + ox, d[1] + oy, d[2] + ox, d[3] + oy, d[4], d[5]])
        if len(out) <= 1:
            return np.asarray(out, np.float32).reshape(-1, 6)
        # merge duplicates (the same plate from the full frame and a vehicle crop): keep the higher-confidence box
        arr = np.asarray(out, np.float32)
        keep = []
        for i in np.argsort(-arr[:, 4]):
            bx = arr[i]
            dup = False
            for k in keep:
                ky = arr[k]
                iw = max(0, min(bx[2], ky[2]) - max(bx[0], ky[0]))
                ih = max(0, min(bx[3], ky[3]) - max(bx[1], ky[1]))
                inter = iw * ih
                union = (bx[2] - bx[0]) * (bx[3] - bx[1]) + (ky[2] - ky[0]) * (ky[3] - ky[1]) - inter
                if union > 0 and inter / union > 0.45:
                    dup = True
                    break
            if not dup:
                keep.append(int(i))
        return arr[keep]

    def code_prior(self):
        return code_log_prior(self.code_hist)

    # ── decisions ──
    def _features(self, st: TrackState, plate: str, cons) -> dict:
        """Everything the calibrator (and the export) needs to judge a read."""
        a = st.best_assess or {}
        alts = cons.alternatives or []
        top_w = float(cons.top_whole[1]) if cons.top_whole else 0.0
        alt_w = float(alts[0][1]) if alts else 0.0
        tpl = template_of(plate) or ""
        return {
            "agreement": round(cons.agreement, 4),
            "mean_conf": round(cons.mean_conf, 4),
            "min_conf": round(min(st.qualities) if st.qualities else 0.0, 4),
            "readers_agree": round(sum(st.reader_agree) / len(st.reader_agree), 4)
            if st.reader_agree
            else None,
            "n_frames": cons.n_frames,
            "reads": st.votes.reads,
            "crop_h": a.get("h", 0),
            "crop_w": a.get("w", 0),
            "sharpness": a.get("sharpness", 0),
            "motion_len": a.get("motion_len", 0),
            "has_motion": "motion" in " ".join(a.get("flags", [])),
            "is_dark": "dark" in a.get("flags", []),
            "is_glare": "glare" in a.get("flags", []),
            "inverted": bool(a.get("inverted")),
            "low_contrast": "low_contrast" in a.get("flags", []),
            "plate_len": len(plate),
            "template_prior": TEMPLATE_PRIOR.get(tpl, -1.0),
            "verify_score": (st.verify or {}).get("score", 0.0) if st.verify else 0.0,
            "quality": round(max(st.qualities) if st.qualities else 0.0, 4),
            "alt_margin": round((top_w - alt_w) / top_w, 4) if top_w > 0 else 0.0,
            "two_row": st.two_row,
            "orphan": st.orphan,
            "det_conf": round(sum(st.det_confs) / len(st.det_confs), 4) if st.det_confs else 0.0,
        }

    def _verify(self, st: TrackState, plate: str, cons):
        """Render-and-compare the consensus (and the voter's valid
        alternatives) against the best crop. → (plate, verify_meta, ok)."""
        if VERIFY_MIN <= 0 or st.best_plate is None:
            return plate, None, True
        try:
            g = enh.to_gray(st.best_plate)
            g, _ = enh.upscale(g)
            g = enh.clahe(enh.auto_gamma(g))
            inv = bool(st.best_assess.get("inverted")) if st.best_assess else False
            cands = [plate] + [validate_or_correct(t) for t, _ in (cons.alternatives or [])[:3]]
            cands = [c for c in cands if c]
            rows = enh.split_two_line(g, inv)
            if rows is not None:
                results = []
                for c in dict.fromkeys(cands):
                    s, per = plate_verify.two_row_score(rows[0], rows[1], c, inv)
                    results.append({"text": c, "score": round(s, 3), "per_char": per})
                results.sort(key=lambda d: -d["score"])
            else:
                results = plate_verify.compare(g, cands, inv)
            mine = next((r for r in results if r["text"] == plate), None)
            if mine is None:
                return plate, None, True
            chosen = plate
            if (
                results[0]["text"] != plate
                and cons.agreement < 0.9
                and results[0]["score"] - mine["score"] >= VERIFY_MARGIN
            ):
                log(
                    f"{self.name}: verifier prefers {results[0]['text']} ({results[0]['score']:.2f}) over {plate} ({mine['score']:.2f})"
                )
                chosen = results[0]["text"]
                mine = results[0]
            meta = {
                "score": mine["score"],
                "per_char": mine["per_char"],
                "min": VERIFY_MIN,
                "alternatives": [{"text": r["text"], "score": r["score"]} for r in results[:3]],
                "two_row": rows is not None,
            }
            return chosen, meta, mine["score"] >= VERIFY_MIN
        except Exception as e:  # noqa: BLE001 — the verifier must never block a read
            log(f"{self.name}: verifier error: {e}")
            return plate, None, True

    def _finalize(self, frame_idx, frame=None):
        now = time.time()
        if self._merge_mem:
            self._expire_merge_mem(now)
        for tid, st in list(self.states.items()):
            # a read is stronger evidence than a second detection: tracks that
            # already carry one wait twice as long for the vehicle to come back (spec §7b)
            ttl = TRACK_TTL * 2 if st.votes.reads > 0 else TRACK_TTL
            expiring = frame_idx - st.last_seen > ttl or frame_idx - st.first_seen > MAX_TRACK_AGE
            if expiring and st.pending and not st.posted and frame is not None:
                # the track is over: spend what is left of its budget on its best crops
                budget = max(0, self.max_reads - st.votes.n_frames)
                last = st.pending[:budget]
                st.pending = []
                if last:
                    self._ocr_jobs(frame, frame_idx, last)
            if not st.posted and st.votes.n_frames > 0:
                if self._decide(st, expiring):
                    continue  # posted — deleted on the next pass
            if expiring:
                if not st.posted and st.votes.reads > 0:
                    self._review(st, tid)
                    # keep its votes around for a moment: the next fragment may pick them up
                    if (
                        MERGE_WINDOW > 0
                        and st.last_centre is not None
                        and now - st.last_read_t <= MERGE_WINDOW
                    ):
                        c = st.votes.consensus()
                        if c is not None:
                            self._mem_push(
                                {
                                    "st": st,
                                    "tid": tid,
                                    "text": c.text,
                                    "centre": st.last_centre,
                                    "t": st.last_read_t,
                                }
                            )
                elif st.votes.n_frames == 0 and not st.orphan and not st.posted:
                    self.plateless[st.vtype] += 1  # detected, tracked, no plate — intelligence too
                self._remember_box(st, now)
                del self.states[tid]
                if self._alias:
                    self._alias = {k: v for k, v in self._alias.items() if v != tid}

    def _length_fix(self, st: TrackState, cons, plate: str) -> str | None:
        """Superstring / length-ambiguity rule (config block LEN_SWITCH). When
        the voter reports a VALID read one character longer than a short
        consensus (plate_votes.Consensus.longer) and it weighs ≥
        LEN_SWITCH_RATIO × the winning bucket, that read is the plate: the
        OCR dropped a character. Returns the longer plate and records the
        switch on the state (meta.length_fix), else None. Only a consensus
        SHORTER than the 10-char standard plate is switched — the measured
        cases were all 9→10, and an 11-char read (only a two-row
        concatenation can produce one) is the RARE shape, so the prior runs
        the other way there."""
        prev = st.length_fix
        st.length_fix = None
        if not LEN_SWITCH or not cons.longer or len(cons.text) >= 10:
            return None
        # 4 Oct 2026 (docs/ai/measurements/FORENSIC_MEASUREMENTS_2026-10.md, item 1): when the
        # OCR's own raw read is already a format-valid SHORT plate (e.g. GJ01 A 1234, the
        # single-letter series), the longer read is an inserted letter, not a dropped one.
        # 371 of 381 such posts since 25 Sep were switched; on 82 labelled passages the
        # switch broke 8 correct 9-char reads and fixed 0. Only switch a raw read that is
        # NOT format-valid (or that is already 10+ chars and lost a character in the vote).
        raw = re.sub(r"[^A-Z0-9]", "", str(cons.raw_text or cons.text).upper())
        if len(raw) < 10 and is_valid_plate(raw):
            return None
        alt, alt_w = cons.longer
        alt_w = float(alt_w)
        bucket_w = max(float(cons.weight), 1e-6)
        if alt_w < LEN_SWITCH_RATIO * bucket_w:
            return None
        longer = validate_or_correct(alt)
        if not longer or longer == plate:
            return None
        st.length_fix = {
            "from": cons.text,
            "to": longer,
            "alt_weight": round(alt_w, 3),
            "bucket_weight": round(bucket_w, 3),
            "ratio": round(alt_w / bucket_w, 3),
        }
        if not prev or (prev.get("from"), prev.get("to")) != (cons.text, longer):
            log(
                f"{self.name}: length fix {cons.text} → {longer} (longer valid read weighs {alt_w:.2f}, "
                f"bucket {bucket_w:.2f}, ratio {alt_w / bucket_w:.2f} ≥ {LEN_SWITCH_RATIO:g})"
            )
        return longer

    def _short_confirmable(self, st: TrackState, w: float) -> bool:
        """Config block SHORT_CONFIRM_*: a plate shorter than 10 chars is
        confirmed only when the two readers agreed on it and the top vote is
        heavy. With ONE reader configured there is no second opinion to ask
        for — the weight gate alone applies; with two, a track where they
        never both produced a valid read counts as disagreement."""
        ra = (sum(st.reader_agree) / len(st.reader_agree)) if st.reader_agree else None
        if ra is None:
            readers_ok = len(getattr(self.ocr, "readers", None) or []) < 2
        else:
            readers_ok = ra >= SHORT_CONFIRM_READERS_AGREE
        return readers_ok and w >= SHORT_CONFIRM_MIN_WEIGHT

    def _decide(self, st: TrackState, expiring: bool) -> bool:
        """Tier decision for a track with reads (spec §7a) → True when posted.
        confirmed: today's gates (MIN_VOTES frames, agreement, det conf,
                   verifier, calibrated confidence) OR the 2-frame rule
                   (strict-format consensus, agreement ≥ CONFIRM_2FRAME_AGREE,
                   top vote weight ≥ CONFIRM_2FRAME_WEIGHT); a plate shorter
                   than 10 chars additionally needs the readers' agreement
                   and a heavy top vote (_short_confirmable) or it falls
                   through to the possible tier.
        possible:  only when the track is OVER — strict-format consensus, top
                   weight ≥ POSSIBLE_MIN_WEIGHT, (≥ 2 frames & agreement ≥ 0.7)
                   or (1 frame, ≥ 2 reads, agreement ≥ 0.8), confidence ≥
                   POSSIBLE_MIN_CONF; OR the single-read rule (1 frame,
                   full-length strict read, agreement ≥ 0.95, OCR conf ≥ 0.8,
                   weight ≥ 0.3 → rule 'possible_single'). Posted as a lead,
                   never an alert.
        Before either tier the superstring rule may replace a short consensus
        with the valid one-char-longer read the buckets out-voted (_length_fix)."""
        cons = st.votes.consensus()
        if cons is None:
            return False
        strict = is_valid_plate(cons.text)
        plate = validate_or_correct(cons.text) or validate_or_correct(cons.top_whole[0])
        if not plate:
            return False
        fixed = self._length_fix(st, cons, plate)
        if fixed:
            plate = fixed
            strict = True  # the longer read is strict-valid by construction
        mean_det = (sum(st.det_confs) / len(st.det_confs)) if st.det_confs else 1.0
        if mean_det < MIN_DET_CONF:
            return False  # a badge / grille the detector half-liked
        short = len(plate) < 9
        need = MIN_AGREEMENT_SHORT if short else MIN_AGREEMENT
        need_conf = MIN_CONF_SHORT if short else MIN_CONF
        w = float(cons.top_whole[1]) if cons.top_whole else 0.0
        full = cons.n_frames >= MIN_VOTES and cons.agreement >= need
        two = (
            not full
            and strict
            and cons.n_frames >= 2
            and cons.agreement >= CONFIRM_2FRAME_AGREE
            and w >= CONFIRM_2FRAME_WEIGHT
        )
        held = False
        if (
            (full or two)
            and len(plate) < 10
            and not is_bh_plate(plate)
            and not self._short_confirmable(st, w)
        ):
            # 9-char confirmed reads were 39 % correct: without the readers'
            # agreement and a heavy vote the read waits for the possible tier
            full = two = False
            held = True
        if full or two:
            plate, vmeta, ok = self._verify(st, plate, cons)
            if fixed and st.length_fix is not None and plate != fixed:
                st.length_fix["overridden_by_verifier"] = plate
            st.verify = vmeta
            feats = self._features(st, plate, cons)
            feats.update(
                {"tier": "confirmed", "top_weight": round(w, 3), "rule": "2frame" if two else "votes"}
            )
            cal = self.models.calibrator
            if cal is not None:
                conf, source = cal.predict_features(feats), "calibrator"
            else:
                conf, source = cons.confidence(2 if two else MIN_VOTES), "heuristic"
            if ok and conf >= need_conf:
                st.posted, st.tier = True, "confirmed"
                self._post(plate, st, cons, conf, feats, source, tier="confirmed")
                return True
            if vmeta and st.votes.n_frames >= self.max_reads:
                self.stats["verify_held"] = self.stats.get("verify_held", 0) + 1
        if not (expiring and POSSIBLE and strict):
            return False
        enough = w >= POSSIBLE_MIN_WEIGHT
        agree_multi = max(POSSIBLE_MIN_AGREE, POSSIBLE_MIN_AGREE_1F) if short else POSSIBLE_MIN_AGREE
        multi = enough and cons.n_frames >= 2 and cons.agreement >= agree_multi
        single = (
            enough and cons.n_frames == 1 and st.votes.reads >= 2 and cons.agreement >= POSSIBLE_MIN_AGREE_1F
        )
        # single-read rule (config block POSSIBLE_SINGLE_*): 27/46 of the
        # 1-frame strict reads the rule above rejected were correct
        single_strict = (
            POSSIBLE_SINGLE_STRICT
            and not (multi or single)
            and cons.n_frames == 1
            and (len(plate) >= 10 or is_bh_plate(plate))
            and cons.agreement >= POSSIBLE_SINGLE_MIN_AGREE
            and cons.mean_conf >= POSSIBLE_SINGLE_MIN_CONF
            and w >= POSSIBLE_SINGLE_MIN_WEIGHT
        )
        if not (multi or single or single_strict):
            return False
        if not fixed:
            plate = cons.text
        feats = self._features(st, plate, cons)
        feats.update(
            {
                "tier": "possible",
                "top_weight": round(w, 3),
                "rule": "possible_single" if single_strict else "possible",
                "short_held": int(held),
            }
        )
        cal = self.models.calibrator
        if cal is not None:
            conf, source = cal.predict_features(feats), "calibrator"
        else:
            # no evidence-volume term (that is what the tier says); a flat discount instead
            conf = float(
                np.clip(
                    cons.agreement * max(cons.mean_conf, 0.05) ** 0.5 * (0.85 if multi else 0.75), 0.0, 1.0
                )
            )
            source = "heuristic"
        if conf < POSSIBLE_MIN_CONF:
            return False
        st.posted, st.tier = True, "possible"
        self._post(plate, st, cons, conf, feats, source, tier="possible")
        return True

    def _post(
        self,
        plate: str,
        st: TrackState,
        cons,
        conf: float | None = None,
        feats: dict | None = None,
        source: str = "heuristic",
        tier: str = "confirmed",
    ):
        now = time.time()
        # Centre the evidence clip on the frame where the vehicle was actually
        # seen, NOT on when the track was finalised. A track is only finalised
        # TRACK_TTL frames after the vehicle stops being seen (~8 s at 3 fps), so
        # a clip cut around `now` could easily contain a completely DIFFERENT
        # vehicle — the one that happened to pass next. The sighting timestamp
        # already uses best_ts (see `ts = st.best_ts` below); the clip disagreeing
        # with it is exactly why clips looked mismatched against their plate.
        # best_ts is the ISO string the sighting is posted with; the recorder's
        # buffer is keyed on time.time(). Passing the string through cost every
        # clip since the ISO change (str - float in ClipRecorder._cut).
        clip_t0 = _clip_epoch(st.best_ts, now)
        last_t, last_tier = self._last_post.get(plate, (0.0, ""))
        # same plate within REPOST_SECS is a duplicate — unless a confirmed read upgrades a possible one
        if now - last_t < REPOST_SECS and not (tier == "confirmed" and last_tier == "possible"):
            return
        self._last_post[plate] = (now, tier)
        if conf is None:
            conf = cons.confidence(MIN_VOTES)
        if feats is not None:
            feats["length_fix"] = 1 if st.length_fix else 0  # export / calibrator can see the switch
        code = code_of(plate)
        if code and tier == "confirmed":
            self.code_hist[code] += 1  # per-camera decode prior learns from every confirmed plate
        scene = {
            "lum": round(float(self.scene_lum), 1) if self.scene_lum is not None else None,
            "night": bool(self.night),
            "ir": bool(self.ir),
        }
        meta = {
            "features": feats,
            "confidence_source": source,
            "vehicle_colour": st.colour,
            "frames": cons.n_frames,
            "reads": st.votes.reads,
            "agreement": round(cons.agreement, 3),
            "consensus": cons.text,
            "alternatives": cons.alternatives[:3],
            "winning_variants": st.variants,
            "assessment": st.best_assess,
            "verify": st.verify,
            "readers": self.ocr.name,
            "readers_agree": round(sum(st.reader_agree) / len(st.reader_agree), 3)
            if st.reader_agree
            else None,
            # What may honestly be shown, and what the detector actually said.
            # Keeping the raw guess means a fine-tune landing later can re-derive
            # better labels for records already taken, and an analyst can still
            # see why a vehicle was filed the way it was.
            "vehicle_type": vehicle_types.shown(st.vtype, self.models.has_auto),
            "vehicle_type_raw": st.vtype,
            "vehicle_type_detector": "coco" if not self.models.has_auto else "fine-tune",
            "tier": tier,
            "top_weight": round(float(cons.top_whole[1]), 3) if cons.top_whole else None,
            "merged_tracks": int(st.merged),
            "scene": scene,
            "worker": PIPELINE_VERSION,
            "pipeline_version": PIPELINE_VERSION,
            # The OCR's own output next to what the rules and the voter made
            # of it (audit 2026-09-02: raw_text in the DB was the heaviest
            # VOTE text, i.e. the rule-corrected string — validation must never
            # silently rewrite the OCR output; both are stored).
            "ocr": {
                "raw_top": cons.raw_text,
                "raw_alternatives": cons.raw_alternatives[:3],
                "consensus": cons.text,
                "normalized": plate,
                "rules_changed": plate != cons.text,
                "vote_alternatives": cons.alternatives[:3],
            },
            "length_fix": st.length_fix,
            # which weights produced this read: fingerprints + registry version tags (model_registry)
            "models": model_registry.compact(getattr(self.models, "versions", None)),
            "track": {
                "uid": st.uid,
                "tracker_id": st.tid,
                "first_frame": st.first_seen,
                "last_frame": st.last_seen,
                "orphan": bool(st.orphan),
                "merged": int(st.merged),
                "n_reads": st.votes.reads,
            },
            "latency": {
                "first_read_to_post_s": round(now - st.t_first_read, 3) if st.t_first_read else None,
                "enh_ms": round(st.enh_ms, 1),
                "ocr_ms": round(st.ocr_ms, 1),
            },
        }
        if tier == "possible":
            meta["tier_note"] = (
                f"possible read — {cons.n_frames} frame(s), {st.votes.reads} reads; "
                f"a lead for an officer, not a verdict"
            )
            if feats and feats.get("rule") == "possible_single":
                meta["tier_note"] += "; single-frame strict read (rule possible_single)"
            if feats and feats.get("short_held"):
                meta["tier_note"] += "; short plate held back from 'confirmed' (readers / weight gate)"
        ts = st.best_ts
        if st.merged and st.ts_first and (ts is None or st.ts_first < ts):
            ts = st.ts_first  # merged fragments post with the earliest ts
        # Where the snapshot sits in the full frame (same pixels as "bbox"), so the
        # console can draw the plate box on the photo. Requested by the vehicle
        # drawer on /ai-analytics/vehicle/live (9 Sept 2026).
        snap_box = st.best_vehicle_box if st.best_vehicle is not None else st.best_plate_box
        if snap_box is not None:
            meta["snapshot_box"] = [int(v) for v in snap_box]
        payload = {
            "plate": plate,
            "raw": cons.raw_text
            or cons.top_whole[0],  # the OCR's heaviest UNCORRECTED read → raw_text column
            "camera_code": self.cam["monitorId"],
            "camera_name": self.cam.get("name"),
            # Reads from the recorded demo loop (demo_*) are real plates from real
            # frames, re-read at a false time and place: flagged test so they never
            # enter a real vehicle history (default lists exclude is_test rows).
            "test": str(self.cam["monitorId"]).startswith("demo"),
            "confidence": round(float(conf), 3),
            "latitude": self.cam.get("latitude"),
            "longitude": self.cam.get("longitude"),
            "ts": ts,
            "bbox": [int(v) for v in st.best_bbox] if st.best_bbox is not None else None,
            "vehicle_type": vehicle_types.shown(st.vtype, self.models.has_auto),
            "meta": meta,
        }
        snap = st.best_vehicle if st.best_vehicle is not None else st.best_plate
        payload["snapshot_b64"] = _jpeg_b64(snap)
        payload["plate_b64"] = _jpeg_b64(st.best_plate, max_w=320, q=90)
        if SAVE_CROPS and tier == "confirmed":
            self._save(
                "confirmed",
                f"{plate}_{self.cam['monitorId']}_{int(now)}",
                st.best_plate,
                {**meta, "plate": plate},
            )
        if tier == "confirmed":
            self.stats["posted"] += 1
        else:
            self.stats["posted_possible"] += 1
        if st.length_fix:
            self.stats["posted_lenfix"] += 1
        if self.night:
            self.stats["posted_night"] += 1
        flags = st.best_assess.get("flags") if st.best_assess else ""
        tier_tag = "  [possible — a lead for an officer, not a verdict]" if tier == "possible" else ""
        merged_tag = f" merged={st.merged}" if st.merged else ""
        fix_tag = f" len-fix {st.length_fix['from']}→{plate}" if st.length_fix else ""
        # ── evidence record on disk FIRST: <records>/<date>/<camera>/<HHMMSS>_<plate>.* ──
        # sighting_id is null until the sender thread (or the outbox flusher)
        # patches it in — the camera thread never waits for the API.
        base = self._record_base(plate, now)
        info = {"sighting_id": None, "plate": plate, "tier": tier}
        if base:
            # encode here (≈ms), write on the DiskWriter thread (26 ms per file
            # on the bind mount) — never dropped, FIFO before the sender's patch
            try:
                w = writer()
                if snap is not None:
                    w.put(base + ".jpg", _jpeg_bytes(snap, 90))
                if st.best_plate is not None:
                    w.put(base + "_plate.jpg", _jpeg_bytes(st.best_plate, 92))
                rec = {k: v for k, v in payload.items() if not k.endswith("_b64")}
                rec["sighting_id"] = None
                rec["watch_hit"] = False  # patched on delivery; retention keeps hit evidence longer
                rec["tier"] = tier
                rec["recorded_at"] = now_iso()
                if st.best_frame is not None and st.best_bbox is not None:
                    fh, fw = st.best_frame.shape[:2]
                    w.put(base + "_frame.jpg", _jpeg_bytes(st.best_frame, 88))
                    # bbox in the SAVED frame's pixels + YOLO-normalised (for train_detector.py)
                    x1, y1, x2, y2 = st.best_bbox
                    scale = fw / max(1.0, self._src_w or fw)
                    bx = [x1 * scale, y1 * scale, x2 * scale, y2 * scale]
                    rec["frame"] = {
                        "file": os.path.basename(base) + "_frame.jpg",
                        "w": fw,
                        "h": fh,
                        "bbox": [round(v, 1) for v in bx],
                        "yolo": [
                            round(((bx[0] + bx[2]) / 2) / fw, 5),
                            round(((bx[1] + bx[3]) / 2) / fh, 5),
                            round((bx[2] - bx[0]) / fw, 5),
                            round((bx[3] - bx[1]) / fh, 5),
                        ],
                    }
                w.put(base + ".json", json.dumps(rec, ensure_ascii=False, indent=1))
            except Exception as e:  # noqa: BLE001
                log(f"{self.name}: record write failed: {e}")
            if self.rec is not None and CLIP_POLICY == "all":
                self.rec.request(clip_t0, base + ".mp4", self._clip_done, meta=info)
        if DRY_RUN or self.backend is None:
            log(
                f"{self.name}: {plate}  conf={conf:.2f} frames={cons.n_frames} agree={cons.agreement:.2f} {flags}{merged_tag}{fix_tag}{tier_tag} (dry-run)"
            )
            return
        payload["_record"] = (base + ".json") if base else None
        name, rec_holder, clip_done = self.name, self.rec, self._clip_done

        def on_done(sid, watch_hit, res, err):  # runs on the sender thread
            if sid:
                info["sighting_id"] = sid
            if err:
                log(
                    f"{name}: {plate}  conf={conf:.2f} frames={cons.n_frames} agree={cons.agreement:.2f} {flags}{merged_tag}{fix_tag}{tier_tag}"
                    f" — post failed: {err} (queued in outbox)"
                )
                return
            hit_tag = "  *** WATCHLIST HIT — a lead for an officer, not a verdict ***" if watch_hit else ""
            log(
                f"{name}: {plate}  conf={conf:.2f} frames={cons.n_frames} agree={cons.agreement:.2f} {flags}{merged_tag}{fix_tag}{tier_tag}{hit_tag}"
            )
            if watch_hit and CLIP_POLICY != "all" and rec_holder is not None and base:
                rec_holder.request(clip_t0, base + ".mp4", clip_done, meta=info)

        self.backend.submit(payload, on_done)

    # CLIP_POLICY: 'all' requests the clip in _post (both tiers); 'hits' and
    # 'review' request it from the sender callback once the API says
    # watch_hit (a hit is unknown when the POST failed → no clip; the outbox
    # re-delivery attaches a clip only if one was cut). The review queue
    # itself is never clipped — see the CLIP_POLICY comment in the config block.

    def _record_base(self, plate: str, ts: float) -> str | None:
        try:
            d = os.path.join(
                RECORDS_DIR, time.strftime("%Y-%m-%d", time.localtime(ts)), self.cam["monitorId"]
            )
            os.makedirs(d, exist_ok=True)
            return os.path.join(d, f"{time.strftime('%H%M%S', time.localtime(ts))}_{plate}")
        except Exception as e:  # noqa: BLE001
            log(f"{self.name}: records dir failed: {e}")
            return None

    def _clip_done(self, path: str | None, info: dict):
        """Runs on the recorder's encode thread once the post-roll has elapsed."""
        if not path:
            log(f"{self.name}: clip failed for {info.get('plate')}: {info.get('error')}")
            return
        self.stats["clips"] += 1
        sid = info.get("sighting_id")
        if sid and self.backend is not None and not DRY_RUN:
            try:
                self.backend.upload_media(sid, path, "clip")
            except Exception as e:  # noqa: BLE001
                log(f"{self.name}: clip upload failed for {info.get('plate')}: {e}")
                return
        log(
            f"{self.name}: clip {os.path.basename(path)} ({info.get('duration', 0):.1f}s, {info.get('frames')} frames)"
        )

    def _review_reason(self, st: TrackState) -> str | None:
        """Review policy (storage-perf spec §A.2) → why this rejected track
        gets a file, or None to skip it. Counters are per camera."""
        if REVIEW_POLICY == "all":
            return "all"
        self._review_seen += 1
        if REVIEW_POLICY == "sample":
            return "sample" if REVIEW_SAMPLE > 0 and (self._review_seen - 1) % REVIEW_SAMPLE == 0 else None
        c = st.votes.consensus()
        w = float(c.top_whole[1]) if (c is not None and c.top_whole) else 0.0
        if c is not None and is_valid_plate(c.text) and w >= REVIEW_MIN_WEIGHT:
            return "valid"  # a plausible plate the gates rejected — worth a label
        self._review_rest += 1  # junk: 1 in N so the trainer still sees negatives
        return "sample" if REVIEW_SAMPLE > 0 and (self._review_rest - 1) % REVIEW_SAMPLE == 0 else None

    def _review(self, st: TrackState, tid: int):
        self.stats["review"] += 1
        if self.night:
            self.stats["review_night"] += 1
        if not SAVE_CROPS or st.best_plate is None:
            return
        reason = self._review_reason(st)
        if reason is None:
            return
        day = utc_day()
        if not _REVIEW_BUDGET.take(day):
            self.stats["review_capped"] += 1
            return
        self.stats["review_saved"] += 1
        s = st.votes.summary()
        name = f"{self.cam['monitorId']}_{int(time.time())}_{tid}_{s.get('consensus') or 'x'}"
        # data/review/<YYYY-MM-DD>/ (UTC, like records) — spec §A.3; readers accept both layouts
        self._save(
            os.path.join("review", day),
            name,
            st.best_plate,
            {
                **s,
                "assessment": st.best_assess,
                "verify": st.verify,
                # The review folder is an engineer's artefact, so it keeps
                # BOTH - the raw class is the thing you are reviewing.
                "vehicle_type": vehicle_types.shown(st.vtype, self.models.has_auto),
                "vehicle_type_raw": st.vtype,
                "merged_tracks": int(st.merged),
                "det_conf": round(sum(st.det_confs) / len(st.det_confs), 3) if st.det_confs else None,
                "review_reason": reason,
                "scene": {
                    "lum": round(float(self.scene_lum), 1) if self.scene_lum is not None else None,
                    "night": bool(self.night),
                    "ir": bool(self.ir),
                },
            },
            droppable=True,
        )

    def _save(self, kind: str, name: str, img: np.ndarray, meta: dict, droppable: bool = True):
        """Crop + json under data/<kind>/ through the DiskWriter (the writer
        creates a missing folder itself — no makedirs on the camera thread).
        Queue crops are droppable: a full queue loses a training example, never a record."""
        try:
            d = os.path.join(DATA_DIR, kind)
            jpg = _jpeg_bytes(img)
            if jpg is None:
                return
            w = writer()
            w.put(os.path.join(d, name + ".jpg"), jpg, droppable=droppable)
            w.put(
                os.path.join(d, name + ".json"),
                json.dumps(
                    {
                        "camera": self.cam["monitorId"],
                        "camera_name": self.cam.get("name"),
                        "ts": now_iso(),
                        **meta,
                    },
                    ensure_ascii=False,
                    indent=1,
                ),
                droppable=droppable,
            )
        except Exception as e:  # noqa: BLE001
            log(f"{self.name}: save failed: {e}")

    def _maybe_stats(self):
        now = time.time()
        if now - self._stats_t < STATS_EVERY:
            return
        self._stats_t = now
        s = self.stats
        n = max(1, s["plates"])
        by_type = self._plate_h_by_type()
        ph = (
            f" plate_h_med={int(np.median([hh for _, hh in self.plate_heights]))}px {by_type}"
            if self.plate_heights
            else ""
        )
        scene = (
            f" lum={self.scene_lum:.0f} night={int(self.night)} ir={int(self.ir)}"
            if self.scene_lum is not None
            else ""
        )
        b = self.backend
        post = f" post={b.post_ok}/{b.post_failed}/{b.outbox_pending}" if b is not None else ""
        boost = "  BOOST" if self._boosted else ""
        if self.src is not None:
            s["decode_errors"] = int(self.src.decode_errors_total)
        w = writer()
        log(
            f"{self.name}: frames={s['frames']} processed={s['processed']} static={s['skipped_motion']} "
            f"plates={s['plates']} (max/frame {s.get('max_plates_frame', 0)}, native {s.get('native_passes', 0)}"
            f" skipped {s.get('native_skipped', 0)}, full_skipped {s.get('full_skipped', 0)}){ph}{scene} "
            f"enh={s['enh_ms']/n:.1f}ms ocr={s['ocr_ms']/n:.1f}ms "
            f"posted={s['posted']}+{s['posted_possible']}p lenfix={s['posted_lenfix']} merged={s['merged_tracks']} clips={s['clips']}"
            f"{f' clip_idle_skipped={self.rec.idle_skipped}' if self.rec is not None else ''} "
            f"review={s['review']}/{s['review_saved']}saved "
            f"rejected=decal:{s['rejected_decal']}/static:{s['rejected_static']}/zones:{len(self._static_zones)} "
            f"static_skipped_moving={s['static_skipped_moving']} corrupt={s.get('corrupt_frames', 0)} "
            f"plateless={dict(self.plateless)} "
            f"tracks={len(self.states)} reconnects={s['reconnects']} dec_err={s['decode_errors']} "
            f"io=q{w.qsize}/dropped{w.dropped}{post}{boost}"
        )
        self._health_sample(now)

    def _health_sample(self, now: float):
        """Camera-health sample (spec §7) from the deltas since the previous
        stats tick. Read by the per-process aggregator thread (self.health)."""
        s, p = self.stats, self._stats_prev
        dt_s = max(1e-3, now - self._stats_prev_t)

        def d(key: str) -> float:
            return float(s.get(key, 0)) - float(p.get(key, 0))

        frames = int(d("frames"))  # frames handed to the detection stage
        processed = int(d("processed"))  # ...that passed the motion gate
        posted = int(d("posted"))
        src = self.src
        b = self.backend
        w = writer()
        sample = {
            "camera_code": self.cam["monitorId"],
            "camera_name": self.cam.get("name"),
            # Reads from the recorded demo loop (demo_*) are real plates from real
            # frames, re-read at a false time and place: flagged test so they never
            # enter a real vehicle history (default lists exclude is_test rows).
            "test": str(self.cam["monitorId"]).startswith("demo"),
            "ts": now_iso(),
            "fps": round(frames / dt_s, 3),
            "frames": frames,
            "reads": posted,
            "reads_per_hr": round(posted * 3600.0 / dt_s, 2),
            "plate_h_med": float(np.median([hh for _, hh in self.plate_heights]))
            if self.plate_heights
            else None,
            "plate_h_by_type": self._plate_h_by_type(),
            "plateless_by_type": {k: int(v) for k, v in self.plateless.items()},
            # fraction of frames WITH motion (passed the gate) — spec §3 / tier rule "gated if < 0.15"
            "motion_frac": round(max(0.0, frames - d("skipped_motion")) / max(1, frames), 4),
            # reconnects + frame errors + packets skipped by the reader (storage-perf §A.4), since the last tick
            "decode_errors": int(d("reconnects") + d("errors") + d("decode_errors")),
            "packets_skipped": int(d("decode_errors")),
            "reconnects": int(d("reconnects")),
            "native_frac": round(d("native_passes") / max(1, processed), 4),
            "alive": bool(src.alive) if src is not None else self.is_alive(),
            "backend": getattr(src, "backend", None) if src is not None else None,
            "reader_backend": getattr(src, "backend", None) if src is not None else None,
            "codec": getattr(src, "codec", None) if src is not None else None,
            # disk writer (storage-perf §A.5) — per PROCESS, repeated on every camera row
            "io_queue": int(w.qsize),
            "io_dropped_review": int(w.dropped),
            "io_inline": int(w.inline),
            "review_saved": int(d("review_saved")),
            # night (spec §5)
            "scene_lum": round(float(self.scene_lum), 1) if self.scene_lum is not None else None,
            "night": bool(self.night),
            "ir": bool(self.ir),
            "night_frac": round(d("frames_night") / max(1, frames), 4),
            "posted_night": int(d("posted_night")),
            "review_night": int(d("review_night")),
            # recall (spec §7)
            "posted_possible": int(d("posted_possible")),
            "merged_tracks": int(d("merged_tracks")),
            "rejected_decal": int(d("rejected_decal")),
            "rejected_static": int(d("rejected_static")),
            "static_zones_live": len(
                self._static_zones
            ),  # live burn-in zones right now (a blinded chokepoint shows here)
            # ingestion (spec §6) — per PROCESS totals, repeated on every camera row
            "post_ok": int(b.post_ok) if b is not None else None,
            "post_failed": int(b.post_failed) if b is not None else None,
            "outbox_pending": int(b.outbox_pending) if b is not None else None,
        }
        self._stats_prev = dict(s)
        self._stats_prev_t = now
        self.health = sample
        self.health_seq += 1


def _dead_sample(w: "CameraWorker") -> dict:
    """Health row for a camera whose thread has exited (source dead)."""
    return {
        "camera_code": w.cam["monitorId"],
        "camera_name": w.cam.get("name"),
        "ts": now_iso(),
        "fps": 0.0,
        "frames": 0,
        "reads": 0,
        "reads_per_hr": 0.0,
        "plate_h_med": None,
        "motion_frac": 0.0,
        "decode_errors": 0,
        "native_frac": 0.0,
        "alive": False,
        "backend": getattr(w.src, "backend", None) if w.src is not None else None,
        "reader_backend": getattr(w.src, "backend", None) if w.src is not None else None,
        "codec": getattr(w.src, "codec", None) if w.src is not None else None,
    }


def _parse_until(value) -> float:
    """ISO timestamp (naive = UTC) → epoch seconds; 0 when unparsable."""
    if not value:
        return 0.0
    try:
        if isinstance(value, (int, float)):
            return float(value)
        t = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        return t.timestamp()
    except Exception:  # noqa: BLE001
        return 0.0


def start_health_thread(workers: list["CameraWorker"], backend: Backend, tag: str = "") -> threading.Thread:
    """ONE thread per process: every HEALTH_EVERY s POST the latest sample of
    every camera to /api/ai/anpr/camera-health; every PRIORITY_POLL s GET
    /api/ai/anpr/priority and set boost_until on the listed cameras. Failures
    are logged calmly (first, then every 10th) and never raise — the backend
    may not have the routes yet, the frame loops must not notice."""
    state = {"h_fail": 0, "p_fail": 0, "h_ok": 0, "sent_seq": {}, "tiers": {}}

    def post_health(now: float):
        rows = []
        for w in workers:
            code = w.cam["monitorId"]
            if not w.is_alive():
                rows.append(_dead_sample(w))
                continue
            h = w.health
            if h is None or state["sent_seq"].get(code) == w.health_seq:
                continue  # nothing new since the last report
            state["sent_seq"][code] = w.health_seq
            rows.append(h)
        if not rows:
            return
        try:
            res = backend.post_json("/api/ai/anpr/camera-health", {"cameras": rows}) or {}
        except Exception as e:  # noqa: BLE001
            state["h_fail"] += 1
            if state["h_fail"] == 1 or state["h_fail"] % 10 == 0:
                log(
                    f"{tag}health: report failed ({state['h_fail']}×, {len(rows)} cameras): {e.__class__.__name__}: {e}"
                )
            return
        if state["h_fail"]:
            log(f"{tag}health: reporting again after {state['h_fail']} failures")
            state["h_fail"] = 0
        state["h_ok"] += 1
        tiers = res.get("tiers") if isinstance(res, dict) else None
        if isinstance(tiers, dict):
            changed = {c: t for c, t in tiers.items() if state["tiers"].get(c) != t}
            state["tiers"].update(tiers)
            if changed:
                log(f"{tag}health: tiers " + ", ".join(f"{c}={t}" for c, t in sorted(changed.items())))
        if state["h_ok"] == 1:
            log(
                f"{tag}health: reported {len(rows)} camera(s) → updated {res.get('updated', '?') if isinstance(res, dict) else '?'}"
            )

    def poll_priority(now: float):
        try:
            res = backend.get_json("/api/ai/anpr/priority") or {}
        except Exception as e:  # noqa: BLE001
            state["p_fail"] += 1
            if state["p_fail"] == 1 or state["p_fail"] % 10 == 0:
                log(f"{tag}priority: poll failed ({state['p_fail']}×): {e.__class__.__name__}: {e}")
            return
        if state["p_fail"]:
            log(f"{tag}priority: polling again after {state['p_fail']} failures")
            state["p_fail"] = 0
        items = res.get("items") if isinstance(res, dict) else res
        until_by_code: dict[str, float] = {}
        for it in items or []:
            if not isinstance(it, dict):
                continue
            code = it.get("camera_code")
            until = _parse_until(it.get("until"))
            if code and until > now:
                until_by_code[code] = max(until, until_by_code.get(code, 0.0))
        for w in workers:
            w.boost_until = until_by_code.get(w.cam["monitorId"], 0.0)  # the server owns priority

    def loop():
        next_prio = time.time() + 5.0
        next_health = time.time() + HEALTH_EVERY
        while True:
            time.sleep(1.0)
            now = time.time()
            if now >= next_prio:
                next_prio = now + PRIORITY_POLL
                try:
                    poll_priority(now)
                except Exception as e:  # noqa: BLE001
                    log(f"{tag}priority: {e.__class__.__name__}: {e}")
            if now >= next_health:
                next_health = now + HEALTH_EVERY
                try:
                    post_health(now)
                except Exception as e:  # noqa: BLE001
                    log(f"{tag}health: {e.__class__.__name__}: {e}")
            if not any(w.is_alive() for w in workers):
                return

    t = threading.Thread(target=loop, daemon=True, name="health")
    t.start()
    return t


# ── entrypoint ───────────────────────────────────────────────────────────────
def _enabled_cams(backend, sources: dict[str, str]) -> list[dict]:
    """Every camera an operator has switched plate reading ON for, plus any
    explicit ANPR_SOURCES test feeds, in a STABLE order.

    Order matters: each shard slices this list independently, so all shards must
    agree on it or two processes would fight over the same camera.
    """
    cams = [c for c in backend.cameras() if c.get("anprEnabled", True)]
    # Grid cameras (imported from a catalogue): attach the row's own address.
    grid = backend.grid_sources() if hasattr(backend, "grid_sources") else {}
    for c in cams:
        g = grid.get(c["monitorId"])
        if g:
            c["gridRtsp"] = g
    if CAMERAS_ENV:
        # ANPR_CAMERAS is the hand-picked subset of the corp8 provider cameras
        # (compose, 15 Sep). It does not fence grid cameras: importing a grid
        # with plate reading on IS the operator's choice, and its per-camera
        # switch (anprEnabled) still turns any one of them off.
        wanted = {c.strip() for c in CAMERAS_ENV.split(",") if c.strip()}
        cams = [c for c in cams if c["monitorId"] in wanted or c.get("gridRtsp")]
    known = {c["monitorId"] for c in cams}
    for name in sources:
        if name not in known:
            cams.append({"monitorId": name, "name": name, "latitude": None, "longitude": None})
    cams.sort(key=lambda c: c["monitorId"])
    return _cap(cams)


def _cap(cams: list) -> list:
    """Apply ANPR_MAX_CAMERAS — and SAY SO when it bites.

    This used to be a bare `cams[:MAX_CAMERAS]` in two places. The cap is a GPU
    budget and dropping cameras is the correct behaviour, but doing it silently
    is not: a fleet configured beyond the cap looks healthy while cameras it
    believes it is watching are simply not being read. That has already happened
    once here — the cap sat at exactly the camera count and quietly truncated the
    demo feed away.

    At Sentinel scale the failure mode is worse, not better: point 80,000 cameras
    at a worker whose cap is 40 and it reports no error at all. A dropped camera
    is a junction nobody is watching, so it is logged loudly, every refresh, with
    the number and the reason.
    """
    if len(cams) <= MAX_CAMERAS:
        return cams
    dropped = len(cams) - MAX_CAMERAS
    kept = cams[:MAX_CAMERAS]
    log(
        f"!! ANPR_MAX_CAMERAS={MAX_CAMERAS} is BELOW the fleet size ({len(cams)}): "
        f"{dropped} camera(s) will NOT be read. This is a GPU budget, not a bug — "
        f"but those junctions are unwatched. Raise ANPR_MAX_CAMERAS, add shards "
        f"(ANPR_SHARDS), or add GPU capacity."
    )
    # Name a few so an operator can tell which junctions went dark.
    sample = ", ".join(c["monitorId"] for c in cams[MAX_CAMERAS : MAX_CAMERAS + 8])
    log(f"   not read (first {min(dropped, 8)}): {sample}{' …' if dropped > 8 else ''}")
    return kept


def _owner_slot(monitor_id: str, n: int) -> int:
    """Which of n slots owns this camera — a STABLE hash of the id.

    Not a stride over the list (`cams[k::n]`), and not Python's `hash()`.

    A stride is positional, so removing one camera from the enabled list shifts
    every camera after it into a different slot: switching one junction off
    would silently hand a third of the fleet to different processes, each
    stopping and restarting cameras that nobody touched. `hash()` is worse — it
    is randomised per interpreter, and the shards are SPAWNED (fresh
    interpreters), so every process would compute a different owner and they
    would fight over the same cameras.

    crc32 of the id is stable across processes and across restarts, and depends
    only on the camera itself, so ownership never moves when the enabled set
    changes.
    """
    import zlib

    return zlib.crc32(monitor_id.encode("utf-8")) % max(1, n)


def _container_shard(cams: list[dict]) -> list[dict]:
    """This CONTAINER's share (ANPR_SHARD=k/n across replicas)."""
    try:
        k, n = (int(x) for x in SHARD.split("/"))
    except ValueError:
        return cams
    if n <= 1:
        return cams
    return [c for c in cams if _owner_slot(c["monitorId"], n) == k]


def _shard_of(cams: list[dict], k: int, n: int) -> list[dict]:
    """The cameras THIS process owns: the container's share, then this
    process's share of that. Both use the stable hash above, so a camera being
    switched on or off never migrates the others — which is what lets every
    shard refresh independently with no coordination between them.
    """
    cams = _container_shard(cams)
    if n <= 1:
        return cams
    return [c for c in cams if _owner_slot(c["monitorId"], n) == k]


def run_cams(
    cams: list[dict],
    sources: dict[str, str],
    shard: str = "",
    shard_k: int = 0,
    shard_n: int = 1,
    token: str | None = None,
):
    """Own a set of cameras in THIS process: models, OCR, backend session."""
    tag = f"[{shard}] " if shard else ""
    backend = None
    if not DRY_RUN:
        # Reuse the parent's token when it handed one down; only log in if we
        # have none (see the note in Backend.__init__ about the login limiter).
        backend = Backend(token=token)
        global OVERLAY
        OVERLAY = OverlayPublisher(backend) if OVERLAY_ENABLED else None
        log(
            "overlay: on → /api/internal/ai/overlay"
            if OVERLAY
            else "overlay: off (ANPR_OVERLAY=0 or no SERVICE_TOKEN)"
        )
        if not token:
            backend.login()
    log(f"{tag}processing {len(cams)} camera(s): {', '.join(c['monitorId'] for c in cams)}")
    if enh.SR_URL:
        log(f"{tag}super-resolution: {enh.SR_URL} (crops < {enh.SR_MAX_H}px)")

    models = Models(tag)
    log(
        f"{tag}OCR readers: {models.ocr.name} ({'gray' if models.ocr.gray else 'rgb'}); verifier min {VERIFY_MIN} font={plate_verify.font_path()}"
    )
    models.watch(float(os.getenv("ANPR_MODEL_WATCH_SECS", "60")))
    writer()  # start the per-process DiskWriter before the first read
    policy = {
        "valid": f"valid (strict-format consensus, top weight ≥ {REVIEW_MIN_WEIGHT:g}; 1 in {REVIEW_SAMPLE} of the rest)",
        "sample": f"sample (1 in {REVIEW_SAMPLE})",
        "all": "all",
    }[REVIEW_POLICY]
    log(
        f"{tag}disk writer: queue {WRITE_QUEUE} (records never dropped, review dropped when full); "
        f"review policy: {policy}; cap {REVIEW_MAX_PER_DAY}/day fleet-wide"
        f"{f' ({_REVIEW_CAP_PER_PROC} per process)' if _REVIEW_CAP_PER_PROC else ' (none)'} → data/review/<UTC date>/"
    )

    workers = []
    for c in cams:
        url = sources.get(c["monitorId"]) or stream_for(c["monitorId"], c)
        if not url:
            log(f"{c['monitorId']}: no source url, skipping")
            continue
        w = CameraWorker(c, url, models, backend)
        w.start()
        workers.append(w)
        time.sleep(0.5)
    if backend is not None and workers:
        start_health_thread(workers, backend, tag)
        log(
            f"{tag}health report every {HEALTH_EVERY:g}s → {BACKEND}/api/ai/anpr/camera-health; "
            f"priority poll every {PRIORITY_POLL:g}s; clip policy: {CLIP_POLICY}"
            + (" (review-queue reads are not clipped — hits only)" if CLIP_POLICY == "review" else "")
        )
    if backend is not None:
        # Forensic search (4 Oct 2026): when each camera was being read, and why
        # not. The lambda reads the CURRENT list (the refresh loop rebinds it).
        import analysis_heartbeat

        analysis_heartbeat.start(lambda: workers, tag, log)
    # ── supervision: follow the console's per-camera ANPR switches ───────────
    # Which cameras get read used to be fixed at start-up from ANPR_CAMERAS, so
    # an officer could not turn plate reading on for a junction without an
    # engineer editing compose and restarting. The switch now lives on the
    # camera row (migration 035) and this loop polls it: cameras turned ON are
    # started, cameras turned OFF are stopped, with no restart and no deploy.
    #
    # Sharding stays deterministic — every shard re-derives the same ordered
    # list and takes its own slice — so exactly one process owns each camera and
    # the shards need no coordination between them.
    next_refresh = time.time() + REFRESH_SECS
    try:
        while True:
            alive = [w for w in workers if w.is_alive()]
            if not alive and not REFRESH_SECS:
                break
            time.sleep(min(5.0, REFRESH_SECS) if REFRESH_SECS else 5.0)
            if not REFRESH_SECS or backend is None or DRY_RUN:
                if not any(w.is_alive() for w in workers):
                    break
                continue
            if time.time() < next_refresh:
                continue
            next_refresh = time.time() + REFRESH_SECS
            try:
                mine = _shard_of(_enabled_cams(backend, sources), shard_k, shard_n)
            except Exception as e:  # noqa: BLE001 — a refresh failure must never stop the reads
                log(f"{tag}camera refresh failed, keeping current set: {e.__class__.__name__}: {e}")
                continue
            want = {c["monitorId"]: c for c in mine}
            have = {w.name: w for w in workers if w.is_alive()}

            for mid, w in have.items():
                if mid not in want:
                    log(f"{tag}{mid}: disabled in the console — stopping plate reading")
                    w._stop_requested.set()

            for mid, c in want.items():
                if mid in have:
                    continue
                url = sources.get(mid) or stream_for(mid, c)
                if not url:
                    continue
                log(f"{tag}{mid}: enabled in the console — starting plate reading")
                nw = CameraWorker(c, url, models, backend)
                nw.start()
                workers.append(nw)
                time.sleep(0.5)

            workers = [w for w in workers if w.is_alive() or not w._stop_requested.is_set()]
            if not workers:
                log(f"{tag}no cameras enabled for this shard — waiting for one to be turned on")
    except KeyboardInterrupt:
        pass
    log(f"{tag}all camera workers exited")


def main():
    sources = parse_sources(SOURCES_ENV)
    cams: list[dict] = []
    backend = None  # stays None under ANPR_DRY_RUN (no backend at all)
    if not DRY_RUN:
        backend = Backend(start_threads=False)  # camera listing only — the shards own sender + outbox
        backend.login()
        # Only the cameras an operator has switched plate reading ON for. The
        # same helper is used by the refresh loop in run_cams, so start-up and
        # every later refresh agree on both the set and its order.
        cams = _enabled_cams(backend, sources)
        total = len(backend.cameras())
        log(
            f"plate reading enabled on {len(cams)} of {total} camera(s)"
            + (f"; re-checking every {REFRESH_SECS:g}s" if REFRESH_SECS else "; refresh disabled")
        )
    else:
        for name in sources:
            cams.append({"monitorId": name, "name": name, "latitude": None, "longitude": None})
        cams = _cap(cams)
    # container-level sharding: replica k of n owns every n-th camera
    before = len(cams)
    cams = _container_shard(cams)
    if len(cams) != before:
        log(f"shard {SHARD}: {len(cams)} camera(s)")
    if not cams:
        # With the console switches in play an empty set is a normal state, not
        # a fatal one: an operator may enable a camera a minute from now, and
        # exiting here would mean the switch does nothing until someone
        # restarts the worker. Stay up and let the refresh loop pick it up.
        if not REFRESH_SECS:
            log("no cameras have plate reading enabled — nothing to do")
            return
        log(
            "no cameras have plate reading enabled yet — waiting for one to be "
            f"switched on in the console (checking every {REFRESH_SECS:g}s)"
        )
    # Retention sweeper: ONE per host, in the parent — the shard processes are
    # spawned (fresh interpreters, __main__ guard) so they never start it.
    try:
        import retention

        retention.start_sweeper(
            records_dir=RECORDS_DIR,
            review_dir=os.path.join(DATA_DIR, "review"),
            confirmed_dir=os.path.join(DATA_DIR, "confirmed"),
            days=retention.days_from_env(),
            dry_run=os.getenv("ANPR_RETENTION_DRY_RUN", "0") == "1",
            log=log,
        )
    except Exception as e:  # noqa: BLE001 — storage policy must never stop the reads
        log(f"retention: not started: {e.__class__.__name__}: {e}")
    # Daily export of the day's records to the Windows-visible folder
    # (export/records/<date>): evidence lives on the fast Docker volume; the
    # officer's Explorer view is a sequential low-priority copy at 02:30 IST.
    try:
        import export_records

        export_records.start_daily_export(log=log)
    except Exception as e:  # noqa: BLE001
        log(f"export: not started: {e.__class__.__name__}: {e}")
    # `or 1` keeps the process count sane when nothing is enabled yet — the
    # single process then sits in its refresh loop waiting for a switch.
    n = max(1, min(PROCESSES, len(cams) or 1))
    if n == 1:
        run_cams(cams, sources, "", 0, 1, backend._token if backend else None)
        return
    # spawn (not fork): CUDA contexts must not be inherited across a fork
    import multiprocessing as mp

    ctx = mp.get_context("spawn")
    procs = []
    for i in range(n):
        shard = _shard_of(cams, i, n)  # same ownership rule the refresh loop uses
        # Pass the process's shard identity so its refresh loop re-derives the
        # SAME slice from the freshly polled list.
        p = ctx.Process(
            target=run_cams,
            args=(shard, sources, f"p{i}", i, n, backend._token if backend else None),
            name=f"anpr-p{i}",
            daemon=False,
        )
        p.start()
        procs.append(p)
        log(f"shard p{i}: {len(shard)} camera(s) → pid {p.pid}")
        time.sleep(2.0)
    try:
        for p in procs:
            p.join()
    except KeyboardInterrupt:
        for p in procs:
            p.terminate()
    log("all shards exited")


if __name__ == "__main__":
    main()
