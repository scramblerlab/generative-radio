# Mobile App Plan: React Native iOS/Android

## Context
Add a React Native mobile app that mirrors the generative AI radio web app. Primary target is iPhone Air (6.5" OLED, iOS 26). Requires background audio playback and maximum code sharing with the existing web app. The existing `frontend/` and `backend/` remain untouched.

---

## Architecture

**Stack**: Expo (managed workflow) + react-native-track-player + npm workspaces monorepo

**Why Expo**: Recommended by React Native team in 2025, handles iOS Background Modes via config plugins, EAS for builds, faster iteration on simulator.

**Why react-native-track-player (RNTP)**: Industry standard for music apps — automatically handles background audio, iOS lock screen / Control Center (Now Playing), audio queue management.

---

## Monorepo Structure

```
/radio/
├── backend/              # Unchanged (FastAPI)
├── frontend/             # Unchanged (Vite + React 19)
├── mobile/               # NEW: Expo app
├── packages/
│   └── shared/           # NEW: shared TypeScript types
├── package.json          # NEW: workspace root (npm workspaces)
└── docs/
    └── mobile-app-plan.md
```

---

## Shared Package: `packages/shared/`

Contains types extracted from `frontend/src/types.ts`:
- All TypeScript interfaces: `Track`, `AdvancedOptions`, `RadioStatus`, `ClientRole`, `ActivityEntry`, `ReactionState`, `ViewerInfo`, WS event payload types
- Published as `@radio/shared`

---

## Mobile App Architecture: `mobile/`

```
mobile/
├── app.json              # Expo config (background audio capability)
├── metro.config.js       # Monorepo-aware Metro config
├── src/
│   ├── config.ts         # Backend URL configuration
│   ├── hooks/
│   │   └── useRadio.ts   # Adapted hook (RNTP instead of HTML5 Audio)
│   ├── components/
│   │   ├── GenreSelector.tsx
│   │   ├── RadioPlayer.tsx
│   │   └── DJPanel.tsx
│   ├── navigation/
│   │   └── AppNavigator.tsx
│   └── App.tsx
└── package.json
```

### Audio Layer: Web → React Native

| Web (HTML5 Audio)               | Mobile (react-native-track-player)           |
|---------------------------------|----------------------------------------------|
| `audio.src = blobUrl`           | `TrackPlayer.load(track)` + `TrackPlayer.play()` |
| Blob URL pre-fetch              | `TrackPlayer.add(nextTrack)` to queue        |
| `audio.ended` event             | `Event.PlaybackActiveTrackChanged`           |
| `audio.currentTime += 10`       | `TrackPlayer.seekBy(10)`                     |
| MediaSession API (lock screen)  | RNTP built-in (automatic)                    |
| `document.visibilitychange`     | `AppState.addEventListener('change', ...)`   |

**Pre-fetch strategy**: When `track_ready (isNext=true)` arrives, call `TrackPlayer.add()` — RNTP pre-buffers it in queue. When current track ends, RNTP auto-advances. Send `track_ended` to WebSocket on `Event.PlaybackActiveTrackChanged`.

### iOS Background Audio Configuration

In `mobile/app.json`:
```json
{
  "plugins": ["react-native-track-player"],
  "ios": {
    "infoPlist": {
      "UIBackgroundModes": ["audio"]
    }
  }
}
```

---

## Implementation Phases

1. **Monorepo setup** — root `package.json` with npm workspaces
2. **Shared package** — extract types to `@radio/shared`
3. **Expo bootstrap** — `npx create-expo-app` + install RNTP + navigation
4. **Metro config** — monorepo watchFolders + package exports
5. **Port `useRadio`** — replace HTML5 Audio refs with RNTP calls
6. **Build UI** — GenreSelector, RadioPlayer, DJPanel in React Native
7. **Navigation** — Stack navigator connecting all screens
8. **Test on iOS Simulator** — see `docs/ios-simulator-guide.md`

---

## Backend URL Configuration

The mobile app connects to the FastAPI backend directly (no Vite proxy). Configure in `mobile/src/config.ts`:

```ts
// For iOS Simulator: use host machine's localhost alias
export const BACKEND_URL = 'http://localhost:5555';
export const WS_URL = 'ws://localhost:5555/ws';
```

iOS Simulator can reach `localhost` on the host Mac — no special IP needed.

---

## Design Tokens (from web app)

```ts
const colors = {
  bg:          '#0a0a0f',
  surface:     '#111118',
  surface2:    '#1a1a26',
  border:      '#1e1e30',
  border2:     '#2a2a40',
  accent:      '#f59e0b',
  accentGlow:  'rgba(245, 158, 11, 0.25)',
  indigo:      '#6366f1',
  text:        '#f1f5f9',
  textMuted:   '#64748b',
  textDim:     '#94a3b8',
  green:       '#22c55e',
  red:         '#ef4444',
};
```
