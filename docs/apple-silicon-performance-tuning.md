# Apple Silicon Performance Tuning — ACE-Step + Ollama

> Research date: 2026-03-25
> Tested on: MacBook Air (baseline + Phase B). Mac Mini M4 Pro 64GB retest pending.
> Relevant files: `scripts/start.sh`, `scripts/start_prod.sh`, `backend/acestep_client.py`

---

## Background

Generation of a 180s track on Mac Mini M4 Pro 64GB was taking ~120s end-to-end. Goal: reduce latency without changing any quality parameters (inference steps, thinking flags, model variant, etc.).

The investigation identified three untapped Apple Silicon-specific optimizations, all applied as environment variable additions to the startup scripts — no Python code or model config changes.

---

## Stack

| Component | Details |
|---|---|
| Audio generation | ACE-Step 1.5 (MLX backend, turbo model, 8 inference steps) |
| LLM | Qwen3.5:4b via Ollama |
| Hardware tested | MacBook Air (16–24GB unified memory, 30s tracks) |
| Hardware target | Mac Mini M4 Pro 64GB (180s tracks) |

---

## How to Measure (Test Methodology)

These commands produce the timing numbers used in this document. Run them after generating 3–4 tracks.

```bash
# LLM time per track + ACE-Step client-side breakdown
grep -E "LLM done|PERF" /tmp/generative-radio-backend.log

# ACE-Step server-side DiT and VAE times
grep -iE "dit|vae|stat|elapsed|seconds" /tmp/generative-radio-acestep.log
```

**Reading the output:**

- `LLM done in Xs` → Ollama inference time (radio.py)
- `PERF ... generation(DiT+VAE)=Xs` → full ACE-Step generation time from client perspective
- `time_costs: {'diffusion_time_cost': X, 'offload_time_cost': X}` → DiT-only time + CPU offload overhead (ACE-Step server)
- `[MLX-VAE] Decoded ... in Xs (dtype=...)` → VAE decode time and active dtype
- `[MLX-DiT] ... (mx.compile=True/False)` → confirms whether DiT compilation is active

**Important: discard T1 (first generation after restart).** `ACESTEP_COMPILE_MODEL=1` causes DiT JIT compilation on the first run. T2 onward reflects steady-state performance.

**Comparable run:** generate 4 consecutive tracks with no long idle gaps between them (< ~60s between tracks). Long gaps may allow Metal kernel cache to be partially evicted, causing T4+ to look more like T1.

---

## Phase A — Debug Logging Added

Before measuring, the following instrumentation was added:

**`backend/acestep_client.py`** — `generate_song` now times each stage:
- `submit`: HTTP POST to `/release_task` (usually ~0s)
- `generation(DiT+VAE)`: from submission to task completion (the main number)
- `download`: audio file retrieval (usually ~0s)
- Emits a `PERF` summary line per track

**`scripts/start.sh` + `scripts/start_prod.sh`** — added `ACESTEP_DEBUG_STATS=1` to ACE-Step launch, which enables server-side DiT and VAE timing in the ACE-Step log.

---

## Baseline — MacBook Air, 30s tracks (before Phase B)

ACE-Step init at baseline:
```
[MLX-DiT] Native MLX DiT decoder initialized successfully (mx.compile=False).
[MLX-VAE] Decode/encode compiled with mx.compile().
[MLX-VAE] Native MLX VAE initialized (dtype=mlx.core.float32, compiled=True).
```

| Stage | T1 'Tidal Guitar Sun' | T2 'Velvet Strings' | T3 'Dusk and Dust' | **Avg** |
|---|---|---|---|---|
| Ollama LLM | 33.0s | 31.2s | 36.5s | **33.6s** |
| ACE-Step LM Phase 1 (CoT metadata) | 8.7s | 19.4s | 18.7s | 15.6s |
| ACE-Step LM Phase 2 (audio codes) | 14.0s | 14.4s | 14.2s | 14.2s |
| Prompt embedding | ~10.6s | ~7.8s | ~7.3s | ~8.6s |
| **DiT diffusion** | **28.1s** | **15.1s** | **24.3s** | **22.5s** |
| CPU offload overhead | 12.2s | 8.3s | 8.2s | 9.6s |
| **VAE decode** | **5.8s** | **5.5s** | **6.1s** | **5.8s** |
| **ACE-Step client total** | **84.2s** | **74.1s** | **84.4s** | **80.9s** |
| **Wall time (LLM + ACE-Step)** | **~117s** | **~105s** | **~121s** | **~115s** |

