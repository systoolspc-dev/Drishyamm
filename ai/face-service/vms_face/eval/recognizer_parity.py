"""Parity gate: does `insightface_batched` produce the SAME vectors as `insightface`?

The enrolled Qdrant gallery and every calibrated cosine threshold are only safe
across that switch if the embeddings are identical. This is the check that says
so — run it before enabling the backend anywhere, and again after any change to
alignment, preprocessing or the model pack.

    docker exec drishyam-ai sh -c 'cd /srv/app/face_detection/vms_face && \
      python -m vms_face.eval.recognizer_parity --images data/known_faces --limit 12'

Passes when every face clears --min-cosine (default 0.9999). Anything lower means
the two paths are NOT interchangeable and switching WOULD require a full
re-enrolment — treat a failure as a hard blocker, not a tolerance to widen.

Also reports the throughput difference, which is the reason the backend exists.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
import time

import cv2
import numpy as np


def _iter_images(root: str, limit: int) -> list[str]:
    exts = ("*.jpg", "*.JPG", "*.jpeg", "*.JPEG", "*.png", "*.PNG")
    files: list[str] = []
    for e in exts:
        files.extend(glob.glob(os.path.join(root, "**", e), recursive=True))
    return sorted(files)[:limit]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--images", default="data/known_faces", help="directory of face images")
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--min-cosine", type=float, default=0.9999)
    ap.add_argument("--max-side", type=int, default=2000, help="downscale huge stills first")
    args = ap.parse_args()

    paths = _iter_images(args.images, args.limit)
    if not paths:
        print(f"no images under {args.images!r}", file=sys.stderr)
        return 2

    from vms_face.infra.insightface_runtime import FaceRuntime
    from vms_face.infra.recognizers.batched_arcface import BatchedArcFaceRecognizer

    # Reference path: detection WITH the recognition head, exactly as the
    # default "insightface" backend runs today.
    reference = FaceRuntime(run_recognition=True)
    candidate = BatchedArcFaceRecognizer()

    rows: list[tuple[str, float, float]] = []
    crops_frames: list[tuple[np.ndarray, np.ndarray]] = []

    for p in paths:
        img = cv2.imread(p)
        if img is None:
            continue
        side = max(img.shape[:2])
        if args.max_side and side > args.max_side:
            s = args.max_side / side
            img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)

        obs = reference.detect(img, max_faces=1)
        if not obs:
            continue
        o = obs[0]
        if o.embedding is None or o.landmark_5 is None:
            continue

        got = candidate.embed(img, o.landmark_5)
        if got is None:
            print(f"  {os.path.basename(p)[:38]:40s} FAILED to embed")
            rows.append((p, 0.0, 1.0))
            continue

        ref = np.asarray(o.embedding, dtype=np.float32).ravel()
        ref = ref / max(float(np.linalg.norm(ref)), 1e-12)
        cos = float(ref @ got)
        rows.append((p, cos, float(np.abs(ref - got).max())))
        crops_frames.append((img, o.landmark_5))
        print(f"  {os.path.basename(p)[:38]:40s} cosine={cos:.10f}  max|d|={rows[-1][2]:.2e}")

    if not rows:
        print("no faces detected in any image", file=sys.stderr)
        return 2

    worst = min(r[1] for r in rows)
    print(f"\nfaces compared : {len(rows)}")
    print(f"worst cosine   : {worst:.10f}  (gate >= {args.min_cosine})")

    # Throughput, the reason the backend exists. Compare per-face calls against
    # one batched call over the same crops.
    if len(crops_frames) >= 2:
        aligned = [
            candidate._align(f, k) for f, k in crops_frames  # noqa: SLF001 - eval tool
        ]
        aligned = [a for a in aligned if a is not None]
        n = len(aligned)
        if n >= 2:
            for _ in range(3):
                candidate._arc.get_feat(aligned)  # noqa: SLF001
            t = time.perf_counter()
            for _ in range(20):
                for a in aligned:
                    candidate._arc.get_feat([a])  # noqa: SLF001
            per_face = (time.perf_counter() - t) / 20 * 1000
            t = time.perf_counter()
            for _ in range(20):
                candidate._arc.get_feat(aligned)  # noqa: SLF001
            batched = (time.perf_counter() - t) / 20 * 1000
            print(
                f"per-face x{n:<3d}  : {per_face:7.2f} ms ({per_face / n:.3f} ms/face)  "
                f"<- what 'insightface' runs"
            )
            print(
                f"batched({n:<3d})  : {batched:7.2f} ms ({batched / n:.3f} ms/face)  "
                f"<- {per_face / max(batched, 1e-9):.1f}x"
            )

    if worst < args.min_cosine:
        print(
            "\nFAIL - the two backends do NOT produce interchangeable vectors. "
            "Switching would require re-enrolling the whole gallery.",
            file=sys.stderr,
        )
        return 1
    print("\nPASS - vectors are interchangeable; gallery and thresholds are safe.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
