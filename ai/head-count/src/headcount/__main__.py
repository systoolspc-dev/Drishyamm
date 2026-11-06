"""Entry point: `python -m headcount` or the `headcount` console script.

    headcount --config config/config.yaml
    HEADCOUNT_API__PORT=9000 headcount
"""

from __future__ import annotations

import argparse
import logging

import uvicorn

from .api import create_app
from .config import load_config


def main() -> None:
    parser = argparse.ArgumentParser(prog="headcount", description="Head-count server")
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
