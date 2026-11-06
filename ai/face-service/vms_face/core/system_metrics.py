"""Background poller that fills the SYSTEM_* gauges in core.metrics.

Two probes:
  - psutil   : process CPU% and RSS (always available, cross-platform)
  - pynvml   : per-GPU util / memory / temp (optional, NVIDIA only)

Run it as an asyncio background task from the API and worker lifespans.
The poller is fault-tolerant: if pynvml fails (no driver, CPU-only host) we
skip GPU metrics quietly.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.core.metrics import (
    SYSTEM_CPU_PCT,
    SYSTEM_GPU_MEM_TOTAL_BYTES,
    SYSTEM_GPU_MEM_USED_BYTES,
    SYSTEM_GPU_TEMP_C,
    SYSTEM_GPU_UTIL_PCT,
    SYSTEM_RSS_BYTES,
)

log = get_logger(__name__)


def _try_import_psutil():
    try:
        import psutil  # type: ignore[import-not-found]
        return psutil
    except Exception as e:
        log.warning("psutil unavailable; CPU/RSS metrics disabled", err=str(e))
        return None


def _try_import_pynvml():
    try:
        import pynvml  # type: ignore[import-not-found]
        pynvml.nvmlInit()
        return pynvml
    except Exception as e:
        log.info("pynvml unavailable; GPU metrics disabled", err=str(e))
        return None


def _gpu_handles(pynvml: Any) -> list[tuple[int, Any, str]]:
    handles: list[tuple[int, Any, str]] = []
    try:
        n = pynvml.nvmlDeviceGetCount()
    except Exception:
        return handles
    for i in range(n):
        try:
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(h)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="ignore")
            handles.append((i, h, str(name)))
        except Exception:
            continue
    return handles


async def run_system_metrics(stop: asyncio.Event) -> None:
    if not settings.system_metrics_enabled:
        log.info("system metrics disabled by config")
        return

    psutil = _try_import_psutil()
    pynvml = _try_import_pynvml()
    proc = psutil.Process(os.getpid()) if psutil is not None else None
    handles = _gpu_handles(pynvml) if pynvml is not None else []
    interval = max(1.0, float(settings.system_metrics_interval_sec))
    log.info(
        "system metrics poller starting",
        interval_sec=interval,
        gpu_count=len(handles),
        psutil=bool(psutil),
        pynvml=bool(pynvml),
    )

    # Prime cpu_percent so the first reading isn't 0.0
    if proc is not None:
        try:
            proc.cpu_percent(interval=None)
        except Exception:
            pass

    while not stop.is_set():
        try:
            if proc is not None:
                try:
                    SYSTEM_CPU_PCT.set(float(proc.cpu_percent(interval=None)))
                    SYSTEM_RSS_BYTES.set(float(proc.memory_info().rss))
                except Exception:
                    pass
            for idx, handle, name in handles:
                try:
                    util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                    SYSTEM_GPU_UTIL_PCT.labels(gpu_index=str(idx), gpu_name=name).set(float(util.gpu))
                    mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                    SYSTEM_GPU_MEM_USED_BYTES.labels(gpu_index=str(idx), gpu_name=name).set(float(mem.used))
                    SYSTEM_GPU_MEM_TOTAL_BYTES.labels(gpu_index=str(idx), gpu_name=name).set(float(mem.total))
                    try:
                        temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
                        SYSTEM_GPU_TEMP_C.labels(gpu_index=str(idx), gpu_name=name).set(float(temp))
                    except Exception:
                        pass
                except Exception:
                    continue
        except Exception as e:
            log.warning("system metrics tick failed", err=str(e))
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue

    if pynvml is not None:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass
    log.info("system metrics poller stopped")
