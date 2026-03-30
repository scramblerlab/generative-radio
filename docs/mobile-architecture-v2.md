# Mobile App Architecture v2: HTTP-First, Sleep-Tolerant Design

> **Handoff document** for implementing the new mobile architecture.
> Written after extensive codebase exploration and research. Read this fully before touching any code.

---

## Why This Rewrite

The current mobile app (`mobile/src/hooks/useRadio.ts`, ~800 lines) uses a WebSocket-driven pre-fetch state machine. While this mirrors the web frontend, it fails on mobile because:

1. **Pre-fetch race conditions under sleep:** When iOS suspends the app, the `prefetchNextTrack()` download may complete but the completion callback never fires. On wake, `nextTrackRef`/`nextQueuedRef`/`queueEndedRef` are in an unknown state — the state machine can't determine if the download succeeded, if the track already ended, or if the WS `track_ready` was missed.

2. **WS dependency for track delivery:** The app needs to receive `track_ready` events while backgrounded. iOS doesn't guarantee this — background WS is fragile.

3. **Three-way ref interlock:** `nextTrackRef`, `nextQueuedRef`, `queueEndedRef` must all be consistent for correct behavior. Any one becoming stale breaks the `prefetchNextTrack` and `PlaybackQueueEnded` handlers.

**The fix:** Remove pre-fetch entirely. Download on demand, play immediately, repeat. WebSocket becomes best-effort.

---

## Codebase Overview (read before editing)

### Backend (Python / FastAPI)
- `backend/main.py` — REST + WebSocket endpoints, `SecurityHeadersMiddleware`
- `backend/radio.py` — `RadioOrchestrator`: async state machine, track lifecycle, watchdog
- `backend/models.py` — Pydantic models: `SongPrompt`, `TrackInfo`, `WSMessage`
- `backend/llm.py` — Ollama/Qwen client → `SongPrompt`
- `backend/acestep_client.py` — ACE-Step submit/poll/download pipeline

Key backend facts:
- `self.current_track` = track being played; `self.next_track` = pre-buffered next
- `audio_cache[track_id]` = raw MP3 bytes (in-memory, evicted on track transition)
- `track_ended` WS event has a **5-second debounce** — duplicate signals within 5s are ignored
- Watchdog fires `play_now` after `duration + 3` seconds if no `track_ended` received
- `GET /api/radio/status` returns `{ state, currentTrack: TrackInfo | null, nextReady, listenerCount }`
- `GET /api/audio/{track_id}` streams MP3 from `audio_cache` (returns 404 if evicted)

### Mobile (React Native / Expo 55)
- `mobile/src/hooks/useRadio.ts` — **entire business logic (800 lines)** — this is the main rewrite target
- `mobile/src/components/RadioPlayer.tsx` — player UI, needs prop cleanup
- `mobile/src/components/GenreSelector.tsx` — genre/mood selector
- `mobile/src/navigation/AppNavigator.tsx` — role-based navigation, blocks on WS connect
- `mobile/src/playbackService.ts` — RNTP background service (lock screen controls) — **keep as-is**
- `mobile/app.json` — Expo config (needs Android permissions added)

### Shared types
- `packages/shared/src/types.ts` (or similar) — `Track`, `RadioStatus`, `WSMessage`, etc.
- Mobile `Track` type has: `id`, `songTitle`, `genre`, `tags`, `lyrics`, `bpm`, `keyScale`, `duration`, `audioUrl`, `djName`, `djKeywords`, `djLanguage`, `isRandom`

---

## New Architecture

### Design principles

1. **HTTP-first for track flow:** `GET /api/radio/status` to check availability, `GET /api/audio/{id}` to download. No WS events needed for playback.
2. **WebSocket best-effort:** Still connect WS for session control (`start`, `stop`, DJ events). If WS dies during sleep, core playback continues.
3. **Download-then-play:** No streaming, no pre-fetch. Download completes fully before RNTP is given the file.
4. **Sleep-tolerant:** Every state transition is recoverable from. `handleWake()` inspects actual RNTP state to decide what to do.
5. **Single-track queue:** RNTP always has exactly one track loaded. No queue management needed.

