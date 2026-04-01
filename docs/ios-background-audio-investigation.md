# Background Audio Playback — Investigative Report
_Generated: 2026-04-01_

## Problem Statement
After migrating from RNTP to `expo-audio`, the iOS app stops audio in the middle of a track when backgrounded on iPhone Air.

---

## Part 1 — Best Practices for Reliable Background Audio on Expo / React Native

### iOS

**Required: Info.plist UIBackgroundModes**
`UIBackgroundModes: ["audio"]` must be declared. Without this, iOS will suspend the app the moment it leaves the foreground. In Expo managed workflow, this goes in `app.json` under `ios.infoPlist`.

**Required: expo-audio Config Plugin with `enableBackgroundPlayback`**
The expo-audio config plugin has an explicit `enableBackgroundPlayback` flag that does additional native wiring. Best practice is:
```json
["expo-audio", { "enableBackgroundPlayback": true }]
```
Simply listing `"expo-audio"` in plugins without this option leaves some native glue missing.

**Required: `setAudioModeAsync` Settings**
```js
setAudioModeAsync({
  playsInSilentMode: true,        // Override iOS silent/ring switch
  shouldPlayInBackground: true,   // Keep session alive in background
  interruptionMode: 'doNotMix',   // Prevent duck/mix from degrading session
  allowsRecording: false,
})
```
`interruptionMode: 'doNotMix'` is especially important — without it the OS will not properly associate lock screen controls with your player. All four fields should always be set together.

**Required: Lock Screen / Now Playing Integration**
Calling `player.setActiveForLockScreen(true, { title, artist, artworkUrl })` on every new track is mandatory. The Now Playing registration tells iOS your app owns the audio session. Without it, the session can be reclaimed by another app or by a system policy timeout.

**Silence Bridge Pattern**
A known workaround for gaps between tracks: play a looped silent MP3 so the audio session never goes idle during download/buffering. iOS will suspend an app whose audio session has been idle for ~3–5 seconds.

**Build Requirement**
Background audio **does not work in Expo Go or development client** because the Metro bundler connection takes the foreground slot. Always test on a production (`eas build`) or device archive build.

---

### Android

