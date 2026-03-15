import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const securityHeaders = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src 'self' wss: https:",
    "font-src 'self' fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "script-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; '),
};

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
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true, // allow tunnel hosts (cloudflare, ngrok, etc.)
    proxy: backendProxy,
    headers: securityHeaders,
  },
  preview: {
    port: 5173,
    allowedHosts: true,
    proxy: backendProxy,
    headers: securityHeaders,
  },
})