---

## New State Machine

### States

```
IDLE      — No session running, RNTP empty
FETCHING  — Downloading current track (GET /status → download audio)
POLLING   — Server has no track yet; polling /api/radio/status every 10s
PLAYING   — RNTP playing (may be in background — iOS handles this)
PAUSED    — User manually paused (track still loaded, position preserved)
ERROR     — Download failed after retries
```

### Transition diagram

```
                 startRadio()
App launch ──► IDLE ─────────────────────────────────────► FETCHING
                ↑                                          │       │
                │                                    track │       │ no track
              Stop()                              available│       │ on server
                │                                          │       ↓
                │                         track ends       │    POLLING ──────┐
                │                    (PlaybackQueueEnded)  │       │          │ still
                │                    ┌──────────────────── │ ─────►│          │ no track
                │                    │                     │    new│          │
                │                    │                     │  track│          │
                │                    ▼                     ▼       ▼          │
                │                FETCHING ◄─────────────────────────── ◄──────┘
                │                    │
                │           download complete:
                │           send track_ended → play
                │                    ↓
                │                PLAYING
                │                    │
                │              pause/play
                │                    ↓
                └──────────────── PAUSED

App wakes (AppState → 'active'):
  PLAYING  + RNTP still playing   → do nothing (background audio survived)
  PLAYING  + RNTP stopped         → FETCHING (track ended while sleeping)
  POLLING  + woke up              → restart poll interval (was suspended)
  FETCHING + woke up              → re-attach download task OR check file exists OR restart

ERROR: retry button → FETCHING
```

### Key timing note

`track_ended` is sent to the server **after download completes, before playback begins**. This gives the server maximum time to generate the next track while the current one plays — reducing (but not eliminating) the polling gap at the end.

---

## Implementation: New `useRadio.ts`

### Eliminated vs current

| Current ref/event | New status |
|-------------------|------------|
| `nextTrackRef` | **Gone** — no pre-fetch |
| `nextQueuedRef` | **Gone** — no queue management |
| `queueEndedRef` | **Gone** — `PlaybackQueueEnded` triggers `fetchAndPlay()` directly |
| `localPausedRef` | **Gone** — use `radioState === 'paused'` |
| `PlaybackActiveTrackChanged` handler (60 lines) | **Gone** — single-track queue, no advance |
| `wsRef`, `pingIntervalRef`, `reconnectTimer/Delay` | **Keep** — WS still used for start/stop/DJ |
| `playerReadyRef`, `isActiveRef` | **Keep** — same guards |

### Minimal state & refs

```typescript
// React state (drives re-renders)
type MobileRadioState = 'idle' | 'fetching' | 'polling' | 'playing' | 'paused' | 'error';

const [radioState, setRadioState] = useState<MobileRadioState>('idle');
const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
const [progress, setProgress] = useState(0);
const [audioDuration, setAudioDuration] = useState<number | null>(null);
const [statusMessage, setStatusMessage] = useState('');
const [errorMessage, setErrorMessage] = useState<string | null>(null);

// Refs
const currentTrackIdRef = useRef<string | null>(null); // detect "new track" on poll
const playerReadyRef = useRef(false);
const wsRef = useRef<WebSocket | null>(null);
const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
const isFetchingRef = useRef(false);  // mutex: prevents concurrent fetchAndPlay()
const isActiveRef = useRef(false);
const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
```

### Core function: `fetchAndPlay()`

This replaces ~200 lines of WS event handlers.