**Key finding:** DiT was running without `mx.compile` (the MLX JIT compiler) despite VAE already using it. This was the largest untapped gain.

---

## Phase B — Optimizations Applied

All changes are environment variable additions to the ACE-Step and Ollama launch lines in `scripts/start.sh` and `scripts/start_prod.sh`. No Python code or model parameters changed.

### Changes

**Ollama (`start.sh` line 29, `start_prod.sh` line 61):**
```bash
# Before:
ollama serve > /tmp/generative-radio-ollama.log 2>&1 &

# After:
OLLAMA_FLASH_ATTENTION=1 ollama serve > /tmp/generative-radio-ollama.log 2>&1 &
```

**ACE-Step launch block (both scripts):**
```bash
# Before:
ACESTEP_LM_BACKEND=mlx \
ACESTEP_DEBUG_STATS=1 \
TOKENIZERS_PARALLELISM=false \
  uv run acestep-api --host 127.0.0.1 --port 8001 \

# After:
ACESTEP_LM_BACKEND=mlx \
ACESTEP_COMPILE_MODEL=1 \
ACESTEP_MLX_VAE_FP16=1 \
MLX_METAL_JIT=1 \
ACESTEP_DEBUG_STATS=1 \
TOKENIZERS_PARALLELISM=false \
  uv run acestep-api --host 127.0.0.1 --port 8001 \
```

### What each flag does

| Flag | What it does | Expected gain |
|---|---|---|
| `ACESTEP_COMPILE_MODEL=1` | Enables `mx.compile=True` for the MLX DiT. Fuses kernel launches, reduces memory bandwidth. First generation after restart is slower (JIT compilation). | **DiT: ~25–30% faster from T2 onward** |
| `ACESTEP_MLX_VAE_FP16=1` | VAE decoder weights converted to float16 (was float32). Apple Silicon Metal handles FP16 natively at ~2× throughput. Affects every generation. | **VAE: ~30–35% faster, consistent** |
| `OLLAMA_FLASH_ATTENTION=1` | Metal-optimized Flash Attention kernels for Qwen3.5:4b. Reduces attention memory bandwidth. | **LLM: ~5–15% faster** (hard to isolate due to natural variance) |
| `MLX_METAL_JIT=1` | Enables MLX Metal JIT kernel compilation caching. | Minor (VAE already compiled; marginal for DiT alongside `COMPILE_MODEL`) |

---

## Phase B Results — MacBook Air, 30s tracks

ACE-Step init confirms both active:
```
[MLX-DiT] Native MLX DiT decoder initialized successfully (mx.compile=True).   ← was False ✓
[MLX-VAE] Model weights converted to float16.                                   ← new ✓
[MLX-VAE] Native MLX VAE initialized (dtype=mlx.core.float16, compiled=True).  ← was float32 ✓
```

| Stage | T1 warmup | T2 'Neon Grief Waltz' | T3 'Dust & Old Strings' | T4 'The Golden Horizon' | **Avg T2–T4** |
|---|---|---|---|---|---|
| Ollama LLM | 39.7s | 28.6s | 29.1s | 36.3s | **31.3s** |
| ACE-Step LM Phase 1 | 9.5s | 14.8s | 13.0s | 15.6s | 14.5s |
| ACE-Step LM Phase 2 | 14.3s | 14.1s | 13.8s | 14.2s | 14.0s |
| Prompt embedding | ~10.3s | ~8.0s | ~9.5s | ~6.1s | ~7.9s |
| **DiT diffusion** | **27.8s** | **14.1s** | **13.3s** | **20.8s** | **16.1s** |
| CPU offload overhead | 12.0s | 8.4s | 9.4s | 7.2s | 8.3s |
| **VAE decode** | **4.0s** | **3.5s** | **3.8s** | **4.2s** | **3.8s** |
| **ACE-Step client total** | **78.5s** | **66.1s** | **62.1s** | **72.2s** | **66.8s** |
| **Wall time total** | **~118s** | **~95s** | **~91s** | **~109s** | **~98s** |

---

## Baseline vs Phase B — MacBook Air, 30s tracks

