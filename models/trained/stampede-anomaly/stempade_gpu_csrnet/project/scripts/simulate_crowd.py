#!/usr/bin/env python
"""Synthetic crowd generator (social-force model) — labeled normal->panic clips.

Real stampede footage is scarce, so this produces controlled crush/escape scenarios
with ground-truth per-frame labels. Agents move by Helbing's social-force model in a
room with a single exit; at the panic onset their desired speed spikes and they rush
the exit, producing convergence + high kinetic energy (the signals the detector keys
on). CPU-only.

Usage:
    python scripts/simulate_crowd.py --n 150 --seconds 30 --panic-at 15 \
        --out data/samples/sim --seed 0
Writes <out>.mp4 (or .avi) and <out>.labels.txt (0/1 per frame).
"""
from __future__ import annotations

import argparse

import cv2
import numpy as np

W, H = 640, 480
EXIT = np.array([W - 5.0, H / 2.0])       # exit on the right wall
EXIT_HALF = 60.0                           # half-height of the doorway gap


def simulate(n, seconds, fps, panic_at, seed):
    rng = np.random.default_rng(seed)
    pos = rng.uniform([40, 60], [W * 0.6, H - 60], size=(n, 2))
    vel = np.zeros((n, 2))
    v0_normal, v0_panic = 1.2, 4.5         # desired speed (px/frame)
    tau = 0.5                               # relaxation time
    frames, labels = [], []
    n_frames = int(seconds * fps)

    for t in range(n_frames):
        panic = t >= panic_at * fps
        v0 = v0_panic if panic else v0_normal

        # desired direction: toward the exit (panic) or mild milling (normal)
        to_exit = EXIT - pos
        dist = np.linalg.norm(to_exit, axis=1, keepdims=True) + 1e-6
        desired = (to_exit / dist) * v0
        if not panic:
            desired += rng.normal(0, 0.4, size=(n, 2))  # wandering

        # pairwise repulsion (social force), vectorized
        diff = pos[:, None, :] - pos[None, :, :]
        d = np.linalg.norm(diff, axis=2) + 1e-6
        np.fill_diagonal(d, 1e6)
        strength = np.where(panic, 22.0, 9.0)
        rep = (diff / d[..., None]) * np.exp((10.0 - d) / 4.0)[..., None]
        rep = rep.sum(axis=1) * strength

        # wall repulsion (top/bottom/left; right is the exit wall)
        wall = np.zeros_like(pos)
        wall[:, 1] += np.exp((5 - pos[:, 1]) / 3) * 20
        wall[:, 1] -= np.exp((pos[:, 1] - (H - 5)) / 3) * 20
        wall[:, 0] += np.exp((5 - pos[:, 0]) / 3) * 20

        acc = (desired - vel) / tau + rep + wall
        vel += acc
        speed = np.linalg.norm(vel, axis=1, keepdims=True)
        vmax = v0 * 1.5
        vel = np.where(speed > vmax, vel / speed * vmax, vel)
        pos += vel

        # agents that reach the doorway exit the scene (respawn far left when normal)
        at_exit = (pos[:, 0] >= W - 8) & (np.abs(pos[:, 1] - EXIT[1]) < EXIT_HALF)
        pos[at_exit, 0] = 20
        pos[:, 1] = np.clip(pos[:, 1], 5, H - 5)
        pos[:, 0] = np.clip(pos[:, 0], 5, W - 5)

        frame = np.zeros((H, W, 3), dtype=np.uint8)
        for (x, y) in pos:
            cv2.circle(frame, (int(x), int(y)), 4, (200, 200, 200), -1)
        cv2.line(frame, (W - 2, int(EXIT[1] - EXIT_HALF)),
                 (W - 2, int(EXIT[1] + EXIT_HALF)), (0, 180, 0), 3)
        frames.append(frame)
        labels.append(1 if panic else 0)

    return frames, labels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--panic-at", type=float, default=15, dest="panic_at")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="data/samples/sim")
    args = ap.parse_args()

    import os
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    frames, labels = simulate(args.n, args.seconds, args.fps, args.panic_at, args.seed)

    path = args.out + ".mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    vw = cv2.VideoWriter(path, fourcc, args.fps, (W, H))
    if not vw.isOpened():  # fallback codec
        path = args.out + ".avi"
        vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), args.fps, (W, H))
    for f in frames:
        vw.write(f)
    vw.release()

    with open(args.out + ".labels.txt", "w") as fh:
        fh.write(" ".join(map(str, labels)))
    print(f"wrote {path} ({len(frames)} frames) and {args.out}.labels.txt")
    print(f"panic onset at frame {int(args.panic_at * args.fps)}")


if __name__ == "__main__":
    main()
