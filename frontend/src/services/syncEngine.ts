import { getPending, markSyncing, markSynced, markFailed, markDead } from './offlineDb';
import axios from 'axios';
import { getCrewToken } from '../utils/crewSession';

let syncing = false;

// Re-create a PRF whose server row is gone (404) from a queued payload, then
// submit the fresh row. Mirrors the live form's inline 404 self-heal: an End
// Shift in another tab (or a draft created offline that never persisted) can
// sweep the draft while the outbox still holds the full, submitted form data.
// A 404 is deterministic — the row truly doesn't exist — so this can never
// duplicate a live PRF. The vehicle/crew2 travel in the payload; the shift
// supervisor is read from local storage (same source the New-PRF button uses).
async function recreateAndSubmit(prfId: string, payload: any, headers: Record<string, string>) {
  const supervisor = (() => {
    try { return JSON.parse(localStorage.getItem('shift_supervisor') || 'null'); }
    catch { return null; }
  })();
  const storedVehicle = (() => {
    try { return JSON.parse(localStorage.getItem('active_vehicle') || 'null'); }
    catch { return null; }
  })();
  const createRes = await axios.post('/api/digital-prf', {
    vehicle_id: payload?.vehicle_id || storedVehicle?.id || null,
    crew_member_2_id: payload?.crew_member_2_id || null,
    supervising_practitioner_pr: supervisor?.hpcsa_number || null,
    supervising_practitioner_name: supervisor?.name || null,
    supervising_practitioner_qualification: supervisor?.qualification || null,
  }, { headers, timeout: 10000 });
  const newId = createRes.data?.id;
  if (!newId) throw new Error('Re-create returned no id');
  if (payload) {
    await axios.patch(`/api/digital-prf/${newId}`, payload, { headers, timeout: 10000 });
  }
  await axios.post(`/api/digital-prf/${newId}/submit`, null, { headers, timeout: 15000 });
}

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
          try {
            await axios.patch(`/api/digital-prf/${prfId}`, entry.payload, { headers, timeout: 10000 });
          } catch (saveErr: any) {
            const code = saveErr?.response?.status;
            // 404 (draft swept) or 423 (already submitted) make this autosave
            // obsolete — the authoritative data rides on the submit entry, so
            // drop it (fall through to markSynced) instead of retrying forever.
            if (code !== 404 && code !== 423) throw saveErr;
          }
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
          try {
            if (entry.payload) {
              try {
                await axios.patch(`/api/digital-prf/${prfId}`, entry.payload, { headers, timeout: 10000 });
              } catch (patchErr: any) {
                // 423 = already submitted → let the idempotent submit confirm.
                // 404 = draft gone → rethrow so the self-heal below re-creates.
                if (patchErr?.response?.status !== 423) throw patchErr;
              }
            }
            // Idempotent: returns 200 with status processed/submitted even on
            // replay, so an already-submitted PRF clears cleanly here.
            await axios.post(`/api/digital-prf/${prfId}/submit`, null, { headers, timeout: 15000 });
          } catch (subErr: any) {
            // "PRF not found": the draft was swept server-side. Re-create it
            // from the queued payload and submit the fresh row rather than
            // stranding the crew's work as "pending upload" forever.
            if (subErr?.response?.status === 404) {
              await recreateAndSubmit(prfId, entry.payload, headers);
            } else {
              throw subErr;
            }
          }
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
