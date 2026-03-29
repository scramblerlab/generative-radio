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

## Troubleshooting

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
