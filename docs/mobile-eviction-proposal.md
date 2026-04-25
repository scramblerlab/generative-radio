# Revised Proposal: Adaptive Track Eviction & "Late-Join" Fallback

## 1. Executive Summary
The backend currently evicts finished tracks from RAM after a fixed `60-second` timer. On mobile, background network throttling or app sleep states often delay audio fetches past this window, resulting in 404 errors and stalled playback. 

**Previous approach:** Increase the Sliding Window FIFO buffer (`N=3`).
**Revised approach:** A **Two-Tier Safety Net**. 
1. **Minor Jitter Handling (Tier 1):** Maintain a small `N=2` FIFO buffer to cover minor network latency (0-3 minutes) without bloating RAM.
2. **"Late-Join" API Fallback (Tier 2):** If a mobile client wakes up after a long pause (e.g., 10+ minutes), their queued next-track will be completely evicted. Instead of crashing with a 404, the system detects the missing track and **gracefully serves the absolute latest live track** (`current_track` or `next_track`).

This aligns with the core philosophy of "Generative Radio": if you tune in late, you shouldn't listen to what played 5 minutes ago—you should immediately snap back into the current live state.

## 2. Problem Statement & Analysis
Mobile clients maintain a local queue of Track IDs provided by the WebSocket or HTTP fallback endpoints. However, if the OS suspends network connectivity:
- Client is paused at `Track 4`. 
- Live server advances to `Track 20` (10 minutes later).
- Client wakes up and attempts HTTP GET `/api/audio/{Track_4_ID}` -> **404 Evicted**.
- Frontend lacks a mechanism to realize its queue is ancient, causing it to loop on the error instead of syncing.

Expanding our memory buffer indefinitely to catch these 10-minute stalls would require retaining dozens of MP3s in active RAM, unnecessarily bloating server overhead (especially relevant for 8GB/16GB M-series Mac Minis). A time-based timer is equally brittle because "latency" on mobile isn't linear. 

## 3. Proposed Solution: Two-Tier Eviction & Fallback

### Tier 1: The N=2 Sliding Window (Jitter Protection)
Instead of a fixed `asyncio.sleep(60)` timer, we use a strictly bounded FIFO queue (`collections.deque(maxlen=2)`).
- **Why N=2?** This retains the `current_track`, `next_track`, and the last two finished tracks. 
- **Benefit:** Covers up to ~4 minutes of generation and transition time. If a mobile request hits during normal background throttling, the file is still there. No timer drift possible.

### Tier 2: "Late Wake-Up" Fallback (State Convergence)
If a request arrives for an ID that has already fallen off the N=2 queue (meaning the gap is >4 minutes), we must stop looking into the past and **converge on the present**.
- The frontend currently expects `track-ready` events. 
- We will equip our REST fallback endpoints (`/api/radio/next-track` and `/api/audio/{id}`) to detect when a requested ID is completely gone from *all* retention buffers.
- When an evicted ID is detected, the endpoint returns a specialized catch-up response: `{"status": "evicted", "sync_now": <Current Best Track Metadata>}`.

## 4. Detailed Implementation (`backend/radio.py` & `main.py`)

### A. Add FIFO Retention to `RadioOrchestrator`
Replace the existing timer-based `_evict_after_delay()` with a queue-based approach.

```python
class RadioOrchestrator:
    def __init__(self, llm, acestep):
        # ... existing properties ...
        
        # New Properties for FIFO management:
        self._retention_buffer_size = int(os.getenv("TRACK_RETENTION_N", "2")) 
        self._eviction_queue = collections.deque(maxlen=self._retention_buffer_size)

    async def _advance_pipeline(self, new_current_track):
        # ... swaps current/next track as usual ... 
        
        if old_id:
            self._eviction_queue.append(old_id)
            self._apply_queue_evictions()

    def _apply_queue_evictions(self):
        """Immediately evict ANY tracks falling off the end of our N=2 queue."""
        # Since deque maxlen handles dropping oldest items automatically, 
        # we simply clear caches for keys NOT in our active set.
        active_ids = {t.id for t in [self.current_track, self.next_track] if t} | set(self._eviction_queue)
        
        for key in list(self.audio_cache.keys()):
            if key not in active_ids:
                self.audio_cache.pop(key)
                # Remove associated metadata to save RAM
                self.prompt_cache.pop(key, None) 
                self.seed_cache.pop(key, None)
```

### B. Modify Audio Endpoint to Detect "Deep Eviction"
Update `GET /api/audio/{track_id}` in `main.py`:

```python
@app.get("/api/audio/{track_id}")
async def get_audio(track_id: str):
    audio_bytes = radio.audio_cache.get(track_id)
    
    # Normal path: serve the file (covers Tier 1 N=2 buffer hits)
    if audio_bytes:
        return StreamingResponse(...) 

    # Path 2: Track is evicted. Client is significantly behind ("Late Wake-up").
    # We catch the exact ID requested. If it's NOT in the audio cache, 
    # we check reaction_metadata_cache to see if it was ever real (prevents 404s for typos).
    
    if track_id in radio.reaction_metadata_cache:
        # It WAS a real track, but it's gone now. Server forces a sync to the live feed.
        best_live_track = radio.get_current_best_track()
        return JSONResponse(content={
            "status": "evicted", 
            "message": "Track expired due to session lag.",
            "sync_now": radio._make_track_dict(best_live_track) if best_live_track else None 
        })

    # Path 3: It was never a real track
    raise HTTPException(status_code=404, detail="Track not found")
```
*Note: The frontend mobile logic handles this by intercepting the JSON response. If `status == 'evicted'`, it discards its locally queued Track 4, immediately replaces it with `sync_now` (e.g., Track 20), and starts fetching audio.*

## 5. Memory Impact Analysis (Revised)
Reducing retention to strictly **N=2** tracks further minimizes the RAM footprint compared to the previous N=3 proposal.

| Component | Size per Track | Buffer Retained (N=2) | Total Overhead |
|:--|--|--:|--:|
| MP3 Bytes (`audio_cache`) | ~1 MB | x2 | ~2 MB |
| Metadata, Prompt, Lyrics | < 10 KB | x2 | Negligible (< 100 KB) |

Total additional overhead for the sliding window is **< 2.5MB**, which is extremely safe for memory-constrained hardware like an M1 Mac Mini (8GB). The server avoids retaining massive history caches while ensuring a "soft landing" for mobile clients waking up from sleep mode. 

## 6. Final Considerations
- **Frontend adaptation:** A small addition to the mobile `AudioService` is required: if it sees `evicted`, clear local queue and play the returned `sync_now` object immediately. 
- **Reaction data resilience:** As noted in previous architecture breakdowns, `reaction_metadata_cache` survives the active pipeline much longer than `audio_cache`. Users waking up after a long pause can still reliably "Like/Dislike" tracks even if they can't retroactively download the audio for them.
