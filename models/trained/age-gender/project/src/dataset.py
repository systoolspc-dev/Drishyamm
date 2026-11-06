"""UTKFace dataset loading and augmentation.

UTKFace images are named:  [age]_[gender]_[race]_[datetime].jpg
  age    : integer 0-116
  gender : 0 = male, 1 = female
A handful of files in the wild have malformed names; those are skipped.
"""
from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import Dataset, DataLoader, random_split
from torchvision import transforms

IMG_EXTS = {".jpg", ".jpeg", ".png"}


def _parse_filename(path: Path):
    """Return (age, gender) parsed from a UTKFace filename, or None if malformed."""
    parts = path.name.split("_")
    if len(parts) < 3:
        return None
    try:
        age = int(parts[0])
        gender = int(parts[1])
    except ValueError:
        return None
    if not (0 <= age <= 116) or gender not in (0, 1):
        return None
    return age, gender


def scan_samples(data_dir: Path):
    """Walk the data directory and collect (path, age, gender) tuples."""
    data_dir = Path(data_dir)
    if not data_dir.exists():
        raise FileNotFoundError(
            f"Data directory not found: {data_dir}\n"
            "Download UTKFace and extract the .jpg files there. "
            "See README.md for the link."
        )
    samples, skipped = [], 0
    for p in sorted(data_dir.rglob("*")):
        if p.suffix.lower() not in IMG_EXTS:
            continue
        parsed = _parse_filename(p)
        if parsed is None:
            skipped += 1
            continue
        age, gender = parsed
        samples.append((p, age, gender))
    if not samples:
        raise RuntimeError(f"No valid UTKFace images found in {data_dir}")
    print(f"Found {len(samples)} images ({skipped} skipped as malformed).")
    return samples


def build_transforms(image_size: int, train: bool):
    # ImageNet normalization, since the backbones are pretrained on ImageNet.
    normalize = transforms.Normalize(
        mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
    )
    if train:
        return transforms.Compose([
            transforms.Resize((image_size, image_size)),
            transforms.RandomHorizontalFlip(),
            transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2),
            transforms.RandomRotation(10),
            transforms.ToTensor(),
            normalize,
        ])
    return transforms.Compose([
        transforms.Resize((image_size, image_size)),
        transforms.ToTensor(),
        normalize,
    ])


class UTKFaceDataset(Dataset):
    def __init__(self, samples, image_size: int, max_age: float, train: bool):
        self.samples = samples
        self.max_age = max_age
        self.transform = build_transforms(image_size, train)

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        path, age, gender = self.samples[idx]
        img = Image.open(path).convert("RGB")
        img = self.transform(img)
        # Age is scaled to [0, 1] so the regression target is well-conditioned.
        age_t = torch.tensor(age / self.max_age, dtype=torch.float32)
        gender_t = torch.tensor(gender, dtype=torch.long)
        return img, age_t, gender_t


def make_dataloaders(cfg):
    """Build train/val DataLoaders from the config."""
    samples = scan_samples(cfg.data_dir)

    full = UTKFaceDataset(samples, cfg.image_size, cfg.max_age, train=True)
    n_val = int(len(full) * cfg.val_split)
    n_train = len(full) - n_val
    gen = torch.Generator().manual_seed(cfg.seed)
    train_set, val_set = random_split(full, [n_train, n_val], generator=gen)

    # The validation subset must NOT use train-time augmentation, so give it
    # its own dataset view that shares the same underlying samples.
    val_view = UTKFaceDataset(
        [samples[i] for i in val_set.indices],
        cfg.image_size, cfg.max_age, train=False,
    )
    train_view = UTKFaceDataset(
        [samples[i] for i in train_set.indices],
        cfg.image_size, cfg.max_age, train=True,
    )

    train_loader = DataLoader(
        train_view, batch_size=cfg.batch_size, shuffle=True,
        num_workers=cfg.num_workers, pin_memory=True, drop_last=True,
    )
    val_loader = DataLoader(
        val_view, batch_size=cfg.batch_size, shuffle=False,
        num_workers=cfg.num_workers, pin_memory=True,
    )
    print(f"Train: {len(train_view)} | Val: {len(val_view)}")
    return train_loader, val_loader
