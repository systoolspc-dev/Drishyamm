"""Settings loaded from env. Match the BACKEND-TEMPLATE convention of
central env handling (everyone imports from here, nobody touches
`os.environ` directly).

Most defaults match docker-compose internal hostnames — flipping any
env var on the compose service overrides for production.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

    # ── Service ─────────────────────────────────────────────────────────
    port: int = 8004
    log_level: str = "info"

    # ── MediaMTX integration ────────────────────────────────────────────
    # FFmpeg reads from this RTSP URL prefix (per-camera path appended):
    #   rtsp://mediamtx:8554/cam_<id>
    mediamtx_rtsp_base: str = "rtsp://mediamtx:8554"
    # FFmpeg publishes back to MediaMTX at the same RTSP host. The clean
    # path is suffixed `_clean` so SPA / AI can switch transparently when
    # the per-camera transcode flag flips.
    clean_path_suffix: str = "_clean"
    # MediaMTX REST API — used to verify paths exist before spawning
    # FFmpeg + to add the clean path if it isn't auto-created by publish.
    mediamtx_api_url: str = "http://mediamtx:9997"
    mediamtx_api_user: str = "drishyam"
    mediamtx_api_pass: str = "drishyam123"

    # ── NVENC profile (the actual normalisation knobs) ──────────────────
    # All values are conservative for browser compatibility. Operators
    # who need higher quality can override per-camera via the start
    # endpoint payload.
    nvenc_codec: str = "h264_nvenc"            # h264 = universal; switch to hevc_nvenc later
    nvenc_preset: str = "p4"                   # p1..p7 (fastest..slowest); p4 = balanced
    nvenc_tune: str = "ll"                     # 'll' = low-latency (matters for live)
    nvenc_profile: str = "baseline"            # baseline = no B-frames, universal decode
    nvenc_bitrate_kbps: int = 4000             # 4 Mbps for 1080p — see DOCS
    nvenc_maxrate_kbps: int = 5000
    nvenc_gop_seconds: float = 2.0             # short GOP → fast recovery from packet loss
    nvenc_fps: int = 25
    nvenc_audio: str = "copy"                  # never re-encode audio; just remux

    # ── Process management ──────────────────────────────────────────────
    # Per-camera FFmpeg state is in-memory only. Restarting the
    # service loses every transcoder instance — operator re-issues the
    # /start calls (or, more likely, the backend supervisor re-toggles
    # the camera-settings flags which the supervisor watches).
    ffmpeg_log_tail_lines: int = 200
    ffmpeg_restart_backoff_sec: float = 5.0
    max_concurrent_transcoders: int = 16       # encoder-slot ceiling

settings = Settings()
