# Plain-Text LLM Output Architecture

## Problem

`qwen3.5:4b` does not reliably output valid JSON even when Ollama's `format=` structured-output
constraint is applied. Over time, six distinct failure modes were discovered and patched with a
5-stage JSON repair pipeline (~230 lines in `backend/llm.py`). New failure modes kept appearing,
and the repair functions interacted with each other in ways that introduced new bugs.

**Root cause:** JSON requires meticulous escaping of quotes, commas, and control characters —
especially inside multi-line lyrics. Plain labeled text eliminates all of these requirements
while conveying identical information.

---

## Solution: Labeled Plain-Text Format

The LLM is asked to output a fixed labeled format instead of JSON:

```
TITLE: Magnetic Tides
STYLE: indie pop, atmospheric
INSTRUMENTS: electric guitar, synthesizer, soft drums
MOOD: melancholic, dreamy, introspective
VOCAL_STYLE: female vocal, breathy, ethereal
PRODUCTION: lo-fi, reverb-heavy, bedroom pop
BPM: 85
KEY: A Minor
DURATION: 60

LYRICS:
[Verse 1]
Walking on the shoreline
...
[Fade Out]
```

`LYRICS:` is a hard separator — everything after it is lyrics verbatim. Raw quotes, apostrophes,
colons, and newlines inside lyrics require no escaping whatsoever.

---

## Implementation

### Only file changed: `backend/llm.py`

#### Removed (JSON repair pipeline)

| Function | Purpose |
|---|---|
| `_find_first_json_object()` | Brace-counting state machine |
| `_extract_song_prompt_json()` | Merge split JSON objects; rescue trailing lyrics |
| `_strip_code_fence()` | Remove ` ```json ``` ` wrappers |
| `_fix_unescaped_quotes()` | 3-stage lookahead heuristic |
| `_fix_control_chars()` | Escape literal control chars inside strings |
| `_fix_missing_commas()` | Insert missing commas between fields |

Also removed: `import json`, `format=SongPrompt.model_json_schema()` from `chat()` call.

#### Added: `_parse_labeled_text(raw: str) -> SongPrompt`

```
Step 1  Strip markdown code fences (re.sub)
Step 2  Skip thinking preamble → scan to first ^TITLE: line
Step 3  Split on LYRICS: separator → header_block + lyrics_text
Step 4  Parse header with ^([A-Z][A-Z_0-9]*)\s*:\s*(.*) regex → dict
Step 5  Map labels → SongPrompt fields; int(float(v)) for BPM/DURATION
Step 6  return SongPrompt(**kwargs)  ← Pydantic validators run here
```

Label → field mapping:

| Label | SongPrompt field |
|---|---|
| TITLE | song_title |
| STYLE | style |
| INSTRUMENTS | instruments |
| MOOD | mood |
| VOCAL_STYLE | vocal_style |
| PRODUCTION | production |
| BPM | bpm |
| KEY | key_scale |
| DURATION | duration |

Missing labels use SongPrompt Pydantic defaults. Missing `song_title` (required, no default)
raises `ValidationError`, which surfaces as a parse error with the raw LLM output logged.

#### Unchanged

- `SongPrompt` model and all validators (`coerce_numeric_to_int`, `ensure_fade_out`, `clamp_duration`)
- `OllamaClient.__init__`, `generate_prompt()` method signature, all logging
- `think=False` in `chat()` call

---

## Complexity Reduction

| Metric | Before | After |
|---|---|---|
| Repair functions | 6 | 0 |
| Lines of repair code | ~230 | 0 |
| Lines of parser | 0 | ~50 |
| Net reduction | — | ~180 lines |
| Parse stages | 5 chained transforms | 1 function |
| Failure modes | Unbounded (new patterns kept appearing) | Structurally bounded |

---

## Risk Analysis

| Risk | Mitigation |
|---|---|
| LLM outputs JSON anyway | `song_title` required → Pydantic raises; raw output logged |
| BPM/DURATION non-numeric (e.g. "allegro") | `int(float(v))` raises → warning logged, Pydantic default used |
| `LYRICS:` label missing | Warning logged, empty lyrics used; `ensure_fade_out` adds [Fade Out] |
| Thinking preamble before TITLE: | `start_idx` scan skips forward to first `TITLE:` line |
| Label-like text inside lyrics (e.g. `KEY: of my heart`) | Header regex only runs on `header_block` (before LYRICS: split) |
| Extra unknown labels in header (e.g. `TEMPO:`) | Silently ignored — not in KEY_MAP |
