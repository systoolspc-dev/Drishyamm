"""Central configuration for the age + gender model.

Edit values here, or override most of them from the command line in train.py.
"""
from dataclasses import dataclass, field
from pathlib import Path

# Project root = the folder that contains this src/ directory.
ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    # --- Data ---
    # Point this at the folder containing the UTKFace .jpg files.
    # Filenames look like: 23_1_0_20170116220224657.jpg.chip.jpg
    #   [age]_[gender]_[race]_[datetime].jpg   (gender: 0 = male, 1 = female)
    data_dir: Path = ROOT / "data" / "UTKFace"
    image_size: int = 224              # input resolution fed to the backbone
    val_split: float = 0.15            # fraction of data held out for validation
    max_age: float = 116.0             # used to scale age into [0, 1] for the model

    # --- Model ---
    backbone: str = "efficientnet_b0"  # efficientnet_b0 | resnet50 | mobilenet_v3_large
    pretrained: bool = True            # start from ImageNet weights (transfer learning)
    dropout: float = 0.3

    # --- Training ---
    epochs: int = 30
    batch_size: int = 64
    lr: float = 3e-4
    weight_decay: float = 1e-4
    num_workers: int = 4               # DataLoader workers; raise on a strong PC
    age_loss_weight: float = 1.0       # relative weight of the age head
    gender_loss_weight: float = 1.0    # relative weight of the gender head
    warmup_freeze_epochs: int = 2      # epochs to train only the heads before unfreezing
    seed: int = 42

    # --- Output ---
    ckpt_dir: Path = ROOT / "checkpoints"
    resume: str = ""                   # path to a checkpoint to resume from

    def __post_init__(self):
        self.data_dir = Path(self.data_dir)
        self.ckpt_dir = Path(self.ckpt_dir)
        self.ckpt_dir.mkdir(parents=True, exist_ok=True)
