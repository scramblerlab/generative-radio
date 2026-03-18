# Multi-Listener: Controller / Viewer Model

## Overview

The radio supports multiple simultaneous browser connections. Only one connection
holds the **controller** role at a time; every other connection is a **viewer**.

| Role | UI shown | Controls |
|---|---|---|
| Controller | GenreSelector **or** RadioPlayer (full) | Genre pick, Start, Stop, Skip, Save track, ⏪ ▶⏸ ⏩ seek |
| Viewer | RadioPlayer (read-only) | ⏪ ▶⏸ ⏩ seek, Be the DJ button |

Both roles see the same track info, progress bar, equalizer, activity log, and listener count.

---

## Role Assignment

### Local-network connections only → controller eligible

Only connections whose resolved IP is a **private or loopback address** can be
assigned the controller role:

| IP range | Classification |
|---|---|
| `127.x.x.x` | Loopback — always local |
| `10.x.x.x` | RFC 1918 private |
| `172.16.x.x – 172.31.x.x` | RFC 1918 private |
| `192.168.x.x` | RFC 1918 private |
| Any other | Remote — always viewer |

The server resolves the real client IP by checking headers in order:
1. `CF-Connecting-IP` — set by Cloudflare on all tunnel traffic (named + quick)
2. `X-Forwarded-For` — standard reverse-proxy header (first entry)
3. `ws.client.host` — raw socket peer (correct for direct LAN connections)

Remote visitors opening the Cloudflare tunnel URL are **always viewers**, even if no controller is connected.

### First local connection (when no controller exists) → controller

When the first local WebSocket connects and no controller is active, it is immediately assigned the controller role. The server unicasts `role_assigned: controller` to that connection.

### All other connections → viewer

Any WebSocket that connects while a controller already exists, or any remote connection, receives `role_assigned: viewer`.

### Late-join state sync

When any client connects while a session is active, the server immediately unicasts a snapshot:

1. `role_assigned` — their role
2. `track_ready` (isNext: false) — if a track is currently playing
3. `status` — current state + message
4. `dj_state` — current DJ lock state and active DJ name

The controller also receives `viewer_list` (IPs + connected-since timestamps) whenever the viewer list changes.

---

## Controller UI Flow

```
connect
  └─► role_assigned: controller
        ├─► GenreSelector shown
        │     └─► picks genres + mood + language + feeling + advanced options
        │               └─► "Start Radio" → WS { event: "start", data: {...} }
        │                       └─► RadioPlayer shown (full controls)
        │                             ├─ ⏪ −10s / ▶⏸ play-pause / ⏩ +10s
        │                             ├─ Skip button
        │                             ├─ Save track button
        │                             └─ "← Back" button (returns to GenreSelector
        │                                  without stopping — current track keeps playing)
        │                                       └─► sends WS { event: "reschedule", data: {...} }
        │                                               on new Start from selector
        └─► (disconnect)
              └─► promotion logic (see below)
```

The **"← Back" button is only rendered when `role === 'controller'`**. Navigating back does not stop the radio — the controller can change genres mid-session and the new settings take effect from the next generated track.

---

## Viewer UI Flow

```
connect
  └─► role_assigned: viewer
        └─► RadioPlayer shown (read-only)
              ├─ Track info, progress bar, equalizer   [same as controller]
              ├─ ⏪ −10s / ▶⏸ play-pause / ⏩ +10s   [local playback controls]
              ├─ Activity log (visible during generating/buffering)
              ├─ StatusBar with listener count          [same as controller]
              ├─ "Be the DJ" button (when DJ slot unlocked)
              └─ "PRESENTED BY [DJ NAME]" footer (when a DJ is active)
```

On first load, viewers are forced into a paused state (browser autoplay policy requires a prior user gesture). A **Play** button is shown until the viewer taps it.

If the session is not yet started (state IDLE or STOPPED), the read-only player shows "Waiting for host to start the radio…".

---

## Controller Promotion

When the controller disconnects, the next **local** viewer in connection order is promoted. Remote viewers are never promoted.

**Promotion timing:**

| Server state when controller drops | When promotion happens |
|---|---|
| IDLE / STOPPED / PLAYING (no active generation) | Immediately on disconnect |
| GENERATING / BUFFERING (generation task running) | Deferred — after current generation finishes |

