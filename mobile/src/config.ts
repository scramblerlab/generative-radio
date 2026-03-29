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

const PROD_ORIGIN = 'https://radio.scrambler-lab.com';
const DEV_ORIGIN  = 'http://localhost:5555';

export const BACKEND_URL = __DEV__ ? DEV_ORIGIN  : PROD_ORIGIN;
export const WS_URL      = __DEV__
  ? 'ws://localhost:5555/ws'
  : 'wss://radio.scrambler-lab.com/ws';