| Stage | Baseline avg | Phase B avg (T2–T4) | Delta | % |
|---|---|---|---|---|
| Ollama LLM | 33.6s | 31.3s | -2.3s | -7% |
| DiT diffusion | 22.5s | 16.1s | **-6.4s** | **-28%** |
| VAE decode | 5.8s | 3.8s | **-2.0s** | **-33%** |
| ACE-Step total | 80.9s | 66.8s | **-14.1s** | **-17%** |
| **Wall time total** | **~115s** | **~98s** | **-17s** | **-15%** |

### Observations

- **T1 warmup is intentionally slow.** `mx.compile=True` triggers DiT JIT kernel compilation on the first generation after a restart. Time is similar to baseline. From T2 onward, kernels are cached for the session.
- **DiT improvement is non-linear.** T2 (14.1s) and T3 (13.3s) show the full benefit. T4 (20.8s) is higher — a 38s idle gap between T3 and T4 appears to have partially evicted Metal kernel cache. In continuous streaming use (tracks queued back-to-back), T2/T3 levels should hold.
- **VAE FP16 is consistent and unconditional.** Every track improved ~2s regardless of warmup or idle gaps.
- **CPU offload overhead (~8–12s) is unchanged.** Hardware-limited by MacBook Air GPU memory; expected to be smaller on Mac Mini M4 Pro 64GB where more models can remain in GPU memory simultaneously.

---

## Mac Mini M4 Pro 64GB — Expected Impact

The MacBook Air data is for 30s tracks. On Mac Mini with 180s tracks:

| Effect | MacBook Air 30s | Mac Mini 180s (projected) | Reason |
|---|---|---|---|
| VAE FP16 saving | ~2s | **~12s** | VAE decode scales linearly with audio length (~6× longer) |
| DiT mx.compile saving | ~6s | **~6–8s** | Per-step cost, not duration-dependent |
| Ollama Flash Attention | ~2s | **~2–5s** | Same model, same benefit |
| **Total projected saving** | **~17s** | **~20–25s** | |
| **Projected wall time** | 115s → ~98s | 120s → **~95–100s** | |

---

## Mac Mini Retest (to be filled in)

**Test procedure:**

1. Ensure Phase B changes are in place (`scripts/start.sh` already updated)
2. Kill and restart ACE-Step to pick up new env vars:
   ```bash
   kill $(lsof -ti tcp:8001)
   ./scripts/start.sh   # or start_prod.sh
   ```
3. Generate 4–5 tracks with no long idle gaps
4. Run the measurement commands:
   ```bash
   grep -E "LLM done|PERF" /tmp/generative-radio-backend.log
   grep -iE "dit|vae|stat|elapsed|seconds" /tmp/generative-radio-acestep.log
   ```
5. Verify ACE-Step init lines confirm `mx.compile=True` and `dtype=mlx.core.float16`
6. Record T2–T4 averages (exclude T1 warmup) in the table below

| Stage | Baseline (reported ~120s total) | Phase B avg | Delta | % |
|---|---|---|---|---|
| Ollama LLM | TBD | TBD | TBD | TBD |
| DiT diffusion | TBD | TBD | TBD | TBD |
| VAE decode | TBD | TBD | TBD | TBD |
| ACE-Step total | TBD | TBD | TBD | TBD |
| **Wall time total** | **~120s** | **TBD** | **TBD** | **TBD** |

---

## What Was Considered But Excluded

| Option | Reason excluded |
|---|---|
| `OLLAMA_KEEP_ALIVE=-1` (keep Ollama loaded between calls) | `keep_alive=0` in `llm.py` is intentional — frees ~2.5GB for MLX's contiguous Metal buffer. Changing this risks memory fragmentation on 180s tracks on Mac Mini. |
| `ACESTEP_COMPILE_MODEL` for PyTorch path | Not applicable — project uses MLX backend (`ACESTEP_LM_BACKEND=mlx`). |
| `QoS / taskpolicy` | Foreground processes already get Performance cores on macOS. Marginal gain (~1–2%) not worth added complexity. |
| Larger LM model (1.7B or 4B) | Opposite direction — slower, not faster. Default 0.6B is correct. |
| Changing `inference_steps`, `thinking`, CoT flags | Quality parameters, explicitly out of scope. |
