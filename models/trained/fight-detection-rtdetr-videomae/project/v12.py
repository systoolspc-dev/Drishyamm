#v12#
import os
import sys
import csv
import cv2
import torch
import numpy as np
from PIL import Image
from collections import deque

from ultralytics import RTDETR
from transformers import AutoImageProcessor, VideoMAEForVideoClassification

# ==========================================
# CONFIG (Ye settings video ke hisaab se auto-adjust hongi)
# ==========================================
VIDEO_SOURCE= "/home/systools/Documents/ai fight/Ranking Top 5 Funny Women Fighting Moments #rankingfails #ranking #funnyfighting_1080p50(1).mp4"
OUTPUT_DIR = "./fight_detection_output"

DETECTOR_MODEL_PATH = "rtdetr-l.pt"  # RT-DETR natively supported by Ultralytics
DETECTOR_CONF = 0.30
DETECTOR_PERSON_CLASS = 0

VIDEOMAE_MODEL_DIR = "./videomae-best-3class"
VIDEOMAE_WEIGHTS = "./videomae_best_3class.pt"
NUM_FRAMES = 16                     # frames fed to VideoMAE per clip
BUFFER_SECONDS = 2.0                # how much recent video we always keep ready (2 seconds matches training)

CLASS_LABELS = ["FIGHT", "NORMAL", "CROWD"]
LABEL2ID = {l: i for i, l in enumerate(CLASS_LABELS)}
ID2LABEL = {i: l for i, l in enumerate(CLASS_LABELS)}

COLORS = {
    "FIGHT": (0, 0, 255), "NORMAL": (0, 200, 0),
    "CROWD": (255, 165, 0), "RIOT": (0, 0, 180),
    "PERSON": (0, 255, 255), "CROP": (255, 0, 255),
}

# --- Crop settings (CCTV me zoom karne ke liye) ---
CROP_PAD_RATIO = 0.6
MIN_CROP_SIZE = 224

# --- ByteTrack (built into Ultralytics, no training needed) ---
BYTETRACK_CONFIG = "bytetrack_cctv.yaml"   # ships with ultralytics; tune via a copy if needed

# --- Performance knobs (this is what was causing the lag) ---
YOLO_INFER_SIZE = 1280          # High res inference to catch small/occluded people in dense crowds
                                 # 1280x720 CCTV frame at imgsz=640 is ~4x fewer pixels than native
FLOW_DOWNSCALE_SIZE = 160        # resize ROI to this before optical flow (speed, not accuracy-critical)
FLOW_EVERY_N_FRAMES = 2          # compute optical flow every Nth frame, reuse value in between
SHOW_LIVE_WINDOW = True          # set False in production - imshow/GUI adds real overhead

# --- Suspicion signal thresholds ---
CLOSE_RATIO = 1.5                   # centers-distance / avg_size below this = "close"
INTERACTION_TIME_THRESHOLD = 0.6    # seconds two people must stay close to count fully
MOTION_NORM_CAP = 6.0               # Farneback flow-magnitude that maps to motion score 1.0
                                     # (re-tune on your footage - print raw `motion` values first)
SUSPICION_THRESHOLD = 0.40          # score >= this -> run VideoMAE this cycle

# --- Cadence / cooldown for the (expensive) VideoMAE call (Baar-baar model na chale) ---
MIN_CLASSIFY_INTERVAL_SECONDS = 0.5 # don't classify more often than this
IDLE_DECAY = 0.85                   # confidence decays toward 0 while skipping

# --- Temporal voting (Frames ko smooth karne ke liye taaki flicker na ho) ---
VOTE_WINDOW_CCTV = 4                # CCTV ke liye thoda smoothing (zyada karne se fight miss ho sakti hai)
VOTE_WINDOW_MOBILE = 2              # Mobile videos me fast reaction chahiye

ALARM_CONFIDENCE_THRESHOLD = 0.80   # Agar model 80% sure hai tabhi alarm bajega

def is_confirmed_fight(label, conf, person_count):
    if label not in ("FIGHT", "RIOT"):
        return False
    threshold = ALARM_CONFIDENCE_THRESHOLD
    if person_count > 5:
        threshold = min(0.95, ALARM_CONFIDENCE_THRESHOLD + (person_count - 5) * 0.02)
    return conf >= threshold

# --- Feature logging (to bootstrap a future learned gating model) ---
LOG_FEATURES = True


# ==========================================
# LOAD MODELS
# ==========================================
def load_models(device):
    print("=" * 60)
    print(" Loading Models...")
    print("=" * 60)

    detector_model = RTDETR(DETECTOR_MODEL_PATH)
    print(f"[1/2] RT-DETR loaded: {DETECTOR_MODEL_PATH}")

    image_processor = AutoImageProcessor.from_pretrained(VIDEOMAE_MODEL_DIR)
    videomae_model = VideoMAEForVideoClassification.from_pretrained(
        VIDEOMAE_MODEL_DIR, label2id=LABEL2ID, id2label=ID2LABEL,
        ignore_mismatched_sizes=True,
    )
    state_dict = torch.load(VIDEOMAE_WEIGHTS, map_location=device, weights_only=True)
    videomae_model.load_state_dict(state_dict)
    videomae_model.to(device).eval()
    print(f"[2/2] VideoMAE loaded: {VIDEOMAE_MODEL_DIR}")
    print("=" * 60)
    return detector_model, videomae_model, image_processor


