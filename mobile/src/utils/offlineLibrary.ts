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

/** Bearer header for the library endpoints, or {} when signed out — in which
 *  case the server answers 401 and we surface LibraryAuthError. */
function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------- Storage layout ----------
// Paths.document/offline/tracks/{trackId}.mp3   — audio
// Paths.document/offline/tracks/{trackId}.json  — sidecar verbatim (written AFTER mp3 ⇒ json implies complete mp3)
// Paths.document/offline/genres.json            — cached /api/genres response

const offlineDir = () => new Directory(Paths.document, 'offline');
const tracksDir  = () => new Directory(Paths.document, 'offline', 'tracks');

export function offlineTrackUri(trackId: string): string {
  return new File(tracksDir(), `${trackId}.mp3`).uri;   // "file:///..."
}

export async function fetchLibraryIndex(token: string | null): Promise<LibraryIndexResponse> {
  const res = await fetch(`${BACKEND_URL}/api/library/index`, { headers: authHeaders(token) });
  if (res.status === 401) throw new LibraryAuthError();
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

const AVG_TRACK_BYTES = 6 * 1024 * 1024;   // ~6 MB for a 240 s mp3 — pre-check estimate

export async function downloadTracks(
  selected: OfflineTrackMeta[],
  onProgress: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
  token: string | null,
): Promise<DownloadResult> {
  // Every file is an authenticated request. Failing up front beats letting all
  // N of them 401 one by one and reporting them as ordinary download failures.
  if (!token) throw new LibraryAuthError();

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
        await File.downloadFileAsync(url, mp3, { idempotent: true, headers: authHeaders(token) });
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
