import { getPending, markSyncing, markSynced, markFailed } from './offlineDb';
import axios from 'axios';

let syncing = false;

export async function startSync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  
  try {
    const pending = await getPending();
    for (const entry of pending) {
      if (entry.retries > 5) continue; // Give up after 5 retries
      
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

export function initSyncListeners() {
  window.addEventListener('online', () => {
    setTimeout(startSync, 1000); // 1s delay to let connection stabilize
  });
  
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
