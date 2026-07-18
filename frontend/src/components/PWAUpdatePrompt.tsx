/**
 * PWAUpdatePrompt — headless PWA service-worker registrar (no UI).
 *
 * The PWA is in 'prompt' mode (see vite.config.ts): a freshly-deployed build is
 * fetched in the background and then WAITS. Because we never call
 * updateServiceWorker() here, the waiting worker activates on its own only when
 * the app is fully closed and reopened — so a crew member mid-PRF is never
 * interrupted and the page never reloads by itself. Updates therefore apply
 * silently on the next app open.
 *
 * There is intentionally NO "update available" banner. This component only
 * registers the service worker and polls hourly so new builds are downloaded
 * and ready to swap in at the next launch (crew often leave the app running a
 * whole shift, so relying on a fresh launch alone isn't enough).
 */
import { useRegisterSW } from 'virtual:pwa-register/react';

// How often to check for a new version while the app stays open.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export default function PWAUpdatePrompt() {
  useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        registration.update().catch(() => {/* offline — try again next tick */});
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });

  // Headless: no banner, no auto-reload. The waiting worker takes over on the
  // next full app open.
  return null;
}
