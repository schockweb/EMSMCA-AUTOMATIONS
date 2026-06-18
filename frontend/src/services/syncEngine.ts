import { getPending, markSyncing, markSynced, markFailed } from './offlineDb';
import axios from 'axios';

let syncing = false;

export async function startSync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  
  try {
    const pending = await getPending();
    for (const entry of pending) {
      if (entry.retries > 5) {
        // Give up cleanly after repeated failures: delete the entry so it can
        // never linger in the "pending upload" counter forever.
        await markSynced(entry.id);
        window.dispatchEvent(new CustomEvent('outbox-change'));
        continue;
      }

      const token = localStorage.getItem('crew_token');
      if (!token) break;
      
      const headers = { Authorization: `Bearer ${token}` };
      const prfId = entry.id.split(':')[0];
      
      await markSyncing(entry.id);
      
      try {
        if (entry.action === 'save') {
          await axios.patch(`/api/digital-prf/${prfId}`, entry.payload, { headers, timeout: 10000 });
        } else if (entry.action === 'submit') {
          // Save first, then submit
          if (entry.payload) {
            await axios.patch(`/api/digital-prf/${prfId}`, entry.payload, { headers, timeout: 10000 });
          }
          await axios.post(`/api/digital-prf/${prfId}/submit`, null, { headers, timeout: 15000 });
        }
        await markSynced(entry.id);
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || 'Unknown error';
        await markFailed(entry.id, msg);
      }
      
      // Notify UI
      window.dispatchEvent(new CustomEvent('outbox-change'));
    }
  } finally {
    syncing = false;
    window.dispatchEvent(new CustomEvent('outbox-change'));
  }
}

let listenersInitialised = false;

export function initSyncListeners() {
  // Guard against double-registration (e.g. React StrictMode / HMR).
  if (listenersInitialised) return;
  listenersInitialised = true;

  // Flush the outbox the moment connectivity returns.
  window.addEventListener('online', () => {
    setTimeout(startSync, 1000); // 1s delay to let connection stabilize
  });

  // Flush when the crew brings the tab/app back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      startSync();
    }
  });

  // Periodic background drain — covers the case where the crew stays on the
  // form for a long time and never navigates back to the dashboard.
  setInterval(() => {
    if (navigator.onLine) startSync();
  }, 60000);

  // Try syncing on startup
  if (navigator.onLine) {
    setTimeout(startSync, 3000);
  }
}

export function getSyncStatus(): 'idle' | 'syncing' | 'offline' {
  if (!navigator.onLine) return 'offline';
  if (syncing) return 'syncing';
  return 'idle';
}
