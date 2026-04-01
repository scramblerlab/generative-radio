# Android Background Audio Architecture

## Problem

When a track ends while the app is backgrounded on Android, the next track must download and play automatically — without the user foregrounding the app. iOS already handles this correctly (PR #68). Android does not.

## Root Cause

`await fetch()` in the JS thread hangs indefinitely in Android background, even with a foreground media service running. This is **not** a Doze network restriction — it is a delivery-queue mismatch.

### Why fetch() hangs but expo-audio events do not

| Delivery path | Behaviour in Android background |
|---|---|
| OkHttp → React Native `NetworkingModule` → JS bridge | **Deferred/frozen** — Android deprioritises this queue when the app is backgrounded, even with a foreground service |
| Native `RCTDeviceEventEmitter.emit()` / JSI event | **Delivered** — same path expo-audio uses for `playbackStatusUpdate` and `didJustFinish`; empirically confirmed by heartbeat logs |

This was confirmed by logs showing `[BG] Heartbeat` arriving in JS while `GET /api/radio/status` hung indefinitely without resolving.

### Why AbortController does not help

`ctrl.abort()` propagates through the same `NetworkingModule` path that is frozen. The abort signal cannot reach OkHttp's in-flight call while that queue is stalled. Calling `abort()` from a heartbeat listener does not unblock the pending `await fetch()`.

### Why setTimeout / setInterval are unreliable

Android Doze mode suspends the Hermes JS event loop's timer queue. Neither retry loops nor abort timeouts fire reliably in background.

## Solution

### BackgroundHttpModule (Kotlin native module)

`BackgroundHttpModule` makes HTTP calls on `Dispatchers.IO` (a Kotlin coroutine thread pool) and delivers results as `RCTDeviceEventEmitter` events — the same delivery path that is proven to reach JS in Android background.

**Methods:**
- `fetchStatus(url, requestId)` — GET, emits `BackgroundHttp.statusResult`
- `sendTrackEnded(url)` — fire-and-forget POST

**Why this works:** OkHttp is called from a native Kotlin coroutine, not from the JS thread. The response is returned to JS via the event emitter (not the networking module queue), bypassing the frozen delivery path entirely.

## Architecture

### Platform separation rule

Any function needing platform-specific behaviour in more than two places is split into `functionNameIOS` / `functionNameAndroid` helpers called from a single dispatcher. No scattered `if (Platform.OS)` blocks within shared logic.

### Background entry (`AppState → 'background'`)

| Platform | Action |
|---|---|
| **iOS** | `handleBackgroundIOS()` — remove `playbackStatusUpdate` listener (prevents cpulimit kill from 500 ms JS wakeups), set backup `setTimeout` near expected track end |
| **Android** | `handleBackgroundAndroid()` — keep listener alive (needed for `didJustFinish`), pre-start silence bridge to eliminate the foreground-service gap during track transition |

### Track-end handling (`handleTrackEnded`)

| Condition | Path |
|---|---|
| Android + backgrounded | `handleTrackEndedAndroid()` — native HTTP |
| iOS or Android foreground | Standard path — `startSilenceBridge` + JS `fetch` + `fetchAndPlay` |

### Android background track-end flow

```
didJustFinish fires (native event — always delivered ✅)
  → handleTrackEnded()
      → handleTrackEndedAndroid()
          → startSilenceBridge()               [ensures foreground service continuity]
          → sendTrackEndedNative(url)          [Kotlin POST, fire-and-forget]
          → fetchStatusNative(url, id, cb)     [Kotlin GET → RCTDeviceEventEmitter event]

'BackgroundHttp.statusResult' event arrives in JS ✅
  → handleNativeStatusResult(result)
      → parse JSON body
      → no track / same track: retry in 5 s via setTimeout
      → new track: fetchAndPlay(prefetchedTrack)
          → skip JS fetch (prefetchedTrack supplied)
          → downloadAudio()                    [background downloader — works fine]
          → player.play()
          → stopSilenceBridge()
```

### Foreground return (`AppState → 'active'`)

| Platform | Action |
|---|---|
| **iOS** | `handleForegroundIOS()` — re-attach `playbackStatusUpdate` listener, cancel backup timer |
| **Android** | Cancel in-flight native status fetch listener; `isFetchingRef` reset clears any stuck state |
| **Both** | Cancel backup timers, reconnect WebSocket, call `handleWake()` |

### `fetchAndPlay(prefetchedTrack?)` signature

`fetchAndPlay` accepts an optional `prefetchedTrack: Track`. When supplied (Android background path), the `GET /api/radio/status` fetch is skipped and the supplied track is used directly. All download + play logic is shared between both paths.

## Files

| File | Purpose |
|---|---|
| `mobile/android/app/src/main/java/com/generativeradio/app/BackgroundHttpModule.kt` | Kotlin native module — HTTP on Dispatchers.IO, results as events |
| `mobile/android/app/src/main/java/com/generativeradio/app/BackgroundHttpPackage.kt` | ReactPackage registration |
| `mobile/android/app/src/main/java/com/generativeradio/app/MainApplication.kt` | Registers `BackgroundHttpPackage` |
| `mobile/src/modules/backgroundHttp.ts` | JS interface — `fetchStatusNative`, `sendTrackEndedNative` |
| `mobile/src/hooks/useRadio.ts` | Hook — platform helpers, `handleTrackEnded` dispatcher, AppState handler |

## iOS

No changes from the PR #68 baseline. iOS uses `AVAudioSession` (silence bridge), `AVPlayerItemDidPlayToEndTime` for track-end detection, and regular JS `fetch()` — all of which work correctly in iOS background.
