"""Stage 3: turn raw videos into labeled temporal windows for training.

Runs the pose backend on every (resampled) frame, extracts camera-invariant
features, builds sliding windows, labels them, and saves one compressed .npz.

Usage:
    python -m src.data.prepare_dataset --raw data_raw --out data_prepared \
        [--annotations annotations.csv]

Windows are tagged with their source video so training can split by video
(no frame leakage between train and val).
"""
from __future__ import annotations
import argparse
import csv
import re
from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm

import config
from src.data.datasets import VIDEO_EXTS
from src.features.normalize import extract_features, N_FEATURES
from src.features.windows import make_windows
from src.pose.factory import get_pose_estimator


def _group_of(name: str) -> str:
    """Group key for train/val splitting. For subject-prefixed names like
    's2_05.mp4' (GMDCSA) or 'v10_L3_ACT2_F_1.mp4' (VideoDataset) the group is the
    subject ('s2' / 'v10') so whole people are held out; else the filename."""
    m = re.match(r"^([a-zA-Z]+\d+)_", name)
    return m.group(1) if m else name


def _largest(poses):
    """Pick the most prominent person in a frame (largest bbox area)."""
    if not poses:
        return None
    def area(p):
        x1, y1, x2, y2 = p.bbox
        return max(x2 - x1, 0) * max(y2 - y1, 0)
    return max(poses, key=area)


def _load_annotations(path: Path | None):
    """video filename -> list of (start_sec, end_sec) fall intervals.

    A video may appear on MULTIPLE rows (OmniFall clips can contain several
    falls); each row is one interval. Single-interval datasets (GMDCSA,
    VideoDataset) simply yield 1-element lists, so this stays backward
    compatible with the older one-row-per-video CSVs."""
    ann: dict[str, list] = {}
    if path and path.exists():
        with open(path) as f:
            for row in csv.DictReader(f):
                ann.setdefault(row["video"].strip(), []).append(
                    (float(row["fall_start_sec"]), float(row["fall_end_sec"]))
                )
    return ann


def _frame_features(video: Path, estimator):
    """Return (feat_seq (T,F), src_fps). Resampled to config.TARGET_FPS."""
    cap = cv2.VideoCapture(str(video))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or config.TARGET_FPS
    estimator.reset()
    feats = []
    last = np.zeros(N_FEATURES, dtype=np.float32)
    kept = 0
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # resample native fps -> TARGET_FPS
        if int(idx * config.TARGET_FPS / src_fps) < kept:
            idx += 1
            continue
        person = _largest(estimator.track(frame))
        last = extract_features(person.keypoints) if person else last
        feats.append(last.copy())
        kept += 1
        idx += 1
    cap.release()
    return np.asarray(feats, dtype=np.float32), src_fps


def _labels_for(video: Path, n_frames: int, is_fall: bool, ann: dict):
    labels = np.zeros(n_frames, dtype=np.float32)
    if not is_fall:
        return labels
    intervals = ann.get(video.name)
    if intervals:
        for start, end in intervals:
            s = int(start * config.TARGET_FPS)
            # include a couple seconds after the fall (the person is on the floor)
            e = int((end + config.CONFIRM_SECONDS) * config.TARGET_FPS)
            labels[max(s, 0) : min(e, n_frames)] = 1.0
    else:
        print(f"  ! no annotation for fall clip {video.name}: labeling whole clip")
        labels[:] = 1.0
    return labels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=Path("data_raw"))
    ap.add_argument("--out", type=Path, default=Path("data_prepared"))
    ap.add_argument("--annotations", type=Path, default=Path("annotations.csv"))
    ap.add_argument("--backend", default=config.POSE_BACKEND)
    args = ap.parse_args()

    ann = _load_annotations(args.annotations)
    estimator = get_pose_estimator(args.backend)

    X, y, groups = [], [], []
    for label_dir, is_fall in [("fall", True), ("adl", False)]:
        d = args.raw / label_dir
        if not d.exists():
            print(f"missing {d}, skipping")
            continue
        videos = [p for p in sorted(d.iterdir()) if p.suffix.lower() in VIDEO_EXTS]
        for v in tqdm(videos, desc=label_dir):
            feats, _ = _frame_features(v, estimator)
            if len(feats) < config.WINDOW_SIZE:
                print(f"  skip {v.name}: too short ({len(feats)} frames)")
                continue
            frame_labels = _labels_for(v, len(feats), is_fall, ann)
            w, wl = make_windows(feats, frame_labels)
            X.append(w)
            y.append(wl)
            groups.extend([_group_of(v.name)] * len(w))

    if not X:
        raise SystemExit("No windows produced. Check data_raw/ layout.")

    X = np.concatenate(X).astype(np.float32)
    y = np.concatenate(y).astype(np.float32)
    groups = np.array(groups)
    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / "windows.npz"
    np.savez_compressed(out, X=X, y=y, groups=groups)
    print(
        f"\nSaved {out}: X={X.shape} y={y.shape} "
        f"(falls={int(y.sum())}, normal={int((y==0).sum())})"
    )


if __name__ == "__main__":
    main()