```
1. Guard: if isFetchingRef.current → return (mutex)
   Set isFetchingRef = true, radioState = 'fetching'

2. GET /api/radio/status
   → currentTrack is null OR state is idle/stopped
     → setRadioState('polling'); startPolling(); isFetchingRef = false; return

   → currentTrack.id === currentTrackIdRef.current (same track as before)
     → check RNTP state:
         Playing/Buffering → setRadioState('playing'); isFetchingRef = false; return
                              (woke mid-track, RNTP still running)
         Stopped/None      → startPolling(); isFetchingRef = false; return
                              (track ended, server hasn't advanced yet; poll)

   → new track → continue

3. Download audio using @kesha-antonov/react-native-background-downloader:
   const localPath = `${documentDirectory}track_current.mp3`
   delete old file if exists (idempotent)
   start download task with id='current-track', destination=localPath
   await task.done()

   → 404 response → server eviction race: go back to step 2 (re-fetch status)
   → other failure after 2 attempts → setRadioState('error'); isFetchingRef = false; return

4. sendTrackEnded()  ← kicks server to generate next track
   (BEFORE playback begins so server has max time)

5. await TrackPlayer.reset()
   await TrackPlayer.add({ id: track.id, url: localPath, title, artist, duration })
   await TrackPlayer.play()
   currentTrackIdRef.current = track.id
   setCurrentTrack(track)
   setRadioState('playing')

6. isFetchingRef = false
```

### `handleTrackEnded()` — called by RNTP `PlaybackQueueEnded`

```
if radioState === 'paused' → return  (user paused, don't auto-advance)
if isFetchingRef.current  → return  (already fetching)

// Clean up finished file (no caching)
delete documentDirectory/track_current.mp3 (idempotent)

fetchAndPlay()
```

No `nextTrackRef` check. No `nextQueuedRef`. Just fetch latest.

### `handleWake()` — called by AppState `change` → `'active'`

```
1. If state === 'polling':
   → stopPolling() then startPolling()  (restart the interval timer)
   → return

2. If state === 'fetching':
   → Check getExistingDownloadTasks() for 'current-track' task
   → If found: re-attach .done() handler (download still running or just completed)
   → If not found:
       Check if file exists at documentDirectory/track_current.mp3
       → exists → send track_ended + play (download completed while sleeping)
       → not found → isFetchingRef = false; fetchAndPlay() from step 1

3. If state === 'playing':
   → Get RNTP state
   → Playing/Buffering → do nothing
   → Stopped/None → isFetchingRef = false; fetchAndPlay()  (ended while sleeping)

4. If state === 'paused':
   → Do nothing (user paused, track still loaded)
```

### `sendTrackEnded()`

```typescript
// WS primary (fast); HTTP fallback when WS dead after sleep
if (wsRef.current?.readyState === WebSocket.OPEN) {
  wsRef.current.send(JSON.stringify({ event: 'track_ended' }));
  return;
}
// HTTP fallback — new backend endpoint
try {
  await fetch(`${BACKEND_URL}/api/radio/track-ended`, { method: 'POST' });
} catch {
  // best-effort; if both fail, server's play_now watchdog fires after duration+3s
}
```

### `startPolling()` / `stopPolling()`

```typescript
function startPolling() {
  if (pollTimerRef.current) return; // already running
  setRadioState('polling');
  pollTimerRef.current = setInterval(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/radio/status`);
      const data = await res.json();
      if (data.currentTrack && data.currentTrack.id !== currentTrackIdRef.current) {
        stopPolling();
        fetchAndPlay();
      }
    } catch { /* network error, try again next interval */ }
  }, 10_000);
}

function stopPolling() {
  if (pollTimerRef.current) {
    clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;
  }
}
```

### AppState handler

```typescript
useEffect(() => {
  const sub = AppState.addEventListener('change', async (nextState) => {
    if (nextState === 'active') {
      await handleWake();
    } else {
      // background/inactive: suspend poll timer (iOS may kill it anyway)
      stopPolling();
      // isFetchingRef stays true if download is running;
      // @kesha-antonov downloader continues via nsurlsessiond independently
    }
  });
  return () => sub.remove();
}, []);
```

### RNTP events (simplified)

```typescript
// The only structural event — drives state transitions
useTrackPlayerEvents([Event.PlaybackQueueEnded], () => {
  handleTrackEnded();
});