**After promotion:**
- Server unicasts `role_assigned: controller` to the promoted client
- Promoted client was already showing RadioPlayer → full controls appear (save, skip, back button)
- Other remaining viewers receive no change

**If no local viewers remain when the controller disconnects:**
- `_controller_ws` is set to `None`
- Generation continues if already underway
- Next **local** client to connect becomes the controller
- Remote viewers continue watching but cannot take the controller role

---

## DJ Mode

Viewers can request the DJ slot when the cooldown has expired. This lets anyone on the session influence what plays next without needing controller access.

```
viewer clicks "Be the DJ"
  └─► WS { event: "dj_claim" }
        └─► dj_claim_ack { granted: true }  → DJPanel modal opens
              └─► viewer fills name + genre + mood + language + feeling
                    └─► WS { event: "dj_submit", data: { djName, genres, keywords, ... } }
                          └─► backend reschedules next track with DJ's settings
                                sets cooldown, broadcasts dj_state to all clients
```

`dj_state` broadcast: `{ locked: true, unlockAt: <timestamp>, activeDjName: "Alice" }`

When locked, the "Be the DJ" button shows a countdown. When unlocked, it re-enables.

The DJ cooldown is configurable in Advanced Options (1–120 min, default 30 min). It is set once by the controller at session start and applies to all viewers equally.

---

## WebSocket Protocol

### Client → Server

| Event | Sender | Description |
|---|---|---|
| `start` | Controller | Begin session with genres, keywords, language, feeling, advancedOptions |
| `stop` | Controller | Stop the radio |
| `skip` | Controller | Skip current track |
| `reschedule` | Controller | Change settings mid-session (current track keeps playing) |
| `track_ended` | All clients | Notify server that the current track finished playing |
| `dj_claim` | Viewer | Request the DJ slot |
| `dj_submit` | Viewer (DJ) | Submit DJ's genre/mood/language selection + name |

### Server → Client

| Event | Target | Description |
|---|---|---|
| `role_assigned` | Unicast | `{ role: "controller" \| "viewer" }` |
| `track_ready` | Broadcast | `{ track: {...}, isNext: bool }` |
| `status` | Broadcast | `{ state, message, nextReady }` |
| `progress` | Broadcast | `{ stage, message }` — LLM/ACE-Step progress |
| `listener_count` | Broadcast | `{ count }` |
| `viewer_list` | Controller only | `{ viewers: [{ ip, connectedAt }] }` |
| `dj_state` | Broadcast | `{ locked, unlockAt, activeDjName }` |
| `dj_claim_ack` | Unicast | `{ granted: bool }` |
| `play_now` | Broadcast | `{ for_track_id }` — watchdog: forces transition if client missed `ended` event |
| `error` | Broadcast or unicast | `{ message }` |

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Viewer connects, no session active | Read-only player with "Waiting for host to start the radio…" |
| Controller starts session, viewers join mid-generation | Viewers receive late-join snapshot (activity log not replayed, but current status is) |
| Controller stops session | All clients receive `status: stopped`; viewers stay on read-only player; controller returns to GenreSelector |
| Controller drops mid-generation, no viewers | Generation continues; next local connection becomes controller |
| Controller drops during PLAYING, viewer promoted | Promoted client sees RadioPlayer with full controls |
| Promoted controller hits "← Back" | Returns to GenreSelector; can change genre without stopping current track |
| Viewer taps "Be the DJ" during cooldown | Receives `dj_claim_ack: { granted: false }`; button stays disabled with countdown |
| iOS client backgrounded / screen locked | Server's `play_now` watchdog forces track transition via `handleTrackEnded()` on return to foreground |
| Only one listener ever | Functions exactly like single-listener behaviour |

---

## Key Implementation Files

| File | Role |
|---|---|
| `backend/radio.py` | Role tracking, promotion, unicast helpers, DJ mode, `play_now` watchdog |
| `backend/main.py` | WS event routing, `_resolve_request_ip`, save-track local-only guard |
| `frontend/src/hooks/useRadio.ts` | `role` state, `dj_*` state, `play_now` handler, `visibilitychange` retry |
| `frontend/src/App.tsx` | Role-aware view routing; auto-promote to player on role change |
| `frontend/src/components/RadioPlayer.tsx` | `readonly` prop; transport controls for all; DJ button for viewers; save for controller |
| `frontend/src/components/DJPanel.tsx` | Modal: DJ name + genre/mood/language form |
