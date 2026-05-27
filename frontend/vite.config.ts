import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

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
    port: 5173,
    host: true,           // bind to 0.0.0.0 — accessible from phone on LAN at 192.168.68.116:5173
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
        target: 'http://backend:8000',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})

