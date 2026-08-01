import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { initSyncListeners } from './services/syncEngine'
import { startServerHealthMonitor } from './services/serverHealth'

// Register the offline outbox auto-sync: drains queued PRF saves/submits as soon
// as connectivity returns, on app startup, when the tab becomes visible, and on
// a periodic timer — so a crew's queued work is never stranded waiting for a
// manual "Sync now" tap.
initSyncListeners()

// Track whether the PORTAL is reachable, which is a different question from
// whether the device has a radio. `navigator.onLine` is true with four bars of
// signal and a dead server, so every offline guard in the app misses that case
// and each request instead runs to the service worker's 10-second NetworkFirst
// timeout. The breaker lets callers go straight to their cached copy, and
// probes on a backoff so the app recovers on its own.
startServerHealthMonitor()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
