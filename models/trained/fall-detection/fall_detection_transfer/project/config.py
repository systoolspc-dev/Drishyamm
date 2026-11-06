"""Central configuration. All tunable constants live here so the whole
pipeline stays consistent (data prep, training, and inference must agree).

Target: production CCTV, GPU server, live RTSP, multi-person.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Pose estimation + tracking (YOLO-pose)
# ---------------------------------------------------------------------------
# YOLOv8/v11-pose does person detection + 17 COCO keypoints in one pass and,
# via Ultralytics, ships built-in multi-object tracking (ByteTrack). That
# tracking is what lets us keep each person's keypoint history separate and
# feed it to the fall classifier per-person. Model size vs accuracy:
#   yolov8n-pose (nano)  -> fastest, many streams/GPU
#   yolov8s-pose (small) -> good balance  [default]
#   yolov8m-pose (medium)-> most accurate, fewer streams/GPU
POSE_BACKEND = "yolo"                 # "yolo" (multi-person) | "movenet" (single, edge)
YOLO_POSE_WEIGHTS = "yolov8s-pose.pt" # auto-downloaded by ultralytics on first use
YOLO_TRACKER = "bytetrack.yaml"       # ultralytics built-in tracker config
YOLO_CONF = 0.4                       # person detection confidence
YOLO_DEVICE = 0                       # CUDA device index; "cpu" to force CPU

N_KEYPOINTS = 17

# COCO-17 keypoint indices (order shared by YOLO-pose and MoveNet)
KP = {
    "nose": 0, "left_eye": 1, "right_eye": 2, "left_ear": 3, "right_ear": 4,
    "left_shoulder": 5, "right_shoulder": 6, "left_elbow": 7, "right_elbow": 8,
    "left_wrist": 9, "right_wrist": 10, "left_hip": 11, "right_hip": 12,
    "left_knee": 13, "right_knee": 14, "left_ankle": 15, "right_ankle": 16,
}

EDGES = [
    (0, 1), (0, 2), (1, 3), (2, 4), (0, 5), (0, 6), (5, 7), (7, 9),
    (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12), (11, 13),
    (13, 15), (12, 14), (14, 16),
]

# A keypoint below this confidence is treated as unreliable when computing
# body center/scale and posture.
KP_CONF_THRESHOLD = 0.3

# Trunk angle (degrees from vertical) above which the torso counts as
# horizontal -> a lying/fallen posture. Used both as a feature and by the
# "stayed-down" confirmation check.
HORIZONTAL_TRUNK_ANGLE = 55.0

# ---------------------------------------------------------------------------
# Temporal windowing
# ---------------------------------------------------------------------------
TARGET_FPS = 15          # resample every stream/video to this rate
WINDOW_SIZE = 30         # frames per window  -> 30 / 15fps = 2.0 seconds
WINDOW_STRIDE = 5        # step between training windows (frames)

# ---------------------------------------------------------------------------
# Model / training
# ---------------------------------------------------------------------------
BATCH_SIZE = 64
EPOCHS = 40
LEARNING_RATE = 1e-3
VAL_SPLIT = 0.2
RANDOM_SEED = 42
FALL_CLASSIFIER_PATH = MODELS_DIR / "fall_cnn.pt"

# ---------------------------------------------------------------------------
# Inference post-processing (the false-alarm killers), per tracked person
# ---------------------------------------------------------------------------
FALL_PROB_THRESHOLD = 0.5     # per-window probability to count as "fall-ish"
DEBOUNCE_WINDOWS = 2          # consecutive fall-ish windows before candidate
CONFIRM_SECONDS = 2.0         # must STAY down this long -> real emergency
RECOVER_GRACE_SECONDS = 1.0   # if they get up within this, cancel (false alarm)
