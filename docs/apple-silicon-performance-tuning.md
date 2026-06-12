# Apple Silicon Performance Tuning — ACE-Step + Ollama

> Research date: 2026-03-25
> Tested on: MacBook Air M3 24GB (baseline + Phase B). Mac Mini M4 Pro 64GB (baseline + Phase B + Phase C LM model).
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

## Mac Mini M4 Pro 64GB — Baseline (before Phase B)

ACE-Step init at baseline:
```
[MLX-DiT] Native MLX DiT decoder initialized successfully (mx.compile=False).
[MLX-VAE] Native MLX VAE initialized (dtype=mlx.core.float32, compiled=True).
```

Note: `offload_time_cost=0.0` on all tracks — Mac Mini 64GB keeps all models in GPU memory, no CPU offload (vs ~8–12s overhead on MacBook Air 24GB).

| Stage | T1 'Velvet Strings In Rain' | T2 'Rebel Rhythm In Golden Notes' | T3 'Neon Breath On Skyline' | T4 'Silent Notes Drifting East' | **Avg T2–T4** |
|---|---|---|---|---|---|
| Ollama LLM | 24.5s | 25.1s | 22.2s | 22.8s | **23.4s** |
| **DiT diffusion** | **23.3s** | **29.1s** | **27.7s** | **27.8s** | **28.2s** |
| CPU offload overhead | 0.0s | 0.0s | 0.0s | 0.0s | 0.0s |
| **VAE decode** | **13.5s** | **12.4s** | **11.0s** | **10.7s** | **11.4s** |
| **ACE-Step client total** | **116.2s** | **122.2s** | **120.2s** | **114.2s** | **118.9s** |
| **Wall time (LLM + ACE-Step)** | **~141s** | **~147s** | **~142s** | **~137s** | **~142s** |

---

## Mac Mini M4 Pro 64GB — Phase B Results

ACE-Step init confirms both active:
```
[MLX-DiT] Native MLX DiT decoder initialized successfully (mx.compile=True).   ← was False ✓
[MLX-VAE] Model weights converted to float16.                                   ← new ✓
[MLX-VAE] Native MLX VAE initialized (dtype=mlx.core.float16, compiled=True).  ← was float32 ✓
```

| Stage | T1 'Iron & Ash' (warmup) | T2 'Neon Revolt In The Library' | T3 'Highland Banner Rise' | T4 'Voltage Bloom In The Smelt' | **Avg T2–T4** |
|---|---|---|---|---|---|
| Ollama LLM | 23.7s | 24.2s | 22.0s | 24.2s | **23.5s** |
| **DiT diffusion** | **28.1s** | **25.0s** | **26.8s** | **27.4s** | **26.4s** |
| CPU offload overhead | 0.0s | 0.0s | 0.0s | 0.0s | 0.0s |
| **VAE decode** | **12.1s** | **11.6s** | **9.5s** | **9.5s** | **10.2s** |
| **ACE-Step client total** | **116.2s** | **120.2s** | **112.2s** | **118.2s** | **116.9s** |
| **Wall time (LLM + ACE-Step)** | **~140s** | **~144s** | **~134s** | **~142s** | **~140s** |

---

## Baseline vs Phase B — Mac Mini M4 Pro 64GB, 180s tracks

| Stage | Baseline avg | Phase B avg (T2–T4) | Delta | % |
|---|---|---|---|---|
| Ollama LLM | 23.4s | 23.5s | 0.0s | ~0% |
| DiT diffusion | 28.2s | 26.4s | -1.8s | -6% |
| VAE decode | 11.4s | 10.2s | -1.2s | -11% |
| ACE-Step total | 118.9s | 116.9s | -2.0s | -2% |
| **Wall time total** | **~142s** | **~140s** | **-2s** | **-1%** |

### Observations