# ==========================================
# TRACK OBJECT (built from ByteTrack output) + INTERACTION BOOKKEEPING
# ==========================================
class TrackObj:
    """Ek frame me ek person ke bounding box (tracker data) ka wrapper."""
    __slots__ = ("id", "center", "size", "box")

    def __init__(self, tid, box):
        x1, y1, x2, y2 = box
        self.id = tid
        self.center = ((x1 + x2) / 2, (y1 + y2) / 2)
        self.size = max((x2 - x1 + y2 - y1) / 2, 1)
        self.box = box


def get_tracks_from_yolo_track_result(result):
    """Extract TrackObj list from a single ultralytics `.track()` result.
    ByteTrack handles association/occlusion for us - we just read the IDs."""
    tracks = []
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return tracks, boxes

    ids = boxes.id
    if ids is not None:
        ids = ids.int().tolist()
    else:
        # ByteTrack occasionally has a frame with no confirmed ID yet
        # (e.g. very first frame) - fall back to a per-frame index so the
        # rest of the pipeline still works, just without persistence.
        ids = list(range(len(boxes)))

    for box, tid in zip(boxes, ids):
        x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
        tracks.append(TrackObj(tid, (x1, y1, x2, y2)))

    return tracks, boxes


class InteractionTracker:
    """Given ByteTrack IDs each frame, bookkeeps how long each pair of IDs
    has stayed 'close'. Association/occlusion is ByteTrack's job now - this
    class only needs to remember timestamps per ID-pair."""

    def __init__(self, id_grace_frames=5):
        # pair_key(id_a,id_b) -> timestamp when they FIRST became close (still close)
        self.close_since = {}
        self.last_seen_frame = {}
        self.id_grace_frames = id_grace_frames

    def update(self, tracks, t, frame_num):
        live_ids = {trk.id for trk in tracks}
        for trk in tracks:
            self.last_seen_frame[trk.id] = frame_num
            
        max_interaction = 0.0

        for i in range(len(tracks)):
            for j in range(i + 1, len(tracks)):
                a, b = tracks[i], tracks[j]
                dx, dy = a.center[0] - b.center[0], a.center[1] - b.center[1]
                dist = (dx ** 2 + dy ** 2) ** 0.5           # correct Euclidean distance
                avg_size = (a.size + b.size) / 2
                ratio = dist / max(avg_size, 1)
                key = tuple(sorted((a.id, b.id)))

                if ratio < CLOSE_RATIO:
                    self.close_since.setdefault(key, t)
                    max_interaction = max(max_interaction, t - self.close_since[key])
                else:
                    self.close_since.pop(key, None)

        # forget pairs whose tracks no longer exist
        for key in list(self.close_since.keys()):
            a_missing = key[0] not in live_ids and frame_num - self.last_seen_frame.get(key[0], -999) > self.id_grace_frames
            b_missing = key[1] not in live_ids and frame_num - self.last_seen_frame.get(key[1], -999) > self.id_grace_frames
            if a_missing or b_missing:
                del self.close_since[key]

        return max_interaction


# ==========================================
# SUSPICION SIGNALS
# ==========================================
def compute_proximity(tracks):
    """0..1 score: how close is the closest pair of people (fixed distance formula)."""
    if len(tracks) < 2:
        return 0.0
    min_ratio = float("inf")
    for i in range(len(tracks)):
        for j in range(i + 1, len(tracks)):
            a, b = tracks[i], tracks[j]
            dx, dy = a.center[0] - b.center[0], a.center[1] - b.center[1]
            dist = (dx ** 2 + dy ** 2) ** 0.5               # FIXED
            avg_size = (a.size + b.size) / 2
            ratio = dist / max(avg_size, 1)
            min_ratio = min(min_ratio, ratio)

    if min_ratio < 0.5:
        return 1.0
    elif min_ratio < 1.5:
        return 0.7
    elif min_ratio < 2.5:
        return 0.3
    return 0.0


def compute_overlap(tracks):
    """Max IoU between any two person boxes -> 0..1."""
    if len(tracks) < 2:
        return 0.0
    best_iou = 0.0
    for i in range(len(tracks)):
        for j in range(i + 1, len(tracks)):
            ax1, ay1, ax2, ay2 = tracks[i].box
            bx1, by1, bx2, by2 = tracks[j].box
            ix1, iy1 = max(ax1, bx1), max(ay1, by1)
            ix2, iy2 = min(ax2, bx2), min(ay2, by2)
            iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
            inter = iw * ih
            if inter == 0:
                continue
            area_a = (ax2 - ax1) * (ay2 - ay1)
            area_b = (bx2 - bx1) * (by2 - by1)
            iou = inter / max(area_a + area_b - inter, 1)
            best_iou = max(best_iou, iou)
    return best_iou


ALIGN_DOWNSCALE = 0.5

