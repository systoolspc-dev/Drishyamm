#!/usr/bin/env python
"""Train / fine-tune CSRNet density estimation on ShanghaiTech.

    >>> HEAVY GPU TRAINING — run this on the machine with the GPU. <<<

Expected data layout (ShanghaiTech):
    data/shanghaitech/part_A/train_data/{images,ground-truth}/
    data/shanghaitech/part_A/test_data/{images,ground-truth}/

Ground-truth .mat files hold head points; we build Gaussian density maps on the fly.

Usage:
    python scripts/train_csrnet.py --data data/shanghaitech/part_A --epochs 100 \
        --out weights/csrnet_shanghaitech.pth
"""
from __future__ import annotations

import argparse
import glob
import os

import numpy as np


def gaussian_density_map(shape, points, sigma=15):
    """Build a density map by placing a Gaussian at each head point."""
    from scipy.ndimage import gaussian_filter

    dm = np.zeros(shape, dtype=np.float32)
    h, w = shape
    for x, y in points:
        xi, yi = min(int(x), w - 1), min(int(y), h - 1)
        dm[yi, xi] = 1.0
    return gaussian_filter(dm, sigma=sigma)


def load_points(mat_path):
    from scipy.io import loadmat

    m = loadmat(mat_path)
    return m["image_info"][0, 0][0, 0][0]  # ShanghaiTech format


class ShanghaiTech:
    def __init__(self, root, train=True):
        import torch  # noqa: F401
        split = "train_data" if train else "test_data"
        self.img_paths = sorted(glob.glob(os.path.join(root, split, "images", "*.jpg")))
        self.root, self.split = root, split

    def __len__(self):
        return len(self.img_paths)

    def __getitem__(self, i):
        import cv2
        from torchvision import transforms

        img_path = self.img_paths[i]
        gt_path = img_path.replace("images", "ground-truth").replace(
            "IMG_", "GT_IMG_").replace(".jpg", ".mat")
        img = cv2.cvtColor(cv2.imread(img_path), cv2.COLOR_BGR2RGB)
        pts = load_points(gt_path)
        dm = gaussian_density_map(img.shape[:2], pts)
        # density map is downsampled x8 by CSRNet -> match target
        dm8 = cv2.resize(dm, (dm.shape[1] // 8, dm.shape[0] // 8)) * 64
        tf = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        import torch
        return tf(img), torch.from_numpy(dm8).unsqueeze(0)


def main():
    import torch
    from torch.utils.data import DataLoader
    from stempade.density import build_csrnet

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--lr", type=float, default=1e-6)
    ap.add_argument("--out", default="weights/csrnet_shanghaitech.pth")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        print("WARNING: no GPU detected — CSRNet training on CPU is impractically slow.")

    model = build_csrnet().to(device)
    train = DataLoader(ShanghaiTech(args.data, train=True), batch_size=1, shuffle=True)
    opt = torch.optim.SGD(model.parameters(), lr=args.lr, momentum=0.95, weight_decay=5e-4)
    loss_fn = torch.nn.MSELoss(reduction="sum")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    best = float("inf")
    for epoch in range(args.epochs):
        model.train()
        running = 0.0
        for img, target in train:
            img, target = img.to(device), target.to(device)
            opt.zero_grad()
            out = model(img)
            loss = loss_fn(out, target)
            loss.backward()
            opt.step()
            running += loss.item()
        mae = running / len(train)
        print(f"epoch {epoch:3d}  loss/img {mae:.2f}")
        if mae < best:
            best = mae
            torch.save({"model": model.state_dict()}, args.out)
            print(f"  saved {args.out}")


if __name__ == "__main__":
    main()
