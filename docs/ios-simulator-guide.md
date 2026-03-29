# iOS Simulator Testing Guide

Step-by-step guide for running Generative Radio on the iPhone Air iOS Simulator.

---

## Prerequisites

### 1. Install Xcode

1. Open the **App Store** on your Mac
2. Search for **Xcode** and install it (it's large — ~15 GB — so grab a coffee)
3. After install, open Xcode once to accept the license agreement:
   ```
   sudo xcodebuild -license accept
   ```
4. Install Command Line Tools:
   ```
   xcode-select --install
   ```

### 2. Install iPhone Air Simulator

Xcode ships with some simulators, but you need to download the iPhone Air runtime specifically:

1. Open **Xcode** → **Settings** (⌘,) → **Platforms** tab
2. Click **+** at the bottom left
3. Select **iOS** and download the latest **iOS 26** runtime
4. After downloading, you can manage individual simulators in **Window → Devices and Simulators** (⌘⇧2)
5. To create an iPhone Air simulator: click **+** in the bottom-left of the Simulators tab, choose **iPhone Air** from the device list, give it a name, click **Create**

### 3. Install Expo CLI and EAS CLI

```bash
npm install -g @expo/cli eas-cli
```

---

## First-Time Setup

### Step 1: Build the native iOS app (required for react-native-track-player)

Expo Go (the generic Expo app) does **not** support `react-native-track-player` because it uses native audio APIs. You need to build a **development build** instead.

```bash
cd /Users/nobu/dev/ai/radio/mobile

# Build a development client for the iOS Simulator
npx expo run:ios --device
```

This will:
1. Generate an `ios/` directory with the Xcode project
2. Compile the native iOS app (takes 3–10 minutes first time)
3. Launch it in the iPhone Air Simulator automatically

> **Tip**: After the first build, subsequent launches are much faster — Metro bundler handles JS changes instantly without rebuilding native code.

---

## Testing the Production Build on Simulator

Use this to verify the app connects to `radio.scrambler-lab.com` (the live public server) instead of localhost.

### Prerequisites
- `./scripts/start_prod.sh` must be running on this Mac (Cloudflare tunnel must be live)

### Build and run in Release mode

```bash
cd /Users/nobu/dev/ai/radio/mobile
npx expo run:ios --configuration Release --device "iPhone Air"
```

`--configuration Release` is what flips `__DEV__` to `false`, switching the app to:
- `https://radio.scrambler-lab.com` for REST/audio
- `wss://radio.scrambler-lab.com/ws` for WebSocket

The first Release build takes a few extra minutes (Xcode recompiles in Release mode). Subsequent builds are faster.

> **Note:** Hot reload is not available in Release builds — the JS bundle is compiled and embedded. Re-run the command after any code change.

### Switch back to dev (localhost) mode

```bash
npx expo run:ios --device "iPhone Air"
# no --configuration flag = Debug = __DEV__ true = localhost:5555
```

---

## Starting the App (After Initial Build)

### Step 1: Start the backend

In one terminal:
```bash
cd /Users/nobu/dev/ai/radio
source backend/.venv/bin/activate   # or however your venv is set up
uvicorn backend.main:app --port 5555 --host 0.0.0.0
```

### Step 2: Start the Expo dev server

In another terminal:
```bash
cd /Users/nobu/dev/ai/radio/mobile
npx expo start --ios
```

This opens the Metro bundler. The app should launch in the simulator automatically (or press `i` to open the iOS Simulator).

### Step 3: Hot reload

- **JS changes** (components, hooks, styles): reflected instantly — just save the file
- **Native changes** (app.json plugins, new native packages): requires `npx expo run:ios` again

---

## Selecting the iPhone Air Simulator

1. In the Metro terminal, press `i` — it opens a list of available simulators
2. Select **iPhone Air** from the list
3. The simulator launches and the app installs

Or via Xcode Simulator directly:
- Open **Simulator** app → **File → Open Simulator → iOS 26 → iPhone Air**
- Then press `i` in the Metro terminal

---

## Testing Background Audio

### Test 1: Lock screen audio continuity

1. Start a radio session in the app (tap **Start Radio**)
2. Wait for a track to start playing
3. Press the **Home button** in the Simulator (hold ⌘ and press `H`, or use **Device → Home** menu)
4. Press the **Lock** button (⌘ + `L`)
5. Audio should keep playing

**On the simulated lock screen:**
- Swipe up from bottom to reveal the Control Center
- You should see the **Now Playing** widget with the track title and genre
- Tap **pause** and **play** — these should control the audio

### Test 2: Control Center media controls

1. While audio is playing, simulate the Control Center (swipe down from top-right corner in the Simulator)
2. Media controls should appear with track info
3. Use play/pause and seek buttons

> **Note**: Lock screen controls don't work in some simulator versions — Apple removed partial support. For full lock screen testing, use a physical iPhone.

### Test 3: App backgrounding

1. Play audio
2. Open another app in the Simulator (e.g. Safari)
3. Come back to Generative Radio
4. Audio should have continued playing, and the UI should be in sync

### Test 4: Zero-gap track transitions

1. Start a session and let a track play to completion
2. Watch the activity log — "Next track ready" appears when the next track is pre-buffered
3. When the current track ends, the next should start instantly with no gap or loading

---

## Targeting iPhone Air Specifically

The iPhone Air has a **6.5" display** (2736×1260). To ensure your UI looks right:

1. In Xcode Simulator, go to **Window → Physical Size** to see the true scale
2. Check that text is readable and buttons are tap-friendly on the narrow but tall screen
3. Test both **portrait** (default) and **landscape** orientations

---

## Useful Simulator Shortcuts

| Action | Shortcut |
|--------|----------|
| Home button | ⌘ H |
| Lock screen | ⌘ L |
| App switcher | ⌘ ⇧ H (double-press Home) |
| Screenshot | ⌘ S |
| Simulate shake | ⌘ ^ Z |
| Toggle slow animations | ⌘ T |
| Rotate left/right | ⌘ ← / ⌘ → |

---

## Testing on a Physical iPhone Air

Physical device testing enables full lock screen controls, Bluetooth headphone buttons, and real-world network conditions.

### Prerequisites

- **Apple Developer account** — a free account works for sideloading to your own device (certificate valid for 7 days); a paid account ($99/yr) gives longer validity and enables TestFlight distribution
- Connect your iPhone Air to the Mac via USB
- On the iPhone, tap **Trust** when prompted ("Trust This Computer?")

### Build and install

```bash
cd /Users/nobu/dev/ai/radio/mobile

# Dev build — connects to localhost:5555 (requires same Wi-Fi, see note below)
npx expo run:ios --device

# Production build — connects to radio.scrambler-lab.com (works on any network)
npx expo run:ios --configuration Release --device
```

Expo detects connected devices automatically. If multiple devices/simulators are available, it will prompt you to choose.

### First-time device trust (required once)

After the app installs, iOS blocks it with an "Untrusted Developer" warning:

1. On iPhone: **Settings → General → VPN & Device Management**
2. Find your Apple ID under **Developer App**
3. Tap **Trust "[your Apple ID]"** → **Trust** to confirm

The app will open normally after this one-time step.

### Dev build on physical device (Wi-Fi requirement)

When using the dev build, the iPhone must be on the **same Wi-Fi network as the Mac** since `localhost` doesn't resolve to the Mac from a physical device. Update the dev URL in `mobile/src/config.ts`:

```ts
const DEV_ORIGIN = 'http://192.168.1.x:5555';  // replace with your Mac's local IP
```

Find your Mac's IP: **System Settings → Wi-Fi → Details → IP Address**

The production build (`--configuration Release`) connects to `radio.scrambler-lab.com` directly and works on any network — no config change needed.

### If the terminal build fails (exit code 65) — build via Xcode directly

When `npx expo run:ios` fails with a signing or provisioning error on a physical device, build from Xcode instead:

1. Open the workspace:
   ```bash
   open /Users/nobu/dev/ai/radio/mobile/ios/GenerativeRadio.xcworkspace
   ```
2. In the top bar, click the scheme selector and choose your iPhone Air as the destination
3. Set the build configuration to **Release**:
   - Click the scheme name **GenerativeRadio** → **Edit Scheme…**
   - Select **Run** in the left sidebar
   - Set **Build Configuration** to **Release**
   - Close the dialog
4. Configure automatic signing:
   - Click the **GenerativeRadio** project in the left sidebar
   - Select the **GenerativeRadio** target → **Signing & Capabilities** tab
   - Check **Automatically manage signing**
   - Set **Team** to your Apple ID (add it via **Xcode → Settings → Accounts** if not listed)
5. Press **▶ Play** — Xcode compiles and installs the app on the device

**Verify it's a production build:** Once the app launches, it should connect to `radio.scrambler-lab.com`. The activity log in the app shows the WebSocket connection URL.

---

## Troubleshooting

### "Unable to boot device" error
- Open **Xcode → Window → Devices and Simulators** and check the simulator isn't already booted
- Restart Simulator: **Simulator → Quit**, then start again

### Metro can't find `@radio/shared`
- Run `npm install` from the **monorepo root** (`/Users/nobu/dev/ai/radio/`)
- Verify the symlink: `ls node_modules/@radio/shared`

### Audio doesn't play in background
- Ensure the native build was done with `npx expo run:ios` (not Expo Go)
- Verify `UIBackgroundModes: ["audio"]` is in `app.json` under `ios.infoPlist`
- Check that `TrackPlayer.registerPlaybackService` is called in `index.ts` before `registerRootComponent`

### WebSocket won't connect
- Ensure backend is running: `curl http://localhost:5555/api/radio/status`
- iOS Simulator uses `localhost` to reach the host Mac — no special IP needed
- For a physical device, change `BACKEND_URL` in `mobile/src/config.ts` to your Mac's local IP (e.g. `192.168.1.x`)

### Build fails with "xcode-select: error"
```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

### react-native-track-player install issues
```bash
cd mobile && npx expo install react-native-track-player
npx expo run:ios  # Rebuild native layer
```