// Error recovery (simplified from current)
useTrackPlayerEvents([Event.PlaybackError], async (event) => {
  await new Promise(r => setTimeout(r, 1000)); // wait for self-recovery
  const { state } = await TrackPlayer.getPlaybackState();
  if (state === State.Playing || state === State.Buffering) return; // recovered
  if (radioState === 'playing') {
    isFetchingRef.current = false;
    fetchAndPlay(); // restart from current track
  }
});

// PlaybackActiveTrackChanged NOT needed — single-track queue, no advance logic
```

---

## Backend Changes Required

> All changes are **additive** and do not affect the existing WS-based web frontend flow. The web app receives track data exclusively via WS events and never calls `/api/radio/status`. Verified by code search.

### 1. `POST /api/radio/track-ended` (new endpoint)

**File:** `backend/main.py`

HTTP fallback for mobile — WS may be dead after sleep.

```python
@app.post("/api/radio/track-ended")
async def http_track_ended(request: Request):
    """HTTP fallback for mobile track_ended signal.
    Used when WebSocket is unavailable (e.g. after app wake from sleep).
    Subject to same 5-second debounce as WS handler.
    """
    # Optional: restrict to local IPs (same as /api/tracks/{id}/save)
    # client_host = request.client.host
    # if not (client_host.startswith("192.168.") or client_host in ("127.0.0.1", "::1")):
    #     raise HTTPException(status_code=403)
    logger.info("[main] POST /api/radio/track-ended (HTTP fallback)")
    await radio.on_track_ended()
    return {"ok": True}
```

Both WS and HTTP paths call the same `on_track_ended()` which has the 5s debounce — duplicate signals within 5s are silently dropped.

### 2. Delayed audio cache eviction (60s grace period)

**File:** `backend/radio.py`

**Problem:** `audio_cache.pop(old_id)` fires immediately when a track transitions. If mobile is mid-download when server advances, the download gets 404.

**Fix:** Add `_evict_after_delay()` method and use it instead of immediate `pop()`:

```python
async def _evict_after_delay(self, track_id: str, delay: float = 60.0) -> None:
    """Evict track data from all caches after a grace period.

    60 seconds gives mobile clients time to complete a download even if
    the server advances to the next track mid-flight.
    """
    await asyncio.sleep(delay)
    self.audio_cache.pop(track_id, None)
    self.prompt_cache.pop(track_id, None)
    self.seed_cache.pop(track_id, None)
    self.track_info_cache.pop(track_id, None)
    logger.debug(f"[radio] Evicted cache for track {track_id} (60s delay)")
