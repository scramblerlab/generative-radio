import os
import subprocess
import logging

import psutil

logger = logging.getLogger(__name__)

MODEL_SMALL = "qwen3:8b"    # < 32 GB unified memory (dev machine)
MODEL_LARGE = "qwen3:14b"   # >= 32 GB unified memory (Mac Mini production)
MEMORY_THRESHOLD_GB = 32


def get_unified_memory_gb() -> int:
    """Read total unified memory via sysctl — Apple Silicon / macOS only."""
    try:
        result = subprocess.run(
            ["sysctl", "-n", "hw.memsize"],
            capture_output=True, text=True, check=True,
        )
        return int(result.stdout.strip()) // (1024 ** 3)
    except Exception as e:
        logger.warning(f"[config] Could not detect unified memory via sysctl: {e}. Defaulting to small model.")
        return 0


def select_ollama_model() -> str:
    """Return the appropriate Qwen3 model tag for this machine.

    Priority:
      1. OLLAMA_MODEL environment variable (manual override)
      2. Auto-detection via sysctl hw.memsize
    """
    env_override = os.environ.get("OLLAMA_MODEL")
    if env_override:
        logger.info(f"[config] OLLAMA_MODEL env override active: {env_override}")
        return env_override

    memory_gb = get_unified_memory_gb()
    model = MODEL_LARGE if memory_gb >= MEMORY_THRESHOLD_GB else MODEL_SMALL
    logger.info(
        f"[config] Detected {memory_gb}GB unified memory "
        f"(threshold: {MEMORY_THRESHOLD_GB}GB) → selected model: {model}"
    )
    return model


# Resolved once at process startup — all modules import this constant.
OLLAMA_MODEL: str = select_ollama_model()


def mem_snapshot() -> str:
    """One-line RAM + swap summary for log messages.

    Example output (no swap):   RAM 18.2/24GB (76% used, 5.8GB free)
    Example output (swapping):  RAM 23.1/24GB (96% used, 0.9GB free) | ⚠ Swap: 2.4GB
    """
    try:
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        used_gb = (mem.total - mem.available) / (1024 ** 3)
        total_gb = mem.total / (1024 ** 3)
        avail_gb = mem.available / (1024 ** 3)
        swap_gb = swap.used / (1024 ** 3)
        line = (
            f"RAM {used_gb:.1f}/{total_gb:.0f}GB "
            f"({mem.percent:.0f}% used, {avail_gb:.1f}GB free)"
        )
        if swap_gb >= 0.1:
            line += f" | ⚠ Swap: {swap_gb:.1f}GB"
        return line
    except Exception:
        return "RAM: unavailable"
