# Mobile Playback Stability & Interruption Handling — Implementation Plan

_Generated: 2026-06-15. Implementation will be done on a different Mac by another AI model — this doc is a self-contained handoff. Read it fully before writing code._

## Problem

On iOS the radio **stops playing at random** and **never recovers after another app's notification/interruption** (notification sound, phone call, Siri, alarm, another media app, AirPods route change). Expected: a transient OS interruption pauses briefly and then **auto-resumes after it ends**, while an *explicit* user pause (lock-screen / Control Center / Android notification) stays paused. Android is expected to share the defect.

Related prior investigation (background-audio config, already applied): [docs/ios-background-audio-investigation.md](./ios-background-audio-investigation.md). This plan addresses a **different** root cause (interruption misclassification), not background config.

## Root cause (confirmed against the codebase + expo-audio native source)

In the `playbackStatusUpdate` listener at `mobile/src/hooks/useRadio.ts:612-630`, **every** external native pause is committed as deliberate user intent (`localPausedRef.current = true`).

An OS interruption produces the **identical** JS event. With `interruptionMode: 'doNotMix'`, expo-audio's native layer pauses the player on interruption (`node_modules/expo-audio/ios/AudioModule.swift:557-594`; Android focus loss at `node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt:68-116`). The lock-screen pause path (`ios/MediaController.swift:142-160`) calls the same `player.pause()`. **expo-audio exposes no JS event** to distinguish them — `AudioEvents` is only `playbackStatusUpdate` / `audioSampleUpdate`.

Once `localPaused` is wrongly `true`, **all recovery paths bail**: `handleWake` (`:747`), `play_now` watchdog (`:852`), `didJustFinish` (`:603`), WS-reconnect resync (`:800`). The radio goes silent permanently. This is the single root cause behind both reported symptoms.

Native auto-resume exists but is conditional: iOS only when iOS includes `.shouldResume` (`AudioModule.swift:599`); Android only on `AUDIOFOCUS_GAIN` after a *transient* loss (`AudioModule.kt:104`). For notification sounds, background interruptions, `setActive(true)` failures, and permanent focus loss it never resumes — and JS has already corrupted `localPaused`.

**Key constraint:** the OS distinguishes interruption-pause from user-pause natively; JS cannot with current expo-audio events. We therefore patch the native module to emit an interruption event, then make JS interruption-aware.

**Design decision (from product owner): respect explicit pause.** An explicit lock-screen/Control-Center pause must stay paused; only true OS interruptions auto-resume.

**Elegant consequence:** once JS stops corrupting `localPaused` during interruptions, the *existing* `handleWake` + `play_now` recovery paths heal playback automatically **even if the native `ended` event is never delivered**. The native event mainly provides prompt classification + resume.

---

## Implementation

### 1. Native patch via patch-package — emit `onInterruption` to JS

Both platforms' module is named `ExpoAudio`; neither declares `Events(...)` today. The JS native handle (`expo-audio/build/AudioModule` default export) is an `EventEmitter`, so declaring an event makes it subscribable from JS.

#### iOS — `node_modules/expo-audio/ios/AudioModule.swift`

Add to `definition()` (near `Name("ExpoAudio")`):
```swift
Events("onInterruption")
```
In `handleInterruptionBegan()` (~`:557`), at the end of the method:
```swift
self.sendEvent("onInterruption", ["type": "began"])
```
In `handleInterruptionEnded(with options:)` (~`:596`), emit regardless of `.shouldResume` so JS decides:
```swift
self.sendEvent("onInterruption", [
  "type": "ended",
  "shouldResume": options.contains(.shouldResume)
])
```
Leave the `routeChange` / `oldDeviceUnavailable` branch unchanged (headphone unplug should stay paused — do **not** emit `ended` there).

#### Android — `node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt`

Add to `definition()` (near `Name("ExpoAudio")`):
```kotlin
Events("onInterruption")
```
In `audioFocusChangeListener` (~`:68`):
- `AUDIOFOCUS_LOSS` and `AUDIOFOCUS_LOSS_TRANSIENT` branches → `sendEvent("onInterruption", bundleOf("type" to "began"))`
- `AUDIOFOCUS_GAIN` branch → `sendEvent("onInterruption", bundleOf("type" to "ended", "shouldResume" to true))`

(`sendEvent` is available on the Expo `Module` base class; `bundleOf` from `androidx.core.os`.)

#### Generate / wire the patch
```bash
cd generative-radio
npx patch-package expo-audio       # writes patches/expo-audio+55.0.10-canary-20260328-bdc6273.patch
```
`postinstall` already runs `patch-package` (see `generative-radio/package.json`), so the patch auto-applies on install. Then:
```bash
cd mobile
npx expo prebuild --clean
npx expo run:ios --device          # or eas build; NOT Expo Go (background audio needs a real build)
```

### 2. JS — interruption-aware state machine (`mobile/src/hooks/useRadio.ts`)

Add a ref and subscribe to the native event. The native handle is a private path — acceptable since we own the patch:
```ts
import AudioModuleNative from 'expo-audio/build/AudioModule';

const interruptedRef = useRef(false);
const pauseClassifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

useEffect(() => {
  const sub = AudioModuleNative.addListener('onInterruption', (e: { type: 'began' | 'ended'; shouldResume?: boolean }) => {
    if (e.type === 'began') {
      interruptedRef.current = true;            // do NOT touch localPaused
      console.log('[Audio] interruption began');
    } else {
      interruptedRef.current = false;
      console.log('[Audio] interruption ended — shouldResume:', e.shouldResume);
      if (!localPausedRef.current) resumeAfterInterruption();
    }
  });
  return () => sub.remove();
}, []);
```
`resumeAfterInterruption()`: call `playerRef.current?.play()`, restart the progress timer, set `radioState='playing'`; after ~1 s verify `playerRef.current?.playing` — if still not audible, call `fetchAndPlayRef.current?.()` (player/session may have been torn down). Resume **regardless** of `shouldResume` (radio intent) as long as `!localPaused`.

