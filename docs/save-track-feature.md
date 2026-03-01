# Save Track Feature

## Overview

The "Save Track" button replaces the former "More Like This" seed-pinning button. It allows the controller to permanently save any currently-playing song to disk as an MP3 and a rich JSON metadata file.

## UI

- Appears in `RadioPlayer` for the **controller only** (not visible to viewers).
- Shown only when a track is actively loaded.
- Button states:
  - **Idle**: `👍 Save Track`
  - **Saving**: `Saving…` (disabled)
  - **Success**: `✓ Saved!` (green, reverts to idle after 2 s)
  - **Error**: `⚠ Error` (red, reverts to idle after 2 s)
- Resets to idle whenever the current track changes.

## Save Location

Files are written to `saved_tracks/` at the project root:

```
/Users/nobu/dev/ai/radio/saved_tracks/
  Electric_Dreams.2026-03-01_14-30-45.mp3
  Electric_Dreams.2026-03-01_14-30-45.json
```

The directory is created automatically on first save. It is git-ignored via `.gitignore`.

## Filename Convention

```
{sanitized_title}.{YYYY-MM-DD_HH-MM-SS}.{ext}
```

- Title sanitization: non-word characters removed, spaces → underscores, max 50 characters.
- Datetime: local time at moment of save.
- Saving the same track twice produces two distinct files (different timestamps).

## JSON Schema

```json
{
  "trackId": "uuid",
  "savedAt": "2026-03-01T14:30:45.123456",
  "songTitle": "Electric Dreams",
  "genre": "Synthwave",
  "isRandom": false,
  "bpm": 128,
  "keyScale": "C Minor",
  "duration": 60,
  "language": "en",
  "keywords": ["chill", "dark"],
  "style": "synthwave, retro-futurism, 80s analog warmth",
  "instruments": "analog synthesizers, drum machine, electric guitar",
  "mood": "nostalgic, euphoric, cinematic",
  "vocalStyle": "female vocal, breathy, soft",
  "production": "layered synths, reverb-heavy, driving beat",
  "lyrics": "[Intro]\n...",
  "tags": "synthwave, retro-futurism, ...",
  "seed": "1234567890",
  "advancedOptions": {
    "timeSignature": "4/4",
    "inferenceSteps": 8,
    "model": "turbo"
  },
  "audioFile": "Electric_Dreams.2026-03-01_14-30-45.mp3"
}
```

## API Endpoint

```
POST /api/tracks/{track_id}/save
```

Returns:
```json
{
  "mp3": "/absolute/path/to/saved_tracks/Electric_Dreams.2026-03-01_14-30-45.mp3",
  "json": "/absolute/path/to/saved_tracks/Electric_Dreams.2026-03-01_14-30-45.json",
  "baseName": "Electric_Dreams.2026-03-01_14-30-45"
}
```

Errors:
- `404` if the track is no longer in the in-memory audio cache (e.g., already evicted after playback ended).
- `404` if prompt or track metadata is missing.

## Backend Changes

| File | Change |
|---|---|
| `backend/radio.py` | Added `prompt_cache`, `seed_cache`, `track_info_cache` dicts (keyed by `track_id`); removed seed-pinning state (`_last_seed`, `_pinned_seed`) and methods |
| `backend/main.py` | Added `POST /api/tracks/{track_id}/save` endpoint; removed `pin_seed`/`unpin_seed` WS handlers |

## Frontend Changes

| File | Change |
|---|---|
| `frontend/src/hooks/useRadio.ts` | Removed `moreLikeThis`, `lastSeed`, `setMoreLikeThis`; added `saveTrack(trackId)` |
| `frontend/src/App.tsx` | Removed More Like This props; passes `onSaveTrack` to controller `RadioPlayer` |
| `frontend/src/components/RadioPlayer.tsx` | Replaced More Like This button with Save Track button + save state machine |
| `frontend/src/App.css` | Replaced `.player__more-like-this` styles with `.player__save-track` styles |
