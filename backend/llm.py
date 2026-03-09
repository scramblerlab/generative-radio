import asyncio
import json
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


def _find_first_json_object(s: str) -> tuple[int, int]:
    """Return (start, end+1) indices of the first complete JSON object in s.

    Uses brace counting so that `}` characters inside string values are ignored
    and nested objects are handled correctly.  Returns (-1, -1) if none found.
    """
    brace_start = s.find("{")
    if brace_start == -1:
        return -1, -1
    depth = 0
    in_string = False
    escaped = False
    for i in range(brace_start, len(s)):
        ch = s[i]
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_string:
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if not in_string:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return brace_start, i + 1
    return -1, -1  # unbalanced braces


def _extract_song_prompt_json(raw: str) -> str:
    """Recover a complete SongPrompt JSON from a raw LLM response.

    qwen3.5:4b exhibits several misbehaviours:

    1. Outputs caption-dimension fields as valid JSON then appends lyrics as
       plain text after the closing brace.
    2. Splits output into two JSON objects — one with most fields (including
       lyrics) and a second with bpm / key_scale / duration.

    Strategy:
    - Use brace counting (not rfind) to locate the first complete object.
    - If the first object parses OK but is missing fields, look for a second
      JSON object in the trailing text and merge them.
    - If the first object has no lyrics but trailing text is present, rescue
      the trailing text as lyrics.
    """
    stripped = raw.strip()
    start, end = _find_first_json_object(stripped)
    if start == -1:
        return raw  # no JSON at all — let validation surface the error

    json_part = stripped[start:end]
    trailing = stripped[end:].strip()

    if not trailing:
        return json_part  # clean output, nothing to recover

    # Parse the first object to understand what's present
    try:
        parsed = json.loads(json_part)
    except json.JSONDecodeError:
        return raw  # malformed JSON — let validation surface the error

    # Check for a second JSON object in the trailing text (split-output pattern)
    t_start, t_end = _find_first_json_object(trailing)
    if t_start != -1:
        second_raw = trailing[t_start:t_end]
        # Also try with _fix_missing_commas applied (inline, to avoid circular dep)
        candidates = [second_raw, re.sub(r'(["\d])([ \t]*\n[ \t]*)(")', r'\1,\2\3', second_raw)]
        for candidate in candidates:
            try:
                second = json.loads(candidate)
                if isinstance(second, dict):
                    # Merge: first-object fields take priority; second fills gaps
                    merged = {**second, **parsed}
                    logger.warning(
                        "[llm] Model split output into 2 JSON objects — merged "
                        f"fields from second object: {sorted(second)}"
                    )
                    return json.dumps(merged)
            except json.JSONDecodeError:
                continue

    # No second JSON object — rescue lyrics from trailing plain text if missing
    if not parsed.get("lyrics") and trailing:
        logger.warning(
            "[llm] Model output lyrics outside JSON block — recovering into 'lyrics' field "
            f"({len(trailing)} chars of trailing text)"
        )
        parsed["lyrics"] = trailing
        return json.dumps(parsed)

    return json_part


# Pre-compile for stripping markdown code fences (```json ... ```)
_CODE_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def _strip_code_fence(raw: str) -> str:
    """Remove markdown code fences that some models wrap JSON in."""
    m = _CODE_FENCE_RE.search(raw)
    return m.group(1) if m else raw


_CTRL_ESCAPE: dict[int, str] = {
    0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0C: "\\f", 0x0D: "\\r",
}


def _fix_unescaped_quotes(s: str) -> str:
    """Escape unescaped double-quote characters inside JSON string values.

    qwen3.5 sometimes includes unescaped " in lyrics (e.g. dialogue or song
    titles with quotation marks), causing the JSON parser to exit the string
    prematurely and fail with "expected , or }".

    Heuristic: when inside a string and we encounter an unescaped ", look
    ahead to the next non-whitespace character.  If it is a valid JSON
    continuation character (, : } ]) then it is a real closing quote;
    otherwise it is an embedded quote and must be escaped.
    """
    result: list[str] = []
    i = 0
    n = len(s)
    in_string = False
    escaped = False

    while i < n:
        ch = s[i]
        if escaped:
            result.append(ch)
            escaped = False
            i += 1
            continue
        if ch == "\\" and in_string:
            result.append(ch)
            escaped = True
            i += 1
            continue
        if ch == '"':
            if not in_string:
                result.append(ch)
                in_string = True
            else:
                # Two-stage lookahead to decide: real closing quote vs embedded.
                #
                # Stage 1: skip spaces/tabs on the same line (not newlines).
                j = i + 1
                while j < n and s[j] in " \t":
                    j += 1
                next_ch = s[j] if j < n else ""

                if next_ch in ",:}]":
                    # Unambiguously a closing quote (e.g. "value", or "value"}).
                    result.append(ch)
                    in_string = False
                elif next_ch == "\n":
                    # Stage 2: the closing " is at the end of a line.
                    # Skip the newline + any indent to see what starts the next line.
                    # If it is " (next JSON key) or , } ] → real closing quote.
                    # If it is regular text → embedded quote at line end.
                    k = j + 1
                    while k < n and s[k] in " \t":
                        k += 1
                    after_nl = s[k] if k < n else ""
                    if after_nl in '",:}]':
                        result.append(ch)
                        in_string = False
                    else:
                        result.append('\\"')
                else:
                    # Followed immediately by non-whitespace text → embedded quote.
                    result.append('\\"')
            i += 1
            continue
        result.append(ch)
        i += 1

    return "".join(result)


