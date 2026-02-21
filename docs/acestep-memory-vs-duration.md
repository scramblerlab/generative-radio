# ACE-Step 1.5 — Memory vs. Audio Duration on Apple Silicon

> Research date: 2026-02-21
> Relevant files: `backend/models.py`, `backend/config.py`, `BUILD_SPEC.md`

---

## Background

The current codebase hard-caps song duration at **60 seconds** (`MAX_DURATION_S = 60` in `models.py`).
The cap exists because the ACE-Step MLX VAE requires a **single contiguous Metal buffer**, and on M3-class chips that buffer maxes out at ~14.3 GB — which is exceeded by a 90-second song.

The goal of this research is to determine how duration limits should scale with available memory so that longer songs can be unlocked on higher-memory machines.

---

## Hard Data Points (from BUILD_SPEC.md)

| Duration | MLX VAE Metal buffer | M3 (14.3 GB limit) |
|----------|---------------------|---------------------|
| 60 s | **9.7 GB** | ✅ Fits |
| 90 s | **15.6 GB** | ❌ Fails → PyTorch MPS fallback (+~25 s penalty) |

---

## Derived Linear Formula

From the two documented data points:

```
rate = (15.6 - 9.7) GB / (90 - 60) s ≈ 0.197 GB/s
```

Extrapolated memory requirements:

| Duration | Est. Metal buffer needed |
|----------|--------------------------|
| 30 s | ~3.8 GB |
| 60 s | **9.7 GB** (documented) |
| 75 s | ~12.6 GB |
| 80 s | ~13.6 GB |
| 83 s | ~14.3 GB ← M3 breakeven |
| 90 s | **15.6 GB** (documented) |
| 120 s | ~21.5 GB |
| 180 s | ~33.3 GB |
| 240 s | ~45.2 GB |

Formula: `memory_GB(t) = 9.7 + (t − 60) × 0.197`

---

## Critical Distinction: Contiguous Metal Buffer ≠ Total RAM

The MLX VAE requires a **single contiguous Metal buffer**, not just free RAM.
The OS caps the maximum contiguous Metal allocation at roughly **60–70% of installed RAM** under normal system load.

Estimated safe duration limits by machine:

| Machine | RAM | Est. max contiguous Metal | Est. max safe duration |
|---------|-----|---------------------------|------------------------|
| MacBook Air M3 | 16 GB | ~9–10 GB | ≈ 60 s (already at edge) |
| Mac mini M4 / MacBook Pro M3 | 24 GB | ~14–16 GB | ≈ 80–83 s |
| Mac mini M4 Pro / MacBook Pro M4 Pro | 24 GB | ~16–18 GB | ≈ 90–95 s |
| Mac mini M4 Pro / MacBook Pro M4 Max | 48 GB | ~28–35 GB | ≈ 150–185 s |
| Mac mini (production target, 64 GB) | 64 GB | ~40–45 GB | ≈ 220–250 s |

> ⚠️ These are estimates. Empirical measurement on the target hardware is needed to confirm exact limits.

---

## ACE-Step Official GPU Tier Table (CUDA-centric, for context)

From `docs/en/GPU_COMPATIBILITY.md` in the ACE-Step repo:

| VRAM | Tier | Max duration (w/ LM / w/o LM) |
|------|------|-------------------------------|
| ≤4 GB | 1 | 4 min / 6 min |
| 4–6 GB | 2 | 8 min / 10 min |
| 6–8 GB | 3 | 8 min / 10 min |
| 8–12 GB | 4 | 8 min / 10 min |
| 12–16 GB | 5 | 8 min / 10 min |
| 16–24 GB | 6a/6b | 8–10 min / 8–10 min |
| ≥24 GB | Unlimited | 10 min / 10 min |

**Important:** These tiers target discrete NVIDIA/AMD GPUs. On CUDA, even 4 GB VRAM is sufficient for 4+ minute songs because CUDA uses **tiled VAE decoding**. The Apple Silicon contiguous-buffer constraint does **not** apply to CUDA.

---

## Key Uncertainty: Tiled MLX VAE

ACE-Step PR #459 introduced **native MLX VAE acceleration** for Apple Silicon, and the project documentation references "tiled encoding/decoding for memory efficiency." If the current MLX VAE path uses tiling:

- The contiguous Metal buffer constraint may be **relaxed or removed**
- The 9.7 GB / 15.6 GB data points in BUILD_SPEC.md may reflect an **older version** of ACE-Step
- Empirical testing on the target machine is the only reliable way to determine current actual limits

---

## Recommended Implementation Approach

Use the existing `get_unified_memory_gb()` function in `config.py` to set a tiered `MAX_DURATION_S` at startup:

| Unified memory | Conservative max duration | Rationale |
|----------------|--------------------------|-----------|
| < 24 GB | 60 s | Stay within documented safe range |
| 24–35 GB | 90 s | Margin for 24 GB machines (est. ~14–16 GB Metal buffer) |
| 36–47 GB | 120 s | ~28–32 GB Metal buffer headroom |
| ≥ 48 GB | 180 s | ~35–45 GB Metal buffer, well within range |

Apply a safety margin of ~10–15% below estimated Metal buffer limits to account for OS overhead and other running services (Ollama, FastAPI, browser).

The LLM system prompt and the `SongPrompt.clamp_duration` field validator in `models.py` both need to be updated to respect the dynamically-selected cap.

---

## Sources

- [ACE-Step GPU Compatibility Guide (Japanese)](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/ja/GPU_COMPATIBILITY.md)
- [ACE-Step DeepWiki — Inference Backends](https://deepwiki.com/ace-step/ACE-Step-1.5/3.5-inference-backends)
- [ACE-Step 1.5 in ComfyUI (duration recommendations)](https://blog.comfy.org/p/ace-step-15-is-now-available-in-comfyui)
- Project internal: `BUILD_SPEC.md` §12 Memory Considerations
- Project internal: `backend/models.py` `MAX_DURATION_S` and `clamp_duration` validator
