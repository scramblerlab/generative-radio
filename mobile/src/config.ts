// Backend URL configuration.
//
// __DEV__ is true in `expo run:ios` / `expo start` (development builds),
// and false in production builds made with `eas build`.
//
// Development: connect directly to the local backend on the host Mac.
//   - iOS Simulator always reaches localhost on the host machine.
//   - Physical device on same Wi-Fi: swap localhost for your Mac's local IP,
//     e.g. 'http://192.168.1.x:5555'.
//
// Production: connect through the Cloudflare tunnel. The tunnel's Vite proxy
//   forwards /api/* and /ws to the FastAPI backend, same as the web browser.

import Constants from 'expo-constants';

const PROD_ORIGIN = 'https://radio.scrambler-lab.com';
const DEV_ORIGIN  = 'http://localhost:5555';

export const BACKEND_URL = __DEV__ ? DEV_ORIGIN  : PROD_ORIGIN;

const WS_ORIGIN = __DEV__ ? 'ws://localhost:5555' : 'wss://radio.scrambler-lab.com';

/** app.json's expo.version. Sent as ?v= so the server can tell a build that
 *  understands accounts from a pre-account one (which it answers with a
 *  one-time "update the app" notice). */
export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

/**
 * WebSocket URL for the current identity.
 *
 * `?client=mobile` is gone: it used to grant DJ mode to this app on trust, and
 * the server no longer honours it. Membership is now proved by the token.
 *
 * The token travels as a query parameter because React Native cannot attach an
 * Authorization header — or a cookie — to a WebSocket upgrade. Both start
 * scripts run uvicorn with --no-access-log so it does not land in logs.
 */
export function wsUrl(token: string | null): string {
  const params = new URLSearchParams({ v: APP_VERSION });
  if (token) params.set('token', token);
  return `${WS_ORIGIN}/ws?${params.toString()}`;
}
