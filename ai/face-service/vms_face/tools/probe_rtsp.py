"""Standalone RTSP / stream health probe.

Run from any host that can reach the RTSP source. Connects, decodes for the
requested duration, reports actual FPS / decode success / packet errors. Use
it to identify *which* camera is broken before involving the orchestrator,
match worker, or any UI.

Examples:
    # Local camera via MediaMTX
    python -m vms_face.tools.probe_rtsp rtsp://mediamtx:8554/cam_GATE-01

    # Camera directly (skip MediaMTX)
    python -m vms_face.tools.probe_rtsp rtsp://192.168.1.42/Streaming/Channels/101 \
        --duration 20 --transport tcp

    # JSON output for scripted batch checks
    python -m vms_face.tools.probe_rtsp rtsp://... --json

Output sections:
    - connect:    did open() succeed, and how long it took
    - decode:     frames/sec actually delivered, decode error counts
    - keyframe:   inter-keyframe gap (large = upstream sending sparse IDRs)
    - codec:      bitstream details, resolution, codec
    - verdict:    one of {healthy, degraded, broken} with the reason
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass

try:
    import av
except ImportError as e:
    print(f"PyAV not installed: {e}", file=sys.stderr)
    sys.exit(2)


@dataclass
class ProbeReport:
    source: str
    transport: str
    duration_sec: float
    open_ok: bool
    open_latency_sec: float | None
    codec: str | None
    width: int | None
    height: int | None
    declared_fps: float | None
    frames_decoded: int = 0
    frames_per_sec_observed: float | None = None
    decode_errors: int = 0
    demux_errors: int = 0
    keyframes_seen: int = 0
    max_keyframe_gap_sec: float | None = None
    verdict: str = "unknown"
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def probe(source: str, *, duration_sec: float, transport: str, timeout_sec: int) -> ProbeReport:
    rep = ProbeReport(
        source=source,
        transport=transport,
        duration_sec=duration_sec,
        open_ok=False,
        open_latency_sec=None,
        codec=None,
        width=None,
        height=None,
        declared_fps=None,
    )

    options = {
        "rtsp_transport": transport,
        "stimeout": str(timeout_sec * 1_000_000),
        "max_delay": "5000000",
        "reorder_queue_size": "500",
        "fflags": "+discardcorrupt+genpts",
        "err_detect": "ignore_err",
        "probesize": "5000000",
        "analyzeduration": "5000000",
    }

    t0 = time.monotonic()
    try:
        container = av.open(source, options=options, timeout=timeout_sec)
    except Exception as e:
        rep.reason = f"open failed: {e}"
        rep.verdict = "broken"
        return rep
    rep.open_latency_sec = round(time.monotonic() - t0, 3)
    rep.open_ok = True

    try:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            rep.reason = "no video stream in container"
            rep.verdict = "broken"
            return rep
        rep.codec = stream.codec_context.name if stream.codec_context else None
        rep.width = stream.codec_context.width if stream.codec_context else None
        rep.height = stream.codec_context.height if stream.codec_context else None
        try:
            rep.declared_fps = float(stream.average_rate) if stream.average_rate else None
        except (TypeError, ValueError):
            rep.declared_fps = None
        stream.thread_type = "AUTO"

        last_keyframe_ts = None
        max_gap = 0.0

        deadline = time.monotonic() + duration_sec
        packet_iter = container.demux(stream)
        first_frame_ts = None

        while time.monotonic() < deadline:
            try:
                packet = next(packet_iter)
            except StopIteration:
                rep.reason = "stream ended early (EOS)"
                break
            except Exception as e:
                rep.demux_errors += 1
                # Print first few demux errors to stderr so the user sees them.
                if rep.demux_errors <= 3:
                    print(f"[demux err] {e}", file=sys.stderr)
                continue

            if packet.is_keyframe:
                now = time.monotonic()
                if last_keyframe_ts is not None:
                    gap = now - last_keyframe_ts
                    if gap > max_gap:
                        max_gap = gap
                last_keyframe_ts = now
                rep.keyframes_seen += 1

            try:
                frames = packet.decode()
            except Exception as e:
                rep.decode_errors += 1
                if rep.decode_errors <= 3:
                    print(f"[decode err] {e}", file=sys.stderr)
                continue

            for f in frames:
                rep.frames_decoded += 1
                if first_frame_ts is None:
                    first_frame_ts = time.monotonic()

        elapsed = max(1e-6, time.monotonic() - (first_frame_ts or t0))
        rep.frames_per_sec_observed = round(rep.frames_decoded / elapsed, 2)
        rep.max_keyframe_gap_sec = round(max_gap, 3) if max_gap > 0 else None
    finally:
        try:
            container.close()
        except Exception:
            pass

    # ── verdict logic ────────────────────────────────────────────────────────
    if rep.frames_decoded == 0:
        rep.verdict = "broken"
        rep.reason = (
            "no decoded frames in the probe window — open succeeded but the "
            "decoder received nothing usable. Either the camera isn't actually "
            "publishing or every packet was corrupt."
        )
    elif rep.declared_fps and rep.frames_per_sec_observed and rep.frames_per_sec_observed < rep.declared_fps * 0.5:
        rep.verdict = "degraded"
        rep.reason = (
            f"observed {rep.frames_per_sec_observed} fps but camera advertises "
            f"{rep.declared_fps:.1f} fps — more than half the frames are being "
            f"lost or rejected by the decoder."
        )
    elif rep.decode_errors + rep.demux_errors > rep.frames_decoded * 0.1:
        rep.verdict = "degraded"
        rep.reason = (
            f"{rep.decode_errors} decode + {rep.demux_errors} demux errors "
            f"vs {rep.frames_decoded} good frames — error rate >10%."
        )
    elif rep.max_keyframe_gap_sec and rep.max_keyframe_gap_sec > 10.0:
        rep.verdict = "degraded"
        rep.reason = (
            f"keyframe gap reached {rep.max_keyframe_gap_sec}s — camera GOP "
            f"is too long for fast reconnect. Set the camera's I-frame "
            f"interval to <=2s in its web UI."
        )
    else:
        rep.verdict = "healthy"
        rep.reason = "decode success rate >90% and observed fps tracks declared rate."

    return rep


def _print_human(rep: ProbeReport) -> None:
    bar = "─" * 72
    print(bar)
    print(f"RTSP probe — {rep.source}")
    print(bar)
    print(f"  transport         : {rep.transport}")
    print(f"  duration          : {rep.duration_sec}s")
    print()
    print("  open:")
    print(f"    success         : {rep.open_ok}")
    if rep.open_latency_sec is not None:
        print(f"    latency         : {rep.open_latency_sec}s")
    print()
    print("  codec:")
    print(f"    name            : {rep.codec}")
    print(f"    resolution      : {rep.width}x{rep.height}" if rep.width else "    resolution      : unknown")
    print(f"    declared fps    : {rep.declared_fps}")
    print()
    print("  decode:")
    print(f"    frames good     : {rep.frames_decoded}")
    print(f"    frames bad      : {rep.decode_errors}")
    print(f"    demux errors    : {rep.demux_errors}")
    print(f"    observed fps    : {rep.frames_per_sec_observed}")
    print()
    print("  keyframes:")
    print(f"    seen            : {rep.keyframes_seen}")
    print(f"    max gap         : {rep.max_keyframe_gap_sec}s")
    print()
    color = {"healthy": "\033[32m", "degraded": "\033[33m", "broken": "\033[31m"}.get(rep.verdict, "")
    reset = "\033[0m" if color else ""
    print(f"  VERDICT : {color}{rep.verdict.upper()}{reset}")
    print(f"  REASON  : {rep.reason}")
    print(bar)


def main() -> int:
    ap = argparse.ArgumentParser(description="One-shot RTSP / stream health probe.")
    ap.add_argument("source", help="RTSP URL or file path")
    ap.add_argument("--duration", type=float, default=10.0, help="Seconds to probe (default 10)")
    ap.add_argument("--transport", default="tcp", choices=["tcp", "udp"], help="RTSP transport")
    ap.add_argument("--timeout", type=int, default=10, help="Open / socket timeout in seconds")
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable output")
    args = ap.parse_args()

    rep = probe(
        args.source,
        duration_sec=args.duration,
        transport=args.transport,
        timeout_sec=args.timeout,
    )
    if args.json:
        print(json.dumps(rep.to_dict(), indent=2))
    else:
        _print_human(rep)
    return 0 if rep.verdict == "healthy" else 1


if __name__ == "__main__":
    sys.exit(main())