def align_frames(prev_gray, curr_gray, person_boxes=None):
    """Camera ka hilna (shaking) compensate karne ke liye (CCTV/Mobile dono me kaam aata hai)."""
    small_prev = cv2.resize(prev_gray, None, fx=ALIGN_DOWNSCALE, fy=ALIGN_DOWNSCALE)
    small_curr = cv2.resize(curr_gray, None, fx=ALIGN_DOWNSCALE, fy=ALIGN_DOWNSCALE)
    
    mask = None
    if person_boxes:
        mask = np.full(small_prev.shape, 255, dtype=np.uint8)
        pad = int(10 * ALIGN_DOWNSCALE)
        for (x1, y1, x2, y2) in person_boxes:
            sx1, sy1 = max(0, int(x1 * ALIGN_DOWNSCALE) - pad), max(0, int(y1 * ALIGN_DOWNSCALE) - pad)
            sx2, sy2 = int(x2 * ALIGN_DOWNSCALE) + pad, int(y2 * ALIGN_DOWNSCALE) + pad
            mask[sy1:sy2, sx1:sx2] = 0

    prev_pts = cv2.goodFeaturesToTrack(small_prev, maxCorners=200, qualityLevel=0.01, minDistance=15, blockSize=3, mask=mask)
    if prev_pts is None or len(prev_pts) < 10:
        return prev_gray

    curr_pts, status, err = cv2.calcOpticalFlowPyrLK(small_prev, small_curr, prev_pts, None)
    
    idx = np.where(status.flatten() == 1)[0]
    prev_pts, curr_pts = prev_pts[idx] / ALIGN_DOWNSCALE, curr_pts[idx] / ALIGN_DOWNSCALE
    
    if len(prev_pts) < 10:
        return prev_gray

    # RANSAC ignores moving objects (people) and locks onto the static background
    M, inliers = cv2.estimateAffinePartial2D(prev_pts, curr_pts, method=cv2.RANSAC)
    
    if M is None:
        return prev_gray
        
    h, w = prev_gray.shape
    aligned_prev = cv2.warpAffine(prev_gray, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    
    return aligned_prev


def compute_motion_and_chaos(prev_gray, gray, roi_box):
    """Farneback dense optical flow magnitude and circular variance (chaos) inside the ROI."""
    if prev_gray is None or roi_box is None:
        return 0.0, 0.0
    x1, y1, x2, y2 = roi_box
    if x2 <= x1 or y2 <= y1:
        return 0.0, 0.0
    prev_roi = prev_gray[y1:y2, x1:x2]
    curr_roi = gray[y1:y2, x1:x2]
    if prev_roi.size == 0 or prev_roi.shape != curr_roi.shape:
        return 0.0, 0.0

    # Downscale before the expensive dense-flow computation
    target = (FLOW_DOWNSCALE_SIZE, FLOW_DOWNSCALE_SIZE)
    prev_small = cv2.resize(prev_roi, target, interpolation=cv2.INTER_AREA)
    curr_small = cv2.resize(curr_roi, target, interpolation=cv2.INTER_AREA)

    flow = cv2.calcOpticalFlowFarneback(
        prev_small, curr_small, None, 0.5, 3, 15, 3, 5, 1.2, 0
    )
    mag, ang = cv2.cartToPolar(flow[..., 0], flow[..., 1])
    
    # 1. Motion Score
    motion_score = float(np.mean(mag)) / MOTION_NORM_CAP
    motion_score = min(motion_score, 1.0)
    
    # 2. Chaos Score (Circular Variance of angles)
    # Exclude stationary background to only measure chaos of moving objects
    MOTION_SIGNIFICANCE_RATIO = 0.15
    moving_mask = mag > (MOTION_NORM_CAP * MOTION_SIGNIFICANCE_RATIO)
    if np.any(moving_mask):
        sig_angs = ang[moving_mask]
        sin_ang = np.sin(sig_angs)
        cos_ang = np.cos(sig_angs)
        R = np.sqrt(np.mean(sin_ang)**2 + np.mean(cos_ang)**2)
        chaos_score = 1.0 - R # 0 = uniform direction (crowd/camera shake), 1 = chaotic (fight)
    else:
        chaos_score = 0.0
        
    return motion_score, chaos_score


def compute_suspicion(person_count, proximity, overlap, motion, chaos, interaction_time):
    """Weighted combination of cheap signals -> 0..1 score."""
    score = 0.0
    if person_count >= 2:
        score += 0.20
    score += proximity * 0.25
    score += overlap * 0.20
    score += motion * 0.15
    score += chaos * 0.10
    score += min(interaction_time / INTERACTION_TIME_THRESHOLD, 1.0) * 0.10

    return max(0.0, min(score, 1.0))


# ==========================================
# ROI (crop) FROM TRACKS
# ==========================================
def get_smart_roi_bboxes(tracks, frame_h, frame_w, is_mobile_closeup=False):
    """
    Multi-Fight Batching (v11 Greedy Pair Clustering):
    Logo ki bheed me jaha log sabse zyada close hain aur overlap kar rahe hain,
    unka ek alag cluster (crop box) banata hai. Isse "A touches B touches C" wala lamba
    crowd chain nahi banta, aur VideoMAE exact fight area par dhyan de pata hai.
    """
    if not tracks:
        return []

    n = len(tracks)
    if n < 2:
        return [(max(0, tracks[0].box[0]-50), max(0, tracks[0].box[1]-50), min(frame_w, tracks[0].box[2]+50), min(frame_h, tracks[0].box[3]+50))]

    # 1. Score all pairs based on overlap and proximity
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            ax1, ay1, ax2, ay2 = tracks[i].box
            bx1, by1, bx2, by2 = tracks[j].box
            ix1, iy1 = max(ax1, bx1), max(ay1, by1)
            ix2, iy2 = min(ax2, bx2), min(ay2, by2)
            
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            area_a = (ax2 - ax1) * (ay2 - ay1)
            area_b = (bx2 - bx1) * (by2 - by1)
            iou = inter / max(area_a + area_b - inter, 1)
            
            dist = ((tracks[i].center[0] - tracks[j].center[0])**2 + (tracks[i].center[1] - tracks[j].center[1])**2)**0.5
            avg_size = (tracks[i].size + tracks[j].size) / 2
            
            # Calculate an interaction intensity score (higher is better)
            intensity = iou + (avg_size / max(dist, 1.0))
            pairs.append((intensity, i, j, iou, dist, avg_size))

    # 2. Sort pairs by highest intensity
    pairs.sort(key=lambda x: x[0], reverse=True)

    # 3. Form greedy clusters
    dist_thresh = 0.5 if is_mobile_closeup else 1.5
    iou_thresh = 0.15 if is_mobile_closeup else 0.0

    max_cluster_size = 5
    parent = list(range(n))
    size = [1] * n
    def find(x):
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]

    for intensity, i, j, iou, dist, avg_size in pairs:
        if iou > iou_thresh or dist < (avg_size * dist_thresh):
            ri, rj = find(i), find(j)
            if ri != rj and size[ri] + size[rj] <= max_cluster_size:
                parent[ri] = rj
                size[rj] += size[ri]

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(tracks[i])
        
    clusters = [g for g in groups.values() if len(g) >= 2]

    # Fallback: if no pairs passed the strict threshold but a fight was flagged,
    # just grab the single most intensely interacting pair in the whole frame.
    if not clusters and pairs:
        _, i, j, _, _, _ = pairs[0]
        clusters.append([tracks[i], tracks[j]])

    # 4. Create a box for EACH cluster
    roi_bboxes = []
    for cluster_tracks in clusters:
        xs1 = [t.box[0] for t in cluster_tracks]
        ys1 = [t.box[1] for t in cluster_tracks]
        xs2 = [t.box[2] for t in cluster_tracks]
        ys2 = [t.box[3] for t in cluster_tracks]

        gx1, gy1, gx2, gy2 = min(xs1), min(ys1), max(xs2), max(ys2)
        gw, gh = gx2 - gx1, gy2 - gy1
        pad_x, pad_y = int(gw * CROP_PAD_RATIO), int(gh * CROP_PAD_RATIO)

        gx1 = max(0, gx1 - pad_x)
        gy1 = max(0, gy1 - pad_y)
        gx2 = min(frame_w, gx2 + pad_x)
        gy2 = min(frame_h, gy2 + pad_y)

        if (gx2 - gx1) < MIN_CROP_SIZE or (gy2 - gy1) < MIN_CROP_SIZE:
            cx, cy = (gx1 + gx2) // 2, (gy1 + gy2) // 2
            half = MIN_CROP_SIZE // 2
            gx1 = max(0, cx - half)
            gy1 = max(0, cy - half)
            gx2 = min(frame_w, cx + half)
            gy2 = min(frame_h, cy + half)

        roi_bboxes.append((gx1, gy1, gx2, gy2))

    return roi_bboxes


