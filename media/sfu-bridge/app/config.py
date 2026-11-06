"""Bridge settings — central config. Same convention as smart-cam-transcoder."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

    port: int = 8005
    log_level: str = "info"

    # ── MediaMTX (RTSP source) ──────────────────────────────────────────
    mediamtx_rtsp_base: str = "rtsp://mediamtx:8554"
    # If a camera has Phase 3 transcoding enabled, we publish the clean
    # path. Otherwise we publish the raw path. The supervisor consults
    # the Camera.settings JSON to decide.
    clean_path_suffix: str = "_clean"

    # ── LiveKit ─────────────────────────────────────────────────────────
    # ws/wss URL of the LiveKit server. Cloud:
    #   wss://demo-62bdagkc.livekit.cloud
    # Self-host:
    #   ws://livekit:7880
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    # JWT TTL for the bridge's publisher participant — bridge re-mints
    # when ~60s remain. 1 hour is plenty for a long-lived publisher.
    livekit_publish_ttl_sec: int = 3600

    # ── Process management ──────────────────────────────────────────────
    ffmpeg_restart_backoff_sec: float = 5.0
    ffmpeg_log_tail_lines: int = 200
    max_concurrent_publishers: int = 100


settings = Settings()
