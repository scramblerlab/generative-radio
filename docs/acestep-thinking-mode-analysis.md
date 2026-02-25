# ACE-Step Thinking Mode Analysis

> **Date:** 2026-02-25
> **Status:** Resolved -- code updated
> **Reference:** [ACE-Step 1.5 Tutorial](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/Tutorial.md), ACE-Step source (`acestep/inference.py`, `acestep/llm_inference.py`, `acestep/audio_codes.py`)

---

## Question

Should we keep `thinking: true` in the ACE-Step API call, given that our Ollama LLM (`qwen3:8b`) already generates the full song prompt -- style tags, lyrics, BPM, key, duration, and vocal language?

## Finding: The 5Hz LM Does Two Distinct Things

When `thinking=True`, ACE-Step's internal 5Hz Language Model runs a **two-phase** pipeline:

### Phase 1 -- Chain-of-Thought (CoT) Metadata

- Infers and/or rewrites BPM, caption, duration, key, language, time signature
- Controlled independently by `use_cot_metas`, `use_cot_caption`, `use_cot_language`
- **This overlaps with our Ollama LLM** and can conflict with our carefully crafted inputs

### Phase 2 -- Semantic Audio Codes

- Generates tokens like `<|audio_code_123|><|audio_code_456|>...` at 5 Hz (5 codes per second)
- These encode **melody, chord progressions, orchestration, and timbre structure** -- information that text descriptions fundamentally cannot capture
- These codes are parsed, converted through a quantizer and detokenizer into **25 Hz latent hints**, and fed directly to DiT as conditioning
- **This is the unique, irreplaceable value of thinking mode.** Our Ollama LLM cannot produce these codes -- only ACE-Step's 5Hz LM can.

### Code path (from ACE-Step source)

```python
# inference.py
infer_type = "llm_dit" if need_audio_codes and params.thinking else "dit"
```

- `thinking=True` + `need_audio_codes=True` --> `infer_type = "llm_dit"` --> LM runs Phase 1 + Phase 2
- `thinking=False` --> `infer_type = "dit"` --> DiT receives text conditioning only (no semantic codes)

Semantic codes are only generated when `thinking=True`. Disabling it means DiT must infer all musical structure from text alone.

## Configuration Comparison

| Setting | Phase 1 (CoT) | Phase 2 (Codes) | DiT receives | Quality |
|---|---|---|---|---|
| `thinking=True`, all CoT on (old default) | Rewrites caption, re-infers metadata | Generates melody/structure codes | Semantic codes + rewritten caption | Best quality, but may override our inputs |
| `thinking=True`, CoT off (new) | Skipped | Generates melody/structure codes | Semantic codes + our original caption | Best quality, our inputs preserved |
| `thinking=False` | Skipped | Skipped | Text only, no codes | Reduced quality |

## Recommendation (Implemented)

Keep `thinking=True` for semantic code generation. Disable all three CoT sub-features to prevent ACE-Step's LM from overriding our inputs:

```python
payload = {
    "thinking": True,           # Keep -- generates semantic audio codes for DiT
    "use_cot_caption": False,   # Disable -- don't rewrite our dimension-based caption
    "use_cot_metas": False,     # Disable -- don't override our BPM/key/duration
    "use_cot_language": False,  # Disable -- don't re-detect language, we provide it
}
```

### Why this is optimal

1. **Semantic codes preserved** -- melody, chords, and orchestration are encoded as latent hints for DiT, producing higher quality audio than text-only conditioning
2. **Caption preserved** -- our carefully crafted dimension-based captions (style, instruments, mood, vocal_style, production) are passed through to DiT unchanged
3. **Metadata preserved** -- BPM, key, and duration from our Ollama LLM are respected exactly as provided
4. **Language preserved** -- the vocal language selected by the user is used directly
5. **Slightly faster** -- skipping Phase 1 CoT saves a few seconds of LM inference time

### What would happen if we disabled thinking entirely

Setting `thinking=False` would skip the LM completely. DiT would receive only text conditioning (caption + lyrics + metadata). Based on the ACE-Step tutorial: *"If you're very clear about what you want, or already have a clear planning goal -- you can completely skip the LM planning step."* However, the loss of semantic codes means DiT must infer melody and orchestration entirely from text, which reduces structural coherence and overall quality. This is not recommended for a radio app where every track needs to sound polished.
