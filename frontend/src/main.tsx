import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { initSyncListeners } from './services/syncEngine'

// Register the offline outbox auto-sync: drains queued PRF saves/submits as soon
// as connectivity returns, on app startup, when the tab becomes visible, and on
// a periodic timer — so a crew's queued work is never stranded waiting for a
// manual "Sync now" tap.
initSyncListeners()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
