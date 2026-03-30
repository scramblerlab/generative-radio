import {
  createDownloadTask,
  getExistingDownloadTasks,
  directories,
} from '@kesha-antonov/react-native-background-downloader';
import type { DownloadTask, ErrorHandlerParams } from '@kesha-antonov/react-native-background-downloader';
import { Track } from '@radio/shared';
import { BACKEND_URL } from '../config';

// Fixed destination — always overwrite with the current track.
// Using documentDirectory (persistent) not cacheDirectory (evicted under memory pressure).
const DOCS_DIR: string = directories.documents;
export const CURRENT_TRACK_DEST = `${DOCS_DIR}/track_current.mp3`;
export const CURRENT_TRACK_URI = `file://${CURRENT_TRACK_DEST}`;
const DOWNLOAD_TASK_ID = 'track_current';

/**
 * Download the audio for `track` to a fixed local path and return its file:// URI.
 *
 * - On wake recovery: re-attaches to the in-flight download task if one exists.
 * - Uses a fixed filename so files never accumulate across track transitions.
 * - Returns the local file:// URI for use with React Native Track Player.
 */
export async function downloadAudio(track: Track): Promise<string> {
  const url = `${BACKEND_URL}${track.audioUrl}`;

  // Check for an existing in-flight download (app woke mid-download).
  const existing = await getExistingDownloadTasks();
  const inFlight = existing.find((t: DownloadTask) => t.id === DOWNLOAD_TASK_ID);
  if (inFlight) {
    console.log('[Download] Re-attaching to existing task for:', track.songTitle);
    return new Promise<string>((resolve, reject) => {
      inFlight
        .done(() => resolve(CURRENT_TRACK_URI))
        .error((params: ErrorHandlerParams) => reject(new Error(params.error)));
      inFlight.resume();
    });
  }

  console.log('[Download] Starting download:', track.songTitle, '—', url);
  const task = createDownloadTask({
    id: DOWNLOAD_TASK_ID,
    url,
    destination: CURRENT_TRACK_DEST,
  });

  return new Promise<string>((resolve, reject) => {
    task
      .done(() => {
        console.log('[Download] Complete:', track.songTitle);
        resolve(CURRENT_TRACK_URI);
      })
      .error((params: ErrorHandlerParams) => {
        console.error('[Download] Error:', params.error);
        reject(new Error(params.error));
      });
  });
}