# ==========================================
# VideoMAE CLASSIFICATION (single pass, on ROI only)
# ==========================================
def get_peak_motion_indices(frames_buffer, num_frames, roi_bbox):
    if len(frames_buffer) < num_frames:
        return np.arange(len(frames_buffer))
        
    grays = []
    for f in frames_buffer:
        if roi_bbox is not None:
            x1, y1, x2, y2 = roi_bbox
            crop = f[y1:y2, x1:x2]
            if crop.size == 0:
                crop = f
        else:
            crop = f
        grays.append(cv2.cvtColor(cv2.resize(crop, (80, 80)), cv2.COLOR_BGR2GRAY))
        
    diffs = [float(np.mean(cv2.absdiff(grays[i], grays[i-1]))) for i in range(1, len(grays))]
    if not diffs:
        return np.linspace(0, len(frames_buffer) - 1, num_frames, dtype=int)
        
    peak_idx = int(np.argmax(diffs)) + 1
    
    # We need to maintain the temporal stride VideoMAE was trained on (usually spanning 2 seconds).
    # If we just take 16 contiguous frames, the model sees a 0.6s slow-mo slice and predicts NORMAL.
    # We take a window spanning up to 50 frames (approx 2 seconds) centered on the peak.
    window_size = min(len(frames_buffer), 50) 
    half = window_size // 2
    lo = max(0, peak_idx - half)
    hi = min(len(frames_buffer), lo + window_size)
    lo = max(0, hi - window_size)
    
    return np.linspace(lo, hi - 1, num_frames, dtype=int)

