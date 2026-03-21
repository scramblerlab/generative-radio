# Thumb Up / Thumb Down Feature

## Context
Add crowd-reaction buttons to the RadioPlayer page. Any listener (controller or viewer) can thumb-up or thumb-down the currently playing track. Reactions are aggregated as integer counts, togglable, and persisted to `tracks_with_user_action/{track_id}.json` (with the MP3 also saved alongside on first reaction). All connected clients see live count updates via WebSocket broadcast.

---

## Operation Diagram: "User selects Thumb Up"

```
Browser (RadioPlayer.tsx)
  └─ User clicks 👍 button
  └─ onReact('thumb_up') fires
        │
        ▼
Browser (useRadio.ts → react())
  └─ POST /api/tracks/{trackId}/react  {"action":"thumb_up"}
        │
        ▼
Backend (main.py → /react endpoint)
  └─ Extracts client IP via _resolve_request_ip()
  └─ Calls radio.react(track_id, "thumb_up", ip, REACTIONS_DIR)
        │
        ▼
Backend (radio.py → react())
  1. Acquires asyncio.Lock for this track_id
  2. Toggles IP in thumb_up_voters[track_id] set
     (if already in set → remove (deselect); if in opposite set → move)
  3. Computes new counts: len(thumb_up_voters), len(thumb_down_voters)
  4. Calls _write_reaction_file():
       - If first reaction: reads reaction_metadata_cache[track_id],
         copies MP3 bytes to tracks_with_user_action/{track_id}.mp3,
         writes full JSON with audioPath = absolute local path to that .mp3
       - If file exists: updates thumb_up / thumb_down counts only
  5. Releases lock
  6. Broadcasts reaction_update event → all WebSocket clients
        │                    │
        ▼                    ▼
REST Response          WS: reaction_update
to requesting          to ALL connected clients
client:                {"event":"reaction_update",
{"thumb_up":N,          "data":{"trackId":"...",
 "thumb_down":M,                "thumbUp":N,
 "userReaction":        "thumbDown":M}}
 "thumb_up"}
        │                    │
        ▼                    ▼
Browser (useRadio.ts)   Browser (useRadio.ts — all tabs)
Updates userReaction    Updates thumbUp/thumbDown counts
→ 👍 button turns amber → All listeners see live counts
```

---

## JSON Schema: `tracks_with_user_action/{track_id}.json`

```json
{
  "trackId": "550e8400-e29b-41d4-a716-446655440000",
  "recordedAt": "2026-03-21T14:32:00.123456",
  "songTitle": "Midnight Wanderer",
  "genre": "Flamenco",
  "bpm": 120,
  "keyScale": "A Minor",
  "duration": 90,
  "language": "en",
  "keywords": ["melancholic", "acoustic"],
  "tags": "flamenco, acoustic guitar, passionate, male vocal, studio",
  "lyrics": "[Verse]\n...",
  "style": "flamenco, acoustic",
  "instruments": "acoustic guitar, cajon, palmas",
  "mood": "passionate, intense",
  "vocalStyle": "male vocal, raspy",
  "production": "studio, dry reverb",
  "djName": "SunsetDJ",
  "audioPath": "/Users/nobu/dev/ai/radio/tracks_with_user_action/550e8400-e29b-41d4-a716-446655440000.mp3",
  "thumb_up": 2,
  "thumb_down": 0
}
```

Key notes:
- `audioPath` is the absolute local Mac path to the MP3 saved in the same folder on first reaction
- `djName` comes from `radio._dj_name` (empty string `""` if no DJ was active)
- `recordedAt` is set once at file creation (first reaction ever for this track)
- MP3 is copied from `audio_cache[track_id]` into `tracks_with_user_action/{track_id}.mp3` on first write

---

## API Contract

### `POST /api/tracks/{track_id}/react`
- Body: `{ "action": "thumb_up" | "thumb_down" }`
- Toggle semantics: same action again = deselect; opposite action = switch sides
- Response: `{ "thumb_up": int, "thumb_down": int, "userReaction": "thumb_up" | "thumb_down" | null }`
- No local-IP restriction — all users can react
- `400` if track metadata unavailable (cache miss + no file)

### `GET /api/tracks/{track_id}/reactions`
- Response: same shape as above
- Falls back to file counts if in-memory is zero (covers server restarts)

### WebSocket broadcast after every vote: `reaction_update`
```json
{ "event": "reaction_update", "data": { "trackId": "...", "thumbUp": 2, "thumbDown": 1 } }
```
`userReaction` intentionally absent — each client tracks their own vote locally.

---

## Design Decisions

**Per-user toggle tracking:** In-memory `thumb_up_voters: dict[str, set[str]]` and `thumb_down_voters: dict[str, set[str]]` (track_id → set of IPs) in `RadioOrchestrator`. Counts only in JSON — no IPs on disk.

**Race conditions:** `asyncio.Lock` per track_id (`reaction_locks: dict[str, asyncio.Lock]`). File I/O offloaded via `loop.run_in_executor` to avoid blocking the event loop.

**Cache eviction:** Add `reaction_metadata_cache: dict[str, dict]` populated in `_generate_track()` alongside `track_info_cache`, but NOT cleared in `_radio_loop`'s eviction blocks — only in `stop()`. Snapshot includes audio bytes so MP3 can be written even after `audio_cache` eviction.

---

## Files Modified

| File | Change |
|---|---|
| `backend/models.py` | Add `ReactionAction` enum, `ReactRequest` model |
| `backend/radio.py` | Add voter dicts, `reaction_metadata_cache`, `react()`, `_write_reaction_file()`, `get_reactions()` |
| `backend/main.py` | Add `REACTIONS_DIR`, two new REST endpoints |
| `frontend/src/types.ts` | Add `ReactionState`, `ReactionUpdateData`, extend `WSMessage.event` |
| `frontend/src/hooks/useRadio.ts` | Add reaction state, WS handler, `react` callback |
| `frontend/src/components/RadioPlayer.tsx` | Add thumb buttons between controls and activity log |
| `frontend/src/App.tsx` | Wire `reactionState` and `onReact` props |
| `frontend/src/App.css` | Add reaction button styles |

---

## Verification

```bash
# 1. Get reactions for a playing track (zeros initially)
curl http://localhost:5555/api/tracks/<track_id>/reactions

# 2. Thumb up → check response + file created
curl -X POST http://localhost:5555/api/tracks/<track_id>/react \
  -H "Content-Type: application/json" -d '{"action":"thumb_up"}'
# Expect: {"thumb_up":1,"thumb_down":0,"userReaction":"thumb_up"}
cat tracks_with_user_action/<track_id>.json   # full metadata + audioPath to .mp3
ls tracks_with_user_action/<track_id>.mp3     # MP3 saved alongside

# 3. Toggle off (same action) → count drops to 0
# 4. Switch sides (up then down) → thumb_up:0, thumb_down:1
# 5. Multi-tab: react from two browser tabs → both update via WS broadcast instantly
# 6. React just after track transitions → file still created (reaction_metadata_cache)
# 7. Invalid action → 422 from FastAPI/Pydantic
```
