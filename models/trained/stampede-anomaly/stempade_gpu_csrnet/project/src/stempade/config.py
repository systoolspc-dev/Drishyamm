"""Configuration loading."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "configs" / "default.yaml"


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """Load a YAML config file, defaulting to configs/default.yaml."""
    path = Path(path) if path else DEFAULT_CONFIG
    with open(path, "r") as f:
        return yaml.safe_load(f)
