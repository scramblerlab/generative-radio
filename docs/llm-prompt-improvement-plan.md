# LLM Song Prompt Improvement Proposal

> **Date:** 2026-02-25
> **Status:** Draft — pending review
> **Reference:** [ACE-Step 1.5 Tutorial — Caption Writing](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/Tutorial.md), [Ambience AI Prompting Guide](https://www.ambienceai.com/tutorials/ace-step-music-prompting-guide)

---

## Problem Analysis

### Current LLM prompt instruction for caption/tags

From `backend/llm.py`, the only guidance the LLM receives for the `tags` field is:

```
The "tags" field must be a comma-separated list of musical style descriptors
that ACE-Step understands: sub-genre, instruments, mood, tempo feel, vocal style,
production style, etc.
```

This is vague. The LLM often produces tags like `"indie rock, dreamy, guitar, chill vibes"` — which covers only 1-3 of the 9 dimensions that ACE-Step can interpret. The tutorial states: *"Single-dimension descriptions give the model too much room to play; combining style+emotion+instruments+timbre can more precisely anchor your desired direction."*

### Current lyrics instruction

```
Write 2-4 lyric sections using [verse], [chorus], [bridge] markers
```

This teaches the LLM only 3 of the 15+ structure tags that ACE-Step supports. Missing tags include `[Intro]`, `[Pre-Chorus]`, `[Outro]`, `[Build]`, `[Drop]`, `[Breakdown]`, `[Instrumental]`, `[Guitar Solo]`, `[Fade Out]`, and combined tags like `[Chorus - anthemic]`. The LLM also receives no guidance on lyric formatting best practices (syllable count, intensity via case, background vocals via parentheses).

### What the ACE-Step Tutorial recommends

The tutorial identifies **9 caption dimensions**:

| Dimension | Examples | Currently generated? |
|---|---|---|
| Style/Genre | indie folk, 80s synth-pop, jazz ballad | Sometimes |
| Emotion/Atmosphere | melancholic, uplifting, dreamy, dark | Sometimes |
| Instruments | acoustic guitar, piano, synth pads, 808 drums | Rarely specific |
| Timbre Texture | warm, bright, crisp, airy, punchy, lush, raw | Almost never |
| Era Reference | 80s synth-pop, 90s grunge, vintage soul | Rarely |
| Production Style | lo-fi, studio-polished, live recording, bedroom pop | Rarely |
| Vocal Characteristics | female vocal, breathy, powerful, raspy, choir | Rarely specific |
| Speed/Rhythm | slow tempo, groovy, driving, laid-back | Rarely (BPM is separate) |
| Structure Hints | building intro, catchy chorus, dramatic bridge | Never |

Key principles from the tutorial:
- *"Specific beats vague"* — `"sad piano ballad with female breathy vocal"` >> `"a sad song"`
- *"Texture words are useful"* — warm, crisp, airy, punchy strongly influence ACE-Step's mixing
- *"Avoid conflicting words"* — don't combine "ambient" + "aggressive"
- *"Don't write BPM/key/duration in caption"* — those should be separate metadata parameters
- *"Maintain consistency between Caption and Lyrics"* — instruments in caption must match instrumental section tags in lyrics; mood in caption must match energy tags in lyrics

---

## Proposal: Two-Part Improvement

### Part 1: Dimension-Based Caption Generation

**Strategy:** Replace the single `tags: str` field in `SongPrompt` with 5 dimension-specific fields. The LLM generates each dimension separately (forcing coverage across all 9 ACE-Step dimensions), and they are concatenated into a single caption string before sending to ACE-Step.

#### New SongPrompt schema

**Current** (1 caption field):

```python
class SongPrompt(BaseModel):
    song_title: str
    tags: str           # "Comma-separated music style tags for ACE-Step"
    lyrics: str
    bpm: int
    key_scale: str
    duration: int
```

**Proposed** (5 dimension fields replacing `tags`):

```python
class SongPrompt(BaseModel):
    song_title: str
    style: str          # Genre, sub-genre, era reference
    instruments: str    # Key instruments featured
    mood: str           # Emotion, atmosphere, timbre texture
    vocal_style: str    # Vocal gender, timbre, technique (empty for instrumental)
    production: str     # Production style, rhythm feel, structure hints
    lyrics: str
    bpm: int
    key_scale: str
    duration: int
```

Why 5 fields instead of 9: to keep token count manageable for `qwen3:8b`. Related dimensions are grouped where they naturally overlap:

| New Field | ACE-Step Dimensions Covered |
|---|---|
| `style` | Style/Genre + Era Reference |
| `instruments` | Instruments |
| `mood` | Emotion/Atmosphere + Timbre Texture |
| `vocal_style` | Vocal Characteristics |
| `production` | Production Style + Speed/Rhythm + Structure Hints |

#### Example output

For a Jazz + Chill + English session, the LLM would produce:

```json
{
  "song_title": "Midnight Boulevard",
  "style": "smooth jazz, bebop influences, late-night club",
  "instruments": "mellow saxophone, soft piano, upright bass, brushed drums",
  "mood": "warm, intimate, nostalgic, smoky, lush",
  "vocal_style": "male vocal, deep, smooth, crooner style",
  "production": "live recording feel, spacious reverb, laid-back groove, building bridge",
  "lyrics": "[Intro - piano]\n\n[Verse 1]\nMoonlight...",
  "bpm": 85,
  "key_scale": "Bb Major",
  "duration": 60
}
```

Compare with what the current single `tags` field typically produces:

```json
{
  "tags": "smooth jazz, mellow saxophone, soft piano, chill vibes, nightclub atmosphere"
}
```

The dimension-based version covers instruments, timbre texture (warm, smoky, lush), vocal characteristics (deep, smooth, crooner), production style (live recording, spacious reverb), and structure hints (building bridge) — all of which are missing from the current output.

#### Concatenation into ACE-Step caption

In `acestep_client.py`, the 5 fields are joined into a single caption:

```python
caption = ", ".join(filter(None, [
    prompt.style,
    prompt.instruments,
    prompt.mood,
    prompt.vocal_style,
    prompt.production,
]))
```

Result: `"smooth jazz, bebop influences, late-night club, mellow saxophone, soft piano, upright bass, brushed drums, warm, intimate, nostalgic, smoky, lush, male vocal, deep, smooth, crooner style, live recording feel, spacious reverb, laid-back groove, building bridge"`

This aligns with the [Ambience AI guide](https://www.ambienceai.com/tutorials/ace-step-music-prompting-guide)'s recommendation of 3-7+ rich, multi-dimensional tags.

#### LLM system prompt — dimension guidance

The rules section in `llm.py` changes from one vague line to explicit dimension instructions with examples:

```
CAPTION DIMENSIONS — generate each field with comma-separated descriptors:

- "style": Genre and sub-genre, optional era reference.
  Good: "smooth jazz, bebop influences", "80s synth-pop, retro", "indie folk, acoustic, Americana"
  Bad: "jazz" (too vague), "sad song" (mood, not style)

- "instruments": Key instruments that should be prominent in the track.
  Good: "acoustic guitar, piano, soft strings", "synth bass, 808 drums, synth pads, electric guitar"
  Bad: "instruments" (not specific), "music" (meaningless)

- "mood": Emotion, atmosphere, and timbre texture adjectives.
  Good: "warm, nostalgic, intimate, airy", "dark, brooding, raw, punchy"
  Texture words that strongly influence output: warm, bright, crisp, airy, punchy, lush, raw, polished, muddy

- "vocal_style": Vocal gender, timbre, and technique. Empty string for instrumental tracks.
  Good: "female vocal, breathy, soft, delicate", "male vocal, raspy, powerful belting"
  Bad: "singing" (too vague), "good vocals" (meaningless)

- "production": Production style, rhythm feel, and structure hints.
  Good: "lo-fi, bedroom pop, laid-back groove, building chorus", "studio-polished, driving beat, fade-out ending"
  Bad: "normal production" (too vague)

IMPORTANT:
- Do NOT put BPM, key, or duration in any caption field — those have their own parameters.
- Avoid conflicting descriptors within a field (e.g., "ambient" + "aggressive" in mood).
- The mood and vocal_style MUST be consistent with the lyrics you write.
```

#### Backward compatibility

- `TrackInfo` (sent to frontend) keeps a single `tags` field — populated by joining the 5 dimensions with `, `
- The frontend display can remain unchanged, or optionally be enhanced to show dimensions in separate labeled lines

---

### Part 2: Enriched Lyrics with ACE-Step Structure Tags

#### Full structure tag vocabulary to teach the LLM

**Basic structure:**

| Tag | Purpose |
|---|---|
| `[Intro]` | Opening — establish atmosphere |
| `[Verse]` / `[Verse 1]` | Narrative progression |
| `[Pre-Chorus]` | Build energy before chorus |
| `[Chorus]` | Emotional climax, hook |
| `[Bridge]` | Transition or elevation |
| `[Outro]` | Ending, conclusion |

**Dynamic sections:**

| Tag | Purpose |
|---|---|
| `[Build]` | Energy gradually rising |
| `[Drop]` | Energy release (electronic genres) |
| `[Breakdown]` | Reduced instrumentation, space |

**Instrumental sections:**

| Tag | Purpose |
|---|---|
| `[Instrumental]` | Pure instrumental, no vocals |
| `[Guitar Solo]` | Guitar solo section |
| `[Piano Interlude]` | Piano interlude |

**Special:**

| Tag | Purpose |
|---|---|
| `[Fade Out]` | Gradual fade to silence |

**Combined tags** — one modifier per tag:

```
[Chorus - anthemic]
[Bridge - whispered]
[Verse - spoken word]
[Intro - ambient]
[Outro - fade out]
```

#### Lyrics formatting best practices

From the ACE-Step tutorial:

| Technique | Example | Effect |
|---|---|---|
| 6-10 syllables per line | `Moonlight falls on city streets` (7) | Natural singing rhythm |
| Blank lines between sections | `[Verse 1]\n...\n\n[Chorus]\n...` | Clear section boundaries |
| UPPERCASE for intensity | `WE ARE THE CHAMPIONS!` | Louder, more powerful delivery |
| Parentheses for backing vocals | `We rise together (together)` | Background vocal harmonies |
| One core metaphor per song | Water imagery throughout | Lyrical cohesion |
| Combined tag modifiers | `[Chorus - anthemic]` | Performance style hint |

#### Updated lyrics rules for the LLM system prompt

```
LYRICS RULES:
- Structure: Use tags from this set:
  [Intro], [Verse], [Verse 1], [Verse 2], [Pre-Chorus], [Chorus], [Bridge], [Outro],
  [Instrumental], [Guitar Solo], [Piano Interlude], [Build], [Drop], [Breakdown], [Fade Out]
- Include 3-5 sections. Always include at least one [Verse] and one [Chorus].
- You may combine a tag with ONE style modifier: [Chorus - anthemic], [Bridge - whispered]
  Do NOT stack multiple modifiers.
- Keep lines to 6-10 syllables for natural singing rhythm. Avoid very long lines.
- Separate each section with a blank line.
- Use UPPERCASE sparingly for high-intensity climax lines in choruses.
- Use parentheses for background vocals: "Into the light (into the light)"
- Stick to one core metaphor per song — explore it from multiple angles rather than mixing unrelated imagery.
- CONSISTENCY: Lyrics must match the mood and vocal_style fields.
  Gentle breathy vocal → tender lyrics. Powerful belting → anthemic, intense lyrics.
  Instruments in the "instruments" field → matching instrumental section tags in lyrics.
```

---

## Impact Assessment

| Aspect | Current | After |
|---|---|---|
| Caption dimensions covered | 1-3 (depends on LLM output) | 5+ (guaranteed by schema) |
| Lyrics structure variety | 3 tags (verse/chorus/bridge) | 15+ tags with modifiers |
| Caption-lyrics consistency | Not enforced | Explicitly enforced in prompt |
| Texture/timbre words | Rarely generated | Directly prompted with examples |
| Vocal style specificity | Rarely specified | Dedicated field with examples |
| Production style | Almost never specified | Dedicated field with examples |
| Era references | Rarely generated | Part of style field guidance |
| Token cost per LLM call | ~200 output tokens | ~300 output tokens (~50% increase) |
| LLM latency impact | Baseline | ~0.5-1s increase (more output tokens) |
| ACE-Step caption quality | Underspecified | Multi-dimensional, tutorial-aligned |

---

## Files Changed

| File | Change |
|---|---|
| `backend/models.py` | Replace `tags: str` with 5 dimension fields (`style`, `instruments`, `mood`, `vocal_style`, `production`) in `SongPrompt` |
| `backend/llm.py` | Rewrite system prompt with dimension-specific guidance, examples, and enriched lyrics rules |
| `backend/acestep_client.py` | Concatenate 5 dimension fields into single caption for ACE-Step `prompt` payload |
| `backend/radio.py` | Update `TrackInfo` construction — join dimensions into a single `tags` string for the frontend |
| `backend/main.py` | Update `/api/radio/status` track serialization to use joined tags |
| `frontend/src/types.ts` | Optionally add dimension fields to `Track` interface for richer display |
| `frontend/src/components/RadioPlayer.tsx` | Optionally display dimensions as labeled lines instead of a single tags line |

---

## Migration Notes

- **No breaking API changes.** The `TrackInfo` sent to the frontend still has a single `tags` field (joined from dimensions). The frontend works unchanged.
- **Optional frontend enhancement:** If dimensions are exposed separately in `TrackInfo`, the player could show them as:
  ```
  Style: smooth jazz, bebop influences
  Instruments: mellow saxophone, soft piano, upright bass
  Mood: warm, intimate, nostalgic
  ```
  instead of the current single-line tag dump.
- **LLM latency:** ~0.5-1s increase due to more output tokens. Acceptable given the quality improvement.
- **Instrumental tracks:** `vocal_style` is set to empty string `""`. The concatenation filter skips it automatically.
