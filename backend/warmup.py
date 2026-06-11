"""Throwaway ACE-Step warmup generation at server startup.

ACESTEP_COMPILE_MODEL=1 makes the first generation after a restart pay the
mx.compile JIT cost, and idle gaps can evict Metal kernel caches (see
docs/apple-silicon-performance-tuning.md, Phase B observations). Running one
short, cheap generation right after startup means the first listener gets
steady-state (T2) performance instead of the slow T1.

Disable with WARMUP_ON_START=0. The output MP3 is discarded; the leftover
api_audio file is removed by the TrackLibrary janitor.
"""

import logging
import time

from acestep_client import ACEStepClient
from models import SongPrompt

logger = logging.getLogger(__name__)

_WARMUP_PROMPT = SongPrompt(
    song_title="Warmup",
    style="ambient",
    instruments="soft synth pad",
    mood="calm, minimal",
    vocal_style="",
    production="sparse, slow",
    lyrics="[Instrumental]\n\n[Fade Out]",
    bpm=80,
    key_scale="C Major",
    duration=30,  # clamped minimum — keeps the warmup short
)


async def run_warmup(acestep: ACEStepClient) -> None:
    try:
        if not await acestep.health_check():
            logger.info("[warmup] ACE-Step not reachable — skipping warmup")
            return
        logger.info("[warmup] Starting throwaway warmup generation (30s instrumental)...")
        t0 = time.monotonic()
        audio_bytes, _ = await acestep.generate_song(
            _WARMUP_PROMPT,
            vocal_language="instrumental",
            inference_steps=8,
            thinking=False,           # skip CoT — only DiT/VAE kernels need warming
            use_cot_caption=False,
            use_cot_metas=False,
            use_cot_language=False,
        )
        logger.info(
            f"[warmup] Done in {time.monotonic() - t0:.1f}s "
            f"({len(audio_bytes) / 1024:.0f} KB discarded) — DiT/VAE kernels are warm"
        )
    except Exception as e:
        logger.warning(f"[warmup] Warmup failed (non-fatal): {e}")
