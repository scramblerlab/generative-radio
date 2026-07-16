# Offline Mode (Airplane Mode Track Play) — Design & Build Hand-off Document

Monorepo: `/Users/nobu/dev/ai/radio`. Backend: FastAPI (`backend/`, all routes in `main.py`). Mobile: Expo canary 55 app (`mobile/`), expo-audio (NOT expo-av), all playback state in one hook `mobile/src/hooks/useRadio.ts`.

**This document is self-contained** — it is intended to be handed to another AI/engineer (e.g. on the mobile-build MacBook) who has the repo but no other context. Implement top-to-bottom per §8.

## Context

The generative-radio mobile app is currently a purely server-driven live radio: the backend decides the current track, the app downloads and plays it. There is no way to listen without connectivity (airplane mode, subway, travel). Meanwhile the backend already maintains a persistent on-disk library of up to 500 finished tracks (`{trackId}.mp3` + `{trackId}.json` metadata sidecars). This feature reuses that library as offline content: the user filters it (keyword against `tags`, genre against `genres`), downloads up to 500 tracks to the device, and plays them in random order fully offline, with all existing transport controls, lock-screen controls, and metadata display working unchanged. iOS is the immediate target; every choice below is Android-compatible (no iOS-only APIs without existing Android-equivalent handling).

**User decisions (locked):**
- New backend library endpoints are **open** (no auth/IP gating), same policy as `/api/audio/{id}`.
- **PLAY EXISTING TRACKS plays ALL downloaded tracks**; the keyword/genre filters affect DOWNLOAD only.
- When the filter matches more than "max tracks": pick a **random sample** of N (client-side).
- **All new UI must inherit existing cosmetics** — only theme tokens from `mobile/src/components/theme.ts` and styles copied from `DJPanel.tsx` / `GenreSelector.tsx` / `RadioPlayer.tsx`. No new fonts, colors, radii, or component styles.
- Note: the requested genre "drop-down" is realized as the app's established **pill selector** (same pattern as DJPanel's genre picker) — this is the app's dropdown-equivalent and satisfies the cosmetics rule.

## 0. Feature summary (requirements)

- Mobile app gets an **OFFLINE MODE** button. Pressing it opens a settings dialog with:
  - "Max tracks to download" numeric input (default 500, clamp 1–500)
  - "Keyword" text input — case-insensitive substring match against the `tags` field (a free-text string); blank = no filter
  - "Genre" selector — options from `GET /api/genres`, matched against the `genres` array field; blank/"All" = no filter
  - Live **"Found XX tracks"** count for the current filter
  - **DOWNLOAD** button: clears previously downloaded files, downloads the filtered set (random sample of max if over), showing "Stand by... XX / XXX tracks downloaded"; when done, offline playback starts automatically
  - **PLAY EXISTING TRACKS** button: enters offline playback using previously downloaded files, zero network needed (works after app restart)
- Offline playback: RANDOM order (reshuffle on exhaustion, no immediate repeat); existing transport controls unchanged (play/pause, ±10 s seek, lock-screen controls, metadata + lyrics display).
- While offline, show **BACK TO ONLINE MODE** which returns to the server-driven radio.

## 1. Established facts (verified in code)

### 1.1 Backend library

`backend/library.py`, class `TrackLibrary` (held by orchestrator as `radio.library`; `radio` is a module-level singleton in `backend/main.py` ~line 39):

- Library dir: `os.getenv("LIBRARY_DIR", "/Volumes/SP PCIe M.2/generative-radio/library")` (library.py:35,58). If the volume isn't mounted, `self.enabled = False` and the library is inert.
- Files: `{trackId}.mp3` + `{trackId}.json` sidecar, cap 500 tracks (`LIBRARY_MAX_TRACKS`).
- In-memory index: `self._index: dict[str, dict]` (trackId → parsed sidecar), loaded at startup by `_load_index()` (library.py:102) — only indexes entries whose `.mp3` exists.
- `load_audio(track_id)` (library.py:231) reads mp3 bytes; `pick(genre_ids)` (library.py:206) filters by `wanted & set(m.get("genres", []))`.

Sidecar JSON schema (verified against a real file; treat every field except `trackId` as optional when parsing):

| field | type | example |
|---|---|---|
| trackId | string (uuid) | "00e3f584-4c3d-48c2-9931-5bee1d9b4037" |
| songTitle | string | "THE HOLLOW WHINE OF A LOST SIGNAL TOWER" |
| genreLabel | string | "Jazz" |
| genres | string[] (genre ids) | ["jazz"] |
| keywords | string[] | [] |
| language | string | "en" |
| bpm | number | 72 |
| keyScale | string | "D Minor" |
| duration | number (seconds) | 240 |
| tags | string (comma/pipe free text) | "smooth jazz, neo-soul influences \| 70s R&B, ..." |
| lyrics | string (multiline) | "[Verse]..." |
| style / instruments / mood / vocalStyle / production | string | — |
| seed | string | "3461618048" |
| djName | string | "Mille" |
| createdAt | string (ISO8601) | "2026-06-24T04:48:46.313388+00:00" |
| acestepFile | string | "8dbaa047-....mp3" |

