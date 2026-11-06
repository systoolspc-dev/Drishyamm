"""Temporal fall classifier (PyTorch).

A compact 1-D CNN (temporal convolutions) over a window of per-frame pose
features. Chosen over an LSTM because it is: faster on GPU for many concurrent
CCTV streams, trivially exportable to ONNX/TensorRT, and just as accurate for
short (~2s) windows. Input:  (batch, WINDOW_SIZE, N_FEATURES).
Output: single logit -> P(fall) after sigmoid.
"""
from __future__ import annotations
import torch
import torch.nn as nn

import config
from src.features.normalize import N_FEATURES


class FallCNN(nn.Module):
    def __init__(self, n_features: int = N_FEATURES, width: int = 64):
        super().__init__()
        # Conv1d expects (batch, channels, time); channels = features.
        self.net = nn.Sequential(
            nn.Conv1d(n_features, width, kernel_size=5, padding=2),
            nn.BatchNorm1d(width),
            nn.ReLU(),
            nn.Conv1d(width, width, kernel_size=5, padding=2),
            nn.BatchNorm1d(width),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(width, width * 2, kernel_size=3, padding=1),
            nn.BatchNorm1d(width * 2),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),   # global pooling over time
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Dropout(0.3),
            nn.Linear(width * 2, 64),
            nn.ReLU(),
            nn.Linear(64, 1),          # single logit
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, time, features) -> (batch, features, time)
        x = x.transpose(1, 2)
        x = self.net(x)
        return self.head(x).squeeze(-1)   # (batch,)


def build_model(n_features: int = N_FEATURES) -> FallCNN:
    return FallCNN(n_features=n_features)
