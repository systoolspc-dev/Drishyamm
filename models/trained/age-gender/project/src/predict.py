"""Run a trained model on one or more images.

Usage:
    python src/predict.py --ckpt checkpoints/best.pt --image path/to/face.jpg
    python src/predict.py --ckpt checkpoints/best.pt --image img1.jpg img2.jpg

For best results, feed a tightly-cropped face (UTKFace images are face crops).
"""
import argparse
from pathlib import Path

import torch
from PIL import Image

from dataset import build_transforms
from model import AgeGenderModel

GENDERS = {0: "male", 1: "female"}


def pick_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


@torch.no_grad()
def predict(model, transform, device, max_age, image_path):
    img = Image.open(image_path).convert("RGB")
    x = transform(img).unsqueeze(0).to(device)
    age_pred, gender_logits = model(x)
    age_years = age_pred.item() * max_age
    probs = torch.softmax(gender_logits, dim=1)[0]
    gender_idx = int(probs.argmax().item())
    return age_years, GENDERS[gender_idx], probs[gender_idx].item()


def main():
    p = argparse.ArgumentParser(description="Predict age + gender from a face image")
    p.add_argument("--ckpt", required=True, help="path to a .pt checkpoint")
    p.add_argument("--image", required=True, nargs="+", help="one or more image paths")
    args = p.parse_args()

    device = pick_device()
    ckpt = torch.load(args.ckpt, map_location=device)
    saved = ckpt.get("config", {})
    backbone = saved.get("backbone", "efficientnet_b0")
    max_age = saved.get("max_age", 116.0)
    image_size = saved.get("image_size", 224)

    model = AgeGenderModel(backbone, pretrained=False).to(device)
    model.load_state_dict(ckpt["model"])
    model.eval()
    transform = build_transforms(image_size, train=False)

    print(f"Loaded {backbone} from {args.ckpt} on {device}\n")
    for img_path in args.image:
        if not Path(img_path).exists():
            print(f"  {img_path}: NOT FOUND")
            continue
        age, gender, conf = predict(model, transform, device, max_age, img_path)
        print(f"  {img_path}")
        print(f"    age    ~ {age:.0f} years")
        print(f"    gender = {gender} ({conf*100:.0f}% confidence)\n")


if __name__ == "__main__":
    main()
