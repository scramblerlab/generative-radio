/**
 * backgroundHttp.ts — JS interface to the BackgroundHttp local Expo module
 * (mobile/modules/background-http).
 *
 * React Native's JS fetch() delivers responses via the networking module queue,
 * which Android deprioritizes in background (Doze) even with a foreground media
 * service. The native module performs the call on a background thread and
 * delivers the result as an Expo module event — the same path expo-audio uses
 * for playbackStatusUpdate, proven to reach JS in Android background.
 *
 * iOS: the native module is absent (Android-only), so `Native` is null and every
 * function is a no-op (iOS uses regular fetch, which works fine).
 */
import { Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export type StatusResult =
  | { ok: true; status: number; body: string; requestId: string }
  | { ok: false; error: string; requestId: string };

interface BackgroundHttpNativeModule {
  fetchStatus(url: string, requestId: string): void;
  sendTrackEnded(url: string): void;
  addListener(
    event: 'onStatusResult',
    listener: (e: StatusResult) => void,
  ): EventSubscription;
}

// null on iOS/web, and on Android until the module is compiled into the binary
// (e.g. before a native rebuild). All call sites guard on it.
const Native = requireOptionalNativeModule<BackgroundHttpNativeModule>('BackgroundHttp');

/**
 * Issue a native GET to [url] and call [onResult] when it completes.
 * Returns a cleanup function that cancels the pending listener (does NOT abort
 * the in-flight network call — the native side finishes regardless).
 *
 * Android-only; on iOS returns a no-op cleanup immediately.
 */
export function fetchStatusNative(
  url: string,
  requestId: string,
  onResult: (result: StatusResult) => void,
): () => void {
  if (Platform.OS !== 'android' || !Native) return () => {};

  const sub = Native.addListener('onStatusResult', (event) => {
    if (event.requestId === requestId) {
      sub.remove();
      onResult(event);
    }
  });

  Native.fetchStatus(url, requestId);

  return () => sub.remove();
}

/**
 * Issue a native fire-and-forget POST to [url].
 * No callback — the server's watchdog covers the case where this fails.
 *
 * Android-only; no-op on iOS.
 */
export function sendTrackEndedNative(url: string): void {
  if (Platform.OS !== 'android' || !Native) return;
  Native.sendTrackEnded(url);
}
