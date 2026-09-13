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
  /** Byte size, when the index carries one. Used only to size the disk-space
   *  pre-check; absent on every sidecar written before it existed. */
  sizeBytes?: number;
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

/** The library endpoints are members-only, so a 401 means "sign in", not
 *  "check your connection". Distinguishing them matters: the two have
 *  completely different fixes and the connection wording is actively
 *  misleading when the network is fine. */
export class LibraryAuthError extends Error {
  constructor(message = 'Sign in to download tracks') {
    super(message);
    this.name = 'LibraryAuthError';
  }
}

/** The server reports `enabled: false` with an empty track list when the
 *  library volume is not mounted. That is a server-side problem the user can do
 *  nothing about, and rendering it as "Found 0 tracks" makes it look like their
 *  filter matched nothing. */
export class LibraryDisabledError extends Error {
  constructor(message = 'The track library is unavailable on the server') {
    super(message);
    this.name = 'LibraryDisabledError';
  }
}

/** Bearer header for the library endpoints, or {} when signed out — in which
 *  case the server answers 401 and we surface LibraryAuthError. */
function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------- Storage layout ----------
// Paths.document/offline/tracks/{trackId}.mp3   — audio
// Paths.document/offline/tracks/{trackId}.json  — sidecar verbatim (written AFTER mp3 ⇒ json implies complete mp3)
// Paths.document/offline/tracks.staging/        — a download in progress; swapped over tracks/ only on success
// Paths.document/offline/tracks.old/            — the previous library, only during a swap
// Paths.document/offline/manifest.json          — the swapped-in set, so opening the panel is one read
// Paths.document/offline/state.json             — present while offline mode is on, so a cold start can resume it
// Paths.document/offline/genres.json            — cached /api/genres response

const offlineDir = () => new Directory(Paths.document, 'offline');
const tracksDir  = () => new Directory(Paths.document, 'offline', 'tracks');
const stagingDir = () => new Directory(Paths.document, 'offline', 'tracks.staging');
const oldDir     = () => new Directory(Paths.document, 'offline', 'tracks.old');

const manifestFile = () => new File(offlineDir(), 'manifest.json');
const stateFile    = () => new File(offlineDir(), 'state.json');

