import { getPending, markSyncing, markSynced, markFailed, markDead } from './offlineDb';
import axios from 'axios';
import { getCrewToken } from '../utils/crewSession';

let syncing = false;

export async function startSync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  
  try {
    const pending = await getPending();
    for (const entry of pending) {
      if (entry.retries > 5) {
        // Auto-retry exhausted. Do NOT delete — the PRF never reached the server.
        // Mark it 'dead': it stops auto-retrying but stays in the outbox count
        // for the crew to see and manually resend. (This previously called
        // markSynced() — a delete — which silently discarded a medical/legal PRF
        // and then falsely showed "✅ All synced".)
        await markDead(entry.id);
        window.dispatchEvent(new CustomEvent('outbox-change'));
        continue;
      }

      const token = getCrewToken();
      if (!token) break;
      
      const headers = { Authorization: `Bearer ${token}` };
      const prfId = entry.id.split(':')[0];
      
      await markSyncing(entry.id);
      
      try {
        if (entry.action === 'save') {
          await axios.patch(`/api/digital-prf/${prfId}`, entry.payload, { headers, timeout: 10000 });
        } else if (entry.action === 'submit') {
          // Save first, then submit. The pre-submit save can legitimately fail
          // with 423 Locked when the PRF is ALREADY submitted/processed on the
          // server — e.g. a prior attempt's submit landed but markSynced never
          // ran (lost response / app closed), or the crew tapped Retry. A
          // submitted PRF is no longer an editable draft, so the save is
          // rejected. That is NOT a real failure: the work is already on the
          // server. Swallow the 423 and fall through to the idempotent submit,
          // which returns "processed"/"submitted" and lets us clear the outbox
          // entry. Without this the save throw stranded the entry as
          // "pending upload" forever with no way to clear it (reported:
          // "1 PRF pending upload, clicking does nothing").
          if (entry.payload) {
            try {
              await axios.patch(`/api/digital-prf/${prfId}`, entry.payload, { headers, timeout: 10000 });
            } catch (patchErr: any) {
              if (patchErr?.response?.status !== 423) throw patchErr; // real save failure — retry later
            }
          }
          // Idempotent: returns 200 with status processed/submitted even on
          // replay, so an already-submitted PRF clears cleanly here.
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
