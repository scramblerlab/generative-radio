import asyncio
import logging
import os
import time

from ollama import chat
from models import SongPrompt
from config import OLLAMA_MODEL

logger = logging.getLogger(__name__)


class OllamaClient:
    def __init__(self, model: str | None = None):
        self.model = model or OLLAMA_MODEL
        logger.info(f"[llm] OllamaClient initialized — model: {self.model}")

    async def generate_prompt(
        self,
        genres: list[str],
        keywords: list[str],
        history: list[str],
    ) -> SongPrompt:
        """Call Ollama to generate a structured SongPrompt.

        Runs ollama.chat() in a thread to avoid blocking the async event loop.
        Thinking mode is disabled (think=False) — not needed for JSON generation.
        """
        model = os.environ.get("OLLAMA_MODEL", self.model)
        logger.info(
            f"[llm] Generating prompt — model: {model}, "
            f"genres: {genres}, keywords: {keywords}, "
            f"history_length: {len(history)}"
        )

        history_section = ""
        if history:
            recent = history[-10:]
            history_section = (
                "\n\nSongs already played this session — avoid repeating similar themes or styles:\n"
                + "\n".join(f"  - {title}" for title in recent)
            )

        system_prompt = f"""You are a creative AI radio DJ. Your job is to generate unique, \
original song prompts for an AI music generator.

SELECTED GENRES: {', '.join(genres)}
SELECTED MOODS / KEYWORDS: {', '.join(keywords) if keywords else 'None specified'}
{history_section}

RULES:
- Write original lyrics (2–4 sections using [verse], [chorus], [bridge] markers)
- The "tags" field must be a comma-separated list of musical style descriptors \
that ACE-Step understands: sub-genre, instruments, mood, tempo feel, vocal style, production style, etc.
- Vary the sub-genre, tempo, key, mood, and lyric themes between songs
- Lyrics should be creative and evocative, not generic or clichéd
- Keep lyrics concise: 4–8 lines per section
- BPM must match the genre and mood naturally
        - Duration must be exactly 60 seconds"""

        t0 = time.monotonic()
        try:
            response = await asyncio.to_thread(
                chat,
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": "Generate the next song for the radio station."},
                ],
                format=SongPrompt.model_json_schema(),
                think=False,  # Disable Qwen3 chain-of-thought — adds latency without improving JSON output
            )
        except Exception as e:
            logger.error(f"[llm] Ollama chat() failed: {e}", exc_info=True)
            raise

        elapsed = time.monotonic() - t0
        raw = response.message.content
        logger.debug(f"[llm] Raw LLM response ({elapsed:.1f}s): {raw[:200]}...")

        try:
            prompt = SongPrompt.model_validate_json(raw)
        except Exception as e:
            logger.error(f"[llm] Failed to parse LLM response into SongPrompt: {e}\nRaw: {raw}")
            raise

        logger.info(
            f"[llm] Prompt generated in {elapsed:.1f}s — "
            f"'{prompt.song_title}' | {prompt.bpm} BPM | {prompt.key_scale} | {prompt.duration}s"
        )
        logger.debug(f"[llm] Tags: {prompt.tags}")
        return prompt