```

Find the immediate `pop()` calls (search for `audio_cache.pop`) and replace with:
```python
asyncio.create_task(self._evict_after_delay(old_id, delay=60.0))
```

**Web UI impact:** None. Web frontend creates a blob URL immediately on download and never re-fetches.
**Memory impact:** ~3-5 MB additional (one extra track in cache). Negligible on M1+.
**Save Track impact:** Positive — users get a 60s window instead of 0s to save after a track ends.

### 3. Add missing fields to `/api/radio/status` response

**File:** `backend/main.py`, in `GET /api/radio/status`, the `track = { ... }` dict.

Currently missing `genre`, `isRandom`, `djName`, `djKeywords`, `djLanguage`. Mobile `RadioPlayer` displays these. Add them:

```python
track = {
    "id": ct.id,
    "songTitle": ct.song_title,
    "genre": ct.genre,            # add
    "isRandom": ct.is_random,     # add
    "tags": ct.tags,
    "lyrics": ct.lyrics,
    "bpm": ct.bpm,
    "keyScale": ct.key_scale,
    "duration": ct.duration,
    "audioUrl": ct.audio_url,
    "djName": ct.dj_name,         # add
    "djKeywords": ct.dj_keywords, # add
    "djLanguage": ct.dj_language, # add
}
```

**Web UI impact:** None. Web frontend never calls this endpoint.

---

## Mobile Dependency Change

### Replace `react-native-blob-util` download with `@kesha-antonov/react-native-background-downloader`

**Why:** `react-native-blob-util` with `IOSBackgroundTask: true` does use NSURLSession background downloads (correct), but its completion callbacks don't fire reliably when the app is backgrounded — they only fire on foreground return. Without proper `handleEventsForBackgroundURLSession` in AppDelegate (which Expo's managed AppDelegate may not forward), the `await RNBlobUtil...fetch()` call never resolves after sleep, leaving `isFetchingRef` permanently locked.

`@kesha-antonov/react-native-background-downloader` has:
- ✅ `getExistingDownloadTasks()` — re-attach to in-flight downloads after sleep/kill
- ✅ Full TurboModules support
- ✅ Clear AppDelegate setup documented
- ✅ Actively maintained (March 2026)

**react-native-blob-util stays** in the project for any non-download file operations.

### Installation

```bash
cd mobile
npm install @kesha-antonov/react-native-background-downloader
```

### AppDelegate setup (required for iOS background callbacks)

In `mobile/ios/*/AppDelegate.mm` (or `.swift`):

```objc
// Objective-C
#import "RNBackgroundDownloader.h"

- (void)application:(UIApplication *)application
  handleEventsForBackgroundURLSession:(NSString *)identifier
  completionHandler:(void (^)(void))completionHandler {
  [RNBackgroundDownloader handleEventsForBackgroundURLSession:identifier
                                           completionHandler:completionHandler];
}
```

For Expo EAS builds, add via a Config Plugin if native AppDelegate modification is needed.

### Download usage pattern

```typescript
import RNBackgroundDownloader from '@kesha-antonov/react-native-background-downloader';
import * as FileSystem from 'expo-file-system';

const CURRENT_TRACK_PATH = `${FileSystem.documentDirectory}track_current.mp3`;
const DOWNLOAD_TASK_ID = 'current-track';

async function downloadAudio(track: Track): Promise<string> {
  // Clean up previous file
  await FileSystem.deleteAsync(CURRENT_TRACK_PATH, { idempotent: true }).catch(() => {});

  const url = `${BACKEND_URL}${track.audioUrl}`;

  return new Promise((resolve, reject) => {
    const task = RNBackgroundDownloader.download({
      id: DOWNLOAD_TASK_ID,
      url,
      destination: CURRENT_TRACK_PATH.replace('file://', ''),
    });

    task
      .begin(({ expectedBytes }) => {
        console.log(`[Download] Starting ${track.songTitle} (${expectedBytes} bytes)`);
      })
      .done(() => {
        console.log(`[Download] Complete: ${CURRENT_TRACK_PATH}`);
        resolve(CURRENT_TRACK_PATH);
      })
      .error((error) => {
        console.error(`[Download] Error: ${error}`);
        reject(new Error(error));
      });
  });
}

// In handleWake(), for re-attachment:
async function resumeOrRestartFetch(): Promise<void> {
  const tasks = await RNBackgroundDownloader.getExistingDownloadTasks();
  const inFlight = tasks.find(t => t.id === DOWNLOAD_TASK_ID);

  if (inFlight) {
    // Download survived sleep — re-attach handlers
    inFlight.done().then(() => {
      // proceed to sendTrackEnded() + play
    });
    return;
  }

  // Check if download silently completed while sleeping
  const info = await FileSystem.getInfoAsync(CURRENT_TRACK_PATH);
  if (info.exists && info.size > 0) {
    // Download completed while sleeping, callback was missed
    isFetchingRef.current = false;
    // proceed directly to sendTrackEnded() + play
    return;
  }

  // Download was cancelled (force-kill, etc.) — restart from scratch
  isFetchingRef.current = false;
  fetchAndPlay();
}
```

---

## Component Changes

### `RadioPlayer.tsx`

- **Remove** `nextReady: boolean` prop — no pre-fetch, so "next track ready" concept is gone
- **Remove** `activityLog: ActivityEntry[]` prop — WS `progress` events are best-effort; drop the ticker on mobile
- **Status label** simplifies to 5 cases:
  ```typescript
  const statusLabel =
    radioState === 'fetching'  ? 'Loading track...' :
    radioState === 'polling'   ? 'Waiting for radio...' :
    radioState === 'playing'   ? (currentTrack?.songTitle ?? 'Playing') :
    radioState === 'paused'    ? 'Paused' :
    radioState === 'error'     ? 'Error — tap retry' : '';
  ```
- **Remove** the `BottomStatusBar` green dot for "next ready"
- **Keep** pause/play, seek, save track, DJ claim button (if applicable)

### `AppNavigator.tsx`

- **Remove** blocking spinner that waits for WS `role_assigned` before showing UI
- WS connects in background; show UI immediately
- Mobile connects to WS as viewer: `${WS_URL}/ws?role=viewer` — needs corresponding backend guard (or just leave it; mobile won't send `start` events anyway)

### `GenreSelector.tsx`

Decision needed: is mobile always a viewer, or can it also be a controller?

- **Always-viewer** (recommended): Replace `GenreSelector` with a simple "Tune In" button that calls `fetchAndPlay()`. Remove the Stack navigator — one screen.
- **Can be controller**: Keep `GenreSelector` but change `onStart` to call HTTP or WS `start` and immediately call `fetchAndPlay()` — don't wait for WS `track_ready`.

---

## RNTP Configuration Changes

### `mobile/app.json` — Add Android permissions (currently missing)

```json
"android": {
  "package": "com.generativeradio.app",
  "permissions": [
    "android.permission.INTERNET",
    "android.permission.WAKE_LOCK",
    "android.permission.FOREGROUND_SERVICE"
  ]
}
```

### `mobile/src/hooks/useRadio.ts` — `setupPlayer()` and `updateOptions()`

```typescript
// Add to setupPlayer():
iosCategoryOptions: [IOSCategoryOptions.DuckOthers],  // lower other apps' volume

// Add to updateOptions():
android: {
  appKilledPlaybackBehavior: AppKilledPlaybackBehavior.PausePlayback,
  // keeps notification visible; user can resume from notification tray
},
```

These are already imported via RNTP's constant exports.

---

## Background Audio Reliability

The new architecture is designed to be resilient to background audio interruptions.

### iOS: what's already working

- `UIBackgroundModes: ["audio"]` in `app.json` — prevents process suspension during audio ✅
- `iosCategoryOptions: IOSCategory.Playback` — correct category for radio ✅
- `autoHandleInterruptions: true` — auto-resumes after calls/Siri ✅
- Download to `documentDirectory` (not `Caches`) — prevents `-12864 FigFilePlayer` error ✅
- Download to `file://` (not HTTP streaming) — prevents `-12860 PlayerRemoteXPC` error ✅
- `PlaybackError` handler with 1s wait + manual recovery ✅

### Android: what's missing

- `WAKE_LOCK` + `FOREGROUND_SERVICE` permissions (add to `app.json` — see above)
- `appKilledPlaybackBehavior: PausePlayback` (add to `updateOptions` — see above)
- Doze mode (screen off + stationary + low battery ~1h) can interfere; WS ping mitigates; can't fully prevent

### Reliability summary

| Scenario | Expected reliability |
|----------|---------------------|
| iOS: track playing while app backgrounded | High — `UIBackgroundModes` + `file://` |
| iOS: track ends while backgrounded | High — RNTP fires `PlaybackQueueEnded`; `handleWake()` catches missed events |
| iOS: call/Siri interruption | Med-High — `autoHandleInterruptions` + error handler |
| Android: screen off, Doze not active | High — RNTP foreground service + `WAKE_LOCK` |
| Android: Doze mode | Medium — WS ping reduces risk; advise users to whitelist app |

---

## Trade-offs and Accepted Limitations

| Limitation | Description | Accepted because |
|-----------|-------------|-----------------|
| **Silence gap** | 0–90s silence after track ends if server hasn't generated next track | `track_ended` sent before playback begins to maximize server head time; gap is rare on a warmed-up server |
| **No gapless playback** | Brief pause between tracks while downloading (usually <1s on local WiFi) | Acceptable for this use case; eliminates all the complexity of pre-fetch |
| **Same-track detection** | If server still shows the same track after polling, need to distinguish "still playing" vs "server catching up" | Handled by `currentTrackIdRef` + RNTP state check in `fetchAndPlay()` |
| **Force-kill cancels download** | If user force-kills from App Switcher during download, NSURLSession task is cancelled | NSURLSession limitation; `handleWake()` restarts download on next open |
| **Android Doze mode** | Can interrupt audio after ~1h inactivity | iOS is primary platform; Android is best-effort |

---

## Implementation Sequence

Work in this order to avoid breaking the current app during migration:

### Phase 1: Backend (unblocks mobile, web unaffected)
1. Add `genre`, `isRandom`, `djName`, `djKeywords`, `djLanguage` to `/api/radio/status` response
2. Add `POST /api/radio/track-ended` endpoint
3. Implement `_evict_after_delay(60s)` in `radio.py`

### Phase 2: New download module
1. `npm install @kesha-antonov/react-native-background-downloader`
2. Add AppDelegate `handleEventsForBackgroundURLSession` setup
3. Write `downloadAudio()` wrapper using new library

### Phase 3: Rewrite `useRadio.ts`
1. Replace state/refs with minimal set
2. Implement `fetchAndPlay()`, `handleTrackEnded()`, `handleWake()`, `startPolling()`
3. Simplify WS: remove state machine dependency; keep for start/stop/DJ/status only
4. Wire RNTP: only `PlaybackQueueEnded` + `PlaybackError` events matter
5. Update AppState handler

### Phase 4: Component cleanup
1. Remove `nextReady` prop from `RadioPlayer`; simplify status labels
2. Remove `activityLog` prop (or make optional if you want to keep it)
3. Fix `AppNavigator`: remove WS-blocking spinner
4. Decide controller/viewer: simplify or replace `GenreSelector`

### Phase 5: Config
1. Add Android permissions to `app.json`
2. Add `iosCategoryOptions` + `appKilledPlaybackBehavior` to `useRadio.ts` RNTP setup

---

## Verification Checklist

- [ ] **Basic playback:** Tap "Tune In" → track loads → plays
- [ ] **track_ended delivery:** Confirm in backend logs that `POST /api/radio/track-ended` appears after download
- [ ] **Lock screen controls:** Play/pause from lock screen work while app backgrounded
- [ ] **Sleep mid-track:** Start playing → lock phone for longer than track duration → unlock → verify new track starts (`handleWake` path exercised)
- [ ] **Sleep during polling:** Manually put server in generating state → background app → wait → open app → verify polling resumed and track plays
- [ ] **Sleep mid-download:** Start a track → background app immediately → wait 30s → open → verify track plays (download re-attached or file check succeeded)
- [ ] **WS disconnected:** Kill WS from server side → verify HTTP `track_ended` fallback works
- [ ] **Eviction race:** Reduce eviction delay to 2s → rapid skip → verify mobile 404 triggers re-fetch
- [ ] **Android Doze:** `adb shell dumpsys deviceidle force-idle` → verify audio survives

---

## Files to Edit (summary)

| File | Change |
|------|--------|
| `backend/main.py` | Add `POST /api/radio/track-ended`; add fields to status response |
| `backend/radio.py` | Replace immediate cache eviction with `_evict_after_delay(60s)` |
| `mobile/src/hooks/useRadio.ts` | **Full rewrite** using design above |
| `mobile/src/components/RadioPlayer.tsx` | Remove `nextReady`, `activityLog` props; simplify status |
| `mobile/src/navigation/AppNavigator.tsx` | Remove WS-blocking spinner; update WS URL to include `?role=viewer` |
| `mobile/src/components/GenreSelector.tsx` | Simplify to "Tune In" button (if always-viewer) |
| `mobile/app.json` | Add Android permissions |
| `mobile/ios/*/AppDelegate.mm` | Add `handleEventsForBackgroundURLSession` for background downloads |
| `mobile/package.json` | Add `@kesha-antonov/react-native-background-downloader` |
