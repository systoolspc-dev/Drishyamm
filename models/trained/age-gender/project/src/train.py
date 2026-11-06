"""Train the multi-task age + gender model.

Usage (on the training PC, with the venv activated):
    python src/train.py --data-dir data/UTKFace --epochs 30 --batch-size 64

Run `python src/train.py --help` to see every overridable option.
"""
import argparse
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from tqdm import tqdm

from config import Config
from dataset import make_dataloaders
from model import AgeGenderModel


def pick_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def set_seed(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def parse_args(cfg: Config):
    p = argparse.ArgumentParser(description="Train age + gender model")
    p.add_argument("--data-dir", default=str(cfg.data_dir))
    p.add_argument("--backbone", default=cfg.backbone,
                   choices=["efficientnet_b0", "resnet50", "mobilenet_v3_large"])
    p.add_argument("--epochs", type=int, default=cfg.epochs)
    p.add_argument("--batch-size", type=int, default=cfg.batch_size)
    p.add_argument("--lr", type=float, default=cfg.lr)
    p.add_argument("--num-workers", type=int, default=cfg.num_workers)
    p.add_argument("--age-weight", type=float, default=cfg.age_loss_weight)
    p.add_argument("--gender-weight", type=float, default=cfg.gender_loss_weight)
    p.add_argument("--resume", default=cfg.resume)
    args = p.parse_args()

    cfg.data_dir = Path(args.data_dir)
    cfg.backbone = args.backbone
    cfg.epochs = args.epochs
    cfg.batch_size = args.batch_size
    cfg.lr = args.lr
    cfg.num_workers = args.num_workers
    cfg.age_loss_weight = args.age_weight
    cfg.gender_loss_weight = args.gender_weight
    cfg.resume = args.resume
    return cfg


def run_epoch(model, loader, cfg, device, l1, ce, optimizer=None, scaler=None):
    """One pass over `loader`. Train if optimizer is given, else evaluate."""
    train = optimizer is not None
    model.train(train)

    totals = {"loss": 0.0, "age_mae_years": 0.0, "gender_correct": 0, "n": 0}
    use_amp = scaler is not None and device.type == "cuda"

    for imgs, age_t, gender_t in tqdm(loader, leave=False,
                                      desc="train" if train else "val"):
        imgs = imgs.to(device, non_blocking=True)
        age_t = age_t.to(device, non_blocking=True)
        gender_t = gender_t.to(device, non_blocking=True)

        with torch.set_grad_enabled(train):
            with torch.autocast(device_type="cuda", enabled=use_amp):
                age_pred, gender_logits = model(imgs)
                loss_age = l1(age_pred, age_t)
                loss_gender = ce(gender_logits, gender_t)
                loss = (cfg.age_loss_weight * loss_age
                        + cfg.gender_loss_weight * loss_gender)

            if train:
                optimizer.zero_grad(set_to_none=True)
                if use_amp:
                    scaler.scale(loss).backward()
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    loss.backward()
                    optimizer.step()

        bs = imgs.size(0)
        totals["loss"] += loss.item() * bs
        # Convert scaled age error back to years for an interpretable metric.
        totals["age_mae_years"] += (
            (age_pred - age_t).abs().mean().item() * cfg.max_age * bs
        )
        totals["gender_correct"] += (gender_logits.argmax(1) == gender_t).sum().item()
        totals["n"] += bs

    n = totals["n"]
    return {
        "loss": totals["loss"] / n,
        "age_mae": totals["age_mae_years"] / n,
        "gender_acc": totals["gender_correct"] / n,
    }


def main():
    cfg = parse_args(Config())
    set_seed(cfg.seed)
    device = pick_device()
    print(f"Device: {device} | Backbone: {cfg.backbone}")

    train_loader, val_loader = make_dataloaders(cfg)

    model = AgeGenderModel(cfg.backbone, cfg.pretrained, cfg.dropout).to(device)
    l1 = nn.L1Loss()
    ce = nn.CrossEntropyLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.lr,
                                  weight_decay=cfg.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=cfg.epochs)
    scaler = torch.cuda.amp.GradScaler(enabled=device.type == "cuda")

    start_epoch, best_val = 0, float("inf")
    if cfg.resume and Path(cfg.resume).exists():
        ckpt = torch.load(cfg.resume, map_location=device)
        model.load_state_dict(ckpt["model"])
        optimizer.load_state_dict(ckpt["optimizer"])
        start_epoch = ckpt["epoch"] + 1
        best_val = ckpt.get("best_val", best_val)
        print(f"Resumed from {cfg.resume} at epoch {start_epoch}")

    # Freeze the backbone for the first few epochs so the randomly-initialized
    # heads can settle without wrecking the pretrained features.
    model.set_backbone_trainable(False)
    frozen = True

    for epoch in range(start_epoch, cfg.epochs):
        if frozen and epoch >= cfg.warmup_freeze_epochs:
            model.set_backbone_trainable(True)
            frozen = False
            print("Unfroze backbone for full fine-tuning.")

        t0 = time.time()
        tr = run_epoch(model, train_loader, cfg, device, l1, ce, optimizer, scaler)
        va = run_epoch(model, val_loader, cfg, device, l1, ce)
        scheduler.step()

        print(
            f"Epoch {epoch+1:02d}/{cfg.epochs} "
            f"({time.time()-t0:.0f}s) | "
            f"train loss {tr['loss']:.4f} | "
            f"val loss {va['loss']:.4f} | "
            f"val age MAE {va['age_mae']:.2f}yr | "
            f"val gender acc {va['gender_acc']*100:.1f}%"
        )

        # Save the latest, plus the best by validation loss.
        ckpt = {
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "epoch": epoch,
            "best_val": best_val,
            "config": {"backbone": cfg.backbone, "max_age": cfg.max_age,
                       "image_size": cfg.image_size},
        }
        torch.save(ckpt, cfg.ckpt_dir / "last.pt")
        if va["loss"] < best_val:
            best_val = va["loss"]
            ckpt["best_val"] = best_val
            torch.save(ckpt, cfg.ckpt_dir / "best.pt")
            print(f"  ✓ new best (val loss {best_val:.4f}) -> checkpoints/best.pt")

    print("Done. Best val loss:", round(best_val, 4))


if __name__ == "__main__":
    main()
