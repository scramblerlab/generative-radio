/**
 * backgroundHttp.ts — JS interface to BackgroundHttpModule (Android native module).
 *
 * React Native's JS fetch() delivers responses via the networking module queue, which
 * Android deprioritizes in background (Doze mode) even with a foreground media service.
 * This module bypasses that by making HTTP calls natively in Kotlin (Dispatchers.IO) and
 * delivering results as RCTDeviceEventEmitter events — the same path expo-audio uses for
 * playbackStatusUpdate, proven to reach JS in Android background.
 *
 * iOS: all functions are no-ops (iOS uses regular fetch, which works fine).
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type StatusResult =
  | { ok: true; status: number; body: string; requestId: string }
  | { ok: false; error: string; requestId: string };

// Lazily initialised — only created on Android where the native module exists.
let emitter: NativeEventEmitter | null = null;

function getEmitter(): NativeEventEmitter {
  if (!emitter) {
    emitter = new NativeEventEmitter(NativeModules.BackgroundHttp);
  }
  return emitter;
}

/**
 * Issue a native GET to [url] and call [onResult] when it completes.
 * Returns a cleanup function that cancels the pending listener (does NOT abort the
 * in-flight network call — the Kotlin side finishes regardless).
 *
 * Must only be called on Android; on iOS returns a no-op cleanup immediately.
 */
export function fetchStatusNative(
  url: string,
  requestId: string,
  onResult: (result: StatusResult) => void,
): () => void {
  if (Platform.OS !== 'android') return () => {};

  const sub = getEmitter().addListener('BackgroundHttp.statusResult', (event: StatusResult) => {
    if (event.requestId === requestId) {
      sub.remove();
      onResult(event);
    }
  });

  NativeModules.BackgroundHttp.fetchStatus(url, requestId);

  return () => sub.remove();
}

/**
 * Issue a native fire-and-forget POST to [url].
 * No callback — the server's watchdog covers the case where this fails.
 *
 * Must only be called on Android; no-op on iOS.
 */
export function sendTrackEndedNative(url: string): void {
  if (Platform.OS !== 'android') return;
  NativeModules.BackgroundHttp.sendTrackEnded(url);
}
