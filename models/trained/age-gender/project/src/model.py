"""Multi-task model: one shared CNN backbone, two heads (age + gender)."""
import torch
import torch.nn as nn
from torchvision import models


def _build_backbone(name: str, pretrained: bool):
    """Return (backbone_without_classifier, feature_dim)."""
    weights_arg = "DEFAULT" if pretrained else None

    if name == "efficientnet_b0":
        net = models.efficientnet_b0(weights=weights_arg)
        feat_dim = net.classifier[1].in_features
        net.classifier = nn.Identity()
    elif name == "resnet50":
        net = models.resnet50(weights=weights_arg)
        feat_dim = net.fc.in_features
        net.fc = nn.Identity()
    elif name == "mobilenet_v3_large":
        net = models.mobilenet_v3_large(weights=weights_arg)
        feat_dim = net.classifier[0].in_features
        net.classifier = nn.Identity()
    else:
        raise ValueError(f"Unknown backbone: {name}")
    return net, feat_dim


class AgeGenderModel(nn.Module):
    def __init__(self, backbone="efficientnet_b0", pretrained=True, dropout=0.3):
        super().__init__()
        self.backbone, feat_dim = _build_backbone(backbone, pretrained)

        self.age_head = nn.Sequential(
            nn.Dropout(dropout),
            nn.Linear(feat_dim, 128),
            nn.ReLU(inplace=True),
            nn.Linear(128, 1),
            nn.Sigmoid(),          # output in [0, 1]; multipkely by max_age to get years
        )
        self.gender_head = nn.Sequential(
            nn.Dropout(dropout),
            nn.Linear(feat_dim, 128),
            nn.ReLU(inplace=True),
            nn.Linear(128, 2),     # logits for [male, female]
        )

    def forward(self, x):
        feats = self.backbone(x)
        age = self.age_head(feats).squeeze(1)   # (B,)  in [0, 1]
        gender = self.gender_head(feats)         # (B, 2) logits
        return age, gender

    def set_backbone_trainable(self, trainable: bool):
        for p in self.backbone.parameters():
            p.requires_grad = trainable