- **Phase B improvements are minimal on Mac Mini.** DiT and VAE are faster, but only by ~1–2s each. The environment variables still provide a free improvement with no downsides, so they remain enabled.
- **The real bottleneck is LM phase (audio token generation).** DiT+VAE together is only ~37s of the ~117s ACE-Step total. The remaining ~80s is LM Phase 1 (CoT metadata) + Phase 2 (audio token generation) + prompt embedding. For 180s tracks, ACE-Step must generate ~6× more audio tokens than for 30s tracks, so LM generation time dominates.
- **No CPU offload overhead** — 64GB unified memory keeps all models resident in GPU. MacBook Air 24GB had ~8–12s offload overhead per track.
- **T1 warmup effect is subtle.** T1 DiT (28.1s) is similar to T2–T4 levels — `mx.compile` warmup cost is masked by the larger LM phase in the total wall time.

---

## Phase C — LM Model Downgrade (4B → 1.7B)

### Background

After Phase B, the per-track sub-phase breakdown revealed that **Phase 2 (audio code generation) was ~55% of total ACE-Step time** — 64.5s of 116.9s. Phase B (DiT/VAE flags) had no impact on this. The bottleneck is LM token generation speed.

ACE-Step auto-selects `acestep-5Hz-lm-4B` for machines with ≥24GB unified memory (`tier=unlimited`). The 4B model generates 900 audio codes at ~14 tok/s. The 1.7B model is available on disk and can be forced via `ACESTEP_LM_MODEL_PATH`.

### Change

**`scripts/start.sh` and `scripts/start_prod.sh`** — added to ACE-Step launch block:
```bash
ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B \
```

### Phase C Results — Mac Mini M4 Pro 64GB, 180s tracks

LM model confirmed: `[API Server] LLM model loaded: acestep-5Hz-lm-1.7B`

| Stage | T1 'Flute Fortress' (warmup) | T2 'Harp Echoes At Suncity' | T3 'Gear Shift Rhythm' | T4 'Hollow Bell Rising' | **Avg T2–T4** |
|---|---|---|---|---|---|
| Ollama LLM | 24.2s | 23.5s | 27.2s | 23.6s | **24.8s** |
| Phase 1 — CoT metadata | 3.88s | 4.25s | 3.27s | 3.99s | **3.8s** |
| Phase 2 — 900 audio codes | 28.61s | 28.83s | 28.99s | 28.62s | **28.8s** |
| **DiT diffusion** | **24.9s** | **27.2s** | **25.1s** | **25.7s** | **26.0s** |
| **VAE decode** | **10.6s** | **9.9s** | **9.8s** | **10.1s** | **9.9s** |
| **ACE-Step client total** | **76.1s** | **74.1s** | **72.4s** | **72.1s** | **72.9s** |
| **Wall time (LLM + ACE-Step)** | **~100s** | **~98s** | **~100s** | **~96s** | **~98s** |

### Phase B vs Phase C — Mac Mini M4 Pro 64GB

| Stage | Phase B (4B LM) | Phase C (1.7B LM) | Delta | % |
|---|---|---|---|---|
| Ollama LLM | 23.5s | 24.8s | +1.3s | +6% |
| Phase 1 — CoT metadata | 10.1s | 3.8s | **-6.3s** | **-62%** |
| Phase 2 — 900 audio codes | 64.5s | 28.8s | **-35.7s** | **-55%** |
| DiT diffusion | 26.4s | 26.0s | -0.4s | ~0% |
| VAE decode | 10.2s | 9.9s | -0.3s | ~0% |
| ACE-Step total | 116.9s | 72.9s | **-44.0s** | **-38%** |
| **Wall time total** | **~140s** | **~98s** | **-42s** | **-30%** |

### Observations

- **Phase 2 halved:** 1.7B generates 900 codes at ~31 tok/s vs 4B at ~14 tok/s — consistent with the ~2.4× parameter ratio.
- **Phase 2 variance dropped to near-zero:** 28.61–28.99s across all 4 tracks. Highly deterministic for this model+duration combination.
- **DiT and VAE unchanged** — as expected, the LM model switch has no effect on diffusion.
- **No audible quality degradation observed** in listening tests on Mac Mini. The 1.7B model produces coherent, varied tracks with proper structure. Quality difference vs 4B may be subtle for ambient/instrumental genres.
- **Wall time now well under track duration:** 180s track generated in ~98s → 82s of headroom before the track ends. This makes pipelined pre-generation straightforward if needed in future.
- **This is the current production configuration** for Mac Mini M4 Pro 64GB.

