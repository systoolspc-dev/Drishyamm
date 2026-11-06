"""Command-line interface: run | calibrate | eval | serve."""
from __future__ import annotations

import argparse
import sys

from .config import load_config


def _load_optional(baseline_path, homography_path):
    baseline = homography = None
    if baseline_path:
        from .calibration import Baseline
        baseline = Baseline.load(baseline_path)
    if homography_path:
        import json
        import numpy as np
        from .calibration import Homography
        mat = np.array(json.load(open(homography_path)))
        homography = Homography(mat)
    return baseline, homography


def cmd_run(args):
    from .pipeline import StampedePipeline
    from .fusion import RiskLevel

    cfg = load_config(args.config)
    baseline, homography = _load_optional(args.baseline, args.homography)
    pipe = StampedePipeline(cfg, baseline=baseline, homography=homography)

    last_level = RiskLevel.NORMAL
    for st in pipe.run(args.source):
        if st.level != last_level:
            tag = "ALARM" if st.level >= RiskLevel.HIGH else "info"
            print(f"[{tag}] t={st.time_s:6.1f}s  {st.level.name:8s} "
                  f"score={st.score:.2f}  subs={ {k: round(v,2) for k,v in st.sub_scores.items()} }")
            last_level = st.level
    print("done.")


def cmd_calibrate(args):
    from .calibration import estimate_baseline

    cfg = load_config(args.config)
    icfg = cfg.get("ingestion", {})
    bl = estimate_baseline(
        args.source,
        target_fps=icfg.get("target_fps", 15),
        resize=tuple(icfg.get("resize")) if icfg.get("resize") else None,
        max_frames=args.max_frames,
    )
    bl.save(args.out)
    print(f"baseline saved to {args.out} ({bl.n_frames} frames)")
    print("  means:", {k: round(v, 3) for k, v in bl.mean.items()})


def cmd_eval(args):
    from .eval import evaluate_video

    cfg = load_config(args.config)
    baseline, homography = _load_optional(args.baseline, args.homography)
    report = evaluate_video(cfg, args.source, args.labels,
                            baseline=baseline, homography=homography)
    for k, v in report.items():
        print(f"{k:20s}: {v}")


def cmd_serve(args):
    from .serving.app import serve

    serve(config_path=args.config, host=args.host, port=args.port)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="stempade", description="Crowd stampede detection")
    p.add_argument("--config", default=None, help="path to YAML config")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run detection on a video/RTSP source")
    r.add_argument("source", nargs="?", help="video path or rtsp:// url")
    r.add_argument("--baseline"); r.add_argument("--homography")
    r.set_defaults(func=cmd_run)

    c = sub.add_parser("calibrate", help="learn per-camera normal baseline")
    c.add_argument("source", help="clip of NORMAL activity")
    c.add_argument("--out", default="baseline.json")
    c.add_argument("--max-frames", type=int, default=None, dest="max_frames")
    c.set_defaults(func=cmd_calibrate)

    e = sub.add_parser("eval", help="evaluate against frame labels")
    e.add_argument("source"); e.add_argument("labels", help="txt/npy of 0/1 per frame")
    e.add_argument("--baseline"); e.add_argument("--homography")
    e.set_defaults(func=cmd_eval)

    s = sub.add_parser("serve", help="launch RTSP serving API + dashboard")
    s.add_argument("--host", default="0.0.0.0"); s.add_argument("--port", type=int, default=8000)
    s.set_defaults(func=cmd_serve)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
