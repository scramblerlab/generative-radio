import asyncio
import logging
import os
import re
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

_FIELD_RE = re.compile(r"^([A-Z][A-Z_0-9]*)\s*:\s*(.*)", re.IGNORECASE | re.MULTILINE)

_KEY_MAP = {
    "TITLE":       "song_title",
    "STYLE":       "style",
    "INSTRUMENTS": "instruments",
    "MOOD":        "mood",
    "VOCAL_STYLE": "vocal_style",
    "PRODUCTION":  "production",
    "BPM":         "bpm",
    "KEY":         "key_scale",
    "DURATION":    "duration",
}


def _parse_labeled_text(raw: str) -> SongPrompt:
    """Parse labeled plain-text LLM output into a SongPrompt.

    Expected format:
        TITLE: ...
        STYLE: ...
        ...
        LYRICS:
        [Verse 1]
        ...
        [Fade Out]

    LYRICS: acts as a hard separator — everything after it is lyrics verbatim,
    with no quoting or escaping required.  See docs/plain-text-llm-output-architecture.md.
    """
    # Strip markdown code fences
    raw = re.sub(r"^```[^\n]*\n?", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"^```\s*$", "", raw, flags=re.MULTILINE)

    # Skip thinking preamble — scan to first TITLE: line
    lines = raw.splitlines()
    start_idx = 0
    for i, line in enumerate(lines):
        if re.match(r"^TITLE\s*:", line, re.IGNORECASE):
            start_idx = i
            break
    relevant = "\n".join(lines[start_idx:])

    # Split header from lyrics on LYRICS: separator
    lyrics_match = re.search(r"^LYRICS\s*:\s*\n?", relevant, re.IGNORECASE | re.MULTILINE)
    if lyrics_match:
        header_block = relevant[:lyrics_match.start()]
        lyrics_text = relevant[lyrics_match.end():].strip()
    else:
        logger.warning("[llm] _parse_labeled_text: LYRICS: label missing — using empty lyrics")
        header_block = relevant
        lyrics_text = ""

    # Parse header lines into {LABEL: value} dict
    fields: dict[str, str] = {
        m.group(1).upper(): m.group(2).strip()
        for m in _FIELD_RE.finditer(header_block)
    }

    # Fix: LLM sometimes collapses two labels onto one line when the first value is empty.
    # e.g. "VOCAL_STYLE: PRODUCTION: lo-fi, bedroom pop"
    # Detect this by checking if a field's value starts with another known label.
    for label in list(fields.keys()):
        val = fields[label]
        inline = re.match(r'^([A-Z][A-Z_0-9]*)\s*:\s*(.*)', val, re.IGNORECASE)
        if inline and inline.group(1).upper() in _KEY_MAP:
            fields[label] = ""
            fields[inline.group(1).upper()] = inline.group(2).strip()
            logger.warning(
                f"[llm] _parse_labeled_text: fixed inline label — "
                f"{label} value contained {inline.group(1).upper()}: on same line"
            )

    missing = [lbl for lbl in _KEY_MAP if lbl not in fields]
    if missing:
        logger.warning(f"[llm] _parse_labeled_text: missing labels in header: {missing}")

    kwargs: dict = {"lyrics": lyrics_text}
    for label, field_name in _KEY_MAP.items():
        if label not in fields:
            continue
        val = fields[label]
        if field_name in ("bpm", "duration"):
            try:
                kwargs[field_name] = int(float(val))
            except (ValueError, TypeError):
                logger.warning(f"[llm] Could not parse numeric field {label}={val!r} — using default")
        else:
            kwargs[field_name] = val

    return SongPrompt(**kwargs)


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
        Thinking mode is disabled (think=False) — adds latency without improving output.
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
                "- INSTRUMENTAL TRACK — absolutely NO sung text, no verses, no chorus, no words. "
                "Under LYRICS:, write ONLY ACE-Step structure tags (e.g. [Intro] [Instrumental] [Guitar Solo] [Fade Out]). "
                "Do NOT write any text content between or after the tags."
            )
        else:
            lang_name = _LANGUAGE_NAMES.get(language, language)
            lyrics_rule = (
                f"- Write all lyrics in {lang_name}. "
                f"Every word of every lyric section must be in {lang_name}. "
                "Do not mix in English or any other language."
            )

        vocal_style_rule = (
            "- VOCAL_STYLE: Leave empty (instrumental track, no vocals)."
            if is_instrumental else
            "- VOCAL_STYLE: Vocal gender, timbre, and technique.\n"
            "  Examples: female vocal, breathy, soft | male vocal, raspy, powerful belting | choir, harmonies"
        )

        system_prompt = f"""You are a creative AI radio DJ. Your job is to generate unique, \
original song prompts for an AI music generator (ACE-Step).

SELECTED GENRES: {', '.join(genres)}
SELECTED MOODS / KEYWORDS: {', '.join(keywords) if keywords else 'None specified'}
{feeling_section}{history_section}

CAPTION DIMENSIONS — fill each field with comma-separated descriptors:

- STYLE: Genre, sub-genre, and optional era reference.
  Examples: smooth jazz, bebop influences | 80s synth-pop, retro | indie folk, acoustic, Americana
- INSTRUMENTS: Key instruments featured in the track.
  Examples: acoustic guitar, piano, soft strings | synth bass, 808 drums, synth pads, electric guitar
- MOOD: Emotion, atmosphere, and timbre texture adjectives.
  Examples: warm, nostalgic, intimate, airy | dark, brooding, raw, punchy
  Texture words that strongly influence output: warm, bright, crisp, airy, punchy, lush, raw, polished
{vocal_style_rule}
- PRODUCTION: Production style, rhythm feel, and structure hints.
  Examples: lo-fi, bedroom pop, laid-back groove, building chorus | studio-polished, driving beat, fade-out ending

IMPORTANT:
- Do NOT put BPM, key, or duration in any caption field — those have their own labels.
- Avoid conflicting descriptors within a field (e.g., "ambient" + "aggressive" in mood).
- The mood and vocal style MUST be consistent with the lyrics you write.
- Vary the style, instruments, mood, and themes between songs — keep it fresh.

LYRICS RULES:
- {lyrics_rule}
- Use ACE-Step structure tags: [Intro], [Verse], [Verse 1], [Verse 2], [Pre-Chorus], [Chorus], [Bridge], [Outro], [Fade Out]
- {'Skip this rule.' if is_instrumental else 'Include 3-5 sections. Always include at least one [Verse] and one [Chorus].'}
- {'Skip this rule.' if is_instrumental else 'You may add [Instrumental], [Guitar Solo], or [Piano Interlude] for breaks.'}
- {'Skip this rule.' if is_instrumental else 'You may combine a tag with ONE style modifier: [Chorus - anthemic], [Bridge - whispered], [Verse - spoken word]'}
- {'Skip this rule.' if is_instrumental else 'Keep lines to 6-10 syllables for natural singing rhythm.'}
- {'Skip this rule.' if is_instrumental else 'Separate sections with blank lines.'}
- {'Skip this rule.' if is_instrumental else 'Use UPPERCASE sparingly for high-intensity climax lines in choruses.'}
- {'Skip this rule.' if is_instrumental else 'Use parentheses for background vocals: Into the light (into the light)'}
- {'Skip this rule.' if is_instrumental else 'Stick to one core metaphor per song for lyrical cohesion.'}
- {'Skip this rule.' if is_instrumental else 'Lyrics should be creative and evocative, not generic or clichéd. Avoid adjective stacking and mixed metaphors.'}
- {'The last section tag must always be [Fade Out] as a standalone tag with no lyrics under it — this signals ACE-Step to end the track with a natural fade.' if is_instrumental else 'The last section must always be [Fade Out]. It may contain a short repeating hook, ad-libs, or humming that fades out — or leave it as a standalone tag for a pure instrumental fade.'}

METADATA RULES:
- BPM range: 30–300. Match the genre naturally (slow 60–80, mid-tempo 90–120, fast 130–180+)
- BPM and DURATION must be whole integers — no decimal points (e.g. 120, not 120.5)
- DURATION should be around {target_duration} seconds — it is fine if the actual audio runs slightly shorter or longer to allow a natural ending

OUTPUT FORMAT:
Output ONLY the labeled plain-text format below. Do NOT output JSON, markdown, or code fences.
Do NOT write anything before TITLE: or after the final lyrics line.

TITLE: <song title>
STYLE: <style descriptors>
INSTRUMENTS: <instrument list>
MOOD: <mood descriptors>
VOCAL_STYLE: <vocal style, or leave empty for instrumental>
PRODUCTION: <production descriptors>
BPM: <integer>
KEY: <musical key, e.g. A Minor, C Major, F# Minor>
DURATION: <integer seconds>

LYRICS:
<full lyrics with all section tags>
[Fade Out]

RULES:
- ALL nine labels (TITLE, STYLE, INSTRUMENTS, MOOD, VOCAL_STYLE, PRODUCTION, BPM, KEY, DURATION) must appear exactly once, each on its own line.
- LYRICS: must be the last label. Write lyrics freely after it — no quoting or escaping needed.
- BPM and DURATION must be whole integers with no decimal point.
- Do NOT use emojis or special Unicode characters. Plain ASCII text only."""

        t0 = time.monotonic()
        try:
            response = await asyncio.to_thread(
                chat,
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": "Generate the next song for the radio station."},
                ],
                think=False,  # Disable Qwen3 chain-of-thought — adds latency without improving output
                keep_alive=0,  # Unload model immediately — frees ~2.5GB before ACE-Step VAE decode
            )
        except Exception as e:
            logger.error(f"[llm] Ollama chat() failed: {e}", exc_info=True)
            raise

        elapsed = time.monotonic() - t0
        raw = response.message.content
        logger.debug(f"[llm] Raw LLM response ({elapsed:.1f}s): {raw[:200]}...")

        try:
            prompt = _parse_labeled_text(raw)
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