function ensureOfflineDir(): void {
  const dir = offlineDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

export function offlineTrackUri(trackId: string): string {
  return new File(tracksDir(), `${trackId}.mp3`).uri;   // "file:///..."
}

/** Network calls here can hang indefinitely on a captive portal or a half-open
 *  socket; the panel would sit on "Loading library…" forever. */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * A signal that aborts after `ms`.
 *
 * NOT `AbortSignal.timeout()`. React Native polyfills AbortSignal from the
 * `abort-controller` package, which ships only the constructor and `aborted` —
 * there is no static `timeout()`, so calling it throws TypeError at runtime.
 * TypeScript does not catch this because tsconfig pulls in the DOM lib, whose
 * AbortSignal does have it: the types describe a browser, not this runtime.
 *
 * Always `cancel()` in a finally, or the pending timer keeps the JS context
 * awake for the full duration after the request has already finished.
 */
export function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

export async function fetchLibraryIndex(token: string | null): Promise<LibraryIndexResponse> {
  const t = timeoutSignal(FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/library/index`, {
      headers: authHeaders(token),
      signal: t.signal,
    });
  } finally {
    t.cancel();
  }
  if (res.status === 401) throw new LibraryAuthError();
  if (!res.ok) throw new Error(`Index fetch failed: ${res.status}`);
  const body = await res.json() as LibraryIndexResponse;
  // `enabled: false` is the server saying its library volume is not mounted.
  // Without this the panel shows "Found 0 tracks", which reads as "your filter
  // matched nothing" and sends the user off adjusting keywords for no reason.
  if (!body.enabled) throw new LibraryDisabledError();
  return body;
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

/** The set swapped in by the last successful download.
 *  Written at swap time so the common path is one read instead of 500. */
function readManifest(): OfflineTrackMeta[] | null {
  try {
    const f = manifestFile();
    if (!f.exists) return null;
    const metas = JSON.parse(f.textSync()) as OfflineTrackMeta[];
    return Array.isArray(metas) ? metas : null;
  } catch {
    return null;                    // corrupt → fall back to the full scan
  }
}

function writeManifest(metas: OfflineTrackMeta[]): void {
  ensureOfflineDir();
  manifestFile().write(JSON.stringify(metas));
}

/** The tracks available on this device.
 *
 *  Prefers the manifest, and only falls back to walking the directory when it
 *  is missing or unreadable — a library written before manifests existed, or
 *  one left behind by an interrupted swap. The fallback rewrites the manifest
 *  so the cost is paid once.
 */
export function scanOfflineTracks(): OfflineTrackMeta[] {
  const fromManifest = readManifest();
  if (fromManifest) return fromManifest;
  const metas = scanOfflineTracksFromDisk();
  if (metas.length > 0) {
    try { writeManifest(metas); } catch { /* best effort */ }
  }
  return metas;
}

/** Walk the directory: a track exists iff {id}.json parses AND sibling {id}.mp3 exists. */
function scanOfflineTracksFromDisk(): OfflineTrackMeta[] {
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
// Perf note: the fallback reads up to 500 small JSON files synchronously on the
// JS thread. That is why the manifest exists — this path should now run at most
// once per library.

/** Remove scratch directories left behind by a crash or a force-quit.
 *
 *  Called on mount. Staging is never useful on its own — on Android it is where
 *  the truncated .mp3 files from a killed download accumulate. `tracks.old` is
 *  the previous library mid-swap; if it is still here while `tracks` exists, the
 *  swap completed and it is just garbage. If `tracks` is missing, the swap died
 *  between the two renames, so the old library is promoted back rather than
 *  thrown away. */
export function cleanupStagingDir(): void {
  try {
    const old = oldDir();
    if (old.exists) {
      const live = tracksDir();
      if (live.exists) old.delete();
      else { old.rename('tracks'); console.warn('[Offline] recovered the previous library after an interrupted swap'); }
    }
  } catch (err) {
    console.warn('[Offline] could not resolve leftover tracks.old', err);
  }
  try {
    const dir = stagingDir();
    if (dir.exists) dir.delete();
  } catch (err) {
    console.warn('[Offline] could not remove orphan staging dir', err);
  }
}

// ---------- Offline-mode persistence ----------

/** Offline mode survives a restart. Without this, a cold start in airplane mode
 *  always comes up as the online radio and falls into a reconnect loop — the
 *  difference between "works on a plane" and "works on a plane as long as you
 *  never close the app". */
export function setOfflineModePersisted(on: boolean): void {
  try {
    if (on) { ensureOfflineDir(); stateFile().write(JSON.stringify({ offline: true })); }
    else { const f = stateFile(); if (f.exists) f.delete(); }
  } catch (err) {
    console.warn('[Offline] could not persist offline state', err);
  }
}

export function isOfflineModePersisted(): boolean {
  try { return stateFile().exists; } catch { return false; }
}

const GENRES_CACHE_FILE = () => new File(offlineDir(), 'genres.json');

export function cacheGenres(genres: Genre[]): void {
  const dir = offlineDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  GENRES_CACHE_FILE().write(JSON.stringify(genres));
}

export function loadCachedGenres(): Genre[] | null {
  try {
    const f = GENRES_CACHE_FILE();
    if (!f.exists) return null;
    return JSON.parse(f.textSync()) as Genre[];
  } catch {
    return null;
  }
}

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

// ---------- Download engine ----------

// Used only when a track carries no sizeBytes. Measured tracks run ~3.8 MB; the
// old 6 MB figure demanded ~3.1 GB for a 500-track library and refused
// downloads that would have fitted comfortably.
const FALLBACK_TRACK_BYTES = 4 * 1024 * 1024;
const SPACE_SAFETY_FACTOR  = 1.2;

function gb(bytes: number): string {
  return `${Math.round(bytes / 1e9 * 10) / 10} GB`;
}

/** Bytes the selection is expected to need, using real sizes where the index
 *  supplies them and a padded estimate everywhere else. */
export function estimateDownloadBytes(selected: OfflineTrackMeta[]): number {
  const raw = selected.reduce((sum, m) => sum + (m.sizeBytes ?? FALLBACK_TRACK_BYTES), 0);
  return Math.round(raw * SPACE_SAFETY_FACTOR);
}

/**
 * Download `selected` into a staging directory, then swap it over the existing
 * library — never the other way round.
 *
 * The previous version called clearOfflineTracks() before the first byte was
 * fetched, so losing the network on file 1 destroyed a library the user had
 * already downloaded. Staging fixes that and also makes the disk-space check
 * honest: it no longer has to reason about space it is about to free, because
 * nothing is freed until the new set is complete.
 *
 * `allowClear` encodes the "never delete the library you are playing from"
 * invariant. It used to live only in a JSX ternary that hid the button.
 */
export async function downloadTracks(
  selected: OfflineTrackMeta[],
  onProgress: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
  token: string | null,
  allowClear: boolean,
): Promise<DownloadResult> {
  // Every file is an authenticated request. Failing up front beats letting all
  // N of them 401 one by one and reporting them as ordinary download failures.
  if (!token) throw new LibraryAuthError();
  if (!allowClear) {
    throw new Error('Leave offline mode before downloading a new library');
  }

  const needed = estimateDownloadBytes(selected);
  const free = Paths.availableDiskSpace;
  if (free < needed) {
    throw new Error(`Not enough free space — need about ${gb(needed)}, ${gb(free)} available`);
  }

  // Fresh staging dir; the old library is untouched until the swap.
  cleanupStagingDir();
  const dir = stagingDir();
  dir.create({ intermediates: true, idempotent: true });

  const downloaded: OfflineTrackMeta[] = [];
  let failed = 0;
  let cancelled = false;

  for (const meta of selected) {
    if (isCancelled()) { cancelled = true; break; }
    const id = meta.trackId;
    const url = `${BACKEND_URL}/api/library/audio/${id}`;
    const mp3 = new File(dir, `${id}.mp3`);

    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {       // 1 retry per file
      try {
        await File.downloadFileAsync(url, mp3, { idempotent: true, headers: authHeaders(token) });
        // INVARIANT: the sidecar implies a complete mp3, so it is written here,
        // inside the per-file guard. Previously a failed write (disk full) threw
        // past the loop and abandoned the entire remaining queue.
        new File(dir, `${id}.json`).write(JSON.stringify(meta));
        ok = true;
      } catch (err) {
        // Android streams the response straight into the destination, so an
        // interrupted download leaves a truncated .mp3 behind. Delete it before
        // retrying — this is the orphan-file leak. A half-written sidecar would
        // break the invariant, so it goes too.
        try { if (mp3.exists) mp3.delete(); } catch {}
        try { const j = new File(dir, `${id}.json`); if (j.exists) j.delete(); } catch {}
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          failed++;
          console.warn('[Offline] download failed twice, skipping', id, err);
        }
      }
    }
    if (!ok) { onProgress({ done: downloaded.length, total: selected.length, failed }); continue; }

    downloaded.push(meta);
    onProgress({ done: downloaded.length, total: selected.length, failed });
  }

  if (downloaded.length === 0) {
    // Nothing worth keeping — discard staging and leave the old library alone.
    cleanupStagingDir();
    return { downloaded, failed, cancelled };
  }

  swapStagingIntoPlace(downloaded);
  return { downloaded, failed, cancelled };
}

/** Replace tracks/ with the staging directory and record the new manifest.
 *
 *  Called only when at least one track downloaded, so the user never trades a
 *  working library for an empty one.
 *
 *  The old library is moved aside rather than deleted, so a failure in the
 *  second rename can put it back. Deleting first would mean a failure there
 *  left no library at all and the next launch's staging cleanup would take the
 *  new one too — losing both sets, which is the outcome this whole change
 *  exists to prevent.
 */
function swapStagingIntoPlace(downloaded: OfflineTrackMeta[]): void {
  const staging = stagingDir();
  const live = tracksDir();
  const old = oldDir();

  try { if (old.exists) old.delete(); } catch { /* stale scratch, best effort */ }

  const hadLive = live.exists;
  if (hadLive) live.rename('tracks.old');
  try {
    staging.rename('tracks');
  } catch (err) {
    if (hadLive) {
      try { oldDir().rename('tracks'); } catch { /* nothing left to try */ }
    }
    throw err;
  }
  try { if (oldDir().exists) oldDir().delete(); } catch { /* garbage, collected next launch */ }
  writeManifest(downloaded);
}