- `GET /api/genres` (main.py:131) returns `{"genres": GENRES, "keywords": KEYWORDS, "languages": LANGUAGES}`; `GENRES` items are `{id, label, subgenres}` (36 genres: rock, pop, jazz, electronic, hiphop, classical, lofi, ambient, rnb, folk, metal, country, blues, soul, reggae, latin, afrobeats, disco, punk, soundtrack, synthwave, gospel, ska, bossanova, funk, indie, house, techno, dnb, trap, flamenco, newage, samba, bluegrass, opera, celtic). Sidecar `genres` values are these same ids.
- **No endpoint currently lists the library or serves library files from disk.** `/api/audio/{track_id}` (main.py:185) serves only the in-memory session `radio.audio_cache` and is open (no auth). `POST /api/tracks/{id}/save` is local-IP gated — the new endpoints must NOT copy that gating (decision: open).
- CORS middleware lists fixed web origins with GET/POST — irrelevant to the native app. `SecurityHeadersMiddleware` (CORP `same-site`) does not affect native fetches.
- Backend dev start: `scripts/start.sh` runs `uvicorn main:app --host 127.0.0.1 --port 5555 --reload` from `backend/` using `backend/.venv`. FastAPI `>=0.115.0` (Starlette's `FileResponse` handles Range; not required — whole-file downloads).

### 1.2 Mobile

- `mobile/package.json` deps: `expo 55.0.10-canary-20260328-bdc6273`, `expo-audio` same canary, `@kesha-antonov/react-native-background-downloader ^4.5.4`, `react-native 0.83.4`, react-navigation stack. **No expo-file-system in package.json yet**, but `expo-file-system@55.0.13-canary-20260328-bdc6273` is already installed at the monorepo root `node_modules` (transitive dep of `expo`) and its native module is autolinked into the dev client. Its **default export is the NEW class API** (`File`, `Directory`, `Paths`); legacy API at `expo-file-system/legacy`. Verified API surface:
  - `Paths.document` (Directory), `Paths.availableDiskSpace` (number, bytes)
  - `new Directory(...parts)`, `.exists`, `.create({intermediates?, idempotent?})`, `.delete()` (recursive), `.list(): (File|Directory)[]`
  - `new File(...parts)`, `.exists`, `.uri` (`file:///…`), `.name`, `.write(string)` (sync), `.textSync()`, `.delete()`
  - `File.downloadFileAsync(url, destination, options?: {headers?, idempotent?}) → Promise<File>` — rejects with `DestinationAlreadyExists` unless `idempotent: true`. **No per-byte progress callback, no cancel token** — we count whole files, matching the required "XX / XXX tracks downloaded" UI.
- `mobile/src/config.ts`: `BACKEND_URL = __DEV__ ? 'http://localhost:5555' : 'https://radio.scrambler-lab.com'`; `WS_URL` analogous.
- `mobile/src/App.tsx`: loads fonts, `const radio = useRadio()`, renders `<AppNavigator radio={radio}/>`.
- `mobile/src/navigation/AppNavigator.tsx`: single screen — `IPadLayout` wrapping `RadioPlayer` plus `DJPanel` modal.
- `mobile/src/utils/downloadAudio.ts`: background downloader with ONE fixed task id `track_current` and fixed file `documents/track_current.mp3` for online streaming. **Leave untouched.**
- `mobile/src/components/theme.ts` tokens (use these, nothing else):
  - `colors`: bg `#0a0a0f`, surface `#111118`, surface2 `#1a1a26`, border `#1e1e30`, border2 `#2a2a40`, accent `#f59e0b`, accentGlow, accentDim, indigo `#6366f1`, text `#f1f5f9`, textMuted `#64748b`, textDim `#94a3b8`, green `#22c55e`, red `#ef4444`
  - `radius`: sm 8, md 12, pill 999
  - `fonts`: display `BebasNeue_400Regular`; regular/medium/semiBold/bold `SpaceGrotesk_*`
- Shared `Track` type (`packages/shared/src/types.ts:11`): `{id, songTitle, genre, isRandom, tags, lyrics, bpm, keyScale, duration, audioUrl, djName, djKeywords, djLanguage}` — `RadioPlayer` renders title, tags, bpm/keyScale/duration, lyrics from this.
- `app.json`: iOS `UIBackgroundModes: ["audio","fetch"]`, `./plugins/withBackgroundDownloader`, `expo-audio` plugin with background playback + remote control. **No app.json changes needed.**

### 1.3 useRadio.ts anatomy (the exact things we branch)

`mobile/src/hooks/useRadio.ts` (~1190 lines). Key items by current line:

- State: `radioState` (+`radioStateRef`), `currentTrack`, `statusMessage`, `errorMessage`, `activityLog`, `progress`, `audioDuration`, `listenerCount`, `viewers`, `localPaused`(+ref), DJ state, `reactionState`(+ref).
- Refs: `currentTrackIdRef`, `pollTimerRef`, `progressTimerRef`, `isFetchingRef`, `fetchEpochRef`, `fetchStartedAtRef`, `wsRef`, `reconnectTimer`, `reconnectDelay`, `pingIntervalRef`, `isActiveRef`, `isBackgroundRef`, `playerReadyRef`, `playerSubRef`, `bgTrackEndTimerRef`, `bgWaitCapTimerRef`, `playerRef`, `silencePlayerRef`, `isBridgingRef`, `bgStatusCleanupRef`, `fetchAndPlayRef`, `handleTrackEndedRef`.
- Functions: `startProgressTimer`/`stopProgressTimer` (L178/197 — read `playerRef` generically; **work unchanged offline**), `sendWS` (L213), `sendTrackEnded` (L221 — WS or HTTP POST `/api/radio/track-ended`), `fetchReactions` (L242), `startSilenceBridge`/`stopSilenceBridge` (L266/287), `handleBackgroundAndroid` (L310), `handleBackgroundIOS` (L322 — removes `playerSubRef`, arms `bgTrackEndTimerRef` from `playerRef` duration; **generic, works offline**), `handleForegroundIOS` (L344 — re-attaches a `playbackStatusUpdate` listener whose `failed` branch calls `fetchAndPlayRef` — needs offline awareness), `handleNativeStatusResult` (L375), `handleTrackEndedAndroid` (L414 — Android Doze path via native `backgroundHttp`), `stopPolling`/`startPolling` (L445/453), `fetchAndPlay` (L479 — core: GET `/api/radio/status`, dedupe, `downloadAudio`, `createAudioPlayer({uri},{keepAudioSessionActive:true,updateInterval:60_000})`, inline status listener with `failed`/`didJustFinish`/external-pause-sync branches, `setActiveForLockScreen`, iOS-background listener re-suspension + backup timer L672–691), `handleTrackEnded` (L717), `handleWake` (L744), `connectWebSocket` (L781), mount effect (L913 — connects WS + first `fetchAndPlay`), AppState effect (L934), `tuneIn`/`tuneOut` (L1047/1056), `saveTrack`, `claimDj`/`submitDj`/`closeDjPanel`, `react` (L1105), `togglePlayPause`/`seekBackward`/`seekForward` (L1125–1165 — operate purely on `playerRef` + `localPausedRef`; **work unchanged offline**), `status` derivation (L1170).

## 2. Design decisions (with rationale)

1. **Index endpoint returns FULL sidecar metadata including lyrics.** 500 sidecars × ~2–4 KB ≈ 1–2 MB in one JSON response — one fetch on panel open, instant client-side filtering, no per-track metadata endpoint. The offline player displays lyrics, so they must reach the device anyway.
2. **Audio endpoint = `FileResponse` from disk.** Path traversal impossible: `track_id` is validated by index membership before any path is built.
3. **Random sample (matches > max) happens CLIENT-SIDE** — Fisher-Yates shuffle of the filtered array, take first N. Keeps the server dumb; the "found XX" count stays consistent with what gets sampled.
4. **Downloads use `expo-file-system` `File.downloadFileAsync` in a sequential foreground loop** — NOT the background downloader. Rationale: (a) per-file counts match the progress dialog for free; (b) 500 downloader tasks means task-id bookkeeping and interference with the existing `track_current` task; (c) while downloading, the online radio keeps playing, so the active audio session keeps JS alive even if backgrounded (iOS `UIBackgroundModes: audio`; Android media foreground service) — the loop survives; (d) identical code on both platforms. Cancellation = flag checked between files (~5 MB each ⇒ cancel latency ≤ one file). Sequential concurrency-1 is intentional (predictable progress, no server hammering); do not add a worker pool in v1.
5. **Persistence is scan-based, not manifest-based.** Layout: `Paths.document/offline/tracks/{trackId}.mp3` + `{trackId}.json` (sidecar verbatim). "PLAY EXISTING" scans the directory and accepts a track iff both files exist — mirroring `TrackLibrary._load_index()`. Crash-safe invariant: **`.json` is written only AFTER its `.mp3` fully downloaded**, so *json present ⇒ mp3 complete*. No manifest file to go stale; partial downloads (cancel/kill/failure) are immediately playable. Additionally cache `GET /api/genres` to `Paths.document/offline/genres.json` for the genre selector when opened without network (the filter only matters for DOWNLOAD, which needs network anyway; if neither network nor cache, render only the "All" pill).
6. **Offline mode is integrated INTO `useRadio` (not a sibling hook)** so it reuses `playerRef`, `playerSubRef`, progress timer, `localPausedRef`, lock-screen registration, AppState/background machinery, and `togglePlayPause`/`seekBackward`/`seekForward` verbatim. A sibling hook can't suppress useRadio's WS reconnects/`handleWake`/mount fetch without useRadio cooperating anyway. Pure download/scan/filter logic lives in `offlineLibrary.ts`; modal UI in `OfflinePanel.tsx`.
7. **No silence bridge during offline playback.** Local files load in milliseconds; `keepAudioSessionActive: true` carries the session across track swaps. Bridge functions stay untouched for online mode.

## 3. Backend changes

### 3.1 `backend/library.py` — add three public accessors to `TrackLibrary`

Place after `pick()` / `load_audio()` (around line 240):

```python
def all_meta(self) -> list[dict]:
    """All sidecar metadata dicts, newest first. Empty when disabled."""
    if not self.enabled:
        return []
    return sorted(
        self._index.values(),
        key=lambda m: m.get("createdAt", ""),
        reverse=True,
    )

def get_meta(self, track_id: str) -> dict | None:
    return self._index.get(track_id) if self.enabled else None

def audio_path(self, track_id: str) -> "Path | None":
    """Absolute path to the mp3, only for track_ids present in the index."""
    if not self.enabled or track_id not in self._index:
        return None
    path = self.dir / f"{track_id}.mp3"
    return path if path.is_file() else None
```

### 3.2 `backend/main.py` — two new routes

Change the import at line 21 to `from fastapi.responses import StreamingResponse, FileResponse`. Add routes near `/api/audio/{track_id}` (after ~line 218):

```python
@app.get("/api/library/index")
async def get_library_index():
    """Full metadata for every track in the persistent library.

    Open access (same policy as /api/audio). ~1-2 MB for a full 500-track
    library; the mobile offline panel fetches it once and filters locally.
    """
    tracks = radio.library.all_meta()
    return {"enabled": radio.library.enabled, "count": len(tracks), "tracks": tracks}


@app.get("/api/library/audio/{track_id}")
async def get_library_audio(track_id: str):
    """Serve a library mp3 from disk. track_id must be a known index key
    (this also makes path traversal impossible)."""
    path = radio.library.audio_path(track_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Track not found in library")
    return FileResponse(
        path,
        media_type="audio/mpeg",
        filename=f"{track_id}.mp3",
        headers={"Cache-Control": "public, max-age=86400"},
    )
```

### 3.3 Endpoint specs

**GET `/api/library/index`** — no params.
- 200, enabled: `{"enabled": true, "count": 500, "tracks": [ {…full sidecar as in §1.1 table…} ]}` (newest first)
- 200, library disabled (volume unmounted): `{"enabled": false, "count": 0, "tracks": []}` — deliberately not an error; client shows "Found 0 tracks" and disables DOWNLOAD.

**GET `/api/library/audio/{track_id}`**
- 200: `audio/mpeg` body, `Content-Length` set by FileResponse, `Cache-Control: public, max-age=86400`.
- 404 `{"detail": "Track not found in library"}` when: library disabled, unknown id, or mp3 vanished from disk.

No CORS or SecurityHeadersMiddleware changes needed.

## 4. Mobile: types and storage

### 4.1 New dependency

`mobile/package.json` → add to `dependencies`:
```json
"expo-file-system": "55.0.13-canary-20260328-bdc6273"
```
(Exact canary version matching the installed root package.) Then `npm install` at repo root. The native module is already in the dev client (autolinked), but rebuild anyway (`npx expo run:ios`).

### 4.2 New file `mobile/src/utils/offlineLibrary.ts` — types, storage, download engine

```ts
import { File, Directory, Paths } from 'expo-file-system';
import { Genre, Track } from '@radio/shared';
import { BACKEND_URL } from '../config';

// ---------- Types ----------

/** Sidecar metadata as served by GET /api/library/index (and stored on device).
 *  Every field except trackId may be missing in old sidecars — keep optional. */
export interface OfflineTrackMeta {
  trackId: string;
  songTitle?: string;
  genreLabel?: string;
  genres?: string[];
  keywords?: string[];
  language?: string;
  bpm?: number;
  keyScale?: string;
  duration?: number;
  tags?: string;
  lyrics?: string;
  style?: string;
  instruments?: string;
  mood?: string;
  vocalStyle?: string;
  production?: string;
  seed?: string;
  djName?: string;
  createdAt?: string;
  acestepFile?: string;
}

export interface LibraryIndexResponse {
  enabled: boolean;
  count: number;
  tracks: OfflineTrackMeta[];
}

export interface DownloadProgress { done: number; total: number; failed: number }
export interface DownloadResult   { downloaded: OfflineTrackMeta[]; failed: number; cancelled: boolean }

// ---------- Storage layout ----------
// Paths.document/offline/tracks/{trackId}.mp3   — audio
// Paths.document/offline/tracks/{trackId}.json  — sidecar verbatim (written AFTER mp3 ⇒ json implies complete mp3)
// Paths.document/offline/genres.json            — cached /api/genres response

const offlineDir = () => new Directory(Paths.document, 'offline');
const tracksDir  = () => new Directory(Paths.document, 'offline', 'tracks');

export function offlineTrackUri(trackId: string): string {
  return new File(tracksDir(), `${trackId}.mp3`).uri;   // "file:///..."
}

export async function fetchLibraryIndex(): Promise<LibraryIndexResponse> {
  const res = await fetch(`${BACKEND_URL}/api/library/index`);
  if (!res.ok) throw new Error(`Index fetch failed: ${res.status}`);
  return await res.json() as LibraryIndexResponse;
}

/** keyword: case-insensitive substring of `tags`; genreId '' = All. */
export function filterTracks(tracks: OfflineTrackMeta[], keyword: string, genreId: string): OfflineTrackMeta[] {
  const kw = keyword.trim().toLowerCase();
  return tracks.filter((t) =>
    (!kw || (t.tags ?? '').toLowerCase().includes(kw)) &&
    (!genreId || (t.genres ?? []).includes(genreId))
  );
}

/** Fisher-Yates shuffle of a copy. Shared by sampleTracks and the playback queue. */
export function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Random sample of n. n >= length → shuffled copy. */
export function sampleTracks(tracks: OfflineTrackMeta[], n: number): OfflineTrackMeta[] {
  return shuffled(tracks).slice(0, n);
}

/** Scan device storage: a track exists iff {id}.json parses AND sibling {id}.mp3 exists. */
export function scanOfflineTracks(): OfflineTrackMeta[] {
  const dir = tracksDir();
  if (!dir.exists) return [];
  const metas: OfflineTrackMeta[] = [];
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.name.endsWith('.json')) {
      try {
        const meta = JSON.parse(entry.textSync()) as OfflineTrackMeta;
        if (meta.trackId && new File(dir, `${meta.trackId}.mp3`).exists) metas.push(meta);
      } catch { /* skip unreadable sidecar */ }
    }
  }
  return metas;
}
// Perf note: this reads up to 500 small JSON files synchronously on the JS
// thread (~tens of ms total on modern devices). Called only on panel open and
// after cancel — acceptable. If panel-open jank is ever observed, wrap the call
// site in InteractionManager.runAfterInteractions; do not pre-optimize.

export function clearOfflineTracks(): void {
  const dir = tracksDir();
  if (dir.exists) dir.delete();                       // recursive
  dir.create({ intermediates: true, idempotent: true });
}

export function cacheGenres(genres: Genre[]): void;        // write offline/genres.json (create offlineDir first)
export function loadCachedGenres(): Genre[] | null;        // read + parse, null on any failure

/** Map sidecar meta → shared Track for RadioPlayer display. */
export function metaToTrack(meta: OfflineTrackMeta): Track {
  return {
    id: meta.trackId,
    songTitle: meta.songTitle ?? 'Unknown Track',
    genre: meta.genreLabel ?? '',
    isRandom: false,
    tags: meta.tags ?? '',
    lyrics: meta.lyrics ?? '',
    bpm: meta.bpm ?? 0,
    keyScale: meta.keyScale ?? '',
    duration: meta.duration ?? 0,
    audioUrl: '',                       // unused offline
    djName: meta.djName ?? '',
    djKeywords: [],
    djLanguage: meta.language ?? '',
  };
}
```

### 4.3 Download loop (near-code; also in `offlineLibrary.ts`)

```ts
const AVG_TRACK_BYTES = 6 * 1024 * 1024;   // ~6 MB for a 240 s mp3 — pre-check estimate

export async function downloadTracks(
  selected: OfflineTrackMeta[],
  onProgress: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
): Promise<DownloadResult> {
  // Disk-space pre-check (soft): throw a user-readable error before clearing anything.
  if (Paths.availableDiskSpace < selected.length * AVG_TRACK_BYTES) {
    throw new Error(
      `Not enough free space (~${Math.round(selected.length * AVG_TRACK_BYTES / 1e9 * 10) / 10} GB needed)`);
  }

  clearOfflineTracks();                      // requirement: DOWNLOAD clears previous files first
  const dir = tracksDir();
  const downloaded: OfflineTrackMeta[] = [];
  let failed = 0;

  for (const meta of selected) {
    if (isCancelled()) return { downloaded, failed, cancelled: true };
    const id = meta.trackId;
    const url = `${BACKEND_URL}/api/library/audio/${id}`;
    const mp3 = new File(dir, `${id}.mp3`);

    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {       // 1 retry per file
      try {
        await File.downloadFileAsync(url, mp3, { idempotent: true });
        ok = true;
      } catch (err) {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
        else {
          try { if (mp3.exists) mp3.delete(); } catch {}          // drop partial bytes
          failed++;
          console.warn('[Offline] download failed twice, skipping', id, err);
        }
      }
    }
    if (!ok) { onProgress({ done: downloaded.length, total: selected.length, failed }); continue; }

    // INVARIANT: sidecar written only after mp3 fully downloaded.
    new File(dir, `${id}.json`).write(JSON.stringify(meta));
    downloaded.push(meta);
    onProgress({ done: downloaded.length, total: selected.length, failed });
  }
  return { downloaded, failed, cancelled: false };
}
```

## 5. Mobile: `useRadio.ts` offline integration

### 5.1 New state/refs (add near existing state, ~L100–150)

```ts
const [offlineMode, setOfflineModeState] = useState(false);
const offlineModeRef = useRef(false);
const setOfflineMode = (v: boolean) => { offlineModeRef.current = v; setOfflineModeState(v); };
const [offlineTrackCount, setOfflineTrackCount] = useState(0);

const offlineTracksRef   = useRef<Map<string, OfflineTrackMeta>>(new Map()); // id → meta
const offlineQueueRef    = useRef<string[]>([]);   // shuffled ids
const offlineQueuePosRef = useRef(-1);             // index of currently playing entry
```

Import `OfflineTrackMeta, offlineTrackUri, metaToTrack, shuffled` from `../utils/offlineLibrary`.

### 5.2 Refactor: shared status listener

Extract the inline `playbackStatusUpdate` listener bodies (near-identical copies in `fetchAndPlay` L584–639 and `handleForegroundIOS` L347–368) into one helper so offline players get correct behavior everywhere:

```ts
const attachStatusListener = useCallback((player: AudioPlayer) => {
  playerSubRef.current?.remove();
  let wasPlaying = player.playing;
  playerSubRef.current = player.addListener('playbackStatusUpdate', (status) => {
    if (status.playbackState === 'failed') {
      if (localPausedRef.current || isFetchingRef.current) return;
      if (offlineModeRef.current) {
        // Corrupt/missing local file → drop it from the pool and advance.
        console.error('[Offline] playback failed — skipping track', currentTrackIdRef.current);
        dropOfflineTrack(currentTrackIdRef.current);
        playNextOfflineRef.current?.();
      } else {
        console.error('[Audio] playbackState=failed — re-downloading current track');
        currentTrackIdRef.current = null;
        setRadioState('error');
        setErrorMessage('Playback failed — recovering...');
        fetchAndPlayRef.current?.();
      }
      return;
    }
    if (status.didJustFinish) {
      if (!localPausedRef.current) handleTrackEndedRef.current?.();  // branches internally (§5.4/§5.5)
      return;
    }
    /* keep the existing external pause/resume sync block (L612–638) verbatim */
    if (status.isLoaded) wasPlaying = status.playing;
  });
}, []);
```

Replace the listener-creation code in `fetchAndPlay` and `handleForegroundIOS` with `attachStatusListener(player)` / `attachStatusListener(playerRef.current)` (keep `handleForegroundIOS`'s `if (!wasBackground || !playerRef.current || playerSubRef.current) return;` guard). **Verify online mode still compiles/behaves after this refactor before continuing.**

### 5.3 Offline playback core (new callbacks)

```ts
const playNextOfflineRef = useRef<(() => void) | null>(null);

const dropOfflineTrack = (id: string | null) => {
  if (!id) return;
  offlineTracksRef.current.delete(id);
  offlineQueueRef.current = offlineQueueRef.current.filter((x) => x !== id);
  if (offlineQueuePosRef.current >= offlineQueueRef.current.length) offlineQueuePosRef.current = -1;
  setOfflineTrackCount(offlineTracksRef.current.size);
};

const playOfflineTrack = useCallback((meta: OfflineTrackMeta) => {
  if (!playerReadyRef.current) return;
  stopSilenceBridge();                                  // never bridge offline
  playerSubRef.current?.remove(); playerSubRef.current = null;
  playerRef.current?.remove();    playerRef.current = null;

  const player = createAudioPlayer(
    { uri: offlineTrackUri(meta.trackId) },
    { keepAudioSessionActive: true, updateInterval: 60_000 },  // identical to online (L573)
  );
  attachStatusListener(player);
  player.setActiveForLockScreen(true, {
    title: meta.songTitle ?? 'Unknown Track',
    artist: meta.genreLabel ?? 'Offline',
    albumTitle: 'Generative Radio — Offline',
  }, { showSeekForward: true, showSeekBackward: true });        // identical shape to L644

  playerRef.current = player;
  localPausedRef.current = false; setLocalPaused(false);
  player.play();

  currentTrackIdRef.current = meta.trackId;
  setCurrentTrack(metaToTrack(meta));
  setRadioState('playing');
  setStatusMessage(`Offline mode — ${offlineTracksRef.current.size} tracks`);
  setErrorMessage(null);
  setProgress(0);
  setAudioDuration(meta.duration ?? null);

  // Mirror fetchAndPlay's iOS bg-transition block (L672–691): when a new track
  // starts while backgrounded, suspend the listener and arm a duration-based
  // backup timer (didJustFinish delivery is unreliable in throttled bg JS).
  if (Platform.OS === 'ios' && isBackgroundRef.current) {
    playerSubRef.current?.remove(); playerSubRef.current = null;
    if (bgTrackEndTimerRef.current) clearTimeout(bgTrackEndTimerRef.current);
    const ms = (meta.duration ?? 0) * 1000;
    if (ms > 0) {
      bgTrackEndTimerRef.current = setTimeout(() => {
        if (isBackgroundRef.current && !localPausedRef.current && !isFetchingRef.current) {
          handleTrackEndedRef.current?.();
        }
      }, ms + 3_000);
    }
  }
}, [attachStatusListener, stopSilenceBridge]);

const playNextOffline = useCallback(() => {
  const tracks = offlineTracksRef.current;
  if (tracks.size === 0) {
    setRadioState('error');
    setErrorMessage('No offline tracks available');
    return;
  }
  let queue = offlineQueueRef.current;
  offlineQueuePosRef.current += 1;
  if (offlineQueuePosRef.current >= queue.length) {
    // Exhausted → reshuffle; avoid immediate repeat of the last-played id.
    const lastPlayed = currentTrackIdRef.current;
    queue = shuffled([...tracks.keys()]);                      // from offlineLibrary.ts
    if (queue.length > 1 && queue[0] === lastPlayed) {
      const j = 1 + Math.floor(Math.random() * (queue.length - 1));
      [queue[0], queue[j]] = [queue[j], queue[0]];
    }
    offlineQueueRef.current = queue;
    offlineQueuePosRef.current = 0;
  }
  const meta = tracks.get(queue[offlineQueuePosRef.current]);
  if (!meta) { playNextOfflineRef.current?.(); return; }       // id evaporated — advance (bounded: queue shrank)
  try {
    playOfflineTrack(meta);
  } catch (err) {
    console.error('[Offline] play failed for', meta.trackId, err);
    dropOfflineTrack(meta.trackId);
    if (offlineTracksRef.current.size > 0) playNextOfflineRef.current?.();
    else { setRadioState('error'); setErrorMessage('No playable offline tracks'); }
  }
}, [playOfflineTrack]);
useEffect(() => { playNextOfflineRef.current = playNextOffline; }, [playNextOffline]);
```

### 5.4 Enter / exit

```ts
const enterOfflineMode = useCallback((tracks: OfflineTrackMeta[]) => {
  if (tracks.length === 0) return;
  setOfflineMode(true);
  // ---- suppress ALL server activity ----
  stopPolling();                                        // pollTimerRef
  fetchEpochRef.current++;                              // invalidate any in-flight fetchAndPlay
  isFetchingRef.current = false;
  if (wsRef.current) {                                  // close WS exactly like the 'inactive' handler (L948–954)
    const dyingWs = wsRef.current; wsRef.current = null;
    dyingWs.onclose = null; dyingWs.close();
  }
  if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
  if (reconnectTimer.current)  { clearTimeout(reconnectTimer.current);   reconnectTimer.current  = null; }
  if (bgTrackEndTimerRef.current) { clearTimeout(bgTrackEndTimerRef.current); bgTrackEndTimerRef.current = null; }
  if (bgWaitCapTimerRef.current)  { clearTimeout(bgWaitCapTimerRef.current);  bgWaitCapTimerRef.current  = null; }
  bgStatusCleanupRef.current?.(); bgStatusCleanupRef.current = null;    // Android native fetch listener
  stopSilenceBridge();
  // ---- reset online-only UI state ----
  setListenerCount(0); setViewers([]); setActivityLog([]);
  setReactionState(emptyReaction); reactionStateRef.current = emptyReaction;
  setErrorMessage(null);
  // ---- build queue & play ----
  offlineTracksRef.current = new Map(tracks.map((t) => [t.trackId, t]));
  setOfflineTrackCount(tracks.length);
  offlineQueueRef.current = [];
  offlineQueuePosRef.current = -1;      // playNextOffline will shuffle on first call
  currentTrackIdRef.current = null;
  localPausedRef.current = false; setLocalPaused(false);
  playNextOffline();
}, [stopPolling, stopSilenceBridge, playNextOffline]);

const exitOfflineMode = useCallback(() => {
  if (!offlineModeRef.current) return;
  setOfflineMode(false);
  if (bgTrackEndTimerRef.current) { clearTimeout(bgTrackEndTimerRef.current); bgTrackEndTimerRef.current = null; }
  playerSubRef.current?.remove(); playerSubRef.current = null;
  try {
    playerRef.current?.clearLockScreenControls();       // same teardown as tuneOut (L1074)
    playerRef.current?.pause();
    playerRef.current?.remove();
  } catch {}
  playerRef.current = null;
  offlineTracksRef.current = new Map();
  offlineQueueRef.current = [];
  offlineQueuePosRef.current = -1;
  setOfflineTrackCount(0);
  currentTrackIdRef.current = null;
  setCurrentTrack(null); setProgress(0); setAudioDuration(null);
  setStatusMessage(''); setErrorMessage(null);
  isFetchingRef.current = false;
  fetchEpochRef.current++;
  localPausedRef.current = false; setLocalPaused(false);
  setRadioState('fetching');
  connectWebSocket();                                   // wsRef is null → connects
  fetchAndPlayRef.current?.();                          // resume server-driven radio
}, [connectWebSocket]);
```

### 5.5 Exact suppression/branch list for existing code (every touch point)

| Location (current line) | Change |
|---|---|
| `fetchAndPlay` top (L479–485) | Add `if (offlineModeRef.current) { console.log('[F&P] offline — skipping'); return; }` before the mutex check. Kills stale scheduled retries (3 s error retry L700, 6 s same-track retry L538) firing after entering offline. |
| `handleTrackEnded` (L717) | Add `if (offlineModeRef.current) { playNextOfflineRef.current?.(); return; }` **exactly between the `isFetchingRef` guard (L720) and the `Platform.OS === 'android'` check (L722)** — it MUST precede the `startSilenceBridge()` + `sendTrackEnded()` calls in the else-branch (L727–728). This single branch routes ALL track-end paths — foreground `didJustFinish`, iOS background backup timers (`handleBackgroundIOS` L329 and the §5.3 copy), Android background — to local playback, and prevents `handleTrackEndedAndroid`'s native HTTP + `sendTrackEnded` POST. |
| `handleWake` (L744, after the `radioStateRef==='idle'` guard at L748) | Add: `if (offlineModeRef.current) { stopSilenceBridge(); if (playerRef.current?.playing) return; try { playerRef.current?.play(); } catch {}; await new Promise(r=>setTimeout(r,1000)); if (!playerRef.current?.playing && !localPausedRef.current) playNextOfflineRef.current?.(); return; }` — never falls through to `fetchAndPlay`. The leading `stopSilenceBridge()` is required: it clears a bridge that `handleBackgroundAndroid` may have pre-started; a lingering `isBridgingRef === true` freezes the progress UI (`startProgressTimer`'s tick skips while bridging, L181). Add `stopSilenceBridge` to the callback's dependency array. |
| `connectWebSocket` (L781) | First line: `if (offlineModeRef.current) return;` (also blocks the reconnect timer chain). |
| AppState `'active'` handler (L985) | `if (wsRef.current === null) connectWebSocket();` → `if (wsRef.current === null && !offlineModeRef.current) connectWebSocket();`. `handleWake()` on the next line stays (branches internally). |
| AppState `'background'` iOS first-track-wait block (L1012) | Already gated on `currentTrackIdRef.current === null && isBridgingRef.current` — both false during offline playback; no change. `handleBackgroundIOS` operates on `playerRef` generically and is correct offline. |
| `handleBackgroundAndroid` (L310–316) | **REQUIRED** (not optional): gate the silence-bridge pre-start — `if (!offlineModeRef.current && playerRef.current?.playing && !localPausedRef.current && !isBridgingRef.current) { startSilenceBridge(); ... }`. Offline playback needs no service-continuity bridge (zero network), and a bridge left running sets `isBridgingRef = true`, which makes the progress timer skip UI updates after returning to foreground (frozen progress bar) until the next track calls `stopSilenceBridge()`. The `handleWake` cleanup above is the second line of defense. |
| `startPolling` (L453) | First line: `if (offlineModeRef.current) return;` (paranoia). |
| `sendTrackEnded` (L221), `fetchReactions` (L242), `react` (L1105) | Not reachable offline via the branches above; additionally add `if (offlineModeRef.current) return;` at the top of `react` since the UI callback could race a mode switch. |
| Mount effect (L913) | Unchanged — app always starts online. |
| `handleForegroundIOS` (L344) | Uses shared `attachStatusListener` (§5.2), which branches on `offlineModeRef` in its `failed` path. |
| `UseRadioReturn` interface (L32) + return object (L1181) | Add: `offlineMode: boolean; offlineTrackCount: number; enterOfflineMode: (tracks: OfflineTrackMeta[]) => void; exitOfflineMode: () => void;`. |

**Stays 100% unchanged and keeps working offline:** `togglePlayPause`, `seekBackward`, `seekForward`, `startProgressTimer`/`stopProgressTimer`, lock-screen controls (registered per-player in `playOfflineTrack`), external widget pause/resume sync (in the shared listener), the `status` derivation switch (L1170).

## 6. Mobile UI

**Hard rule: inherit existing cosmetics.** Only theme tokens from `mobile/src/components/theme.ts` (`colors.*`, `fonts.*`, `radius.*`); copy style objects from `DJPanel.tsx` (modal `container`/`header`/`title`/`subtitle`/`sectionLabel`/`optional`/`pillGrid`/`pill`/`pillActive`/`pillText`/`pillTextActive`/`textInput`/`errorText`/`footer`/`submitBtn`/`submitBtnDisabled`/`submitBtnText`/`cancelBtn`/`cancelBtnText`/`loadingContainer` — all verified present in DJPanel's StyleSheet), `GenreSelector.tsx` (stepper pattern if desired), and `RadioPlayer.tsx` (`djBtn`/`djBtnLocked`/`djBtnText`/`djBtnTextLocked` for buttons, `progressBar`/`progressFill` for the download bar, `badge`/`badgeText` for the offline banner, `errorBox`/`errorText` for errors). **No new fonts, colors, or radii.** DJPanel's `loadingContainer` is the ready-made centered layout for the downloading phase.

### 6.1 New file `mobile/src/components/OfflinePanel.tsx`

Component tree:

```
<Modal visible animationType="slide" onRequestClose>        // exact DJPanel pattern (DJPanel.tsx L117)
  <View container>            // {flex:1, backgroundColor: colors.bg}
    <View header>             // DJPanel header style
      <Text title>OFFLINE MODE</Text>                        // fonts.display 32
      <Text subtitle>Download tracks to play without a connection</Text>
    phase === 'setup':
      <ScrollView content>
        <Text sectionLabel>Max tracks to download</Text>
        <TextInput textInput keyboardType="number-pad" />    // default "500"; clamp 1–500 on change/blur
        <Text sectionLabel>Keyword (matches track tags, optional)</Text>
        <TextInput textInput placeholder="e.g. saxophone" />
        <Text sectionLabel>Genre</Text>
        <View pillGrid>                                      // pill selector = the app's established
          <Pill "All" active={genreId===''} />               //   dropdown-equivalent (DJPanel genre pills)
          {genres.map(g => <Pill g.label active={genreId===g.id} />)}
        </View>
        <Text foundText>Found {found} tracks</Text>          // fonts.semiBold, colors.accent; when index
                                                             // unavailable: colors.textMuted "Library unavailable (offline?)"
        {error && <View errorBox><Text errorText>⚠ {error}</Text></View>}
      </ScrollView>
      <View footer>                                          // DJPanel footer style
        <TouchableOpacity submitBtn  disabled={found===0 || !indexLoaded}>DOWNLOAD</TouchableOpacity>
        <TouchableOpacity submitBtn-as-outline (djBtnLocked style) disabled={existingCount===0}>
          PLAY EXISTING TRACKS ({existingCount})
        </TouchableOpacity>
        <TouchableOpacity cancelBtn onPress={onClose}>Cancel</TouchableOpacity>
      </View>
    phase === 'downloading':
      <View loadingContainer>                                // centered
        <ActivityIndicator color={colors.accent} />
        <Text (fonts.display)>STAND BY...</Text>
        <Text subtitle>{done} / {total} tracks downloaded{failed>0 ? ` · ${failed} failed` : ''}</Text>
        <View progressBar><View progressFill width={done/total*100%} /></View>   // RadioPlayer styles
      </View>
      <View footer>
        <TouchableOpacity cancelBtn onPress={cancel}>Cancel</TouchableOpacity>
      </View>
  </View>
</Modal>
```

Props:
```ts
interface Props {
  visible: boolean;
  onClose: () => void;
  onStartOffline: (tracks: OfflineTrackMeta[]) => void;   // → radio.enterOfflineMode
}
```

State: `phase: 'setup' | 'downloading'`, `maxTracksText: string` (parse+clamp to `maxTracks`), `keyword: string`, `genreId: string` (`''` = All), `index: OfflineTrackMeta[] | null`, `indexError: string | null`, `genres: Genre[]`, `existingCount: number`, `progress: DownloadProgress`, `cancelRef = useRef(false)`.

Behavior:

- `useEffect` on `visible`:
  1. `setExistingCount(scanOfflineTracks().length)` (sync, instant — network-free).
  2. `fetchLibraryIndex()` → `setIndex(r.tracks)` (treat `enabled:false`/empty as loaded with 0). On throw → `indexError` ("Library unavailable — check connection"); DOWNLOAD disabled, PLAY EXISTING unaffected.
  3. `fetch(`${BACKEND_URL}/api/genres`)` → `setGenres(data.genres)` + `cacheGenres(data.genres)`. On failure → `loadCachedGenres()` → if null, render only the "All" pill.
- `found = useMemo(() => index ? filterTracks(index, keyword, genreId).length : 0, [index, keyword, genreId])` — the live "Found XX tracks".
- DOWNLOAD press:
  ```ts
  const filtered = filterTracks(index!, keyword, genreId);
  const selected = filtered.length > maxTracks ? sampleTracks(filtered, maxTracks) : filtered;
  cancelRef.current = false; setPhase('downloading');
  setProgress({ done: 0, total: selected.length, failed: 0 });
  try {
    const result = await downloadTracks(selected, setProgress, () => cancelRef.current);
    if (result.cancelled) {                       // partial set kept on disk (playable later)
      setExistingCount(scanOfflineTracks().length); setPhase('setup'); return;
    }
    if (result.downloaded.length === 0) {         // every file failed
      setPhase('setup'); setIndexError('Download failed — no tracks saved'); return;
    }
    onStartOffline(result.downloaded);            // auto-start offline playback
    onClose(); setPhase('setup');
  } catch (err) {                                  // e.g. disk-space pre-check
    setPhase('setup'); setIndexError(String((err as Error).message));
  }
  ```
- PLAY EXISTING press: `const tracks = scanOfflineTracks(); if (tracks.length) { onStartOffline(tracks); onClose(); }` — ignores all filter inputs by design.
- Cancel (downloading phase): `cancelRef.current = true` (button label switches to "Cancelling…", disabled). Loop exits after the in-flight file.
- `onRequestClose` during download: same as Cancel (never dismiss silently mid-loop).

### 6.2 `mobile/src/components/RadioPlayer.tsx` changes

New props on `Props` (L149): `offlineMode: boolean; offlineTrackCount?: number; onOpenOfflinePanel?: () => void; onExitOffline?: () => void;`.

1. **Offline banner** — inside the card, after the badge block (~L243), when `offlineMode`:
   ```tsx
   <View style={[styles.badge, { alignSelf: 'center', marginBottom: 12 }]}>
     <Text style={styles.badgeText}>OFFLINE MODE · {offlineTrackCount} TRACKS</Text>
   </View>
   ```
   (Reuses existing `badge`/`badgeText` styles — accent outline pill.)
2. **Buttons in the DJ section** (L367–382):
   - `offlineMode` → one button styled exactly like `djBtn` (accent, `djBtnText`) labeled **BACK TO ONLINE MODE**, `onPress={onExitOffline}`.
   - else → keep the existing "Generate Your Tracks" `djBtn` unchanged; add below it a secondary button composing the existing styles `[styles.djBtn, styles.djBtnLocked]` + `djBtnTextLocked` text (marginTop ~10), labeled **OFFLINE MODE**, `onPress={onOpenOfflinePanel}`. No new style objects.
3. When `offlineMode`: reactions row and listener badge disappear automatically because AppNavigator passes `onReact={undefined}` and `listenerCount` is 0 (existing conditional rendering L307, L121). `BottomStatusBar` shows `statusMessage` = "Offline mode — N tracks" (set by the hook).

### 6.3 `mobile/src/navigation/AppNavigator.tsx` changes

```tsx
const [offlinePanelOpen, setOfflinePanelOpen] = useState(false);
// destructure additionally: offlineMode, offlineTrackCount, enterOfflineMode, exitOfflineMode

<RadioPlayer
  {...existing props}
  offlineMode={offlineMode}
  offlineTrackCount={offlineTrackCount}
  onOpenOfflinePanel={() => setOfflinePanelOpen(true)}
  onExitOffline={exitOfflineMode}
  onClaimDj={offlineMode ? undefined : claimDj}
  onReact={offlineMode ? undefined : react}
/>
<OfflinePanel
  visible={offlinePanelOpen}
  onClose={() => setOfflinePanelOpen(false)}
  onStartOffline={enterOfflineMode}
/>
```

(Change `import React from 'react'` → `import React, { useState } from 'react'`.)

**Design guarantee — no self-deletion:** the OFFLINE MODE panel is only reachable while online (in offline mode the DJ section shows only BACK TO ONLINE MODE), so DOWNLOAD's `clearOfflineTracks()` can never delete the file currently being played. Preserve this invariant if the button placement is ever changed.

### 6.4 `mobile/src/components/iPadLayout.tsx` — NO changes needed (verified)

`StatsPane` renders entirely from `track` (works offline via `metaToTrack`) and conditionally hides the activity-log section (`activityLog.length > 0`, L131) and the listeners section (`listenerCount > 0 || viewers.length > 0`, L150) — `enterOfflineMode` clears all three, so the pane degrades gracefully. The `OfflinePanel` is rendered as a sibling of `IPadLayout` in AppNavigator (same as `DJPanel`), so it covers the full screen on iPad too.

Also verified, no changes: the `status` derivation (L1170) maps offline's `radioState 'playing'/'paused'/'error'` correctly for `RadioPlayer`/`BottomStatusBar`; the mount effect (L913) always starts online, as intended; the progress timer is started at mount (L204) and restarted in the AppState `'active'` handler (L966) — both generic over `playerRef`, so offline progress display works without changes.

## 7. Edge cases (behavioral spec)

| Case | Behavior |
|---|---|
| Cancel mid-download | Loop exits after current file; partial `{mp3+json}` pairs remain; panel returns to setup with refreshed "PLAY EXISTING (n)". |
| App killed mid-download | Sidecar-after-mp3 invariant ⇒ scan finds only complete tracks; orphan partial `.mp3` without `.json` is ignored by scan and wiped by the next DOWNLOAD's `clearOfflineTracks()`. |
| Individual file 404/network error | 1 retry after 1 s; then delete partial, `failed++`, continue. Progress line shows "· N failed". |
| All files fail | Return to setup with error box; offline mode not entered. |
| Disk full | Pre-check via `Paths.availableDiskSpace` (~6 MB/track) throws before clearing; mid-loop write errors hit the per-file catch (skip + count). |
| BACK TO ONLINE while local track playing | `exitOfflineMode`: lock-screen cleared, player removed, refs reset, WS reconnects, `fetchAndPlay()` resumes server radio ('fetching' → 'playing'). Downloaded files stay on disk. |
| Track file missing/corrupt at play time | `playbackState === 'failed'` → offline branch drops the id from map+queue and advances; pool empties → "No playable offline tracks". |
| App restart, no network, PLAY EXISTING | Scan is filesystem-only; index/genre fetches fail gracefully (error note, DOWNLOAD disabled, genre pills from cached `genres.json` or just "All"); PLAY EXISTING works fully. |
| Backgrounding during offline playback | iOS: `handleBackgroundIOS` removes listener + arms duration backup timer → `handleTrackEnded` → offline branch → next local track (per-track re-arm in `playOfflineTrack`). Android: listener stays alive, `didJustFinish` → same branch; no Doze issue (zero network needed). |
| Backgrounding during download | Online radio keeps playing (don't tune out) — active audio session keeps JS alive on both platforms, loop continues. If the user paused music AND backgrounds, the loop may suspend until foreground; cancel/retry recovers. Note this limitation in code comments. |
| matches > max | Client-side Fisher-Yates random sample of `maxTracks` from the filtered set. |
| Library disabled on server | Index returns `enabled:false, tracks:[]` → "Found 0 tracks", DOWNLOAD disabled. |
| maxTracks input | Digits only, clamp 1–500 (empty → 500 on blur). |
| Entering offline while the online track's `downloadAudio` is in flight | Safe: `enterOfflineMode` bumps `fetchEpochRef`, so `fetchAndPlay`'s post-download epoch check (L556) discards the result; the background-downloader `track_current` task completes harmlessly into its fixed file. |
| Online track ends while the OfflinePanel download loop runs | Normal online flow continues (`fetchAndPlay` fetches the next track) — both downloads coexist; the loop hits different endpoints/files. Only when the loop finishes does `enterOfflineMode` tear the online pipeline down. |

**Android-compat audit:** `expo-file-system` new API, `Paths.document`, expo-audio lock-screen — all cross-platform. The only platform-divergent code added is the iOS background listener/backup-timer mirror in `playOfflineTrack` (guarded by `Platform.OS === 'ios'`, same as existing code). No iOS-only APIs introduced.

## 8. Ordered implementation steps

1. **Backend** — `backend/library.py`: add `all_meta`, `get_meta`, `audio_path` (§3.1).
2. **Backend** — `backend/main.py`: import `FileResponse`; add `GET /api/library/index` and `GET /api/library/audio/{track_id}` (§3.2). Verify with curl (§9.1) before touching mobile.
3. **Mobile deps** — add `"expo-file-system": "55.0.13-canary-20260328-bdc6273"` to `mobile/package.json`; `npm install` at repo root.
4. **Mobile** — create `mobile/src/utils/offlineLibrary.ts` (§4.2–4.3).
5. **Mobile** — `mobile/src/hooks/useRadio.ts`: (a) refactor status listeners into `attachStatusListener` (§5.2), verify online mode still works; (b) offline state/refs (§5.1); (c) `playOfflineTrack`/`playNextOffline`/`dropOfflineTrack` (§5.3); (d) `enterOfflineMode`/`exitOfflineMode` (§5.4); (e) every branch in the §5.5 table; (f) extend `UseRadioReturn` + return object.
6. **Mobile** — create `mobile/src/components/OfflinePanel.tsx` (§6.1), copying styles from DJPanel/RadioPlayer.
7. **Mobile** — modify `RadioPlayer.tsx` (§6.2) and `AppNavigator.tsx` (§6.3).
8. Typecheck (`cd mobile && npx tsc --noEmit`), then build (`npx expo run:ios`).

## 9. Verification

### 9.1 Backend (curl)

If `/Volumes/SP PCIe M.2` isn't mounted on the build machine, the library disables itself — create fixtures first:

```bash
mkdir -p ~/tmp-radio-library
cp some.mp3 ~/tmp-radio-library/test-0001.mp3
cat > ~/tmp-radio-library/test-0001.json <<'EOF'
{"trackId":"test-0001","songTitle":"Fixture One","genreLabel":"Jazz","genres":["jazz"],
 "tags":"smooth jazz, saxophone, late night","lyrics":"la la","bpm":90,"keyScale":"C Major",
 "duration":30,"djName":"","language":"en","createdAt":"2026-07-16T00:00:00+00:00"}
EOF
cd /Users/nobu/dev/ai/radio/backend
LIBRARY_DIR=~/tmp-radio-library WARMUP_ON_START=0 .venv/bin/uvicorn main:app --port 5555
```
(Or the full stack via `scripts/start.sh` with `LIBRARY_DIR` exported. Without Ollama/ACE-Step the online radio won't generate, but library endpoints work regardless.)

```bash
curl -s localhost:5555/api/library/index | python3 -m json.tool | head -30   # enabled:true, count, full sidecars
curl -s -o /tmp/t.mp3 -w '%{http_code} %{size_download}\n' localhost:5555/api/library/audio/test-0001
curl -s -w '%{http_code}\n' -o /dev/null localhost:5555/api/library/audio/../../etc/passwd   # 404
curl -s -w '%{http_code}\n' -o /dev/null localhost:5555/api/library/audio/nonexistent        # 404
# disabled path: restart without LIBRARY_DIR (volume absent) → index returns {"enabled": false, ...}
curl -s localhost:5555/api/genres | python3 -m json.tool | head
```

### 9.2 iOS simulator end-to-end

```bash
cd /Users/nobu/dev/ai/radio/mobile && npx expo run:ios    # simulator reaches localhost:5555 directly
```
1. App starts in online mode (or fetch error if the generation stack isn't running — offline entry still works from the panel).
2. Tap **OFFLINE MODE** → verify "Found N tracks" updates live typing a keyword present in a fixture's `tags` (e.g. "saxophone") and picking the Jazz pill vs All. Verify max input clamps (900 → 500, 0 → 1).
3. Tap **DOWNLOAD** → "STAND BY... X / Y tracks downloaded" counts up → on completion the modal closes and a local track plays. Verify banner "OFFLINE MODE · N TRACKS", title/tags/lyrics render, progress bar moves, play/pause + ±10 s work, lock screen (simulator: Device > Lock) shows title/artist and controls work.
4. Let a track finish → next random track plays; with 2 fixtures confirm no immediate repeat after queue exhaustion.
5. Kill the backend, let tracks advance → still plays (zero network). Kill and relaunch the app with backend down → OFFLINE MODE → **PLAY EXISTING TRACKS (N)** enabled → plays; DOWNLOAD disabled with the unavailable notice; genre pills come from cache.
6. Restart backend → **BACK TO ONLINE MODE** → WS reconnects, server radio resumes (watch `[WS] Connecting` / `[F&P]` logs).
7. Mid-download Cancel: start a large download, cancel at ~5/20 → back to setup, "PLAY EXISTING (5)"; press it → plays the 5.
8. Background test: start offline playback, home the app → audio continues; wait for a track end in background → next track starts (backup-timer path; check `[BG]` logs).

### 9.3 Android notes

`npx expo run:android` (emulator: localhost maps to the emulator itself — use `adb reverse tcp:5555 tcp:5555`, or point `DEV_ORIGIN` in `mobile/src/config.ts` at the Mac's LAN IP). Repeat steps 2–8; specifically verify background track-advance (Android keeps the status listener → `didJustFinish` → offline branch) and lock-screen/MediaSession controls.

---

### Critical files

| File | Action |
|---|---|
| `backend/library.py` | modify — add `all_meta`/`get_meta`/`audio_path` |
| `backend/main.py` | modify — 2 new routes, FileResponse import |
| `mobile/package.json` | modify — add expo-file-system |
| `mobile/src/utils/offlineLibrary.ts` | **new** — types, storage, filters, download engine |
| `mobile/src/hooks/useRadio.ts` | modify — offline integration (§5) |
| `mobile/src/components/OfflinePanel.tsx` | **new** — dialog UI |
| `mobile/src/components/RadioPlayer.tsx` | modify — buttons + banner |
| `mobile/src/navigation/AppNavigator.tsx` | modify — wire panel + props |