def _fix_control_chars(s: str) -> str:
    """Replace literal control characters inside JSON string values.

    LLMs sometimes embed raw newlines / other control chars (U+0000–U+001F)
    directly in string fields instead of using JSON escape sequences, producing
    invalid JSON that json / Pydantic reject.  This walks the string with a
    minimal state machine and escapes only characters that are inside a JSON
    string value.
    """
    result: list[str] = []
    in_string = False
    escaped = False
    for ch in s:
        if escaped:
            result.append(ch)
            escaped = False
        elif ch == "\\" and in_string:
            result.append(ch)
            escaped = True
        elif ch == '"':
            result.append(ch)
            in_string = not in_string
        elif in_string and ord(ch) < 0x20:
            result.append(_CTRL_ESCAPE.get(ord(ch), f"\\u{ord(ch):04x}"))
        else:
            result.append(ch)
    return "".join(result)


def _fix_missing_commas(s: str) -> str:
    """Insert missing commas between JSON object fields.

    qwen3.5:4b sometimes omits the comma after a long string value (e.g. the
    lyrics field), producing "expected `,` or `}`" parse errors.  This runs
    after _fix_control_chars, so literal newlines inside string values have
    already been escaped to \\n — only structural newlines remain, making it
    safe to match across lines.

    Pattern: a field value ending in `"` or a digit, followed by whitespace
    containing at least one real newline, then an indented `"` opening a new
    key — with no comma in between.
    """
    return re.sub(r'(["\d])([ \t]*\n[ \t]*)(")', lambda m: m.group(1) + "," + m.group(2) + m.group(3), s)


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
- Use ACE-Step structure tags: [Intro], [Verse], [Verse 1], [Verse 2], [Pre-Chorus], [Chorus], [Bridge], [Outro], [Fade Out]
- {'Set lyrics to an empty string.' if is_instrumental else 'Include 3-5 sections. Always include at least one [Verse] and one [Chorus].'}
- {'Skip this rule.' if is_instrumental else 'You may add [Instrumental], [Guitar Solo], or [Piano Interlude] for breaks.'}
- {'Skip this rule.' if is_instrumental else 'You may combine a tag with ONE style modifier: [Chorus - anthemic], [Bridge - whispered], [Verse - spoken word]'}
- {'Skip this rule.' if is_instrumental else 'Keep lines to 6-10 syllables for natural singing rhythm.'}
- {'Skip this rule.' if is_instrumental else 'Separate sections with blank lines.'}
- {'Skip this rule.' if is_instrumental else 'Use UPPERCASE sparingly for high-intensity climax lines in choruses.'}
- {'Skip this rule.' if is_instrumental else 'Use parentheses for background vocals: "Into the light (into the light)"'}
- {'Skip this rule.' if is_instrumental else 'Stick to one core metaphor per song for lyrical cohesion.'}
- {'Skip this rule.' if is_instrumental else 'Lyrics should be creative and evocative, not generic or clichéd. Avoid adjective stacking and mixed metaphors.'}
- {'The last section tag must always be [Fade Out] as a standalone tag with no lyrics under it — this signals ACE-Step to end the track with a natural fade.' if is_instrumental else 'The last section must always be [Fade Out]. It may contain a short repeating hook, ad-libs, or humming that fades out — or leave it as a standalone tag for a pure instrumental fade.'}

METADATA RULES:
- BPM range: 30–300. Match the genre naturally (slow 60–80, mid-tempo 90–120, fast 130–180+)
- BPM and duration must be whole integers — no decimal points (e.g. 120, not 120.5)
- Duration should be around {target_duration} seconds — it is fine if the actual audio runs slightly shorter or longer to allow a natural ending

OUTPUT RULES:
- Output ONLY a single JSON object. Do NOT write anything outside the JSON — no prose, no markdown, no code fences.
- Put the lyrics INSIDE the JSON as the value of the "lyrics" field. Do NOT write lyrics after the closing brace.
- Include ALL required fields: song_title, style, instruments, mood, vocal_style, production, lyrics, bpm, key_scale, duration.
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
            cleaned = _strip_code_fence(raw)
            cleaned = _extract_song_prompt_json(cleaned)
            cleaned = _fix_unescaped_quotes(cleaned)
            cleaned = _fix_control_chars(cleaned)
            cleaned = _fix_missing_commas(cleaned)
            prompt = SongPrompt.model_validate_json(cleaned)
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