def classify_roi(frames_buffer, roi_bbox, videomae_model, image_processor, device):
    """Sample NUM_FRAMES from the sliding buffer, crop each to roi_bbox, classify once.
    (v2 ran this TWICE per cycle - full frame + crop - which was the main
    speed cost. We crop once; if there's no valid ROI we fall back to full frame.)"""
    if len(frames_buffer) < NUM_FRAMES:
        return "NORMAL", 0.0, {l: 0.0 for l in CLASS_LABELS}

    indices = get_peak_motion_indices(frames_buffer, NUM_FRAMES, roi_bbox)
    sampled = []
    for i in indices:
        frame = frames_buffer[i]
        if roi_bbox is not None:
            x1, y1, x2, y2 = roi_bbox
            crop = frame[y1:y2, x1:x2]
            sampled.append(crop if crop.size > 0 else frame)
        else:
            sampled.append(frame)

    pil_frames = [Image.fromarray(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)) for f in sampled]
    inputs = image_processor(pil_frames, return_tensors="pt")
    pixel_values = inputs["pixel_values"].to(device)

    with torch.no_grad():
        outputs = videomae_model(pixel_values=pixel_values)
        # T=1.0 (no scaling). T=1.7 was crushing FIGHT probabilities making
        # them invisible to the alarm threshold. Calibration should happen
        # offline with fit_temperature() on a held-out validation set.
        probs = torch.softmax(outputs.logits, dim=-1)[0]

    pred_idx = probs.argmax().item()
    pred_label = ID2LABEL[pred_idx]
    confidence = probs[pred_idx].item()
    all_probs = {ID2LABEL[i]: probs[i].item() for i in range(len(CLASS_LABELS))}
    return pred_label, confidence, all_probs


# ==========================================
# TEMPORAL VOTING (only fed real classifications, not idle skips)
# ==========================================
class TemporalVoter:
    def __init__(self, max_window=8):
        self.history = deque(maxlen=max_window)

    def update(self, label, conf, probs):
        self.history.append((label, conf, probs))

    def clear(self):
        self.history.clear()

    def get_result(self, is_mobile=False, person_count=0):
        if not self.history:
            return "NORMAL", 0.0, {l: 0.0 for l in CLASS_LABELS}
            
        # DYNAMIC SMOOTHING: Mobile videos get fast reactions, CCTV gets heavy smoothing
        active_window = VOTE_WINDOW_MOBILE if is_mobile else VOTE_WINDOW_CCTV
        
        items_to_average = list(self.history)[-active_window:]
        n = len(items_to_average)
        
        avg_probs = {l: 0.0 for l in CLASS_LABELS}
        for _, _, probs in items_to_average:
            for l in CLASS_LABELS:
                avg_probs[l] += probs.get(l, 0.0)
                
        for l in CLASS_LABELS:
            avg_probs[l] /= max(n, 1)
            
        best_label = max(avg_probs, key=avg_probs.get)
        
        # APPLY THRESHOLD: If it predicts FIGHT or RIOT but confidence is too low,
        # it is likely just an aggressive CROWD or normal motion.
        if best_label in ("FIGHT", "RIOT") and not is_confirmed_fight(best_label, avg_probs[best_label], person_count):
            # Fallback to CROWD if many people, otherwise NORMAL
            best_label = "CROWD" if avg_probs.get("CROWD", 0) > 0.15 else "NORMAL"
            
        return best_label, avg_probs[best_label], avg_probs


# ==========================================
# FEATURE LOGGER (bootstraps a future learned gating model)
# ==========================================
class FeatureLogger:
    """Writes one CSV row per frame with the cheap suspicion features plus
    the VideoMAE result whenever the gate fired. You don't have labeled
    data to train XGBoost/MLP today - but once you manually label a batch
    of clips as fight/normal (e.g. by timestamp ranges), you can join those
    labels onto this CSV by frame_num/timestamp_s and train a simple
    LogisticRegression or XGBoostClassifier offline. That trained model
    then replaces the hand-tuned weights in compute_suspicion()."""

    FIELDS = ["frame_num", "timestamp_s", "person_count", "proximity",
              "overlap", "motion", "chaos", "interaction_time", "suspicion_score",
              "gate_fired", "videomae_label", "videomae_conf"]

    def __init__(self, path):
        self._file = open(path, "w", newline="")
        self._writer = csv.writer(self._file)
        self._writer.writerow(self.FIELDS)

    def log(self, frame_num, t, person_count, proximity, overlap, motion, chaos,
            interaction_time, suspicion, gate_fired, label=None, conf=None):
        self._writer.writerow([
            frame_num, f"{t:.3f}", person_count, f"{proximity:.3f}",
            f"{overlap:.3f}", f"{motion:.3f}", f"{chaos:.3f}", f"{interaction_time:.3f}",
            f"{suspicion:.3f}", int(gate_fired),
            label or "", f"{conf:.3f}" if label else "",
        ])

    def close(self):
        self._file.close()


