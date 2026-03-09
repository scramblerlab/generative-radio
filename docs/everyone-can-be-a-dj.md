# Everyone Can Be a DJ

## Overview

Any user viewing the RadioPlayer page can temporarily claim the "DJ" role and drive the musical direction for everyone. After a cooldown period, the "Generate Your Tracks" button activates. The first user to press it gets to choose genre, mood, language, and their name — their selections feed the LLM for all subsequent tracks, and their name appears in every track title they sponsor.

---

## User Flow

1. User opens RadioPlayer — sees "Generate Your Tracks" button (grayed out with countdown)
2. After 5 minutes the button activates for **all** connected users simultaneously
3. First user to click gets the DJ slot → a form panel opens
4. They fill in: Genre, Mood, Language, How are you feeling?, **Your name (required)**
5. On submit → backend reschedules tracks with new settings; button re-locks for 5 minutes for everyone
6. All subsequent tracks carry the title format: `[SONG_TITLE] (DJ: [NAME])`
7. "Now curated by [NAME]" appears under the button for all users

---

## Architecture

### New WebSocket Events

| Direction | Event | Payload | Purpose |
|---|---|---|---|
| Client → Server | `dj_claim` | — | Attempt to claim the DJ slot |
| Client → Server | `dj_submit` | `{ genres, keywords, language, feeling, djName }` | Submit DJ form after claim granted |
| Server → Client | `dj_state` | `{ locked, unlockAt, activeDjName }` | Broadcast on every lock change + in late-join snapshot |
| Server → Client | `dj_claim_ack` | `{ granted }` | Unicast: opens panel if `true` |

`unlockAt` is a Unix wall-clock timestamp (float seconds). Clients compute the countdown locally from this value — no per-tick server pushes needed.

### Backend (`backend/radio.py`)

New state on `RadioOrchestrator`:
- `_DJ_LOCK_S = 300.0` — lock duration in seconds
- `_dj_lock_until: float` — initialized to `time.time() + 300` on server start
- `_dj_claimant_ws: WebSocket | None` — WS that won the claim but hasn't submitted yet
- `_dj_name: str` — current DJ name; drives title suffix for all generated tracks

New methods:
- `claim_dj_from_ws(ws)` — atomic first-click-wins guard; re-locks immediately on success
- `submit_dj_from_ws(ws, ...)` — validates claimant, sets `_dj_name`, calls `reschedule()`
- `_broadcast_dj_state()` / `_make_dj_state_message()` — build and send the `dj_state` event

Track title injection in `_generate_track()` (after TrackInfo construction, before caching):
```python
if self._dj_name:
    track_info = track_info.model_copy(
        update={"song_title": f"{track_info.song_title} (DJ: {self._dj_name})"}
    )
```
LLM history (`self.history`) retains the original clean title so the model's repetition-avoidance context stays uncluttered.

`_dj_name` persists until overwritten by the next DJ — all tracks generated in between carry the current DJ's credit.

### Race Condition Safety

`claim_dj_from_ws` sets `_dj_claimant_ws` before the first `await`. Because FastAPI's WebSocket handler runs in a single-threaded asyncio event loop, there is no preemption between the guard check and the assignment — the race is logically impossible within one process.

### Frontend

| File | Change |
|---|---|
| `types.ts` | `DjStateData`, `DjClaimAckData` interfaces; extended `WSMessage` event union |
| `hooks/useRadio.ts` | `djLocked`, `djUnlockAt`, `activeDjName`, `djPanelOpen` state; `claimDj()`, `submitDj()`, `closeDjPanel()` functions; handles `dj_state` and `dj_claim_ack` events |
| `components/DJPanel.tsx` | Modal overlay with genre/mood/language/feeling/name form. Fetches `/api/genres` on mount. Name field is mandatory. |
| `components/RadioPlayer.tsx` | "Generate Your Tracks" button with `djLocked`/`djUnlockAt` props; countdown computed via `setInterval(1000)` locally; "Unlocks in MM:SS" text below button |
| `App.tsx` | Passes DJ props to both RadioPlayer instances; renders `<DJPanel>` overlay when `radio.djPanelOpen` |

---

## Testing Checklist

1. **Timer**: Set `_DJ_LOCK_S = 10` temporarily — button unlocks ~10s after server start in all open tabs
2. **First-click wins**: Open two tabs, click simultaneously — only one gets the panel
3. **Re-lock**: After submission, button grays out in all tabs with fresh countdown
4. **Title suffix**: Next track title appears as `[SONG_TITLE] (DJ: [NAME])` in both tabs
5. **Mandatory name**: Submit with empty name → red border + error message, no submit sent
6. **Disconnect during claim**: Close the tab that won the claim → button state broadcast clears
7. **Late join**: Open a new tab while button is locked → sees correct locked state immediately