**Required: Permissions**
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_MEDIA_PLAYBACK` (Android 10+, required to show lock screen controls)
- `WAKE_LOCK` (prevents CPU from sleeping during playback)
- `POST_NOTIFICATIONS` (Android 13+, required for the foreground service notification)

**Required: Foreground Service**
Android background processes are killed aggressively. Media apps must run a foreground service with a persistent notification. The expo-audio config plugin (`enableBackgroundPlayback: true`) auto-injects an `AudioControlsService` declaration into AndroidManifest.xml. Without this, playback stops after roughly 3 minutes.

**Known Android 3-Minute Bug**
GitHub issue [expo/expo#38317](https://github.com/expo/expo/issues/38317): background audio stops after ~3 minutes. Fixed in PR #38980. Using an outdated or canary build of expo-audio may reintroduce this.

---

### General Best Practices

| Practice | Reason |
|---|---|
| Set `AudioMode` once at app init, before any player is created | Re-setting later can interrupt the session |
| Always call `setActiveForLockScreen(true, metadata)` per track | Keeps OS-level session registration fresh |
| Use a silence bridge (looped silent audio) during track transitions | Prevents iOS from reclaiming the audio session in the ~few second gap |
| Keep WebSocket / HTTP connection alive with heartbeat | Prevents backend from closing the socket, which can block next-track fetch |
| Test only on production or archive builds | Expo Go / dev client do not support background audio |
| Pin to a stable expo-audio release, not canary | Canary builds may have regressions |

---

## Part 2 — Codebase Analysis

### Files Involved

| File | Role |
|---|---|
| `mobile/app.json` | Expo config: iOS UIBackgroundModes, Android permissions, plugin list |
| `mobile/src/hooks/useRadio.ts` | Core audio logic: AudioMode, player lifecycle, silence bridge, lock screen, AppState |
| `mobile/src/utils/downloadAudio.ts` | Background track download via `@kesha-antonov/react-native-background-downloader` |
| `mobile/plugins/withBackgroundDownloader.js` | Config plugin that injects iOS AppDelegate callback for background downloads |
| `mobile/assets/silence.mp3` | 20 KB silence file used by the bridge |

No native `ios/` or `android/` directories — everything is Expo managed, applied at prebuild time.

---

### What Is Configured Correctly

**iOS UIBackgroundModes** (`app.json`)
```json
"infoPlist": { "UIBackgroundModes": ["audio"] }
```
✅ Present and correct.

**Android Permissions** (`app.json`)
```json
"permissions": [
  "android.permission.INTERNET",
  "android.permission.WAKE_LOCK",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"
]
```
✅ All four required permissions are declared.

**AudioMode** (`useRadio.ts` ~line 128)
```ts
setAudioModeAsync({
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'doNotMix',
  allowsRecording: false,
})
```
✅ All the right flags.

**Silence Bridge** (`useRadio.ts` ~line 215)
- `silencePlayerRef` loads `assets/silence.mp3`, sets `loop = true`, plays it while the next track downloads.
- Stopped once the new player starts.
✅ Implementation is correct in intent.

**Lock Screen** (`useRadio.ts`)
- `player.setActiveForLockScreen(true, { title, artist, ... })` called after creating each player.
✅ Present.

**WebSocket Heartbeat** (`useRadio.ts`)
- 20-second ping interval to keep the WS connection alive.
✅ Present.

---

### Identified Issues and Risks

#### Issue 1 — `expo-audio` Config Plugin NOT invoked with `enableBackgroundPlayback: true` ⚠️ HIGH RISK

**In `app.json` plugins:**
```json
"plugins": [
  "./plugins/withBackgroundDownloader",
  "expo-audio"
]
```

The `expo-audio` plugin is listed **without options**. The `enableBackgroundPlayback: true` option is what makes the plugin:
- Inject `UIBackgroundModes: audio` into iOS (also sets additional AVAudioSession category flags)
- Declare the `AudioControlsService` in Android's `AndroidManifest.xml`
- Wire the Android foreground service that keeps playback alive past ~3 minutes

**Without `AudioControlsService` declared in AndroidManifest, Android has no foreground service for audio** — the declared permissions alone are not enough.

#### Issue 2 — Canary Build of expo-audio ⚠️ MEDIUM RISK

```json
"expo-audio": "55.0.10-canary-20260328-bdc6273"
```

This is a canary (pre-release) build. The 3-minute Android background bug (expo/expo#38317) and its fix (#38980) may or may not be included in this exact commit.

#### Issue 3 — Silence Bridge Timing Risk ⚠️ LOW-MEDIUM RISK

If the silence bridge player fails to load (e.g., first cold start), there is no explicit error handling fallback. The audio session can drop before the next track is ready.

#### Issue 4 — Single Fixed Download Filename Race Condition ⚠️ LOW RISK

`downloadAudio.ts` always downloads to `track_current.mp3`. The mutex (`isFetchingRef`) mitigates this, but background resume resets the mutex — a very fast background-to-foreground cycle could potentially overwrite a file mid-stream.

#### Issue 5 — AppState Wake Recovery Complexity ⚠️ LOW RISK

State checks across `isBridgingRef`, `isFetchingRef`, and `statusRef` could create edge cases on slow devices during rapid background/foreground cycles.

---

## Part 3 — iOS-Specific: Missing Permissions Compared to Spotify (iPhone Air Focus)

iPhone Air Settings shows three permission entries in Spotify that are absent from this app: **Bluetooth**, **ローカルネットワーク (Local Network)**, and **アプリのバックグラウンド更新 (Background App Refresh)**.

---

### A — Bluetooth (`NSBluetoothAlwaysUsageDescription`)

**Does basic AirPods / Bluetooth headphone audio require this?** **No.** Audio routing to Bluetooth devices is handled by the system-level AVAudioSession. The permission is only needed for Core Bluetooth APIs (device scanning, BLE).

**Is missing Bluetooth causing the audio stop?** Almost certainly **no**. This app does not use Core Bluetooth APIs.

**Should it be declared?** Only if route-change management or device-selection features are planned. Not urgent for fixing background stop.

**How to add in `app.json`:**
```json
"NSBluetoothAlwaysUsageDescription": "Allow access to Bluetooth to connect to wireless audio devices."
```

---

### B — ローカルネットワーク (Local Network) — `NSLocalNetworkUsageDescription`

**What triggers it (iOS 14+):** TCP/UDP connections to local IPs (192.168.x.x, 10.x.x.x, 127.0.0.1) or Bonjour/mDNS service discovery.

**Does `wss://radio.scrambler-lab.com` require it?** **No.** External HTTPS/WSS domain connections never trigger this.

