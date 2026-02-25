import asyncio
import logging
import os
import time

from ollama import chat
from models import SongPrompt
from config import OLLAMA_MODEL, MAX_DURATION_S

logger = logging.getLogger(__name__)

# Human-readable names injected into the LLM system prompt
_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "zh": "Chinese (Mandarin)",
    "el": "Greek",
    "fi": "Finnish",
    "sv": "Swedish",
    "ja": "Japanese",
    "ko": "Korean",
}


class OllamaClient:
    def __init__(self, model: str | None = None):
        self.model = model or OLLAMA_MODEL
        logger.info(f"[llm] OllamaClient initialized — model: {self.model}")

    async def generate_prompt(
        self,
        genres: list[str],
        keywords: list[str],
        history: list[str],
        duration: int | None = None,
        language: str = "en",
        feeling: str = "",
    ) -> SongPrompt:
        """Call Ollama to generate a structured SongPrompt.

        Runs ollama.chat() in a thread to avoid blocking the async event loop.
        Thinking mode is disabled (think=False) — not needed for JSON generation.
        """
        model = os.environ.get("OLLAMA_MODEL", self.model)
        target_duration = duration if duration is not None else MAX_DURATION_S
        is_instrumental = language == "instrumental"
        logger.info(
            f"[llm] Generating prompt — model: {model}, "
            f"genres: {genres}, keywords: {keywords}, "
            f"history_length: {len(history)}, target_duration: {target_duration}s, "
            f"language: {language}, feeling: {feeling[:50]!r}"
        )

        feeling_section = ""
        if feeling.strip():
            feeling_section = (
                f'\n\nUSER\'S FEELING: "{feeling.strip()[:200]}"\n'
                "Use this feeling to inspire the song's mood, lyric themes, and musical choices.\n"
                "Reflect the emotional tone in your lyrics and style tag selection."
            )

        history_section = ""
        if history:
            recent = history[-10:]
            history_section = (
                "\n\nSongs already played this session — avoid repeating similar themes or styles:\n"
                + "\n".join(f"  - {title}" for title in recent)
            )

        if is_instrumental:
            lyrics_rule = (
                "- INSTRUMENTAL TRACK — there are no vocals. "
                "Set the lyrics field to an empty string \"\"."
            )
        else:
            lang_name = _LANGUAGE_NAMES.get(language, language)
            lyrics_rule = (
                f"- Write all lyrics in {lang_name}. "
                f"Every word of every lyric section must be in {lang_name}. "
                "Do not mix in English or any other language."
            )

        vocal_style_rule = (
            '- "vocal_style": Empty string "" (instrumental track, no vocals).'
            if is_instrumental else
            '- "vocal_style": Vocal gender, timbre, and technique.\n'
            '  Examples: "female vocal, breathy, soft", "male vocal, raspy, powerful belting", "choir, harmonies"'
        )

        system_prompt = f"""You are a creative AI radio DJ. Your job is to generate unique, \
original song prompts for an AI music generator (ACE-Step).

SELECTED GENRES: {', '.join(genres)}
SELECTED MOODS / KEYWORDS: {', '.join(keywords) if keywords else 'None specified'}
{feeling_section}{history_section}

CAPTION DIMENSIONS — fill each field with comma-separated descriptors:

- "style": Genre, sub-genre, and optional era reference.
  Examples: "smooth jazz, bebop influences", "80s synth-pop, retro", "indie folk, acoustic, Americana"
- "instruments": Key instruments featured in the track.
  Examples: "acoustic guitar, piano, soft strings", "synth bass, 808 drums, synth pads, electric guitar"
- "mood": Emotion, atmosphere, and timbre texture adjectives.
  Examples: "warm, nostalgic, intimate, airy", "dark, brooding, raw, punchy"
  Texture words that strongly influence output: warm, bright, crisp, airy, punchy, lush, raw, polished
{vocal_style_rule}
- "production": Production style, rhythm feel, and structure hints.
  Examples: "lo-fi, bedroom pop, laid-back groove, building chorus", "studio-polished, driving beat, fade-out ending"

IMPORTANT:
- Do NOT put BPM, key, or duration in any caption field — those have their own parameters.
- Avoid conflicting descriptors within a field (e.g., "ambient" + "aggressive" in mood).
- The mood and vocal_style MUST be consistent with the lyrics you write.
- Vary the style, instruments, mood, and themes between songs — keep it fresh.

LYRICS RULES:
- {lyrics_rule}
- Use ACE-Step structure tags: [Intro], [Verse], [Verse 1], [Verse 2], [Pre-Chorus], [Chorus], [Bridge], [Outro]
- {'Set lyrics to an empty string.' if is_instrumental else 'Include 3-5 sections. Always include at least one [Verse] and one [Chorus].'}
- {'Skip this rule.' if is_instrumental else 'You may add [Instrumental], [Guitar Solo], or [Piano Interlude] for breaks.'}
- {'Skip this rule.' if is_instrumental else 'You may combine a tag with ONE style modifier: [Chorus - anthemic], [Bridge - whispered], [Verse - spoken word]'}
- {'Skip this rule.' if is_instrumental else 'Keep lines to 6-10 syllables for natural singing rhythm.'}
- {'Skip this rule.' if is_instrumental else 'Separate sections with blank lines.'}
- {'Skip this rule.' if is_instrumental else 'Use UPPERCASE sparingly for high-intensity climax lines in choruses.'}
- {'Skip this rule.' if is_instrumental else 'Use parentheses for background vocals: "Into the light (into the light)"'}
- {'Skip this rule.' if is_instrumental else 'Stick to one core metaphor per song for lyrical cohesion.'}
- {'Skip this rule.' if is_instrumental else 'Lyrics should be creative and evocative, not generic or clichéd. Avoid adjective stacking and mixed metaphors.'}

METADATA RULES:
- BPM must match the genre and mood naturally
- Duration must be exactly {target_duration} seconds

OUTPUT RULES:
- Do NOT use emojis or special Unicode characters in any field. Use only plain ASCII text.
- All field values must be valid JSON strings — no unescaped quotes or control characters."""

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
        logger.debug(f"[llm] Style: {prompt.style}")
        logger.debug(f"[llm] Instruments: {prompt.instruments}")
        logger.debug(f"[llm] Mood: {prompt.mood}")
        logger.debug(f"[llm] Vocal: {prompt.vocal_style}")
        logger.debug(f"[llm] Production: {prompt.production}")
        logger.debug(f"[llm] Combined caption: {prompt.tags}")
        return prompt
