import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true, // allow tunnel hosts (cloudflare, ngrok, etc.)
    proxy: {
      '/api': {
        target: 'http://localhost:5555',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:5555',
        ws: true,
      },
    },
  },
})
