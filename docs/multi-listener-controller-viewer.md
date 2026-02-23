# Multi-Listener: Controller / Viewer Design

## Overview

The radio supports multiple simultaneous browser connections. Only one connection
holds the **controller** role at a time; every other connection is a **viewer**.

| Role | UI shown | Controls |
|---|---|---|
| Controller | GenreSelector **or** RadioPlayer (full) | Genre pick, Start, Stop, Rewind, "Change genres" |
| Viewer | RadioPlayer (read-only) | None — observes only |

---

## Role Assignment

### First connection → controller
When the very first WebSocket connects, it is immediately assigned the controller
role. The server unicasts `role_assigned: controller` to that connection.

### Subsequent connections → viewer
Any WebSocket that connects while a controller already exists receives
`role_assigned: viewer`. Viewers never see the GenreSelector.

### Late-join state sync
When a viewer connects while a session is active, the server immediately
unicasts a snapshot to that one connection so they don't have to wait for
the next broadcast cycle:
1. `role_assigned: viewer`
2. `track_ready` (isNext: false) — if a track is currently playing
3. `status` — current state + message

If no session is running (state IDLE/STOPPED), the viewer sees a
"Waiting for host…" overlay on the player view.

---

## Controller UI Flow

```
connect
  └─► role_assigned: controller
        ├─► GenreSelector shown
        │     └─► picks genres, hits "Start Radio"
        │               └─► sends WS { event: "start", data: {...} }
        │                       └─► RadioPlayer shown (full controls)
        │                             ├─ Rewind button
        │                             ├─ Stop/Play button
        │                             └─ "Change genres" back button
        │                                   └─► sends WS { event: "stop" }
        │                                           └─► back to GenreSelector
        └─► (disconnect)
              └─► promotion logic (see below)
```

The **"Change genres" back button is only rendered when `role === 'controller'`**.
Viewers never see it.

---

## Viewer UI Flow

```
connect
  └─► role_assigned: viewer
        └─► RadioPlayer shown (read-only)
              ├─ Track info, progress bar, equalizer  [same as controller]
              ├─ "Listening" badge (replaces back button)
              ├─ Activity log (visible during generating/buffering)
              ├─ StatusBar with listener count          [same as controller]
              └─ Controls: disabled / hidden
```

If the session is not yet started (state IDLE or STOPPED), the read-only player
shows "Waiting for host to start the radio…" in place of track info.

---

## Controller Promotion

When the controller disconnects, the next viewer in connection order
(first-come-first-get) is promoted.

**Promotion timing:**

| Server state when controller drops | When promotion happens |
|---|---|
| IDLE / STOPPED / PLAYING (no prebuffer task) | Immediately on disconnect |
| GENERATING / BUFFERING (prebuffer task running) | Deferred — after current generation finishes |

**After promotion:**
- Server unicasts `role_assigned: controller` to the promoted client
- Promoted client was already showing RadioPlayer → button and controls appear
- If a track is currently playing, they see it in full-control mode
- They can hit "Change genres" to stop the session and pick new genres
- Other remaining viewers receive no change (they keep watching the track)

**If no viewers remain when the controller disconnects:**
- `_controller_ws` is set to `None`
- Next client to connect becomes the controller (fresh assignment)

---

## WebSocket Protocol Changes

### New client → server events

These replace the current REST calls for `start`, `stop`, and `skip`.
The server checks whether the sending WebSocket is the controller before
executing; non-controllers receive an `error` event back.

```json
{ "event": "start",  "data": { "genres": [...], "keywords": [...], "language": "en" } }
{ "event": "stop" }
{ "event": "skip" }
```

`track_ended` is unchanged and still sent by all connected clients (debounce
already handles deduplication).

### New server → client event (unicast only)

```json
{ "event": "role_assigned", "data": { "role": "controller" } }
{ "event": "role_assigned", "data": { "role": "viewer"     } }
```

This event is sent **only to the relevant client**, never broadcast to all.
All existing broadcast events (`track_ready`, `status`, `progress`,
`listener_count`, `error`) remain unchanged.

---

## Backend Changes

### `backend/radio.py`

