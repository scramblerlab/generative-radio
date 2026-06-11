# Generative Radio — Next Improvements Plan

## Context

Three improvement areas were requested: (1) faster perceived music generation on the Mac mini M4 Pro 64GB without quality loss, (2) mobile app reliability (reported bug: backgrounding before the first song plays leaves the app silent forever), (3) commercialization via tiering/auth.

**Evidence base (verified, no guesswork):**
- Steady-state generation already outpaces playback: a 180s track generates in ~98s wall (Ollama LLM ~24.8s → ACE-Step ~73s), leaving 82s headroom ([docs/apple-silicon-performance-tuning.md](docs/apple-silicon-performance-tuning.md) Phase C tables). So the user-visible problem is **time-to-first-song (~98s+)**, not throughput.
- The local ACE-Step clone at `/Users/nobu/dev/ai/ACE-Step-1.5` is at commit `dce6214`, **ahead of upstream v0.1.8** — no update needed. Upstream recommends keeping `inference_steps=8` for turbo ("Default is optimal"), and documents **no MLX quantization option** — so neither is a lever. (Refs: [ACE-Step-1.5 repo](https://github.com/ace-step/ACE-Step-1.5), [releases](https://github.com/ace-step/ACE-Step-1.5/releases).)
- Mobile bug root cause **verified in code** (not the originally suspected polling restart): `localPausedRef` initializes `true` ([useRadio.ts:93-94](mobile/src/hooks/useRadio.ts#L93-L94)) and the mount effect ([useRadio.ts:837-849](mobile/src/hooks/useRadio.ts#L837-L849)) never clears it, so `handleWake` bails at its first guard ([useRadio.ts:682](mobile/src/hooks/useRadio.ts#L682)) and the WS `play_now` handler drops the event ([useRadio.ts:771-781](mobile/src/hooks/useRadio.ts#L771-L781), both the `!localPausedRef` check and `currentTrackIdRef === for_track_id` with a null ref). Additionally, with no audio session active, iOS suspends the app in background, so polling timers can't fire anyway (UIBackgroundModes `audio` only keeps an app running while audio is actually playing).
- Commercial licensing is clean: ACE-Step 1.5 is **MIT** (code+weights, no restriction on generated music; README adds an originality-disclosure disclaimer), Qwen3.5 is **Apache 2.0**. Apple **Guideline 3.1.1** requires In-App Purchase for digital subscriptions in the iOS app (2025 US update permits external purchase links on the US storefront); **RevenueCat officially supports Expo**.

**User decisions (from Q&A):**
1. First-song latency: play a **random pre-generated track from a persisted library** immediately on start (repeating picks until the fresh track is ready); fall back to current 180s wait when the library is empty.
2. Commercialization phase 1 = **auth + server-side entitlements, manual premium grants; IAP via RevenueCat in phase 2**.
3. Premium = **DJ slot / set genres** + **save-song-to-local (download)**. **Remove** the thumb-reaction server-side MP3/JSON persistence. **Advanced options become controller-only** (localhost), hidden from standard and premium users.

Recommended execution order: **Part 2 (mobile fix) → Part 1 (instant start + tuning) → Part 3 (auth/tiers)**. Parts are independent; each ships as its own PR.

---

## Part 1 — Mac mini M4: instant start + generation tuning

### 1A. Instant-start via persisted track library (primary, user-chosen)

**Goal:** music within ~2s of pressing Start, instead of ~98s.

**Storage reality (verified):** ACE-Step already persists every generated MP3 — its API writes to `temp_audio_dir = <tmp_root>/api_audio` ([ACE-Step api/lifespan_runtime.py:135](../../ACE-Step-1.5/acestep/api/lifespan_runtime.py)), which on this machine is `/Volumes/SP PCIe M.2/ACE-Step/api_audio`, currently **18,127 UUID-named MP3s / 55 GB with no metadata and no effective pruning**. The radio client gets the absolute `file_path` from `/query_result` ([backend/acestep_client.py:108-173](backend/acestep_client.py#L108-L173)) and downloads bytes over HTTP, leaving the file behind forever. Design principle per user: **no duplicate MP3s; all info in one place.**

**Design — move, don't copy.** The library takes ownership of ACE-Step's original file via `os.rename` (atomic + instant when the library lives on the same volume) at the moment generation completes — the only moment the metadata (prompt, genres, title) exists.

**New module** `backend/library.py` — `TrackLibrary` class:
- Directory from env `LIBRARY_DIR`, default `/Volumes/SP PCIe M.2/generative-radio/library` (same volume as `api_audio` → rename is atomic; configurable for dev machines). If the volume isn't mounted at startup: log a warning and run with the library disabled (all methods no-op, radio behaves exactly as today).
- One `.mp3` + one `.json` sidecar per track, both named by radio `track_id` (sidecar also records ACE-Step's original task UUID for traceability). Sidecar fields: `track_id, acestep_task_id, title, genres[], keywords[], language, duration_s, created_at, prompt` — reuse the metadata serialization of the existing save feature ([backend/main.py:210-267](backend/main.py#L210-L267)). Sidecar-per-file (not a central DB) is crash-safe and self-describing; an in-memory index is built by scanning sidecars at startup.
- `adopt(track_id, acestep_file_path, metadata)` — `os.rename(acestep_file_path, library/<track_id>.mp3)` (fallback `shutil.move` if `EXDEV`), then write the sidecar. Idempotent: if `<track_id>.mp3` already exists, do nothing (no duplicates by construction). Enforce rolling cap `LIBRARY_MAX_TRACKS` (env, default 500 ≈ ~2.5 GB; files avg ~3 MB) by deleting oldest `created_at` pair.
- `pick(genres: list[str]) -> LibraryTrack | None` — random among tracks sharing ≥1 genre; fall back to fully random; `None` if empty/disabled. Track recently-played ids in-memory (avoid repeats within a session).
- `load_audio(track_id) -> bytes` — read from the library file.

**Hook 1 — adopt every generated track:** `acestep_client.generate_song` already knows the result `file_path` before downloading ([backend/acestep_client.py:175-194](backend/acestep_client.py#L175-L194)) — return it in `result_meta`. In the post-generation store step ([backend/radio.py:1050-1104](backend/radio.py#L1050-L1104)), after caching audio/prompt/metadata, call `self.library.adopt(track_id, result_meta["file_path"], ...)`. Audio bytes are already in `audio_cache`, so the move never races playback. This also replaces the persistence value of the removed reaction-save feature (Part 3D).

**Janitor for `api_audio` (stops the unbounded 55 GB growth):** since every successful track is now moved out, leftovers in `api_audio` are only failed/abandoned tasks and 1F warmup output. Add to `TrackLibrary` a startup + daily task: delete `api_audio/*.mp3` older than `API_AUDIO_ORPHAN_TTL_H` (env, default 48h). **One-time backlog decision for the user at implementation time:** the existing 18k files are un-attributable (no metadata) and cannot be imported into the library meaningfully — recommend archiving or deleting them manually; the janitor must NOT auto-delete the pre-existing backlog on first run without explicit confirmation (gate the first sweep behind a `--clean-backlog` flag on a small CLI, `backend/scripts/library_maintenance.py`).

**Hook 2 — serve library tracks while generating:** in `start_from_ws` ([backend/radio.py:413](backend/radio.py#L413)) and in the track-advance path when no generated track is buffered yet:
- After kicking off generation, if `library.pick(selected_genres)` returns a track: load its MP3 into `audio_cache`, build a `TrackInfo` with a new flag `"replay": True`, set it as `current_track`, broadcast the normal `track_ready` + `status` events. Clients need **zero changes** — they already react to `track_ready` (web blob prefetch; mobile download).
- On `track_ended` while the first fresh track still isn't ready: pick another library track (same logic). When the fresh track is ready it sits in `next_track` and plays at the next natural boundary — do **not** interrupt a playing library track.
- Library empty → exactly current behavior (`generating` state, clients wait).
- Frontend nicety (optional, 1 line each in web `RadioPlayer.tsx` / mobile `NowPlaying` UI): show a small "replay" badge when `track.replay === true`.

**Why:** picked over a shorter first track by the user; uses only already-generated audio so per-track quality is untouched; the persistence mechanism already exists and is proven (save-track feature).

### 1B. Fix the `keep_alive=0` conflict with the aimodel proxy (do first — it's a live bug)

Ollama now runs as a shared proxied server managed by `/Users/nobu/dev/ai/aimodel` (proxy :11430 → Ollama :11434), tuned with `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=4` (aimodel README, "Performance Settings"). But [backend/llm.py:399](backend/llm.py#L399) still passes `keep_alive=0` per-request — and Ollama's request-level `keep_alive` **overrides** the server setting, so generative-radio unloads the shared model after every call (also evicting it for the logger app) and re-pays model load on each track. The original rationale ("free ~2.5GB before VAE decode") is obsolete: aimodel's RAM budget table shows ~24-25 GB grand total incl. ACE-Step peak, **~39 GB headroom** on 64 GB.

**Change:** remove the `keep_alive=0` line from the `chat()` call in [backend/llm.py](backend/llm.py#L399) (inherit the server's `-1`). Also delete the now-stale `OLLAMA_FLASH_ATTENTION` mention in the radio start scripts if any remains (Ollama is no longer launched there). Update [docs/apple-silicon-performance-tuning.md](docs/apple-silicon-performance-tuning.md) "excluded" table accordingly.

### 1C. Overlap Ollama LLM with ACE-Step generation

Currently each generation in [backend/radio.py:936-1024](backend/radio.py#L936-L1024) runs LLM (~24.8s) **then** ACE-Step (~73s) sequentially inside `_generate_and_buffer_next` ([radio.py:854-906](backend/radio.py#L854-L906)). Restructure the self-chaining pipeline so the **next** slot's LLM prompt generation starts as soon as the current slot's ACE-Step submission is in flight (ACE-Step polling is pure I/O wait — `poll_task` every 2s, [backend/acestep_client.py:108-173](backend/acestep_client.py#L108-L173)):
- Split generation into `prepare_prompt()` (LLM) and `synthesize(prompt)` (ACE-Step) coroutines; keep a one-deep prompt prequeue (`self._next_prompt`). When `_generate_and_buffer_next` starts `synthesize`, immediately `asyncio.create_task(prepare_prompt_for_next_slot())`.
- **Memory/concurrency note:** safe — Ollama stays resident under aimodel (1B) and `OLLAMA_NUM_PARALLEL=4` handles the radio + logger overlap; ~39 GB headroom per aimodel's budget. Watch `/tmp/generative-radio-acestep.log` for any new offload/fragmentation lines during verification.
- Effect: steady-state cycle ~98s → ~75s. Matters for buffer refill after start/skip/DJ-reschedule (3 slots fill in ~3×75s instead of ~3×98s) and shortens how long 1A's library replays are needed.

### 1D. ACE-Step LM speedup: 8-bit MLX quantization of the 1.7B LM (measured A/B with quality gate)

The LM phase is now ACE-Step's biggest block: Phase 1 CoT 3.8s + Phase 2 audio codes 28.8s = ~33s of the ~73s ACE-Step total (tuning doc, Phase C). Verified in source: the checkpoint `checkpoints/acestep-5Hz-lm-1.7B` is a **Qwen3-architecture bf16 model** (its `config.json`: `"dtype": "bfloat16"`) loaded unquantized via `mlx_lm.utils.load` ([ACE-Step llm_inference.py:2933-3019](../../ACE-Step-1.5/acestep/llm_inference.py)), and ACE-Step's own batch-decode docstring states decode is **memory-bandwidth-bound** on Apple Silicon (llm_inference.py:3054-3072). Bandwidth-bound decode scales ~linearly with weight bytes → q8 ≈ 1.6-1.9× decode speed, Phase 2 ~28.8s → ~16-18s, ACE-Step total ~73s → ~60s.

**Procedure (experiment branch, gated):**
1. `uv run python -m mlx_lm convert --hf-path /Users/nobu/dev/ai/ACE-Step-1.5/checkpoints/acestep-5Hz-lm-1.7B -q --q-bits 8 --mlx-path /Users/nobu/dev/ai/ACE-Step-1.5/checkpoints/acestep-5Hz-lm-1.7B-q8` (run inside the ACE-Step venv). **Known wrinkle:** the checkpoint's safetensors keys lack the `model.` prefix (ACE-Step works around this at llm_inference.py:2953-2996); if `convert` fails on key names, write a one-off script that replicates that remapping (load weights, prefix `model.`, build Qwen3 via `mlx_lm.utils._get_classes`, then `mlx_lm.utils.quantize_model` + save). The quantized output loads through the **standard** `mlx_load` path since convert/save writes mlx-lm-native keys + quantization config.
2. Point `ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B-q8` in [scripts/start.sh](scripts/start.sh) / [scripts/start_prod.sh](scripts/start_prod.sh).
3. Measure per the tuning doc's methodology (4 tracks, discard T1; `grep -E "LLM done|PERF" /tmp/generative-radio-backend.log` + ACE-Step log Phase 1/2 lines).
4. **Quality gate:** blind A/B listen of 4 q8 vs 4 bf16 tracks across 2-3 genres (same seeds via the `seed` param for pairing). Any audible degradation → revert and document. Do not merge without passing the gate.

No other LM lever exists: no speculative decoding in the codebase (grep confirms), `ACESTEP_USE_FLASH_ATTENTION` already defaults true ([api/startup_model_init.py:51](../../ACE-Step-1.5/acestep/api/startup_model_init.py)), and MLX skips CFG/constrained-decoding already.

### 1E. VAE decode chunk tuning (small, measured)

VAE decode is 9.9s/track. `ACESTEP_MLX_VAE_CHUNK` (highest-priority override, [ACE-Step gpu_config.py:782-794](../../ACE-Step-1.5/acestep/gpu_config.py)) controls decode chunk size; the auto-tuner is conservative for low-memory machines. On 64 GB, test larger values (e.g. 512 → 1024 → 2048) with the same 4-track methodology; keep the fastest value that shows no memory pressure in the ACE-Step log. Expected ~2-3s/track.

### 1F. Startup warmup generation

`ACESTEP_COMPILE_MODEL=1` makes T1 pay mx.compile JIT cost, and idle gaps partially evict Metal kernel cache (tuning doc, Phase B observations). Add to `scripts/start.sh` / `scripts/start_prod.sh` (or a small `backend/warmup.py` invoked after health checks): one throwaway short-duration generation request to ACE-Step (e.g. 10s duration, fixed simple prompt, discard output) after the API reports healthy. First listener then gets steady-state T2 performance.

### Explicitly NOT doing (with reasons)
| Rejected | Why |
|---|---|
| Lower `inference_steps` below 8 | Upstream: 8 is the turbo optimum; user constraint is "keep quality". |
| LM 1.7B → 0.6B | Unverified quality on 180s tracks; 1D's q8 quantization is the lower-risk speed lever. |
| Ollama-side tuning | Already done in the aimodel project (KEEP_ALIVE=-1, flash attention, q8_0 KV, NUM_PARALLEL=4); only the client-side `keep_alive=0` conflict remains (1B). |
| Speculative decoding for the LM | Not implemented anywhere in the ACE-Step codebase (verified by grep). |
| Upgrade ACE-Step clone | Already ahead of v0.1.8. |

### Verification (Part 1)
Use the existing methodology in [docs/apple-silicon-performance-tuning.md](docs/apple-silicon-performance-tuning.md#L28-L50) (4 consecutive tracks, discard T1). Success criteria: Start→audible ≤5s with non-empty library (1A); `LLM done` time drops after 1B and the aimodel proxy console shows the model staying loaded between calls (near-infinite `in tok/s` = cached prefix / no reload); steady-state wall ≤80s/track with 1C alone, ≤65s with 1C+1D+1E; q8 passes the blind listening gate before merge; no `offload_time_cost > 0` regressions in the ACE-Step log; library cap enforced (generate >cap tracks, check oldest evicted); after a generation, the MP3 exists in `LIBRARY_DIR` with sidecar and is **gone** from `api_audio` (no duplicate); janitor first-run leaves the pre-existing backlog untouched without `--clean-backlog`.

---

## Part 2 — Mobile reliability fix (iOS-first)

All changes in [mobile/src/hooks/useRadio.ts](mobile/src/hooks/useRadio.ts) unless noted. Implementation order = listed order (1 and 3 are prerequisites for 2). `MobileRadioState` values unchanged.

### 2.1 Mark play-intent at mount (the deterministic one-liner)
In the mount effect ([useRadio.ts:837-849](mobile/src/hooks/useRadio.ts#L837-L849)), before the `fetchAndPlayRef.current?.()` call at line 841, insert (mirrors `tuneIn` at lines 935-942):
```ts
localPausedRef.current = false;
setLocalPaused(false);
```
This alone unblocks `handleWake` and `play_now` for the pre-first-track window. Side effect to verify: `RadioPlayer.tsx:295` shows the pause icon during initial load (correct for an auto-playing app). Keep `handleWake`'s `if (localPausedRef.current) return;` — it correctly covers tuneOut/explicit pause.

### 2.2 Fetch-epoch guard (safe mutex recovery, prerequisite for 2.3)
- Add `const fetchEpochRef = useRef(0);` and `const fetchStartedAtRef = useRef(0);` next to `isFetchingRef` (~line 113).
- In `fetchAndPlay` ([:445](mobile/src/hooks/useRadio.ts#L445)), after `isFetchingRef.current = true;` (line 451): `const epoch = ++fetchEpochRef.current; fetchStartedAtRef.current = Date.now();`
- After **every** `await` in `fetchAndPlay` (status fetch+json ~464-466, `await sendTrackEnded()` ~501, `await downloadAudio(track)` ~506), first statement: `if (epoch !== fetchEpochRef.current) { console.log('[F&P] stale epoch — aborting'); return; }` Stale runs must not touch `isFetchingRef` or create a player.
- `catch` block (~629-635): first line `if (epoch !== fetchEpochRef.current) return;` so a stale failure can't flip state to `'error'` or schedule the 3s retry.
- Safety stack: mutex blocks concurrent entry; epoch kills suspended zombie continuations; `downloadAudio`'s fixed task id `track_current` re-attach ([mobile/src/utils/downloadAudio.ts:27-37](mobile/src/utils/downloadAudio.ts#L27-L37)) makes re-issued downloads converge.

### 2.3 `handleWake` refactor — always immediate guarded re-sync
Replace the state switch in `handleWake` ([:678-719](mobile/src/hooks/useRadio.ts#L678-L719)) with:
```ts
if (localPausedRef.current) return;                 // user paused / tuned out
if (radioStateRef.current === 'idle') return;
if (playerRef.current?.playing) return;             // already audible
if (radioStateRef.current === 'playing' && playerRef.current && playerReadyRef.current) {
  try { playerRef.current.play(); } catch {}
  await new Promise<void>((r) => setTimeout(r, 1_000));
  if (playerRef.current?.playing) return;           // cheap resume worked
}
if (isFetchingRef.current) {                        // in-flight fetch grace
  await new Promise<void>((r) => setTimeout(r, 4_000));
  if (playerRef.current?.playing) return;
  if (isFetchingRef.current) { fetchEpochRef.current++; isFetchingRef.current = false; }
}
stopPolling();
await fetchAndPlay();                               // immediate sync — kills the 10s first-poll delay
```
Idempotency is already inside `fetchAndPlay`: same-track+playing no-op (~481-487), same-track+stopped 6s retry (~489-491), no-track → `startPolling()` (~470-476).

### 2.4 `play_now` guard — accept never-played state
In the WS handler ([:771-781](mobile/src/hooks/useRadio.ts#L771-L781)) change the condition to:
```ts
!localPausedRef.current && !isFetchingRef.current &&
(currentTrackIdRef.current === null || !for_track_id || currentTrackIdRef.current === for_track_id)
```
Plus stuck-mutex escape: if `isFetchingRef.current && Date.now() - fetchStartedAtRef.current > 120_000`, bump epoch, clear mutex, proceed.

### 2.5 True background-start (iOS) — silence bridge while waiting for first track
iOS cannot activate an audio session from the background, so the existing silence bridge ([startSilenceBridge :251-270](mobile/src/hooks/useRadio.ts#L251-L270)) must start while foregrounded:
- **In `fetchAndPlay`'s no-track branch** (~470-476): `if (currentTrackIdRef.current === null) startSilenceBridge();` before `startPolling()`. (Gate on null ref keeps mid-session behavior unchanged; add `startSilenceBridge` to the dep array at ~640.)
- **In the AppState `'background'` branch** (~899-926), replace the unconditional `stopPolling()` at line 918: when `Platform.OS === 'ios' && currentTrackIdRef.current === null && isBridgingRef.current && !localPausedRef.current`, **keep polling alive** (the active audio session keeps the app unsuspended; JS timers + fetch work — same mechanism the mid-session iOS path already relies on, see comments ~656-666) and arm a cap timer `BG_FIRST_TRACK_WAIT_CAP_MS = 10 * 60_000` (new const ~line 68, new ref `bgWaitCapTimerRef` ~line 128) that on expiry calls `stopPolling(); stopSilenceBridge();` if still backgrounded with no track. Otherwise `stopPolling()` as today. `stopProgressTimer()` stays unconditional.
- Clear the cap timer inside `stopSilenceBridge` (~272-281) so every bridge teardown cancels it, and in the `'active'` branch next to the `bgTrackEndTimerRef` clear (~886-889).
- Do **not** reopen the WS in background (the `'inactive'` WS-close at ~859-880 exists to prevent cpulimit kills); one HTTP GET per 10s is the right transport here.
- **App Review note:** Guideline 2.5.4 disallows indefinite silent background audio; this is a bounded (10 min cap) bridge into imminent real playback — keep the cap.
- Trade-off to document in a code comment: with `interruptionMode: 'doNotMix'` (~144) the bridge stops other apps' audio at launch. Acceptable for an auto-playing radio app.
- Android: explicitly `Platform.OS === 'ios'`-gated; native Kotlin fallbacks untouched. (Optional phase 2: native first-track poll via `fetchStatusNative` in [mobile/src/modules/backgroundHttp.ts:35-52](mobile/src/modules/backgroundHttp.ts#L35-L52) — do not build in the first pass.)

### 2.6 Playback failure detection
expo-audio 55 has **no** error event (verified: `AudioEvents` = `playbackStatusUpdate` + `audioSampleUpdate` only). At the top of the `playbackStatusUpdate` listener (~536-575, and its foreground re-attach twin in `handleForegroundIOS` ~327-337):
```ts
if (status.playbackState === 'failed') {
  if (!localPausedRef.current && !isFetchingRef.current) {
    currentTrackIdRef.current = null;   // forces re-download; also suppresses sendTrackEnded
    setRadioState('error'); setErrorMessage('Playback failed — recovering...');
    fetchAndPlayRef.current?.();
  }
  return;
}
```
Resetting `currentTrackIdRef` is essential — otherwise the same-track guard loops on 6s retries against a corrupt local file.

### 2.7 (Optional) WS reconnect re-sync
In `ws.onopen` (~732-741): trigger `fetchAndPlayRef.current?.()` when not paused/fetching/playing/bridging and state ∉ {polling, idle}. Skip if minimizing the diff — 2.1+2.3+2.4 already fix the reported bug.

### Edge cases handled (verified against current code)
Backgrounding during a mid-session download (unchanged path — bridge already active from `handleTrackEnded` ~661); wake during download (4s grace → epoch invalidation → download re-attach; no double player since stale epochs return before `createAudioPlayer` ~523); poll/play_now/wake races (mutex + epoch + same-track guard); `inactive`→`active` without background (no regression); lock-screen pause then wake (intent guard holds); tuneOut (both guards hold); server never delivers (cap timer releases session, next foreground recovers); airplane-mode wake (existing error/3s-retry path).

### Test matrix (iOS device build; Android sanity on 4/5/7)
| # | Scenario | Expected |
|---|---|---|
| 1 | Launch → background within 5s → wait | Bridge log at bg entry; 10s poll logs continue; music starts **in background** ≤10s after server readiness; lock screen shows track |
| 2 | Launch → background → track generated → foreground | Music ≤2s after foreground (immediate fetch, not 10s poll) |
| 3 | Foreground before track exists | One immediate fetch; bridge running; plays when ready |
| 4 | Background mid-playback, let track end | Next track plays in background (regression) |
| 5 | Background during track transition download | Continuous bridge→track, no gap |
| 6 | Foreground during download | Exactly one player; `stale epoch` log allowed |
| 7 | Lock-screen pause → background → wake | Stays paused; no bridge |
| 8 | tuneOut → background → wake | Stays idle |
| 9 | Control-center pulldown while playing | Uninterrupted |
| 10 | Server stopped, background >10 min | Cap fires (bridge+poll stop); later foreground recovers |
| 11 | Spotify playing, launch app | Spotify stops at bridge start (doNotMix — confirm acceptable) |
| 12 | Airplane mode on wake | Error + 3s retries; recovers with network |
| 13 | Corrupt `track_current.mp3` | `playbackState=failed` → re-download same track; server not advanced |

---

## Part 3 — Commercialization phase 1: auth + entitlements (IAP in phase 2)

### Tier model (user-decided)
| Capability | Anonymous/free | Premium | Controller (localhost) |
|---|---|---|---|
| Listen, reactions, status | ✅ | ✅ | ✅ |
| DJ slot: `dj_claim`/`dj_submit` (genres, keywords, language, feeling) | ❌ | ✅ | ✅ |
| Save song to local (download) | ❌ | ✅ | ✅ |
| Start/stop/skip/reschedule | ❌ | ❌ | ✅ (unchanged) |
| Advanced options (steps, model, CoT, time sig, DJ cooldown) | ❌ (hidden) | ❌ (hidden) | ✅ only |

### 3A. Backend auth — new module `backend/auth.py`
- **Identity:** Sign in with Apple. `POST /api/auth/apple` accepts `{identityToken}`; verify the JWT against Apple's JWKS (`https://appleid.apple.com/auth/keys`) with `aud == "com.generativeradio.app"` (bundle id from [mobile/app.json](mobile/app.json)), `iss == https://appleid.apple.com`. Use `pyjwt[crypto]` (add to [backend/requirements.txt](backend/requirements.txt)). Using only Sign in with Apple satisfies Guideline 4.8 (it *is* the privacy-preserving option).
- **User store:** SQLite via stdlib `sqlite3` (no new infra) at `backend/users.db`: `users(id TEXT PK, apple_sub TEXT UNIQUE, tier TEXT DEFAULT 'free', created_at)`. Backend is single-process — stdlib is fine.
- **Session token:** issue our own JWT, HS256, secret from env `JWT_SECRET` (generate once, store in `~/.generative-radio.env`, source from start scripts), claims `{sub, tier, exp: 30d}`. Refresh by re-login.
- **Manual premium grant (phase 1):** CLI script `backend/scripts/grant_tier.py <apple_sub|user_id> premium` (direct SQLite update). No payment yet.
- **REST gating:** FastAPI dependency `require_tier("premium")` reading `Authorization: Bearer`. Apply to the new download endpoint (3C).
- **WS gating:** token as query param `?token=` on `wss://.../ws` (browser/RN WS can't set headers); validate in the WS handler ([backend/main.py:341-402](backend/main.py#L341-L402)), attach `tier` to the connection object. In `dj_claim`/`dj_submit` handling ([backend/radio.py:1247-1277](backend/radio.py#L1247-L1277)): reject with `error` event `{code:"premium_required"}` unless `tier=="premium"` or connection is controller. Missing/invalid token → connect as anonymous free viewer (no breaking change for the web app).
- **Keep** the existing IP-based controller assignment ([backend/radio.py:44-50](backend/radio.py#L44-L50)) untouched — it cleanly implements "advanced options = localhost only".
- **Rate limiting (cheap, do now):** in-memory per-IP/per-user counters on `react` and `auth` endpoints (e.g. 30/min) — currently there is none anywhere.

### 3B. Mobile auth UI
- Add `expo-apple-authentication` (Apple-only login button on iOS; hide on Android for now) and `expo-secure-store` for the JWT.
- New `mobile/src/hooks/useAuth.ts`: sign-in → `POST /api/auth/apple` → store JWT → expose `{tier, signIn, signOut}`. Append `?token=` to the WS URL in `connectWebSocket` ([useRadio.ts:725-834](mobile/src/hooks/useRadio.ts#L725-L834)) and `Authorization` header on REST calls.
- DJ button: visible to all, but for free users tapping it shows an upsell sheet ("Premium lets you pick the genres") instead of `dj_claim`. Server still enforces.

### 3C. Save-track rework (premium "save to local")
- **New endpoint** `GET /api/tracks/{track_id}/download` (premium-gated): returns the MP3 with `Content-Disposition: attachment; filename="<title>.mp3"`. Serve from `audio_cache`, falling back to the Part-1A library directory.
- **Mobile:** save button → download to cache dir → `expo-sharing` share sheet (user saves to Files/etc.). **Web:** anchor-download of the blob with the bearer token.
- **Remove** the current controller-only server-side save flow as a user feature ([backend/main.py:210-267](backend/main.py#L210-L267)) or keep the endpoint as controller-only admin tool — recommend keeping it (it's IP-gated already, harmless, and the metadata serializer is reused by 1A).

### 3D. Remove reaction-persistence; advanced options controller-only
- In the react endpoint ([backend/main.py:270-289](backend/main.py#L270-L289)) and its helpers: **delete the `tracks_with_user_action/` MP3+JSON writes** (see [docs/thumb-reaction-feature.md](docs/thumb-reaction-feature.md)); keep in-memory counts, the `reaction_update` broadcast, and the reactions GET (drop its file-count fallback). Update the doc.
- Web frontend: render the advanced-options panel (in `GenreSelector.tsx`) only when `role === 'controller'` — verify whether this is already the case (controller-only UI exists); if any advanced option is visible to viewers/DJ submitters, remove it. Server side: ignore `advancedOptions` in `dj_submit` payloads.

### Phase 2 (separate effort, scoped now, not built now)
RevenueCat `react-native-purchases` via Expo dev-client (Preview-API mode in Expo Go), one `premium` entitlement, App Store subscription product, server webhook → flips `users.tier`. IAP is mandatory for this on iOS (Guideline 3.1.1); the 2025 US ruling additionally allows an external purchase link on the US storefront if you later want Stripe. Include the 3.1.1-required restore-purchases mechanism.

### Verification (Part 3)
- `curl -X POST /api/auth/apple` with an invalid token → 401; valid token (from a device run) → JWT.
- WS without token: listen + react work; `dj_claim` → `premium_required` error event.
- `grant_tier.py` → premium user can `dj_claim`/`dj_submit` and hit `/download`; free user gets 403 on `/download`.
- Web app unchanged for anonymous viewers; controller (localhost) retains all controls + advanced options.
- Regression: reactions still broadcast counts; `tracks_with_user_action/` no longer grows.

---

## Sources
- [ACE-Step 1.5 repo (MIT license, model variants, backends)](https://github.com/ace-step/ACE-Step-1.5) · [Releases](https://github.com/ace-step/ACE-Step-1.5/releases) · [INSTALL/macOS notes (steps=8 optimal, MLX backend)](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/INSTALL.md)
- Local measurements: [docs/apple-silicon-performance-tuning.md](docs/apple-silicon-performance-tuning.md) (Phases A–C, Mac mini M4 Pro 64GB tables)
- aimodel proxy: `/Users/nobu/dev/ai/aimodel/README.md` (Ollama tuning, RAM budget incl. ACE-Step peak, ~39 GB headroom, per-app proxy ports)
- ACE-Step source (local clone `dce6214`): `acestep/llm_inference.py:2933-3072` (bf16 MLX load, bandwidth-bound decode note, key-prefix remap), `acestep/gpu_config.py:782-794` (`ACESTEP_MLX_VAE_CHUNK`), `acestep/api/startup_model_init.py:51` (`ACESTEP_USE_FLASH_ATTENTION` default true)
- [Apple App Review Guidelines (3.1.1 IAP, 2.5.4 background audio, 4.8 login)](https://developer.apple.com/app-store/review/guidelines/) · [2025 US external-link update](https://developer.apple.com/news/?id=dovxb62h)
- [RevenueCat Expo docs](https://www.revenuecat.com/docs/getting-started/installation/expo) · [Expo IAP guide](https://docs.expo.dev/guides/in-app-purchases/)
- [Qwen3.5 on Ollama (Apache 2.0)](https://ollama.com/library/qwen3.5)
