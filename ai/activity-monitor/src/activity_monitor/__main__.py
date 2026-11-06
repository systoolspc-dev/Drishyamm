"""Entry point: `python -m activity_monitor` or the `activity-monitor` console script.

    activity-monitor --config config/config.yaml
    MONITOR_API__PORT=9000 activity-monitor
"""

from __future__ import annotations

import argparse
import logging

import uvicorn

from .api import create_app
from .config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(prog="activity-monitor",
                                     description="Activity-monitor server")
    parser.add_argument("--config", default="config/config.yaml", help="path to YAML config")
    args = parser.parse_args()

    config = load_config(args.config)
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    app = create_app(config)
    uvicorn.run(app, host=config.api.host, port=config.api.port,
                log_level=config.log_level.lower())


if __name__ == "__main__":
    main()