| Addition | Purpose |
|---|---|
| `_controller_ws: WebSocket \| None` | Tracks which connection is the controller |
| `_pending_promotion: bool` | Deferred promotion flag (set when controller drops mid-generation) |
| `add_ws(ws)` | Assign controller if none; else viewer. Unicast role. Send late-join snapshot if session active. |
| `remove_ws(ws)` | If controller: promote immediately or defer. Clear `_controller_ws`. |
| `_promote_next_controller()` | Picks first remaining WS, unicasts controller role, clears pending flag |
| `_send_to(ws, message)` | Unicast helper (single WS, no broadcast loop) |
| `_send_state_snapshot(ws)` | Unicasts current track + status to one late-joining WS |
| `start_from_ws(ws, ...)` | Checks `ws == _controller_ws`; calls `start()` if authorised |
| `stop_from_ws(ws)` | Checks `ws == _controller_ws`; calls `stop()` if authorised |
| `skip_from_ws(ws)` | Checks `ws == _controller_ws`; calls `skip()` if authorised |
| `_generate_and_buffer_next()` | After completion, check `_pending_promotion` and call `_promote_next_controller()` if set |
| `start()` | Reset `_pending_promotion = False` |

### `backend/main.py`

- **WebSocket handler**: route `start`, `stop`, `skip` events to the new
  `*_from_ws` methods; keep `track_ended` routing unchanged.
- **Remove** REST endpoints: `POST /api/radio/start`, `POST /api/radio/stop`,
  `POST /api/radio/skip` — these are now WebSocket-only and would bypass role
  checks if kept open.
- **Keep** REST endpoints: `GET /api/genres`, `GET /api/audio/{id}`,
  `GET /api/radio/status`.

---

## Frontend Changes

### `frontend/src/types.ts`
- Add `export type ClientRole = 'controller' | 'viewer'`
- Add `'role_assigned'` to the `WSMessage` event union
- Add `interface RoleAssignedData { role: ClientRole }`

### `frontend/src/hooks/useRadio.ts`
- Add `role: ClientRole | null` state (starts `null` during WS handshake)
- Handle `role_assigned` event → `setRole(data.role)`
- `start(genres, keywords, language)`: send `{ event: 'start', data: {...} }` over WS
  instead of `fetch('/api/radio/start', ...)`
- `stop()`: send `{ event: 'stop' }` over WS instead of `fetch('/api/radio/stop')`
- Expose `role` in the hook return value

### `frontend/src/App.tsx`
Replace the current `view` state binary with role-aware rendering:

```
role === null          →  "Connecting…" full-screen spinner
role === 'controller'  →  view === 'selector' ? <GenreSelector> : <RadioPlayer readonly={false}>
role === 'viewer'      →  <RadioPlayer readonly={true}>   (always, ignores local view state)
```

The controller's existing `view` state machine stays exactly as-is internally.

### `frontend/src/components/RadioPlayer.tsx`
Add `readonly: boolean` prop. When `true`:
- Render `"Listening"` pill where the "← Change genres" button normally sits
- Disable (or hide) Stop/Play and Rewind buttons
- When status is IDLE or STOPPED: show `"Waiting for host to start…"` instead of
  the empty track placeholder

### `frontend/src/App.css`
- `.player__viewer-badge` — small muted pill: `"Listening"` / `"Now Listening"`
- Viewer controls area: reduce opacity or hide buttons via `[disabled]` styling

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| Viewer connects, no session active | Shows read-only player with "Waiting for host…" |
| Controller starts session, viewers join mid-generation | Viewers receive late-join snapshot (activity log entries not replayed, but current status is) |
| Controller stops session | All clients receive `status: stopped`; viewers stay on read-only player; controller returns to GenreSelector |
| Controller drops mid-generation, no viewers | `_controller_ws = None`; generation continues; next person to connect becomes controller immediately |
| Controller drops during PLAYING, next viewer promoted | Promoted client sees RadioPlayer with full controls + "Change genres" available |
| Promoted controller hits "Change genres" | Sends `stop` over WS; session stops; GenreSelector shown to them; viewers see "Waiting for host…" |
| Only one listener ever | Functions exactly like the current single-listener behaviour |

---

## Files Changed

| File | Change type |
|---|---|
| `backend/radio.py` | Role tracking, promotion, unicast, WS-control gate methods |
| `backend/main.py` | Route new WS events; remove REST start/stop/skip |
| `frontend/src/types.ts` | `ClientRole`, `RoleAssignedData`, updated event union |
| `frontend/src/hooks/useRadio.ts` | `role` state; WS-based start/stop; `role_assigned` handler |
| `frontend/src/App.tsx` | Role-aware rendering; viewer never sees GenreSelector |
| `frontend/src/components/RadioPlayer.tsx` | `readonly` prop; viewer badge; disabled controls |
| `frontend/src/App.css` | `.player__viewer-badge` and viewer-mode control styles |