---

## Mac Mini M4 Pro 64GB — Full Progression

| Configuration | Wall time avg | vs Baseline | Notes |
|---|---|---|---|
| Baseline (no Phase B, 4B LM) | ~142s | — | Auto-selected 4B, no compile flags |
| Phase B (compile + FP16, 4B LM) | ~140s | -2s (-1%) | DiT/VAE flags, LM was the bottleneck |
| **Phase C (compile + FP16, 1.7B LM)** | **~98s** | **-44s (-31%)** | **Current config** |

---

## Machine Comparison — MacBook Air M3 24GB vs Mac Mini M4 Pro 64GB

Comparing Phase B steady-state (T2–T4 avg) across machines. Different track durations make direct comparison tricky — the table includes per-second-of-audio normalization where useful.

| Stage | MacBook Air M3 24GB (30s tracks) | Mac Mini M4 Pro 64GB (180s tracks) | Notes |
|---|---|---|---|
| Ollama LLM | 31.3s | 23.5s | **Mac Mini 25% faster** — M4 Pro CPU + Flash Attention likely both contributing |
| DiT diffusion | 16.1s | 26.4s | Mac Mini slower in absolute time, but generating 6× longer audio. Per-second: Air=0.54s/s, Mini=0.15s/s — **Mac Mini 3.7× more efficient** |
| VAE decode | 3.8s | 10.2s | Same pattern. Per-second: Air=0.13s/s, Mini=0.057s/s — **Mac Mini 2.3× more efficient** |
| CPU offload overhead | 8.3s | 0.0s | **Mac Mini: eliminated entirely** — 64GB keeps all models in GPU |
| ACE-Step total | 66.8s | 116.9s | Longer audio, but LM phase dominates on Mac Mini |
| **Wall time total** | **~98s** | **~140s** | Mac Mini generates 6× longer audio in only 1.4× the time |
| **Audio output per minute of generation** | **~18s audio/min** | **~77s audio/min** | **Mac Mini delivers 4.3× more audio per unit time** |

### Key takeaways

- **Mac Mini is dramatically more capable per unit time** — generating 180s tracks at 4.3× the audio throughput of MacBook Air on 30s tracks.
- **M4 Pro architecture advantage is clear in DiT and VAE** — per second of audio generated, Mac Mini is 2–4× more efficient. More GPU cores + higher memory bandwidth.
- **Ollama LLM is faster on Mac Mini in absolute terms** (23.5s vs 31.3s) despite both using the same Qwen3.5:4b model — M4 Pro CPU and memory bandwidth advantage.
- **The optimization headroom is different between machines.** On MacBook Air, DiT+VAE was ~30% of wall time and Phase B cut it significantly. On Mac Mini, DiT+VAE is only ~26% of wall time — LM token generation is the ceiling to break next.
- **Phase C addressed the LM bottleneck** by switching to 1.7B, cutting wall time from ~140s to ~98s. The Mac Mini now generates 180s of audio in ~98s — well under the track duration, giving 82s of pre-generation headroom.

---

## What Was Considered But Excluded

| Option | Reason excluded |
|---|---|
| ~~`OLLAMA_KEEP_ALIVE=-1`~~ (superseded 2026-06) | Originally excluded to free ~2.5GB before VAE decode. Now DONE: Ollama runs as a shared server under `../aimodel` with `OLLAMA_KEEP_ALIVE=-1` and the request-level `keep_alive=0` was removed from `llm.py` (64GB has ample headroom — see aimodel/README.md RAM budget). |
| `ACESTEP_COMPILE_MODEL` for PyTorch path | Not applicable — project uses MLX backend (`ACESTEP_LM_BACKEND=mlx`). |
| `QoS / taskpolicy` | Foreground processes already get Performance cores on macOS. Marginal gain (~1–2%) not worth added complexity. |
| Larger LM model (1.7B or 4B) | Opposite direction — slower, not faster. Default 0.6B is correct. |
| Changing `inference_steps`, `thinking`, CoT flags | Quality parameters, explicitly out of scope. |

