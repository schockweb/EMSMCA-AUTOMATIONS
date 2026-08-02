import { getPending, markSyncing, markSynced, markFailed, markDead, setReplacementId } from './offlineDb';
import axios from 'axios';
import { getCrewToken } from '../utils/crewSession';

let syncing = false;

/** The provider whose crew is logged in on this device right now. */
function currentProviderId(): string | undefined {
  try {
    const raw = localStorage.getItem('crew_profile');
    return raw ? (JSON.parse(raw)?.provider_id || undefined) : undefined;
  } catch {
    return undefined;
  }
}

// Re-create a PRF whose server row is gone (404) from a queued payload, then
// submit the fresh row. Mirrors the live form's inline 404 self-heal: an End
// Shift in another tab (or a draft created offline that never persisted) can
// sweep the draft while the outbox still holds the full, submitted form data.
// A 404 is deterministic — the row truly doesn't exist — so this can never
// duplicate a live PRF. The vehicle/crew2 travel in the payload; the shift
// supervisor is read from local storage (same source the New-PRF button uses).
async function recreateAndSubmit(
  entryKey: string,
  prfId: string,
  payload: any,
  headers: Record<string, string>,
  entryProviderId: string | undefined,
  existingReplacementId: string | undefined,
) {
  // This is the ONE operation that mints a brand-new server row under whoever
  // is logged in now, so it is the only path that can launder a queued record
  // into a different provider's tenant. The save/submit paths target an
  // existing prfId and are already refused server-side for a foreign PRF.
  //
  // Entries queued before authorship stamping exist in the wild and are
  // unsynced patient records, so they are NOT discarded — but they may not be
  // re-created either, because there is no way to prove which provider they
  // belong to. They stay pending and stay visible in the outbox count.
  if (!entryProviderId) {
    throw new Error('Cannot re-create an unattributed PRF — it may belong to another provider');
  }
  const supervisor = (() => {
    try { return JSON.parse(localStorage.getItem('shift_supervisor') || 'null'); }
    catch { return null; }
  })();
  const storedVehicle = (() => {
    try { return JSON.parse(localStorage.getItem('active_vehicle') || 'null'); }
    catch { return null; }
  })();
  // IDEMPOTENT RE-CREATE.
  //
  // This create sent no client_id, so it was NOT idempotent: every retry of a
  // failed heal minted a brand-new server row and submitted it. Each of those
  // rows runs the billing pipeline and produces its own Case and Claim, so one
  // ambulance call was billed once per retry — and the entry is retried up to
  // five times before it is marked dead. A network wobble between the create
  // and the submit was enough to trigger it.
  //
  // The replacement id is generated ONCE and persisted on the outbox entry
  // BEFORE the create is attempted, so a crash at any point after this line
  // resumes against the same id. Repeats then hit create_prf's replay branch,
  // which returns the existing row untouched.
  const replacementId =
    existingReplacementId ||

    (globalThis.crypto?.randomUUID?.() as string | undefined) ||
    `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  if (!existingReplacementId) {
    await setReplacementId(entryKey, replacementId);
  }

  const createRes = await axios.post('/api/digital-prf', {
    client_id: replacementId,
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

/**
 * Link a just-synced PRF to its Case, so a facility email confirmed offline can
 * be completed.
 *
 * The email endpoint is keyed by CASE id, but the Case is created by the
 * asynchronous billing pipeline — so the submit response usually has none yet.
 * Rather than block the outbox drain polling for it, this records what it can
 * and returns; the pending-email record is resolved on a later pass or by the
 * dashboard. A failure here must NEVER fail the sync: the PRF itself is safely
 * on the server by this point, and the email has a server-side backstop.
 */
async function noteSubmittedCase(
  prfId: string,
  caseIdFromSubmit: string | null,
  headers: Record<string, string>,
): Promise<void> {
  try {
    const { getPendingEmail, attachCaseId } = await import('./pendingFacilityEmail');
    const pending = getPendingEmail(prfId);
    if (!pending || pending.caseId) return;

    let caseId = caseIdFromSubmit;
    if (!caseId) {
      // /case-status, NOT /{prfId}.
      //
      // This read used to be `GET /api/digital-prf/{prfId}` and take
      // `res.data.case_id` — a key that response has never contained (it
      // returns case_NUMBER). So it resolved undefined every single time,
      // attachCaseId never fired, and because markSynced then deletes the
      // outbox entry there was nothing left for a later pass to retry. Every
      // offline-confirmed facility email silently never sent. The online path
      // was unaffected — it polls /case-status directly — which is why it went
      // unnoticed.
      //
      // /case-status is the one endpoint that carries case_id, and it is
      // deliberately exempt from the response cache (NEVER_CACHE_SUFFIXES), so
      // it cannot serve a stale null. Do NOT "fix" this by adding case_id to
      // the detail response: that one IS cached for an hour once submitted.
      try {
        const res = await axios.get(
          `/api/digital-prf/${prfId}/case-status`, { headers, timeout: 8000 },
        );
        caseId = res.data?.case_id || null;
      } catch {
        return;
      }
    }
    if (caseId) attachCaseId(prfId, caseId);
  } catch {
    /* pending-email bookkeeping must never break the outbox drain */
  }
}

export async function startSync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  
  try {
    const pending = await getPending();

    // PRFs whose create has not (yet) landed this pass. Their save/submit
    // entries MUST NOT be attempted: the row does not exist server-side, the
    // PATCH would 404, and the 404 branch below deliberately DROPS a save as
    // "obsolete" — which for an offline-created PRF would silently discard the
    // crew's only copy of a patient record. Blocked entries are simply left
    // pending and retried on the next pass.
    const blockedPrfIds = new Set<string>();

    // The outbox outlives a shift — End Shift and logout do not clear it — so a
    // queued entry can still be here when a different crew, possibly from a
    // different provider, logs in on the same device. Draining then uses THEIR
    // token, which the server accepts because it is genuinely valid.
    const providerNow = currentProviderId();

    for (const entry of pending) {
      const entryPrfId = entry.id.split(':')[0];
      if (entry.action !== 'create' && blockedPrfIds.has(entryPrfId)) {
        continue;
      }

      // Refuse to send another provider's queued record under this provider's
      // credentials. Left pending, never dropped: it is an unsynced patient
      // record and belongs to the crew that captured it, so it must survive
      // until their device (or their session) drains it.
      if (entry.providerId && providerNow && entry.providerId !== providerNow) {
        blockedPrfIds.add(entryPrfId);
        continue;
      }

      if (entry.retries > 5) {
        // Auto-retry exhausted. Do NOT delete — the PRF never reached the server.
        // Mark it 'dead': it stops auto-retrying but stays in the outbox count
        // for the crew to see and manually resend. (This previously called
        // markSynced() — a delete — which silently discarded a medical/legal PRF
        // and then falsely showed "✅ All synced".)
        await markDead(entry.id);
        // A create that has been given up on leaves its PRF non-existent
        // server-side, so its save/submit must stay blocked rather than being
        // dropped as "obsolete" against a row that was never there.
        if (entry.action === 'create') blockedPrfIds.add(entryPrfId);
        window.dispatchEvent(new CustomEvent('outbox-change'));
        continue;
      }

      const token = getCrewToken();
      if (!token) break;
      
      const headers = { Authorization: `Bearer ${token}` };
      const prfId = entry.id.split(':')[0];
      
      await markSyncing(entry.id);
      
      try {
        if (entry.action === 'create') {
          // The PRF was started with no signal; register it now under the id
          // the device already chose. The server treats a repeat client_id as
          // a replay and returns the existing row, so a lost response cannot
          // produce a duplicate patient record.
          await axios.post('/api/digital-prf', {
            ...entry.payload,
            client_id: prfId,
          }, { headers, timeout: 15000 });
        } else if (entry.action === 'save') {
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
            const subRes = await axios.post(
              `/api/digital-prf/${prfId}/submit`, null, { headers, timeout: 15000 },
            );
            // If the crew confirmed a facility address while offline, the send
            // needs a Case id — the email endpoint is keyed by case, not PRF.
            // The billing pipeline creates the Case asynchronously, so it is
            // often absent on this first response; noteSubmittedCase resolves
            // it later rather than blocking the drain on a poll.
            await noteSubmittedCase(prfId, subRes.data?.case_id || null, headers);
          } catch (subErr: any) {
            // "PRF not found": the draft was swept server-side. Re-create it
            // from the queued payload and submit the fresh row rather than
            // stranding the crew's work as "pending upload" forever.
            if (subErr?.response?.status === 404) {
              await recreateAndSubmit(
                entry.id, prfId, entry.payload, headers, entry.providerId, entry.replacementId,
              );
            } else {
              throw subErr;
            }
          }
        }
        await markSynced(entry.id);
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || 'Unknown error';
        await markFailed(entry.id, msg);
        // The row does not exist server-side, so hold back this PRF's
        // save/submit until a later pass gets the create through. Attempting
        // them now would 404 and the save would be discarded as "obsolete".
        if (entry.action === 'create') blockedPrfIds.add(entryPrfId);
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
