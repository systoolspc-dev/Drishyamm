"""CSRNet crowd density estimation.

CSRNet (Li et al., CVPR 2018): a VGG-16 frontend + dilated-convolution backend that
regresses a per-pixel density map. Integrating the map gives a head count; combined
with a per-camera homography it yields people/m².

torch is imported lazily so the rest of the system (motion, fusion, serving) runs
without a heavy torch install. Density is a Phase-2 GPU component.

Training / fine-tuning on ShanghaiTech is heavy -> run scripts/train_csrnet.py on a
GPU machine, then point `weights` at the resulting checkpoint.
"""
from __future__ import annotations

import numpy as np


def build_csrnet():
    """Construct the CSRNet nn.Module (requires torch + torchvision)."""
    import torch.nn as nn
    from torchvision import models

    class CSRNet(nn.Module):
        def __init__(self, load_vgg: bool = True):
            super().__init__()
            # VGG-16 frontend: first 10 conv layers (up to conv4_3)
            frontend_cfg = [64, 64, "M", 128, 128, "M", 256, 256, 256, "M", 512, 512, 512]
            backend_cfg = [512, 512, 512, 256, 128, 64]
            self.frontend = _make_layers(frontend_cfg, in_channels=3)
            self.backend = _make_layers(backend_cfg, in_channels=512, dilation=2)
            self.output_layer = nn.Conv2d(64, 1, kernel_size=1)
            if load_vgg:
                self._init_frontend_from_vgg()

        def forward(self, x):
            x = self.frontend(x)
            x = self.backend(x)
            x = self.output_layer(x)
            return x

        def _init_frontend_from_vgg(self):
            import torch
            vgg = models.vgg16(weights=models.VGG16_Weights.IMAGENET1K_V1)
            fe = dict(self.frontend.state_dict())
            keys = list(fe.keys())
            vgg_feats = list(vgg.features.state_dict().items())
            for k, (_, v) in zip(keys, vgg_feats):
                if fe[k].shape == v.shape:
                    fe[k] = v
            self.frontend.load_state_dict(fe)

    def _make_layers(cfg, in_channels, dilation=1):
        layers = []
        d = dilation
        for v in cfg:
            if v == "M":
                layers.append(nn.MaxPool2d(2, 2))
            else:
                pad = d
                layers += [
                    nn.Conv2d(in_channels, v, kernel_size=3, padding=pad, dilation=d),
                    nn.ReLU(inplace=True),
                ]
                in_channels = v
        return nn.Sequential(*layers)

    return CSRNet()


class DensityEstimator:
    """Runtime wrapper: load weights, produce density maps and counts."""

    def __init__(self, weights: str | None = None, device: str = "cuda") -> None:
        self.weights = weights
        self.device = device
        self.model = None

    def load(self) -> "DensityEstimator":
        import torch

        self.model = build_csrnet()
        if self.weights:
            state = torch.load(self.weights, map_location="cpu")
            state = state.get("model", state)
            self.model.load_state_dict(state)
        self.model.eval().to(self.device)
        return self

    def _preprocess(self, frame: np.ndarray):
        import torch
        from torchvision import transforms

        rgb = frame[..., ::-1].copy()  # BGR -> RGB
        tf = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406],
                                 std=[0.229, 0.224, 0.225]),
        ])
        return tf(rgb).unsqueeze(0).to(self.device)

    def density_map(self, frame: np.ndarray) -> np.ndarray:
        """Return an (H', W') density map for a BGR frame."""
        import torch

        if self.model is None:
            self.load()
        with torch.no_grad():
            out = self.model(self._preprocess(frame))
        return out.squeeze().cpu().numpy()

    def count(self, frame: np.ndarray) -> float:
        """Estimated head count = sum of the density map."""
        return float(self.density_map(frame).sum())