---

## Phase D Baseline — 2026-06-12 (pre-LM-quantization, production steady-state)

Frozen baseline for the next-improvements-plan **1D** (q8 LM quantization) and **1E**
(`ACESTEP_MLX_VAE_CHUNK`) experiments. Measured from `/private/tmp/generative-radio-acestep.log`
with [scripts/acestep_baseline.py](../scripts/acestep_baseline.py) — 34 tracks over ~75 min of
continuous radio, T1 discarded, full-length cohort = codes ≥ 900 (n=23).

**Conditions (must match for A/B):** ACE-Step `dce6214`, `acestep-v15-xl-turbo` DiT +
`acestep-5Hz-lm-1.7B` (bf16) on MLX, `ACESTEP_COMPILE_MODEL=1`, steps=8, thinking+CoT on;
Ollama 0.30.7 via aimodel proxy (flash attention, q8_0 KV, parallel 4, ctx 8192, keep-alive -1);
radio prompt-prefetch overlapping synthesis (production-normal GPU contention); track durations
180–260s (900–1300 codes).

| Metric (full-length, n=23) | median | p25 | p75 |
|---|---|---|---|
| Phase 1 CoT metadata | 8.2 s | 6.8 | 9.3 |
| Phase 2 audio codes | 41.7 s | 38.6 | 44.3 |
| **Phase 2 decode rate** | **27.4 tok/s** | 26.6 | 28.1 |
| DiT diffusion | 57.5 s | 48.5 | 70.1 |
| DiT per 100 codes | 5.4 s | 4.3 | 5.9 |
| VAE decode | 14.1 s | 13.1 | 14.5 |
| VAE per 100 codes | 1.2 s | 1.2 | 1.3 |
| Total per track | 131.0 s | 117.8 | 145.9 |

Notes vs the Phase C tables: durations are longer now (median ~1175 codes ≈ 235s audio vs 900),
and all numbers include bidirectional GPU contention with the Ollama prompt prefetch (Phase 2
runs ~27 tok/s here vs ~31 measured in isolation). Compare 1D/1E results **under the same
production conditions**, primarily via the duration-independent rates: Phase 2 tok/s and the
per-100-codes columns. 1D success target: Phase 2 ≥ ~40 tok/s (≈1.6×) with no audible quality
loss in the paired-seed blind A/B. 1E target: VAE per 100 codes below ~1.0 s.

### Phase D Results — q8 LM quantization (1D), measured 2026-06-12

`acestep-5Hz-lm-1.7B-q8` (8-bit MLX, group_size 64, converted with
[scripts/quantize_5hz_lm_q8.py](../scripts/quantize_5hz_lm_q8.py)), same production conditions as the baseline,
n=16 full-length tracks, T1 discarded:

| Metric (full-length) | bf16 baseline | q8 | Delta |
|---|---|---|---|
| Phase 1 CoT metadata | 8.2 s | 5.1 s | **-38%** |
| Phase 2 audio codes | 41.7 s | 27.4 s | **-34%** |
| **Phase 2 decode rate** | 27.4 tok/s | **43.8 tok/s** | **1.60×** ✓ (target ≥ ~40) |
| DiT per 100 codes | 5.4 s | 4.9 s | -9% (less LM/Ollama contention spillover) |
| VAE per 100 codes | 1.2 s | 1.2 s | unchanged (1E still open) |
| **Total per track** | **131.0 s** | **106.7 s** | **-24.3 s (-19%)** |

Idle microbenchmark (raw mlx_lm decode, no contention): 58.3 → 92.0 tok/s (1.58×), identical
greedy first tokens vs bf16. Quality: no degradation noticed in extended casual listening;
formal paired-seed blind A/B pending. Caveat: the quantized dir is MLX-only — the Gradio UI's
PMI scoring panel (torch load) cannot read it; the radio API flow is unaffected.