**Does `ws://localhost:5555` (dev mode) require it?** **Yes.** Loopback connections on non-standard ports on iOS 14+ will be **silently dropped** without `NSLocalNetworkUsageDescription` — no error is returned to the app. WebSocket connect attempts simply hang.

**Impact on production builds:** Not triggered. But **dev builds using localhost are silently broken** without this declaration — causing no next-track fetch → audio stops.

**How to add in `app.json`:**
```json
"NSLocalNetworkUsageDescription": "Generative Radio connects to a local server on your network to stream music.",
"NSBonjourServices": ["_http._tcp"]
```

---

### C — アプリのバックグラウンド更新 (Background App Refresh)

**Why the toggle is absent:** The app declares only `UIBackgroundModes: ["audio"]`. The `audio` mode does NOT generate a "Background App Refresh" toggle — it grants continuous background execution. Spotify declares additional modes (`fetch`, `remote-notification`) which create the toggle.

**Does the absence block audio playback?** Not for an actively playing audio session. However, **if a user has globally disabled Background App Refresh** (`Settings > General > Background App Refresh → Off`), iOS 16+ may interfere with background network requests even with audio mode active.

**Should `"fetch"` be added to `UIBackgroundModes`?** Yes — it:
- Makes the "Background App Refresh" toggle visible in Settings so users can manage it
- Grants ~30s of periodic background execution when audio is paused (useful for buffering/polling)
- Has no negative side effects on the existing `audio` mode

**How to add in `app.json`:**
```json
"UIBackgroundModes": ["audio", "fetch"]
```

---

### iOS Permission — Combined Summary

| Permission | Currently Missing? | Causes Audio Stop? | Priority |
|---|---|---|---|
| `NSBluetoothAlwaysUsageDescription` | Yes | No | LOW |
| `NSLocalNetworkUsageDescription` | Yes | Yes, **in dev builds** using localhost | MEDIUM |
| `UIBackgroundModes: fetch` | Yes | Indirectly (if user disabled BG refresh globally) | MEDIUM |
| `expo-audio` plugin `enableBackgroundPlayback: true` | Yes | Yes, on Android + possibly iOS | **CRITICAL** |

---

## Part 4 — Actionable Fixes

All fixes are in `mobile/app.json`. No TypeScript changes needed.
After applying changes: `cd mobile && npx expo prebuild --clean`, then rebuild for device.

### Fix 1 — CRITICAL: expo-audio plugin `enableBackgroundPlayback: true`

```json
// Before
"plugins": [
  "./plugins/withBackgroundDownloader",
  "expo-audio"
]

// After
"plugins": [
  "./plugins/withBackgroundDownloader",
  ["expo-audio", { "enableBackgroundPlayback": true }]
]
```

### Fix 2 — HIGH: Add `"fetch"` to UIBackgroundModes

```json
// Before
"UIBackgroundModes": ["audio"]

// After
"UIBackgroundModes": ["audio", "fetch"]
```

### Fix 3 — MEDIUM: Add Local Network permission

```json
// Add to ios.infoPlist
"NSLocalNetworkUsageDescription": "Generative Radio connects to a local server on your network to stream music.",
"NSBonjourServices": ["_http._tcp"]
```

### Fix 4 — LOW: Add Bluetooth usage description

```json
// Add to ios.infoPlist
"NSBluetoothAlwaysUsageDescription": "Allow access to Bluetooth to connect to wireless audio speakers and headphones."
```

### Test Checklist After Applying Fixes

1. `cd mobile && npx expo prebuild --clean`
2. Build for device: `npx expo run:ios --device` or `eas build --platform ios`
3. Install on iPhone Air
4. Start playback → press Home → lock screen → wait 5–10 min
5. Verify audio continues through 2–3 track transitions
6. Verify lock screen controls (play/pause, skip) respond
7. Check iOS Settings > [App Name]: Bluetooth, Local Network, Background App Refresh toggles now appear
8. Check iOS Settings > General > Background App Refresh: app is listed and enabled

### Remaining Risk After Fixes

The canary build `expo-audio@55.0.10-canary-20260328-bdc6273` may still have regressions. If issues persist after config fixes, pin to the latest stable expo-audio (`~54.x.x` or stable `55.x.x` once released) and retest.
