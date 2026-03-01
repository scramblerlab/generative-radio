import os
import subprocess
import logging

import psutil

logger = logging.getLogger(__name__)

# LLM model — qwen3:8b is sufficient for prompt generation on all machines.
# Extra memory freed by dropping qwen3:14b benefits ACE-Step's MLX VAE buffer.
OLLAMA_MODEL_NAME = "qwen3:8b"

# Audio duration tiers (unified memory in GB → max song duration in seconds).
# See docs/acestep-memory-vs-duration.md for the research behind these numbers.
DURATION_SMALL_THRESHOLD_GB = 32  # ≤32 GB → short debug songs
DURATION_THRESHOLD_GB = 48        # ≥48 GB → full-length progressive songs
DURATION_SMALL_S = 30             # fast iteration on ≤24 GB dev machines
DURATION_DEFAULT_S = 60           # standard on 25–47 GB machines
DURATION_LARGE_S = 180            # safe on ≥48 GB machines (~33 GB MLX VAE buffer)

# Progressive duration ramp for large-memory machines (track index → seconds):
#   Track 0 (first):  60 s — quick start
#   Track 1 (second): 120 s — medium
#   Track 2+ (third+): 180 s — full length
_PROGRESSIVE_DURATIONS = [DURATION_DEFAULT_S, 120, DURATION_LARGE_S]



def get_unified_memory_gb() -> int:
    """Read total unified memory via sysctl — Apple Silicon / macOS only."""
    try:
        result = subprocess.run(
            ["sysctl", "-n", "hw.memsize"],
            capture_output=True, text=True, check=True,
        )
        return int(result.stdout.strip()) // (1024 ** 3)
    except Exception as e:
        logger.warning(f"[config] Could not detect unified memory via sysctl: {e}. Defaulting to safe values.")
        return 0


# Read once at startup; shared by both selections below.
_MEMORY_GB: int = get_unified_memory_gb()


def select_ollama_model() -> str:
    """Return the Qwen3 model tag for this machine.

    Priority:
      1. OLLAMA_MODEL environment variable (manual override)
      2. qwen3:8b on all machines — sufficient for prompt generation
    """
    env_override = os.environ.get("OLLAMA_MODEL")
    if env_override:
        logger.info(f"[config] OLLAMA_MODEL env override active: {env_override}")
        return env_override

    logger.info(f"[config] Detected {_MEMORY_GB}GB unified memory → using {OLLAMA_MODEL_NAME}")
    return OLLAMA_MODEL_NAME


def select_max_duration() -> int:
    """Return the maximum audio duration in seconds for this machine.

    Machines with ≥48 GB unified memory can safely generate 180 s songs.
    All others are capped at 60 s to stay within the MLX VAE Metal buffer limit.
    See docs/acestep-memory-vs-duration.md for details.

    Priority:
      1. MAX_DURATION_S environment variable (manual override)
      2. Auto-detection via unified memory
    """
    env_override = os.environ.get("MAX_DURATION_S")
    if env_override:
        try:
            val = int(env_override)
            logger.info(f"[config] MAX_DURATION_S env override active: {val}s")
            return val
        except ValueError:
            logger.warning(f"[config] Invalid MAX_DURATION_S env value: {env_override!r}. Using auto-detection.")

    if _MEMORY_GB <= DURATION_SMALL_THRESHOLD_GB:
        duration = DURATION_SMALL_S
    elif _MEMORY_GB >= DURATION_THRESHOLD_GB:
        duration = DURATION_LARGE_S
    else:
        duration = DURATION_DEFAULT_S
    logger.info(
        f"[config] Detected {_MEMORY_GB}GB unified memory → max audio duration: {duration}s"
    )
    return duration


# Resolved once at process startup — imported as constants by other modules.
OLLAMA_MODEL: str = select_ollama_model()
MAX_DURATION_S: int = select_max_duration()


def get_progressive_duration(track_index: int) -> int:
    """Return the target audio duration (seconds) for a 0-based track index.

    On ≥48 GB machines the duration ramps up so the first track starts quickly:
      - Track 0: 60 s
      - Track 1: 120 s
      - Track 2+: 180 s

    On <48 GB machines every track uses the safe default (60 s).
    """
    if _MEMORY_GB <= DURATION_SMALL_THRESHOLD_GB:
        return DURATION_SMALL_S
    if _MEMORY_GB < DURATION_THRESHOLD_GB:
        return DURATION_DEFAULT_S
    idx = min(track_index, len(_PROGRESSIVE_DURATIONS) - 1)
    return _PROGRESSIVE_DURATIONS[idx]


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
