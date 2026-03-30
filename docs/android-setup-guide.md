# Android Setup Guide

Step-by-step guide for running Generative Radio on an Android emulator or physical Android device from a fresh MacBook Air (no prior Android development tools installed).

---

## Prerequisites

### Step 1: Install Android Studio

1. Download **Android Studio** from [developer.android.com/studio](https://developer.android.com/studio)
2. Open the `.dmg`, drag to Applications, and launch it
3. Follow the setup wizard — choose **Standard** installation (downloads the SDK, emulator, and build tools automatically)

This takes ~5 GB and a few minutes.

### Step 2: Set environment variables

Add to `~/.zshrc`:

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

Reload the shell:

```bash
source ~/.zshrc
```

Verify: `adb --version` should print a version number.

### Step 3: Install a Java JDK

Android Studio bundles a JDK internally, but Expo's build tools need one on the PATH:

```bash
brew install --cask zulu@17
```

Add to `~/.zshrc`:

```bash
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
```

Reload: `source ~/.zshrc`

---

## Running on an Android Emulator

### Create a Virtual Device (AVD)

1. Open Android Studio → **Virtual Device Manager** (icon in the right sidebar, or **Tools → Device Manager**)
2. Click **+** → **Create Virtual Device**
3. Choose a phone — **Pixel 9** is a good modern target
4. Select a system image — download and pick **API 35** (Android 15, latest stable)
5. Click **Finish**

### Boot the emulator

Press the **▶ Play** button next to your AVD. First boot takes ~1 minute.

### Build and run the app

With the emulator running:

```bash
cd /Users/nobu/dev/ai/radio/mobile

# Dev build — connects to localhost:5555
npx expo run:android

# Production build — connects to radio.scrambler-lab.com
npx expo run:android --variant release
```

First build takes 5–10 minutes (Gradle compiles the native layer). Subsequent builds are much faster — Metro handles JS changes instantly without a full rebuild.

---

## Running on a Physical Android Device

### Enable Developer Mode and USB Debugging

1. On the Android phone: **Settings → About Phone** → tap **Build Number** 7 times to enable Developer Mode
2. Go to **Settings → Developer Options** → enable **USB Debugging**
3. Connect the phone to the Mac via USB
4. Tap **Allow** on the phone when the USB debugging prompt appears

### Verify the device is detected

```bash
adb devices
# Expected output:
# List of devices attached
# [serial number]    device
```

If it shows `unauthorized`, tap Allow on the phone again or revoke and re-enable USB debugging.

### Build and install

```bash
cd /Users/nobu/dev/ai/radio/mobile

# Dev build (connects to localhost:5555 — Mac and phone must be on same Wi-Fi)
npx expo run:android --device

# Production build (connects to radio.scrambler-lab.com — works on any network)
npx expo run:android --variant release --device
```

### Install a pre-built APK directly

If you already have a release APK (e.g. from CI or a previous build), you can install it without recompiling:

```bash
adb install -r /Users/nobu/dev/ai/radio/mobile/android/app/build/outputs/apk/release/app-release.apk
```

The `-r` flag reinstalls over an existing installation, preserving app data.

> **Dev build + physical device**: update `mobile/src/config.ts` to use your Mac's local IP instead of `localhost`, same as iOS. See `docs/ios-simulator-guide.md` → "Dev build on physical device" section.

---

## iOS vs Android Comparison

| | iOS | Android |
|--|-----|---------|
| Background audio mechanism | `UIBackgroundModes: audio` in `app.json` | RNTP runs as a persistent foreground Service automatically |
| Lock screen / notification controls | Now Playing card | Media notification in the pull-down notification shade |
| Background audio reliability | Good (with WS keep-alive ping) | Very reliable — Android won't kill a foreground Service |
| First build time | 5–10 min | 5–10 min |
| Hot reload (JS changes) | Instant via Metro | Instant via Metro |
| Production build flag | `--configuration release` | `--variant release` |
| File cache (audio downloads) | `documentDirectory` | `documentDirectory` (same code) |

Android's background audio is generally more reliable than iOS — the RNTP foreground Service persists even under memory pressure.

---

## Known Compatibility Issues & Patches

This project uses React Native 0.83 and Expo SDK 55. Several native libraries required patches to work — these are managed via **patch-package** and applied automatically on `npm install`.

### patch-package setup

Patches live in `/patches/` at the monorepo root. The `postinstall` script in `package.json` runs `patch-package` automatically after every `npm install`, so no manual steps are needed after a fresh clone.

If you ever modify a file in `node_modules/` and want to persist it:
```bash
# From the monorepo root (/Users/nobu/dev/ai/radio)
npx patch-package <package-name>
# e.g.: npx patch-package react-native-track-player
```
This creates/updates `patches/<package-name>+<version>.patch` which you commit to git.

### Patch 1: react-native-track-player (RNTP 4.1.2)

**Problem**: RNTP 4.1.2 has two incompatibilities with React Native 0.83:

**1a. `MusicModule.kt` — `@ReactMethod` methods returning `Job` instead of `void`**

RN 0.83's TurboModule interop layer parses `@ReactMethod` annotations and requires all methods to return `void`. RNTP's `MusicModule.kt` used Kotlin expression bodies like:

```kotlin
// BROKEN — Kotlin expression body returns kotlinx.coroutines.Job
fun updateOptions(data: ReadableMap?, callback: Promise) = scope.launch { ... }
```

The patch converts all 36+ such methods to block bodies that return `void`:

```kotlin
// FIXED — block body returns Unit (void)
fun updateOptions(data: ReadableMap?, callback: Promise) { scope.launch { ... }}
```

**1b. `MusicService.kt` — `reactNativeHost` deprecated in RN 0.83**

`MusicService.emit()` called `reactNativeHost.reactInstanceManager.currentReactContext`, which throws at runtime in RN 0.83:
> `You should not use ReactNativeHost directly in the New Architecture`

The patch replaces the direct call with a helper that tries `reactHost` (New Arch API) first and falls back to `reactNativeHost` with a suppressed deprecation warning:

```kotlin
@MainThread
private fun getCurrentReactContext(): ReactContext? {
    val app = application as? ReactApplication ?: return null
    return try {
        app.reactHost?.currentReactContext
            ?: @Suppress("DEPRECATION") app.reactNativeHost.reactInstanceManager.currentReactContext
    } catch (e: Exception) {
        null
    }
}
```

### Patch 2: @kesha-antonov/react-native-background-downloader

**Problem**: This library has a `codegenConfig` entry in its `package.json`, which means the New Architecture codegen generates JNI bridge files into `android/build/generated/source/codegen/jni/`. The library's `CMakeLists.txt` references these files. With `newArchEnabled=false` (Old Arch), the codegen step doesn't run, so cmake fails with "directory not found".

**Solution**: The patch persists the generated JNI files from a one-time New Arch build. After `npm install`, the patch restores these files so cmake finds them even with `newArchEnabled=false`.

> **Note**: The `gradle.properties` file has `newArchEnabled=false`. This is intentional — New Arch is disabled because RNTP 4.1.2 is not fully compatible with it. The background-downloader patch handles the codegen dependency.

---

## Troubleshooting

### Android Studio can't find `node` — `command 'node' not found` in Gradle

**Cause**: macOS GUI apps launched from the Dock or Finder do not inherit your shell's PATH. Gradle's settings phase calls `node` using the JVM process environment, which only has the system's default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — not Homebrew's `/opt/homebrew/bin`.

**Fix**: Always launch Android Studio from the terminal:

```bash
open -a "Android Studio" /Users/nobu/dev/ai/radio/mobile/android
```

This inherits your shell's PATH (including Homebrew node), which Android Studio passes to the JVM.

> **Why not the Dock?** The Dock launches apps via `LaunchServices`, which does not source `~/.zshrc`. The terminal launch is the reliable workaround.

The `settings.gradle` file is already updated to read the node path from the `NODE_BINARY` environment variable:
```groovy
def nodeBinary = System.getenv("NODE_BINARY") ?: "/usr/local/bin/node"
```
But the expo-autolinking-settings plugin (compiled Kotlin) also calls node and can't be patched — hence the terminal launch requirement.

### App exits immediately on Android — debugging

Connect the device and filter logcat:

```bash
adb logcat -d | grep -E "ReactNativeJS|AndroidRuntime|FATAL" | grep -v "^[[:space:]]*at "
```

This strips stack frame lines and shows only the root error and JS log output.

### Build not picking up source changes to node_modules

Gradle's build cache can serve stale compiled outputs even after you edit source files. Force a clean rebuild:

```bash
# Clear compiled RNTP output
rm -rf node_modules/react-native-track-player/android/build

# Clear Gradle's global build cache
rm -rf ~/.gradle/caches/build-cache*

# Build without cache
cd mobile/android && ./gradlew assembleRelease --no-build-cache
```

### `ANDROID_HOME` not found during build
- Double-check `~/.zshrc` and run `source ~/.zshrc`
- Verify: `echo $ANDROID_HOME` should print the SDK path

### `adb devices` shows `unauthorized`
- Tap **Allow** on the phone, or go to **Developer Options → Revoke USB debugging authorizations** and reconnect

### Build fails with Gradle errors
```bash
cd /Users/nobu/dev/ai/radio/mobile/android
./gradlew clean
cd ..
npx expo run:android
```

### Emulator is slow
- In AVD settings, enable **Hardware - GLES 2.0** and increase RAM to **4096 MB**
- On Apple Silicon, the Android emulator uses Apple's Hypervisor Framework automatically — no extra setup needed

### Metro can't find `@radio/shared`
- Run `npm install` from the monorepo root (`/Users/nobu/dev/ai/radio/`)
- Verify the symlink: `ls node_modules/@radio/shared`
