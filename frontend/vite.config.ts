import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

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
    "worker-src 'self'",
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
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Generative Radio',
        short_name: 'Gen Radio',
        description: 'AI-powered generative music radio',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png',          sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png',           sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png',  sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      devOptions: { enabled: true },
    }),
  ],
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
