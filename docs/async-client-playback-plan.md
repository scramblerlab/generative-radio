# Plan: Async Client Playback — Pull-Based Track Pipeline

## Context

The current design broadcasts `track_ready {isNext: true}` to synchronize all clients to the same playback point. This breaks with iOS/Android background mode: mobile clients have no active WebSocket, so they never receive the push, and playback timing diverges silently.

The fix: remove the synchronized "next track ready" push. Each client pulls the best available track when it's ready. The server maintains an eager pipeline (always generating the next track), and advances it on the first `track_ended` signal from any client.

**Server-side changes only — no client code modified.**

---

## Current Flow (to be changed)

```
prebuffer done → broadcast track_ready {isNext: true} → all clients pre-cache + auto-switch
```

## New Flow

```
prebuffer done → next_track held silently server-side
client finishes → POST /api/radio/track-ended OR GET /api/radio/next-track
                → A) next_track ready? return it + advance pipeline + start next-next
                → B) still generating? return current_track (client re-plays briefly)
```

---

## Changes

### 1. `backend/radio.py` — Remove `track_ready {isNext: true}` broadcast

In `_generate_and_buffer_next()`, remove the two broadcast lines:
```python
await self._broadcast_track_ready(track, is_next=True)
await self._broadcast_status("playing", "Playing — next track ready")
```
Keep `self.next_track = track` and `self._next_track_ready_event.set()` — the internal event is still needed for the main loop's buffering-path wait.

---

### 2. `backend/radio.py` — Broadcast in happy path (web client compat)

Since web clients no longer pre-cache the track via `isNext: true`, they need a `track_ready {isNext: false}` broadcast when the pipeline advances. Add in the happy-path of `_radio_loop()` after `self.state = RadioState.PLAYING`:

```python
await self._broadcast_track_ready(self.current_track, is_next=False)
```

Web clients will still sync-switch when the first `track_ended` arrives. Mobile clients ignore this (they're in background or use HTTP pull).

---

### 3. `backend/radio.py` — Replace time-based debounce with track-ID-based

The current 5-second time debounce is too fragile: async mobile clients sending `track_ended` minutes later (for the already-transitioned track) would spuriously advance the pipeline.

Add optional `finished_track_id` param to `on_track_ended()` — if provided and doesn't match current track, signal is ignored as stale. Time-based debounce kept for the N-simultaneous-clients case.

---

### 4. `backend/radio.py` — Add `get_current_best_track()` helper

Non-blocking public method: returns `next_track` if buffered and ready, else `current_track`. Returns `None` if no session active.

---

### 5. `backend/main.py` — Modify `POST /api/radio/track-ended` to return track info

Add optional `track_id` query param. Returns `{ok, track}` with best available track immediately — A) next track if ready, B) current track if still generating.

---

### 6. `backend/main.py` — Add `GET /api/radio/next-track` endpoint

Pure query, no side effects. Returns best available track or 404.

---

## What stays the same

- `track_ready {isNext: false}` — still broadcast on session start and pipeline advance (web clients use this)
- `play_now` watchdog — unchanged (safety net for clients that miss track-ended)
- WS `track_ended` handler — calls same `on_track_ended()` with no track_id (backwards-compatible)
- Eager prebuffering — `_start_prebuffer()` still triggers immediately when pipeline advances
- 60-second eviction grace period — unchanged

---

## Async timing diagram

Timeline showing web + mobile clients finishing T1 at different times, while server generates T2 eagerly:

```
t=0s   Server finishes T1, broadcasts track_ready{isNext:false} → all clients start T1
       Server immediately starts generating T2 in background

t=0s   Web client:    playing T1 ─────────────────────────────────────────────────────►
t=0s   Mobile A:      playing T1 ────────────────────────────────────────────────────►
t=0s   Mobile B:      playing T1 (in background, no WS) ────────────────────────────►

       [T2 generation takes ~90s]

t=90s  Server: T2 ready, stored silently as next_track (NO broadcast)

t=120s Web client ends T1 ──────────────────────────────────────── WS track_ended
         → on_track_ended(): debounce OK, set _track_ended_event
         → main loop: next_track(T2) ready → advance pipeline
                       current=T2, start prebuffering T3
         → broadcast track_ready{isNext:false, track=T2}
         → Web client receives T2, plays it ──────────────────────────────────────────►

t=125s Mobile A ends T1 ──────────── POST /track-ended?track_id=T1
         → on_track_ended(finished_track_id=T1)
         → T1 == current? NO — current is already T2
         → track-ID check: T1 ≠ T2 → IGNORED (stale signal)
         → get_current_best_track() → returns T2 immediately
         ← response: {ok:true, track: T2}
         Mobile A plays T2 (slightly behind web, no gap) ─────────────────────────────►

t=200s Mobile B wakes from background, ends T1
         → POST /track-ended?track_id=T1
         → T1 ≠ current(T2) → IGNORED
         → response: {ok:true, track: T2}
         Mobile B plays T2 ──────────────────────────────────────────────────────────►

       [T3 generation kicked off at t=120s when web advanced pipeline, completes ~t=210s]

t=250s Web client ends T2 ──────────────── WS track_ended
         → advance pipeline: current=T3, start T4 prebuffer
         → broadcast track_ready{isNext:false, track=T3}
         ...

t=260s Mobile A ends T2 ──── POST /track-ended?track_id=T2
         → T2 ≠ current(T3) → IGNORED
         ← response: {ok:true, track: T3}
```

**Buffering scenario** (mobile A ends T1 before T2 is ready):

```
t=60s  Mobile A ends T1 early ─── POST /track-ended?track_id=T1
         → on_track_ended(): T1 == current, debounce OK → set _track_ended_event
         → main loop: next_track is None (T2 still generating) → BUFFERING state
         → get_current_best_track(): next_track=None → returns T1 (current)
         ← response: {ok:true, track: T1}   ← client B) path: re-plays T1

t=90s  T2 generation completes → main loop exits buffering, advance pipeline
         → broadcast track_ready{isNext:false, track=T2}

t=120s Mobile A ends T1 again ─── POST /track-ended?track_id=T1
         → T1 ≠ current(T2) → IGNORED (stale)
         ← response: {ok:true, track: T2}   ← client A) path: gets T2
```