# ==========================================
# DRAW HUD
# ==========================================
def draw_hud(frame, label, conf, all_probs, person_count, suspicion, mode,
             frame_num, total_frames, roi_bbox):
    h, w = frame.shape[:2]
    s = max(max(w, h) / 1280.0, 0.8)
    pad = int(10 * s)
    font_sm, font_md, font_lg, font_xl = 0.45 * s, 0.7 * s, 0.9 * s, 1.2 * s
    th_sm, th_md, th_lg = max(1, int(s)), max(1, int(2 * s)), max(2, int(3 * s))

    pw, ph = int(420 * s), int(255 * s)
    ov = frame.copy()
    cv2.rectangle(ov, (pad, pad), (pad + pw, pad + ph), (0, 0, 0), -1)
    cv2.addWeighted(ov, 0.7, frame, 0.3, 0, frame)

    cv2.putText(frame, "ACTION CLASSIFICATION", (int(20 * s), int(35 * s)),
                cv2.FONT_HERSHEY_SIMPLEX, font_md, (255, 255, 255), th_md)

    mode_color = (0, 220, 255) if mode == "ACTIVE" else (150, 150, 150)
    cv2.putText(frame, f"[{mode}]", (int(300 * s), int(35 * s)),
                cv2.FONT_HERSHEY_SIMPLEX, font_sm, mode_color, th_sm)

    color = COLORS.get(label, (255, 255, 255))
    cv2.putText(frame, f"{label}: {conf:.1%}", (int(20 * s), int(70 * s)),
                cv2.FONT_HERSHEY_SIMPLEX, font_lg, color, th_md)

    y_off = int(95 * s)
    bar_max, bar_h, bar_gap = int(250 * s), int(18 * s), int(25 * s)
    for cl in CLASS_LABELS:
        p = all_probs.get(cl, 0.0)
        bc = COLORS.get(cl, (200, 200, 200))
        bw = int(p * bar_max)
        cv2.putText(frame, f"{cl[:5]:>5}", (int(20 * s), y_off + bar_h - 3),
                    cv2.FONT_HERSHEY_SIMPLEX, font_sm, (200, 200, 200), th_sm)
        cv2.rectangle(frame, (int(100 * s), y_off), (int(100 * s) + bw, y_off + bar_h), bc, -1)
        cv2.rectangle(frame, (int(100 * s), y_off), (int(100 * s) + bar_max, y_off + bar_h), (100, 100, 100), th_sm)
        cv2.putText(frame, f"{p:.1%}", (int(360 * s), y_off + bar_h - 3),
                    cv2.FONT_HERSHEY_SIMPLEX, font_sm, (200, 200, 200), th_sm)
        y_off += bar_gap

    susp_color = (0, 0, 255) if suspicion >= SUSPICION_THRESHOLD else (0, 200, 0)
    cv2.putText(frame, f"Suspicion: {suspicion:.0%}", (int(20 * s), y_off + int(10 * s)),
                cv2.FONT_HERSHEY_SIMPLEX, font_sm, susp_color, th_sm)

    yt = f"Persons: {person_count}"
    tsz = cv2.getTextSize(yt, cv2.FONT_HERSHEY_SIMPLEX, font_md, th_md)[0]
    xp = w - tsz[0] - int(30 * s)
    ov2 = frame.copy()
    cv2.rectangle(ov2, (xp - pad, pad), (w - pad, int(55 * s)), (0, 0, 0), -1)
    cv2.addWeighted(ov2, 0.7, frame, 0.3, 0, frame)
    yc = (0, 0, 255) if person_count > 0 else (0, 200, 0)
    cv2.putText(frame, yt, (xp, int(40 * s)), cv2.FONT_HERSHEY_SIMPLEX, font_md, yc, th_md)

    if roi_bbox is not None:
        cx1, cy1, cx2, cy2 = roi_bbox
        cv2.rectangle(frame, (cx1, cy1), (cx2, cy2), COLORS["CROP"], 2)
        cv2.putText(frame, "CROP REGION (fed to model)", (cx1, cy1 - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, font_sm, COLORS["CROP"], th_sm)

    progress = frame_num / max(total_frames, 1)
    bar_y = h - int(30 * s)
    prog_h = int(15 * s)
    cv2.rectangle(frame, (pad, bar_y), (w - pad, bar_y + prog_h), (50, 50, 50), -1)
    cv2.rectangle(frame, (pad, bar_y), (pad + int((w - 2 * pad) * progress), bar_y + prog_h), (0, 200, 255), -1)
    cv2.putText(frame, f"Frame {frame_num}/{total_frames}", (int(15 * s), bar_y - int(5 * s)),
                cv2.FONT_HERSHEY_SIMPLEX, font_sm, (200, 200, 200), th_sm)

    # --- DYNAMIC CONFIDENCE THRESHOLD ---
    if is_confirmed_fight(label, conf, person_count):
        alert = f"!! {label} DETECTED !!"
        tsz2 = cv2.getTextSize(alert, cv2.FONT_HERSHEY_SIMPLEX, font_xl, th_lg)[0]
        xc = (w - tsz2[0]) // 2
        ov3 = frame.copy()
        cv2.rectangle(ov3, (xc - int(20 * s), h // 2 - int(40 * s)),
                      (xc + tsz2[0] + int(20 * s), h // 2 + int(20 * s)), (0, 0, 180), -1)
        cv2.addWeighted(ov3, 0.8, frame, 0.2, 0, frame)
        cv2.putText(frame, alert, (xc, h // 2), cv2.FONT_HERSHEY_SIMPLEX, font_xl, (255, 255, 255), th_lg)

    return frame


# ==========================================
# MAIN PIPELINE
# ==========================================
def run_pipeline(video_path):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    detector_model, videomae_model, image_processor = load_models(device)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"ERROR: Cannot open video: {video_path}")
        sys.exit(1)

    fps = int(cap.get(cv2.CAP_PROP_FPS)) or 25
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f"\nVideo: {os.path.basename(video_path)}")
    print(f"Resolution: {width}x{height} | FPS: {fps} | Frames: {total_frames}")

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(video_path))[0]
    out_path = os.path.join(OUTPUT_DIR, base_name + "_v12.mp4")
    writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))

    log_path = os.path.join(OUTPUT_DIR, base_name + "_features.csv")
    logger = FeatureLogger(log_path) if LOG_FEATURES else None

    buffer_len = max(NUM_FRAMES, int(fps * BUFFER_SECONDS))
    frame_buffer = deque(maxlen=buffer_len)   # always sliding - no "wait to fill" restart lag

    interaction_tracker = InteractionTracker()
    voter = TemporalVoter(max_window=VOTE_WINDOW_CCTV)

    current_label, current_conf = "NORMAL", 0.0
    current_probs = {l: 0.0 for l in CLASS_LABELS}
    current_roi = None
    current_mode = "IDLE"
    last_classify_t = -999.0
    prev_gray = None
    cached_motion = 0.0   # reused on frames where we skip optical flow (speed)
    cached_chaos = 0.0

    frame_num = 0
    print(f"\nProcessing... hybrid mode: ByteTrack + optical flow every frame, "
          f"VideoMAE only when suspicion >= {SUSPICION_THRESHOLD:.0%} "
          f"(cooldown {MIN_CLASSIFY_INTERVAL_SECONDS}s)")
    if LOG_FEATURES:
        print(f"Logging features to: {log_path}")
    print(f"Device: {device} | YOLO imgsz: {YOLO_INFER_SIZE} | "
          f"Flow every {FLOW_EVERY_N_FRAMES} frame(s) at {FLOW_DOWNSCALE_SIZE}px | "
          f"Live window: {SHOW_LIVE_WINDOW}")
    print("-" * 60)

    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        # --- LOW LIGHT HANDLING (CLAHE) ---
        gray_temp = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if np.mean(gray_temp) < 60:
            lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
            l, a, b = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            cl = clahe.apply(l)
            frame = cv2.cvtColor(cv2.merge((cl, a, b)), cv2.COLOR_LAB2BGR)
            
        frame_num += 1
        t = frame_num / fps  # video-timeline seconds, stable regardless of processing speed

        # BUG FIX: grab a clean copy BEFORE any boxes/HUD are drawn on `frame`.
        # Previously the buffer stored `frame` *after* YOLO boxes were drawn on
        # it, so VideoMAE was classifying frames with colored rectangles/ID
        # labels burned in - that hurts both accuracy and (marginally) speed.
        clean_frame = frame.copy()

        # --- RT-DETR + ByteTrack person detection & tracking ---
        results = detector_model.track(
            frame, persist=True, tracker=BYTETRACK_CONFIG,
            conf=DETECTOR_CONF, classes=[DETECTOR_PERSON_CLASS], verbose=False,
            imgsz=YOLO_INFER_SIZE,
        )
        tracks, person_boxes = [], []
        for result in results:
            tracks, person_boxes = get_tracks_from_yolo_track_result(result)
        person_count = len(tracks)

        for trk in tracks:
            x1, y1, x2, y2 = trk.box
            box_color = COLORS["FIGHT"] if (current_label in ("FIGHT", "RIOT") and current_conf > 0.4) else COLORS["PERSON"]
            cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 3)
            lt = f"ID {trk.id}"
            (tw, th), _ = cv2.getTextSize(lt, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
            cv2.rectangle(frame, (x1, y1 - th - 10), (x1 + tw + 10, y1), box_color, -1)
            cv2.putText(frame, lt, (x1 + 5, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)

        # --- AUTO-SWITCH LOGIC (Mobile vs CCTV) ---
        frame_area = width * height
        avg_box_area_ratio = 0.0
        if tracks:
            avg_box_area = sum([(t.box[2]-t.box[0]) * (t.box[3]-t.box[1]) for t in tracks]) / len(tracks)
            avg_box_area_ratio = avg_box_area / frame_area
            
        is_mobile_closeup = avg_box_area_ratio > 0.15 and person_count >= 2 # If avg person takes up >15% of screen AND there are at least 2 people

        # --- Cheap suspicion signals (no model cost) ---
        interaction_time = interaction_tracker.update(tracks, t, frame_num)
        proximity = compute_proximity(tracks)
        overlap = compute_overlap(tracks)

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        roi_boxes = get_smart_roi_bboxes(tracks, height, width, is_mobile_closeup)
        
        if frame_num % FLOW_EVERY_N_FRAMES == 0:
            max_motion, max_chaos = 0.0, 0.0
            if roi_boxes and prev_gray is not None:
                aligned_prev = align_frames(prev_gray, gray, [t.box for t in tracks])
                for roi in roi_boxes:
                    m, c = compute_motion_and_chaos(aligned_prev, gray, roi)
                    max_motion = max(max_motion, m)
                    max_chaos = max(max_chaos, c)
            cached_motion = max_motion
            cached_chaos = max_chaos
            
        motion = cached_motion
        chaos = cached_chaos
        prev_gray = gray

        suspicion = compute_suspicion(person_count, proximity, overlap, motion, chaos, interaction_time)

        # --- Buffer always slides forward (clean frame, no overlays - see bug fix above) ---
        frame_buffer.append(clean_frame)

        # --- Gate: VideoMAE sirf tab chalega jab log suspicious honge aur 0.5 sec ka cooldown khatam hoga ---
        # Agar mobile closeup hai toh ye gate bypass ho jayega (har 0.5s pe chalega)
        is_suspicious = (suspicion >= SUSPICION_THRESHOLD and person_count >= 1) or is_mobile_closeup
        cooldown_ok = (t - last_classify_t) >= MIN_CLASSIFY_INTERVAL_SECONDS

        gate_fired = is_suspicious and cooldown_ok and len(frame_buffer) >= NUM_FRAMES

        if gate_fired:
            # UNIVERSAL RULE: Agar mobile/closeup video hai, toh CROP NAHI karna. 
            # Kyunki log pehle se hi bade hain frame me. Agar aur crop kiya toh model confuse 
            # hoke bheed (metro crowd) ko fight samajh leta hai.
            # CCTV me log chote hote hain, isliye sirf waha crop box banenge.
            roi_bboxes = get_smart_roi_bboxes(tracks, height, width, is_mobile_closeup) if not is_mobile_closeup else []
            
            best_raw_label = "NORMAL"
            best_raw_conf = 0.0
            best_raw_probs = {l: 0.0 for l in CLASS_LABELS}
            best_roi = roi_bboxes[0] if roi_bboxes else None
            
            def threat_score(l, c):
                # Ye dhyan rakhta hai ki koi 40% confidence wala "FIGHT" crop, 
                # 99% confidence wale "CROWD" full-frame ko galti se hara na de.
                # Agar model >60% sure hai, tabhi usko fight maana jayega.
                base = 0.0
                if l == "FIGHT": base = 3.0 if c > 0.6 else 0.0
                elif l == "RIOT": base = 2.0 if c > 0.6 else 0.0
                elif l == "CROWD": base = 1.0
                return base + c
            
            # FULL-FRAME FALLBACK: Always also classify the full frame (no crop).
            # test.py sends full frames and works perfectly. ROI crops lose scene
            # context on CCTV where people are small. We pick whichever is more threatening.
            full_lbl, full_conf, full_probs = classify_roi(list(frame_buffer), None, videomae_model, image_processor, device)
            if threat_score(full_lbl, full_conf) > threat_score(best_raw_label, best_raw_conf):
                best_raw_label, best_raw_conf, best_raw_probs = full_lbl, full_conf, full_probs
                best_roi = None
            
            for roi in roi_bboxes:
                lbl, conf, probs = classify_roi(list(frame_buffer), roi, videomae_model, image_processor, device)
                if probs is not None and threat_score(lbl, conf) > threat_score(best_raw_label, best_raw_conf):
                    best_raw_label, best_raw_conf, best_raw_probs = lbl, conf, probs
                    best_roi = roi
                    
            raw_label, raw_conf, raw_probs = best_raw_label, best_raw_conf, best_raw_probs
            
            # FLUSH STALE HISTORY: Agar video 2 second se zyada ke liye ruk gayi (koi activity nahi hai),
            # toh purane "CROWD" ya "NORMAL" labels clear kar do. Warna naya frame aane pe model 
            # purani history ki wajah se galat predict karega.
            STALE_HISTORY_SECONDS = 2.0
            if (t - last_classify_t) > STALE_HISTORY_SECONDS:
                voter.clear()
                
            voter.update(raw_label, raw_conf, raw_probs)
            current_label, current_conf, current_probs = voter.get_result(is_mobile=is_mobile_closeup, person_count=person_count)
            current_roi = best_roi
            current_mode = "ACTIVE"
            last_classify_t = t

            mode_str = "MOBILE-BYPASS" if is_mobile_closeup else "GATED"
            print(f"  Frame {frame_num:>6}/{total_frames} | RAN VideoMAE [{mode_str}] | "
                  f"{current_label:>6} ({current_conf:.1%}) | Persons: {person_count} | "
                  f"Susp: {suspicion:.0%} (prox {proximity:.0%} ovl {overlap:.0%} "
                  f"mot {motion:.0%} chs {chaos:.0%} inter {interaction_time:.1f}s)")

            if logger:
                logger.log(frame_num, t, person_count, proximity, overlap, motion, chaos,
                           interaction_time, suspicion, gate_fired, raw_label, raw_conf)
        else:
            # idle: don't touch the model. Let confidence gently decay so an
            # old FIGHT alert doesn't stay pinned forever once things calm down.
            current_conf *= IDLE_DECAY
            if current_conf < 0.15:
                current_label = "NORMAL"
            current_mode = "IDLE"
            current_roi = None

            if logger:
                logger.log(frame_num, t, person_count, proximity, overlap, motion, chaos,
                           interaction_time, suspicion, gate_fired)

        # --- Draw ---
        frame = draw_hud(frame, current_label, current_conf, current_probs,
                          person_count, suspicion, current_mode,
                          frame_num, total_frames, current_roi)
        writer.write(frame)

        if SHOW_LIVE_WINDOW:
            disp = frame
            ds = min(1280 / width, 900 / height, 1.0)
            if ds < 1.0:
                disp = cv2.resize(frame, (int(width * ds), int(height * ds)))
            cv2.imshow("Fight Detection v5 - Fast", disp)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                print("\nStopped by user")
                break

    cap.release()
    writer.release()
    cv2.destroyAllWindows()
    if logger:
        logger.close()
    print(f"\n{'='*60}\n Output saved: {out_path}")
    if LOG_FEATURES:
        print(f" Features logged: {log_path}")
    print("=" * 60)


if __name__ == "__main__":
    video = sys.argv[1] if len(sys.argv) > 1 else VIDEO_SOURCE
    run_pipeline(video)
