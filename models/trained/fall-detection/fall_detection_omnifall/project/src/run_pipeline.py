 trained model.

The ONLY manual step is putting the videos on disk (the staged datasets must be
downloaded from their owners; OOPS/of-itw can be auto-fetched with --fetch-oops).
After that, this runs every stage for you and skips whatever isn't present:

    adapters (gmdcsa / videodataset / omnifall)  ->  prepare_dataset  ->  train
                                                 ->  (optional) of-itw eval

Typical use on the GPU PC (you downloaded le2i + mcfd into ONE folder <VID>):

    python -m src.run_pipeline --omnifall-videos <VID> --configs le2i,mcfd

Add your other datasets if they're on this box too (else they're skipped and the
already-prepared data_prepared_combined/windows.npz is reused as a base):

    python -m src.run_pipeline \
        --gmdcsa <GMDCSA root> --videodataset <VideoDataset root> \
        --omnifall-videos <VID> --configs le2i,mcfd,cmdfall \
        --holdout s2 --fetch-oops

Nothing here needs a GPU to be *correct* — it just runs much faster with one.
Use --dry-run to print the exact commands without executing them.
"""
from __future__ import annotations
import argparse
import subprocess
import sys
from pathlib import Path

PY = [sys.executable, "-m"]


def run(cmd: list[str], dry: bool):
    print("\n$ " + " ".join(str(c) for c in cmd), flush=True)
    if dry:
        return 0
    return subprocess.run(cmd, check=True).returncode


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gmdcsa", type=Path, help="GMDCSA24 dataset root (optional)")
    ap.add_argument("--videodataset", type=Path, help="VideoDataset root (optional)")
    ap.add_argument("--omnifall-videos", type=Path,
                    help="folder holding downloaded OmniFall staged videos")
    ap.add_argument("--configs", default="le2i,mcfd",
                    help="OmniFall staged configs to ingest (comma-separated)")
    ap.add_argument("--raw", type=Path, default=Path("data_raw"))
    ap.add_argument("--annotations", type=Path, default=Path("annotations.csv"))
    ap.add_argument("--prepared", type=Path, default=Path("data_prepared_omnifall"))
    ap.add_argument("--model", type=Path, default=Path("models/fall_cnn_omnifall.pt"))
    ap.add_argument("--holdout", default="s2",
                    help="subject/scene to force into validation (e.g. s2)")
    ap.add_argument("--fetch-oops", action="store_true",
                    help="auto-download OOPS (of-itw) and build a held-out wild "
                         "validation set after training")
    ap.add_argument("--skip-train", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # 1) adapters -> shared data_raw/ + annotations.csv (order matters) ----------
    if args.gmdcsa:
        run(PY + ["src.data.gmdcsa24", "--root", args.gmdcsa,
                  "--out", args.raw, "--annotations", args.annotations], args.dry_run)
    if args.videodataset:
        run(PY + ["src.data.videodataset", "--root", args.videodataset,
                  "--out", args.raw, "--annotations", args.annotations], args.dry_run)
    if args.omnifall_videos:
        run(PY + ["src.data.omnifall", "--videos", args.omnifall_videos,
                  "--configs", args.configs,
                  "--out", args.raw, "--annotations", args.annotations], args.dry_run)

    if not (args.gmdcsa or args.videodataset or args.omnifall_videos):
        print("No dataset roots given -> nothing new to ingest. Pass at least one "
              "of --gmdcsa / --videodataset / --omnifall-videos.", file=sys.stderr)
        return 2

    # 2) features -> windows -----------------------------------------------------
    run(PY + ["src.data.prepare_dataset", "--raw", args.raw,
              "--out", args.prepared, "--annotations", args.annotations], args.dry_run)

    # 3) train -------------------------------------------------------------------
    if not args.skip_train:
        train = PY + ["src.model.train", "--data", args.prepared / "windows.npz",
                      "--out", args.model]
        if args.holdout:
            train += ["--holdout", args.holdout]
        run(train, args.dry_run)

    # 4) optional in-the-wild validation on OOPS (of-itw) ------------------------
    if args.fetch_oops:
        if not args.omnifall_videos:
            print("--fetch-oops needs --omnifall-videos (where OOPS extracts to).",
                  file=sys.stderr)
        else:
            run(["omnifall", "prepare-oops"], args.dry_run)
            run(PY + ["src.data.omnifall", "--videos", args.omnifall_videos,
                      "--configs", "of-itw",
                      "--out", "data_raw_itw",
                      "--annotations", "annotations_itw.csv"], args.dry_run)
            run(PY + ["src.data.prepare_dataset", "--raw", "data_raw_itw",
                      "--out", "data_prepared_itw",
                      "--annotations", "annotations_itw.csv"], args.dry_run)
            run(PY + ["src.model.eval_npz", "--data", "data_prepared_itw/windows.npz",
                      "--model", args.model], args.dry_run)

    print("\n✅ pipeline done."
          f"\n   trained model : {args.model}"
          f"\n   windows       : {args.prepared / 'windows.npz'}")
    if not args.fetch_oops:
        print("   tip: add --fetch-oops for an honest in-the-wild (OOPS) validation.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
