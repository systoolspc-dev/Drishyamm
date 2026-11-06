"""Live parity check for the edge shape: is a vector from the server's
/edge/embed (via RemoteRecognizer) the same vector a local recognizer makes?

    docker exec drishyam-ai sh -c 'cd /srv/app/face_detection/vms_face && \
      EDGE_SERVER_URL=http://127.0.0.1:8001 python -m vms_face.eval.remote_parity \
        --images data/known_faces --limit 8'

Reports cosine(local, remote) per face for PNG (expect 1.0 to ~7 decimals)
and for JPEG at the configured quality (expect ~0.999+), plus the bytes per
crop each format costs. The gate is the same as recognizer_parity: below
--min-cosine the two are NOT interchangeable.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
import time

import cv2
import numpy as np


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--images", default="data/known_faces")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--min-cosine", type=float, default=0.9999)
    ap.add_argument("--server", default=os.environ.get("EDGE_SERVER_URL", "http://127.0.0.1:8001"))
    ap.add_argument("--token", default=os.environ.get("EDGE_SERVER_TOKEN", ""))
    args = ap.parse_args()

    from vms_face.config import settings
    from vms_face.infra.insightface_runtime import FaceRuntime
    from vms_face.infra.recognizers.batched_arcface import BatchedArcFaceRecognizer
    from vms_face.infra.recognizers.remote import RemoteRecognizer

    files: list[str] = []
    for e in ("*.jpg", "*.JPG", "*.jpeg", "*.png"):
        files.extend(glob.glob(os.path.join(args.images, "**", e), recursive=True))
    files = sorted(files)[: args.limit]
    if not files:
        print("no images", file=sys.stderr)
        return 2

    rt = FaceRuntime(run_recognition=False)
    local = BatchedArcFaceRecognizer()

    results = {"png": [], "jpeg": []}
    bytes_per = {"png": [], "jpeg": []}
    latency = {"png": [], "jpeg": []}
    for fmt in ("png", "jpeg"):
        settings.edge_crop_format = fmt
        remote = RemoteRecognizer(args.server, args.token)
        if remote.name == "remote":
            print(f"FAIL - could not reach {args.server}/edge/info", file=sys.stderr)
            return 1
        for p in files:
            img = cv2.imread(p)
            if img is None:
                continue
            if max(img.shape[:2]) > 2000:
                s = 2000 / max(img.shape[:2])
                img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
            obs = rt.detect(img, max_faces=1)
            if not obs or obs[0].landmark_5 is None:
                continue
            a = local.embed(img, obs[0].landmark_5)
            t0 = time.perf_counter()
            b = remote.embed(img, obs[0].landmark_5)
            latency[fmt].append((time.perf_counter() - t0) * 1000)
            if a is None or b is None:
                print(f"  {os.path.basename(p)[:36]:38s} {fmt:4s} FAILED (local={a is not None}, remote={b is not None})")
                results[fmt].append(0.0)
                continue
            cos = float(a @ b)
            results[fmt].append(cos)
            aligned = remote._align(img, obs[0].landmark_5)  # noqa: SLF001 - eval tool
            payload, _ = remote._encode(aligned)             # noqa: SLF001
            bytes_per[fmt].append(len(payload))
            print(f"  {os.path.basename(p)[:36]:38s} {fmt:4s} cosine={cos:.7f}  {len(payload):6d} B  {latency[fmt][-1]:6.1f} ms")

    print()
    ok = True
    for fmt in ("png", "jpeg"):
        if not results[fmt]:
            continue
        worst = min(results[fmt])
        print(f"{fmt:4s}: faces={len(results[fmt])} worst cosine={worst:.7f} "
              f"mean bytes={int(np.mean(bytes_per[fmt]) if bytes_per[fmt] else 0)} "
              f"mean latency={np.mean(latency[fmt]):.1f} ms")
        if fmt == "png" and worst < args.min_cosine:
            ok = False
    print("\nPASS - PNG remote vectors are interchangeable with local ones." if ok
          else "\nFAIL - remote PNG vectors differ from local; do not mix galleries.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
