"""Loaders for the UCSD Anomaly Detection Dataset — this project's only source.

UCSD ships two pedestrian subsets, each a fixed camera on one walkway:

    UCSDped1   34 Train + 36 Test clips, 200 frames each, 238 x 158
    UCSDped2   16 Train + 12 Test clips, 120-180 frames,   360 x 240

Train clips contain only normal frames (UCSD README).  Test clips carry a
frame-level anomaly annotation in ``Test/<subset>.m``.  Ten Ped1 and twelve
Ped2 clips additionally ship pixel masks in ``Test<n>_gt/``; those are not used
here, since the pipeline classifies whole frames.

See src/ucsd_labels.py for how the binary annotation becomes four classes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from config import UCSD_ROOT, UCSD_SPLITS, UCSD_SUBSETS


@dataclass
class UcsdClip:
    name: str                  # e.g. "UCSDped1/Test001"
    subset: str                # "UCSDped1" | "UCSDped2"
    split: str                 # "Train" | "Test"
    frame_paths: list[Path]
    abnormal: np.ndarray       # (N,) bool, frame-level ground truth

    @property
    def cache_name(self) -> str:
        """Flat name for this clip's cache directory."""
        return "ucsd__" + self.name.replace("/", "_")


def _parse_gt_m(m_path: Path) -> list[np.ndarray]:
    """Parse `TestVideoFile{end+1}.gt_frame = [60:152];` lines into index arrays.

    Handles the multi-range form `[5:90, 140:200]`.  Indices in the file are
    1-based; they are converted to 0-based here.
    """
    out: list[np.ndarray] = []
    text = m_path.read_text(errors="ignore")
    for line in text.splitlines():
        m = re.search(r"gt_frame\s*=\s*\[([^\]]*)\]", line)
        if not m:
            continue
        idx: list[int] = []
        for part in m.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            if ":" in part:
                a, b = part.split(":")
                idx.extend(range(int(a) - 1, int(b)))
            else:
                idx.append(int(part) - 1)
        out.append(np.asarray(sorted(set(idx)), dtype=np.int64))
    return out


def load_ucsd_test(subset: str = "UCSDped1") -> list[UcsdClip]:
    """Test clips of one subset, with frame-level abnormality labels."""
    test_dir = UCSD_ROOT / subset / "Test"
    gt_ranges = _parse_gt_m(test_dir / f"{subset}.m")

    clip_dirs = sorted(
        d for d in test_dir.iterdir()
        if d.is_dir() and re.fullmatch(r"Test\d+", d.name)
    )
    if len(gt_ranges) != len(clip_dirs):
        raise ValueError(
            f"{subset}: {len(gt_ranges)} gt entries but {len(clip_dirs)} test clips"
        )

    clips = []
    for d, idx in zip(clip_dirs, gt_ranges):
        frames = sorted(d.glob("*.tif"))
        flags = np.zeros(len(frames), dtype=bool)
        flags[idx[idx < len(frames)]] = True
        clips.append(UcsdClip(f"{subset}/{d.name}", subset, "Test", frames, flags))
    return clips


def load_ucsd_train(subset: str = "UCSDped1") -> list[UcsdClip]:
    """Training clips, which the UCSD README states contain only normal frames."""
    train_dir = UCSD_ROOT / subset / "Train"
    clips = []
    for d in sorted(
        x for x in train_dir.iterdir()
        if x.is_dir() and re.fullmatch(r"Train\d+", x.name)
    ):
        frames = sorted(d.glob("*.tif"))
        clips.append(
            UcsdClip(f"{subset}/{d.name}", subset, "Train", frames,
                     np.zeros(len(frames), dtype=bool))
        )
    return clips


def load_ucsd(
    subsets=UCSD_SUBSETS, splits=UCSD_SPLITS
) -> list[UcsdClip]:
    """Every requested clip across every requested subset, in a stable order."""
    loaders = {"Train": load_ucsd_train, "Test": load_ucsd_test}
    clips: list[UcsdClip] = []
    for subset in subsets:
        for split in splits:
            if split not in loaders:
                raise ValueError(f"unknown UCSD split {split!r}")
            clips.extend(loaders[split](subset))
    return clips


def read_tif_bgr(path: Path) -> np.ndarray:
    """Read a UCSD .tif frame as 3-channel BGR uint8.

    UCSD frames are grayscale; they are widened to three channels because the
    paper's flow stage (Sec. 4.2) runs Farneback per colour channel and averages.
    On a grayscale source the three channels are identical, so the average
    reduces to single-channel flow — the multi-channel path is preserved rather
    than special-cased so the code stays faithful to the spec.
    """
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise IOError(f"could not read {path}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.dtype != np.uint8:
        img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    return img
