import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Ensure index.html is never served from browser cache so new deployments are
// picked up immediately. Hashed assets (JS/CSS in /assets/) are safe to cache
// forever since their filenames change with every build.
function cacheControlPlugin(): Plugin {
  const setCacheHeaders = (pathname: string, setHeader: (name: string, value: string) => void) => {
    if (pathname === '/' || pathname.endsWith('.html')) {
      setHeader('Cache-Control', 'no-cache');
    } else if (pathname.startsWith('/assets/')) {
      setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  };
  return {
    name: 'cache-control',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        setCacheHeaders((req as { url?: string }).url ?? '/', (k, v) => res.setHeader(k, v));
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        setCacheHeaders((req as { url?: string }).url ?? '/', (k, v) => res.setHeader(k, v));
        next();
      });
    },
  };
}

// Security headers applied in both dev and preview modes.
// CSP is intentionally omitted here — it is added only in preview (below) because
// Vite's dev server injects inline scripts for React Fast Refresh which would be
// blocked by a strict script-src policy.
const baseSecurityHeaders = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
};

const csp = [
  "default-src 'self'",
  "connect-src 'self' wss: https:",
  "font-src 'self' fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
  "script-src 'self'",
  "worker-src 'self'",
  "media-src 'self' blob:",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
].join('; ');

const backendProxy = {
  '/api': {
    target: 'http://localhost:5555',
    changeOrigin: true,
  },
  '/ws': {
    target: 'ws://localhost:5555',
    ws: true,
  },
};

export default defineConfig({
  plugins: [react(), cacheControlPlugin()],
  server: {
    port: 5173,
    allowedHosts: true, // allow tunnel hosts (cloudflare, ngrok, etc.)
    proxy: backendProxy,
    // No CSP in dev — React Fast Refresh requires inline scripts
    headers: baseSecurityHeaders,
  },
  preview: {
    port: 5173,
    allowedHosts: true,
    proxy: backendProxy,
    // Production build has no inline scripts, so strict CSP is safe here
    headers: { ...baseSecurityHeaders, 'Content-Security-Policy': csp },
  },
})