**Fix the misclassification** at `:612-630`. The pause `playbackStatusUpdate` and the `onInterruption('began')` event may arrive in either order, so use a short **deferred classification** instead of committing immediately:
```ts
// when wasPlaying && !status.playing && !status.isBuffering && !localPausedRef.current:
if (pauseClassifyTimerRef.current) clearTimeout(pauseClassifyTimerRef.current);
pauseClassifyTimerRef.current = setTimeout(() => {
  pauseClassifyTimerRef.current = null;
  if (interruptedRef.current) return;          // OS interruption — keep play intent; ended/watchdog resumes
  // genuine widget/Control-Center pause:
  localPausedRef.current = true;
  setLocalPaused(true);
  setRadioState('paused');
}, 400);
```
Clear `pauseClassifyTimerRef` on any subsequent `playing:true` status, on `ended`, and in `tuneOut`. Keep the existing external **resume** detection (`:632-637`) — it still catches native auto-resume.

This satisfies both requirements: widget pause → no interruption flag → stays paused; interruption → play-intent preserved → resumes.

### 3. Listener consolidation + `mediaServicesDidReset` (`mobile/src/hooks/useRadio.ts`)

Extract one `attachPlaybackListener(player: AudioPlayer)` helper holding the logic currently inline at `:586-639`:
- `playbackState === 'failed'` recovery,
- `didJustFinish`,
- the new deferred external pause + external resume sync,
- **new** `status.mediaServicesDidReset` branch → treat like `failed` (null `currentTrackIdRef`, re-run `fetchAndPlay`).

Use it in **both** `fetchAndPlay` and `handleForegroundIOS` (`:347-368`). `handleForegroundIOS` currently lacks the external pause/resume sync — consolidation removes that drift. Preserve the iOS-background listener-removal behavior (the listener is still detached on background and the backup track-end timer logic stays).

### 4. Network/fetch hardening (`mobile/src/hooks/useRadio.ts`)

Add:
```ts
async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 12_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
```
Use it for: the status fetch in `fetchAndPlay` (`:500`), `startPolling` (`:460`), `sendTrackEnded` HTTP fallback (`:235`), `fetchReactions` (`:246`). Prevents a hung request from holding `isFetchingRef` until the 120 s zombie timeout and stalling next-track loading. The existing `fetchAndPlay` catch already releases the mutex + retries on abort.

---

## Verification

1. Apply patch + rebuild (commands in §1.3) on a real device / release build (not Expo Go).
2. **Interruption resume (primary):** play → trigger a notification-with-sound / short phone call / Siri / play+stop a YouTube clip. Audio should pause then **auto-resume within ~1–2 s** of the interruption ending, both foreground and locked. Repeat across a track transition.
3. **Respect explicit pause:** pause from lock screen / Control Center → **stays paused**; tap play → resumes. Same via Android notification controls.
4. **Lost `ended` fallback:** interrupt, then background→foreground → `handleWake` resumes; or wait for server `play_now` watchdog. Neither should be blocked.
5. **Android:** repeat 2–3 (notification-shade pause = stays paused; navigation prompt / notification sound = auto-resume).
6. **Fetch hardening:** toggle airplane mode mid-fetch → mutex releases within the timeout and the radio retries instead of going silent.
7. Logs: confirm `onInterruption began/ended`, the deferred-classification path, and **no** spurious `Player stopped externally — syncing pause state` during interruptions.

## Files touched

- `generative-radio/patches/expo-audio+55.0.10-canary-20260328-bdc6273.patch` (new — from `npx patch-package expo-audio`)
- `generative-radio/mobile/src/hooks/useRadio.ts` (interruption handler, deferred classification, consolidated listener, fetch timeouts)
- No `app.json` change needed (background config already correct).

## Handoff notes / gotchas

- **Canary expo-audio.** The patch targets `expo-audio@55.0.10-canary-20260328-bdc6273`. After any expo-audio bump, re-run `npx patch-package expo-audio`, re-verify the line anchors in `AudioModule.swift` / `AudioModule.kt`, and re-test. If/when expo-audio ships a public interruption API, migrate off the patch + the `expo-audio/build/AudioModule` private import.
- **Event payload typing.** `AudioModuleNative.addListener` is untyped for our custom event; cast the payload as shown. Consider a tiny `types.ts` alias.
- **Do not regress background behavior.** The iOS background path removes the `playbackStatusUpdate` listener to avoid 500 ms JS wakeups (cpulimit kill) and relies on a backup track-end timer + `play_now`. Keep that intact; the new `onInterruption` subscription is module-level (not the per-player listener) so it survives background — fine, and desirable, because interruptions can begin/end in background.
- **Silence bridge.** During track transitions the silence player is active; an interruption will pause it too. Not a correctness problem (bridge is transient and re-created on the next transition), but if testing shows a stuck bridge after an interruption-during-transition, have `resumeAfterInterruption()` fall through to `fetchAndPlay` which rebuilds the bridge/player.
- **Order independence.** The 400 ms classify delay is the crux for event-ordering robustness; if a slow device misclassifies (rare), increase it — do not remove it.
- **Testing must be on-device.** Interruptions (calls/Siri) and background audio do not behave correctly in Simulator or Expo Go.
