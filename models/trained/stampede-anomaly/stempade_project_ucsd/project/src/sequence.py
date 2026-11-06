"""Sequence windowing and the Keras data generator.

Windows are 16 frames with 12 frames of overlap (stride 4), per pipeline.md
Sec. 6.  Frames are read from per-clip memmaps rather than materialised, so the
4x redundancy the overlap implies costs no memory.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from tensorflow.keras.utils import Sequence, to_categorical

from config import CACHE, NUM_CLASSES, SEQ_LEN, SEQ_STRIDE, WINDOW_LABEL


@dataclass
class ClipCache:
    """Handles onto one preprocessed clip on disk."""
    name: str
    flow: np.memmap      # (N, 224, 224, 2) float16, already normalised to [-1,1]
    bits: np.ndarray     # (N, 32) float32
    labels: np.ndarray   # (N,) int8

    @property
    def n_frames(self) -> int:
        return len(self.labels)


def load_clip(name: str, cache_dir: Path = CACHE) -> ClipCache:
    d = cache_dir / name
    meta = json.loads((d / "meta.json").read_text())
    flow = np.memmap(
        d / "flow.f16", dtype=np.float16, mode="r",
        shape=tuple(meta["flow_shape"]),
    )
    return ClipCache(
        name=name,
        flow=flow,
        bits=np.load(d / "bits.npy"),
        labels=np.load(d / "labels.npy"),
    )


def list_cached_clips(cache_dir: Path = CACHE) -> list[str]:
    return sorted(p.name for p in cache_dir.iterdir() if (p / "meta.json").exists())


def window_starts(n_frames: int, seq_len: int = SEQ_LEN, stride: int = SEQ_STRIDE) -> np.ndarray:
    if n_frames < seq_len:
        return np.empty(0, dtype=np.int64)
    return np.arange(0, n_frames - seq_len + 1, stride, dtype=np.int64)


def window_label(labels: np.ndarray, start: int, seq_len: int = SEQ_LEN,
                 mode: str = WINDOW_LABEL) -> int:
    """Collapse a window's per-frame labels into one class.

    See config.WINDOW_LABEL for the trade-off between "max" (safety-correct,
    skews the balance upward) and "mode" (balance-preserving, can average away
    an onset).
    """
    seg = labels[start:start + seq_len]
    if mode == "mode":
        return int(np.bincount(seg.astype(np.int64), minlength=NUM_CLASSES).argmax())
    return int(seg.max())


def build_index(clip_names: list[str], cache_dir: Path = CACHE) -> list[tuple[str, int, int]]:
    """(clip_name, start_frame, label) for every window in the given clips."""
    index = []
    for name in clip_names:
        clip = load_clip(name, cache_dir)
        for s in window_starts(clip.n_frames):
            index.append((name, int(s), window_label(clip.labels, int(s))))
    return index


class SequenceGenerator(Sequence):
    """Batches of (flow, scalars) -> one-hot risk class."""

    def __init__(
        self,
        index: list[tuple[str, int, int]],
        batch_size: int,
        cache_dir: Path = CACHE,
        shuffle: bool = True,
        use_scalars: bool = True,
        seed: int = 0,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.index = list(index)
        self.batch_size = batch_size
        self.shuffle = shuffle
        self.use_scalars = use_scalars
        self.rng = np.random.default_rng(seed)
        self._clips: dict[str, ClipCache] = {}
        self._cache_dir = cache_dir
        self.on_epoch_end()

    def _clip(self, name: str) -> ClipCache:
        if name not in self._clips:
            self._clips[name] = load_clip(name, self._cache_dir)
        return self._clips[name]

    def __len__(self) -> int:
        return int(np.ceil(len(self.index) / self.batch_size))

    def __getitem__(self, i: int):
        rows = self.index[i * self.batch_size:(i + 1) * self.batch_size]
        flow = np.empty((len(rows), SEQ_LEN, *self._clip(rows[0][0]).flow.shape[1:]), np.float32)
        bits = np.empty((len(rows), SEQ_LEN, 32), np.float32)
        y = np.empty(len(rows), np.int64)

        for j, (name, start, label) in enumerate(rows):
            c = self._clip(name)
            flow[j] = np.asarray(c.flow[start:start + SEQ_LEN], dtype=np.float32)
            bits[j] = c.bits[start:start + SEQ_LEN]
            y[j] = label

        y1h = to_categorical(y, num_classes=NUM_CLASSES)
        if self.use_scalars:
            return {"flow": flow, "scalars": bits}, y1h
        return {"flow": flow}, y1h

    def on_epoch_end(self) -> None:
        if self.shuffle:
            self.rng.shuffle(self.index)

    @property
    def labels(self) -> np.ndarray:
        return np.array([lbl for _, _, lbl in self.index], dtype=np.int64)


def clip_stratum(name: str, cache_dir: Path = CACHE) -> str:
    """The group a clip is balanced within when splitting.

    "<subset>/<split>/<dominant class>".  The dominant class matters because
    crowd density is close to constant inside a single 120-200 frame UCSD clip
    -- measured, whole Train clips come out 100% `dense` or 94% `normal` -- so
    which clips land in validation, not how many, decides whether validation
    covers all four classes at all.  Since early stopping monitors validation
    accuracy, a validation set missing a class silently changes what is being
    optimised.

    Falls back to the cache name if the clip predates this metadata, which
    leaves such a clip in its own stratum rather than mis-grouping it.
    """
    meta_path = cache_dir / name / "meta.json"
    if not meta_path.exists():
        return name
    meta = json.loads(meta_path.read_text())
    counts = meta.get("class_counts")
    dominant = int(np.argmax(counts)) if counts else -1
    return f"{meta.get('subset', '?')}/{meta.get('split', '?')}/{dominant}"


def split_by_clip(
    clip_names: list[str], val_fraction: float, seed: int = 0,
    cache_dir: Path = CACHE,
) -> tuple[list[str], list[str]]:
    """Hold out whole clips for validation, stratified by subset and split.

    [gap] The paper never states its split policy, and its validation set of 260
    sequences is not class-balanced despite a balanced frame set.  Splitting by
    clip is the only safe option here: consecutive windows share 12 of their 16
    frames, so a random window split puts near-duplicate sequences on both sides
    and inflates validation accuracy.

    Stratifying matters on UCSD specifically.  Only the Test clips carry
    anomalies, so they are the only source of the `risky` class; an unstratified
    draw of 20 clips from 98 can easily land a validation set with almost no
    risky windows, or one made entirely of Ped2.  Each subset/split group is
    therefore sampled at `val_fraction` independently.
    """
    rng = np.random.default_rng(seed)
    groups: dict[str, list[str]] = {}
    for name in sorted(clip_names):
        groups.setdefault(clip_stratum(name, cache_dir), []).append(name)

    train, val = [], []
    for _, names in sorted(groups.items()):
        names = list(names)
        rng.shuffle(names)
        n_val = max(1, int(round(len(names) * val_fraction))) if len(names) > 1 else 0
        val.extend(names[:n_val])
        train.extend(names[n_val:])
    return sorted(train), sorted(val)
