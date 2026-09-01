import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' (not 'autoUpdate'): a new version is downloaded in the
      // background but NOT applied until the user taps "Update" in the in-app
      // banner (see PWAUpdatePrompt). This is deliberate for an EMS app — a
      // silent reload mid-PRF would interrupt a crew member on a live call.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'ems-logo.png', 'jems_logo.png'],
      manifest: false,  // We provide our own manifest.json in public/
      workbox: {
        // mjs: the pdf.js worker (attach-time PDF→image conversion) is
        // emitted as a hashed .mjs asset — without it in the precache the
        // conversion would fail offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        // skipWaiting must be false so the freshly-built service worker waits
        // in the background until the user explicitly confirms the update.
        skipWaiting: false,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 },
              networkTimeoutSeconds: 10,
            },
          },
        ],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],

  // ── Vitest configuration ────────────────────────────────────────────────────
  test: {
    // Use jsdom to simulate a browser environment (required for React components)
    environment: 'jsdom',
    // Run this setup file before every test suite — imports jest-dom matchers
    setupFiles: ['./src/test/setup.ts'],
    // Allow describe / it / expect globally without needing to import them
    globals: true,
    // Coverage configuration (run with: npm run test:coverage)
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },

  server: {
    // PORT wins when it is set, so a tool that assigns a free port can start
    // this server while the Docker frontend container is already bound to 5173.
    // Falls back to 5173, which keeps a plain `npm run dev` behaving as before.
    port: Number(process.env.PORT) || 5173,
    host: true,           // bind to 0.0.0.0 — accessible from phone on LAN at 192.168.68.104:5173
    // Allow Ngrok tunnels and external hosts
    allowedHosts: true,
    // Polling is required for HMR to work on Windows Docker bind mounts
    // (inotify events don't cross the WSL2/container boundary reliably)
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})

