/**
 * Offline outbox + sync engine.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This is the machinery that holds a crew's PRF when there is no signal. If it
 * loses an entry, a patient record taken at the roadside is gone — and the crew
 * is told "✅ All synced" while it happens. It had ZERO test coverage.
 *
 * These tests import the REAL modules (services/offlineDb, services/syncEngine)
 * and drive them against fake-indexeddb. They deliberately do NOT re-implement
 * the logic in the test file: a test that owns its own copy of the code under
 * test passes happily while production breaks.
 *
 * The invariant that matters most, and is asserted several ways below:
 *   AN ENTRY IS ONLY EVER DELETED WHEN THE SERVER HAS CONFIRMED IT.
 * Everything else — give-up, network failure, missing token — must preserve it.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  queueCreate, queueSave, queueSubmit, getPending, getAll, getCount, getOutboxSummary,
  markSyncing, markSynced, markFailed, markDead, retryDead, clearAll,
  type OfflineEntry,
} from '../services/offlineDb';

// axios and the crew session are the sync engine's only outside world.
vi.mock('axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));
vi.mock('../utils/crewSession', () => ({ getCrewToken: vi.fn(() => 'crew-token-abc') }));

import axios from 'axios';
import { getCrewToken } from '../utils/crewSession';
import { startSync } from '../services/syncEngine';

const mockAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};
const mockToken = getCrewToken as unknown as ReturnType<typeof vi.fn>;

/** Build an axios-shaped rejection, since the engine branches on response.status. */
function httpError(status: number, detail = 'err') {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: { detail } },
  });
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

const PRF = '11111111-2222-3333-4444-555555555555';

beforeEach(async () => {
  await clearAll();
  // mockReset, not clearAllMocks: clearAllMocks empties `mock.calls` but leaves
  // any UNCONSUMED mockResolvedValueOnce/mockRejectedValueOnce queued, so a test
  // that sets up three one-shot responses and consumes one silently poisons the
  // next two. Reset drains the queue as well.
  mockAxios.post.mockReset();
  mockAxios.patch.mockReset();
  mockToken.mockReset();
  mockToken.mockReturnValue('crew-token-abc');
  mockAxios.post.mockResolvedValue({ data: { id: 'new-id' } });
  mockAxios.patch.mockResolvedValue({ data: {} });
  // A queued entry is stamped with the crew that queued it; without a profile
  // every entry would be unattributed, which is the legacy path rather than the
  // normal one. Default to a signed-in crew so tests exercise reality.
  localStorage.setItem('crew_profile', JSON.stringify({
    id: 'crew-default', provider_id: 'provider-default',
  }));
  setOnline(true);
});

afterEach(async () => { await clearAll(); });

// ═══════════════════════════════════════════════════════════════════════════
// The outbox store
// ═══════════════════════════════════════════════════════════════════════════
describe('offlineDb — queueing', () => {
  it('queueSave stores one pending entry keyed <prfId>:save', async () => {
    await queueSave(PRF, { patient_name: 'A' });
    const all = await getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(`${PRF}:save`);
    expect(all[0].action).toBe('save');
    expect(all[0].status).toBe('pending');
    expect(all[0].retries).toBe(0);
    expect(all[0].payload).toEqual({ patient_name: 'A' });
  });

  it('queueSubmit stores a separate entry keyed <prfId>:submit', async () => {
    await queueSave(PRF, { a: 1 });
    await queueSubmit(PRF, { a: 2 });
    const ids = (await getAll()).map(e => e.id).sort();
    expect(ids).toEqual([`${PRF}:save`, `${PRF}:submit`].sort());
  });

  it('re-queueing the same PRF replaces rather than duplicating, keeping the newest payload', async () => {
    await queueSave(PRF, { v: 'old' });
    await queueSave(PRF, { v: 'new' });
    const all = await getAll();
    expect(all).toHaveLength(1);
    expect(all[0].payload).toEqual({ v: 'new' });
  });

  it('keeps entries for different PRFs separate', async () => {
    await queueSave('prf-a', { x: 1 });
    await queueSave('prf-b', { x: 2 });
    expect(await getCount()).toBe(2);
  });
});

describe('offlineDb — retrieval and status', () => {
  it('getPending returns pending, syncing and failed, oldest first', async () => {
    await queueSave('prf-a', {});
    await new Promise(r => setTimeout(r, 5));
    await queueSave('prf-b', {});
    await markSyncing('prf-a:save');
    const pending = await getPending();
    expect(pending.map(e => e.id)).toEqual(['prf-a:save', 'prf-b:save']);
  });

  it('getPending includes "syncing" so an entry orphaned mid-upload is retried, not stranded', async () => {
    await queueSave(PRF, {});
    await markSyncing(`${PRF}:save`);
    // Simulates the tab closing during upload: status stays 'syncing' forever.
    const pending = await getPending();
    expect(pending.map(e => e.id)).toContain(`${PRF}:save`);
  });

  it('getPending EXCLUDES dead entries so they stop being auto-retried', async () => {
    await queueSave(PRF, {});
    await markDead(`${PRF}:save`);
    expect(await getPending()).toHaveLength(0);
  });

  it('markFailed increments retries and records the reason, without dropping the entry', async () => {
    await queueSave(PRF, {});
    await markFailed(`${PRF}:save`, 'network down');
    await markFailed(`${PRF}:save`, 'network down again');
    const [entry] = await getAll();
    expect(entry.retries).toBe(2);
    expect(entry.status).toBe('failed');
    expect(entry.lastError).toBe('network down again');
  });

  it('markSynced is the ONLY operation that deletes — and only after server confirmation', async () => {
    await queueSave(PRF, {});
    await markSynced(`${PRF}:save`);
    expect(await getAll()).toHaveLength(0);
  });
});

describe('offlineDb — a dead entry is never lost', () => {
  it('markDead preserves the record and its payload', async () => {
    await queueSave(PRF, { patient_name: 'Roadside Patient' });
    await markDead(`${PRF}:save`);
    const all = await getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('dead');
    expect(all[0].payload).toEqual({ patient_name: 'Roadside Patient' });
  });

  it('getCount still counts dead entries, so the crew never sees a false zero', async () => {
    await queueSave(PRF, {});
    await markDead(`${PRF}:save`);
    expect(await getPending()).toHaveLength(0);   // not retried
    expect(await getCount()).toBe(1);             // but still visible
  });

  it('getOutboxSummary separates "will retry" from "gave up"', async () => {
    await queueSave('prf-a', {});
    await queueSave('prf-b', {});
    await markDead('prf-b:save');
    expect(await getOutboxSummary()).toEqual({ pending: 1, dead: 1 });
  });

  it('retryDead resurrects give-ups and resets their retry count', async () => {
    await queueSave(PRF, {});
    for (let i = 0; i < 6; i++) await markFailed(`${PRF}:save`, 'x');
    await markDead(`${PRF}:save`);
    await retryDead();
    const [entry] = await getAll();
    expect(entry.status).toBe('pending');
    expect(entry.retries).toBe(0);
    expect(await getPending()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The sync engine
// ═══════════════════════════════════════════════════════════════════════════
describe('syncEngine — refuses to run when it cannot succeed', () => {
  it('does nothing while offline, leaving the queue untouched', async () => {
    setOnline(false);
    await queueSave(PRF, {});
    await startSync();
    expect(mockAxios.patch).not.toHaveBeenCalled();
    expect(await getCount()).toBe(1);
  });

  it('stops without discarding anything when there is no crew token', async () => {
    mockToken.mockReturnValue(null);
    await queueSave(PRF, {});
    await startSync();
    expect(mockAxios.patch).not.toHaveBeenCalled();
    expect(await getCount()).toBe(1);
  });
});

describe('syncEngine — save entries', () => {
  it('PATCHes the PRF and clears the entry on success', async () => {
    await queueSave(PRF, { patient_name: 'A' });
    await startSync();
    expect(mockAxios.patch).toHaveBeenCalledWith(
      `/api/digital-prf/${PRF}`,
      { patient_name: 'A' },
      expect.objectContaining({ headers: { Authorization: 'Bearer crew-token-abc' } }),
    );
    expect(await getCount()).toBe(0);
  });

  it('drops an autosave the server says is obsolete (404 draft swept)', async () => {
    mockAxios.patch.mockRejectedValueOnce(httpError(404));
    await queueSave(PRF, {});
    await startSync();
    // Not retried forever — the authoritative data rides on the submit entry.
    expect(await getCount()).toBe(0);
  });

  it('drops an autosave for an already-submitted PRF (423 Locked)', async () => {
    mockAxios.patch.mockRejectedValueOnce(httpError(423));
    await queueSave(PRF, {});
    await startSync();
    expect(await getCount()).toBe(0);
  });

  it('KEEPS the entry on a real server error and records the failure', async () => {
    mockAxios.patch.mockRejectedValueOnce(httpError(500, 'boom'));
    await queueSave(PRF, {});
    await startSync();
    const [entry] = await getAll();
    expect(entry.status).toBe('failed');
    expect(entry.retries).toBe(1);
    expect(await getCount()).toBe(1);
  });
});

describe('syncEngine — submit entries', () => {
  it('saves then submits, and clears the entry', async () => {
    await queueSubmit(PRF, { patient_name: 'A' });
    await startSync();
    expect(mockAxios.patch).toHaveBeenCalledWith(
      `/api/digital-prf/${PRF}`, { patient_name: 'A' }, expect.anything(),
    );
    expect(mockAxios.post).toHaveBeenCalledWith(
      `/api/digital-prf/${PRF}/submit`, null, expect.anything(),
    );
    expect(await getCount()).toBe(0);
  });

  it('swallows a 423 on the pre-submit save and still submits', async () => {
    // The PRF is already submitted server-side (a prior attempt landed but the
    // response was lost). The save is rejected, but the work IS on the server —
    // the idempotent submit must still run so the entry can clear. Without this
    // the entry stranded as "pending upload" forever with no way to clear it.
    mockAxios.patch.mockRejectedValueOnce(httpError(423));
    await queueSubmit(PRF, { a: 1 });
    await startSync();
    expect(mockAxios.post).toHaveBeenCalledWith(
      `/api/digital-prf/${PRF}/submit`, null, expect.anything(),
    );
    expect(await getCount()).toBe(0);
  });

  it('re-creates and resubmits when the server row is gone (404)', async () => {
    mockAxios.post
      .mockRejectedValueOnce(httpError(404))                 // submit -> gone
      .mockResolvedValueOnce({ data: { id: 'recreated-id' } }) // create
      .mockResolvedValueOnce({ data: {} });                  // submit the new row
    await queueSubmit(PRF, { vehicle_id: 'veh-1', patient_name: 'A' });
    await startSync();

    expect(mockAxios.post).toHaveBeenCalledWith(
      '/api/digital-prf',
      expect.objectContaining({ vehicle_id: 'veh-1' }),
      expect.anything(),
    );
    expect(mockAxios.post).toHaveBeenCalledWith(
      '/api/digital-prf/recreated-id/submit', null, expect.anything(),
    );
    expect(await getCount()).toBe(0);
  });

  it('KEEPS the entry when submit fails for any other reason', async () => {
    mockAxios.post.mockRejectedValueOnce(httpError(500, 'server exploded'));
    await queueSubmit(PRF, {});
    await startSync();
    const [entry] = await getAll();
    expect(entry.status).toBe('failed');
    expect(entry.lastError).toBe('server exploded');
    expect(await getCount()).toBe(1);
  });
});

describe('syncEngine — giving up must never mean throwing away', () => {
  it('marks an entry dead after 5 retries instead of deleting it', async () => {
    await queueSave(PRF, { patient_name: 'Roadside Patient' });
    for (let i = 0; i < 6; i++) await markFailed(`${PRF}:save`, 'network');

    await startSync();

    const all = await getAll();
    expect(all).toHaveLength(1);                 // still there
    expect(all[0].status).toBe('dead');
    expect(all[0].payload).toEqual({ patient_name: 'Roadside Patient' });
    expect(await getCount()).toBe(1);            // still counted for the crew
    // A previous version called markSynced() (a delete) here, silently
    // discarding a medical/legal record and then reporting "All synced".
    expect(mockAxios.patch).not.toHaveBeenCalled();
  });

  it('does not touch other pending entries when one is given up on', async () => {
    await queueSave('prf-dead', {});
    for (let i = 0; i < 6; i++) await markFailed('prf-dead:save', 'network');
    await queueSave('prf-live', { ok: true });

    await startSync();

    const byId = Object.fromEntries((await getAll()).map(e => [e.id, e]));
    expect(byId['prf-dead:save'].status).toBe('dead');   // preserved
    expect(byId['prf-live:save']).toBeUndefined();       // synced and cleared
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Starting a PRF with no signal
// ═══════════════════════════════════════════════════════════════════════════
describe('offline PRF creation', () => {
  const CREATE_BODY = { vehicle_id: 'veh-1', crew_member_2_id: 'crew-2' };

  it('queueCreate stores a pending create entry under the device-chosen id', async () => {
    await queueCreate(PRF, CREATE_BODY);
    const [entry] = await getAll();
    expect(entry.id).toBe(`${PRF}:create`);
    expect(entry.action).toBe('create');
    expect(entry.status).toBe('pending');
    expect(entry.payload).toEqual(CREATE_BODY);
  });

  it('registers the PRF with the id the device already chose', async () => {
    await queueCreate(PRF, CREATE_BODY);
    await startSync();
    expect(mockAxios.post).toHaveBeenCalledWith(
      '/api/digital-prf',
      expect.objectContaining({ vehicle_id: 'veh-1', client_id: PRF }),
      expect.anything(),
    );
    expect(await getCount()).toBe(0);
  });

  it('creates BEFORE saving, so the PATCH has a row to land on', async () => {
    await queueCreate(PRF, CREATE_BODY);
    await new Promise(r => setTimeout(r, 5));
    await queueSave(PRF, { patient_name: 'A' });

    await startSync();

    expect(mockAxios.post.mock.invocationCallOrder[0])
      .toBeLessThan(mockAxios.patch.mock.invocationCallOrder[0]);
    expect(await getCount()).toBe(0);
  });

  // ── The data-loss guard ──────────────────────────────────────────────────
  // syncEngine treats a 404 on a save as "obsolete, drop it". That is right for
  // a draft swept server-side, and catastrophic for a PRF whose create simply
  // hasn't drained yet — it would delete the crew's only copy of a patient
  // record taken at the roadside.
  it('does NOT attempt a save while its create is still outstanding', async () => {
    mockAxios.post.mockRejectedValueOnce(httpError(500, 'server down'));
    await queueCreate(PRF, CREATE_BODY);
    await new Promise(r => setTimeout(r, 5));
    await queueSave(PRF, { patient_name: 'Roadside Patient' });

    await startSync();

    // The save must not have been sent...
    expect(mockAxios.patch).not.toHaveBeenCalled();
    // ...and must still be queued, with its payload intact.
    const byId = Object.fromEntries((await getAll()).map(e => [e.id, e]));
    expect(byId[`${PRF}:save`].status).toBe('pending');
    expect(byId[`${PRF}:save`].payload).toEqual({ patient_name: 'Roadside Patient' });
    expect(byId[`${PRF}:create`].status).toBe('failed');
    expect(await getCount()).toBe(2);
  });

  it('does NOT attempt a submit while its create is still outstanding', async () => {
    mockAxios.post.mockRejectedValueOnce(httpError(500, 'server down'));
    await queueCreate(PRF, CREATE_BODY);
    await new Promise(r => setTimeout(r, 5));
    await queueSubmit(PRF, { patient_name: 'A' });

    await startSync();

    expect(mockAxios.post).toHaveBeenCalledTimes(1);          // only the create
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      `/api/digital-prf/${PRF}/submit`, null, expect.anything(),
    );
    expect(await getCount()).toBe(2);
  });

  it('keeps the save blocked even after the create is given up on', async () => {
    await queueCreate(PRF, CREATE_BODY);
    for (let i = 0; i < 6; i++) await markFailed(`${PRF}:create`, 'network');
    await new Promise(r => setTimeout(r, 5));
    await queueSave(PRF, { patient_name: 'Roadside Patient' });

    await startSync();

    expect(mockAxios.patch).not.toHaveBeenCalled();
    const byId = Object.fromEntries((await getAll()).map(e => [e.id, e]));
    expect(byId[`${PRF}:create`].status).toBe('dead');
    expect(byId[`${PRF}:save`].payload).toEqual({ patient_name: 'Roadside Patient' });
    expect(await getCount()).toBe(2);   // nothing discarded
  });

  it('a blocked PRF does not hold up an unrelated PRF', async () => {
    mockAxios.post.mockRejectedValueOnce(httpError(500));
    await queueCreate('prf-blocked', CREATE_BODY);
    await new Promise(r => setTimeout(r, 5));
    await queueSave('prf-blocked', { x: 1 });
    await queueSave('prf-healthy', { y: 2 });

    await startSync();

    const ids = (await getAll()).map(e => e.id).sort();
    expect(ids).toEqual(['prf-blocked:create', 'prf-blocked:save']);
    expect(mockAxios.patch).toHaveBeenCalledWith(
      '/api/digital-prf/prf-healthy', { y: 2 }, expect.anything(),
    );
  });

  it('drains create then save then submit in one pass once the server is reachable', async () => {
    await queueCreate(PRF, CREATE_BODY);
    await new Promise(r => setTimeout(r, 5));
    await queueSave(PRF, { step: 'save' });
    await new Promise(r => setTimeout(r, 5));
    await queueSubmit(PRF, { step: 'submit' });

    await startSync();

    expect(mockAxios.post).toHaveBeenCalledWith(
      '/api/digital-prf', expect.objectContaining({ client_id: PRF }), expect.anything(),
    );
    expect(mockAxios.post).toHaveBeenCalledWith(
      `/api/digital-prf/${PRF}/submit`, null, expect.anything(),
    );
    expect(await getCount()).toBe(0);
  });

  it('leaves the whole PRF queued while offline, losing nothing', async () => {
    setOnline(false);
    await queueCreate(PRF, CREATE_BODY);
    await queueSave(PRF, { patient_name: 'A' });
    await startSync();
    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(await getCount()).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-tenant protection
//
// The outbox outlives a shift — End Shift and logout do not clear it — so a
// queued entry can still be present when a DIFFERENT crew logs in on the same
// device. Draining used whatever crew_token was current, and the 404 self-heal
// CREATES a fresh PRF, so one provider's patient record could be re-created
// inside another provider's tenant as a genuinely-authorised row. No
// server-side isolation check fires, because the token really is theirs.
// ═══════════════════════════════════════════════════════════════════════════
describe('outbox authorship', () => {
  const PROVIDER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const PROVIDER_B = 'bbbbbbbb-0000-0000-0000-000000000002';

  function loginAs(providerId: string, crewId = 'crew-1') {
    localStorage.setItem('crew_profile', JSON.stringify({ id: crewId, provider_id: providerId }));
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('stamps the queueing crew and provider onto every entry', async () => {
    loginAs(PROVIDER_A, 'crew-alpha');
    await queueCreate(PRF, { vehicle_id: 'v1' });
    await queueSave(PRF, { a: 1 });
    await queueSubmit(PRF, { a: 2 });
    for (const e of await getAll()) {
      expect(e.providerId, `${e.id} lost its provider stamp`).toBe(PROVIDER_A);
      expect(e.crewId).toBe('crew-alpha');
    }
  });

  it('refuses to drain another provider\'s entry, and does NOT discard it', async () => {
    loginAs(PROVIDER_A);
    await queueSave(PRF, { patient_name: 'Provider A Patient' });

    // A different provider's crew now takes the same device.
    loginAs(PROVIDER_B);
    await startSync();

    expect(mockAxios.patch).not.toHaveBeenCalled();
    const [entry] = await getAll();
    expect(entry.status).toBe('pending');                    // untouched
    expect(entry.providerId).toBe(PROVIDER_A);               // still attributed
    expect(entry.payload).toEqual({ patient_name: 'Provider A Patient' });
    expect(await getCount()).toBe(1);                        // still visible
  });

  it('blocks the whole PRF, not just one entry, when it belongs to another provider', async () => {
    loginAs(PROVIDER_A);
    await queueCreate(PRF, { vehicle_id: 'v1' });
    await new Promise(r => setTimeout(r, 5));
    await queueSubmit(PRF, { a: 1 });

    loginAs(PROVIDER_B);
    await startSync();

    expect(mockAxios.post).not.toHaveBeenCalled();
    expect(await getCount()).toBe(2);
  });

  it('drains normally when the same provider is logged in', async () => {
    loginAs(PROVIDER_A);
    await queueSave(PRF, { a: 1 });
    await startSync();
    expect(mockAxios.patch).toHaveBeenCalled();
    expect(await getCount()).toBe(0);
  });

  it('still drains an entry queued before authorship stamping existed', async () => {
    // Legacy entries are unsynced patient records; stranding them would be the
    // data-loss bug all over again. Save/submit target an existing prfId, which
    // the server already refuses for a foreign PRF.
    loginAs(PROVIDER_A);
    await queueSave(PRF, { a: 1 });
    const db = await (await import('../services/offlineDb')).initDb();
    const e = await db.get('outbox', `${PRF}:save`);
    delete e.providerId; delete e.crewId;
    await db.put('outbox', e);

    await startSync();
    expect(mockAxios.patch).toHaveBeenCalled();
    expect(await getCount()).toBe(0);
  });

  it('refuses to RE-CREATE an unattributed entry — that is the laundering path', async () => {
    // A 404 on submit triggers recreateAndSubmit, which mints a brand-new row
    // under whoever is logged in now. Without provenance we cannot prove the
    // record belongs to this provider, so it must not be re-created.
    loginAs(PROVIDER_A);
    await queueSubmit(PRF, { patient_name: 'Unattributed Patient' });
    const db = await (await import('../services/offlineDb')).initDb();
    const e = await db.get('outbox', `${PRF}:submit`);
    delete e.providerId;
    await db.put('outbox', e);

    mockAxios.post.mockRejectedValueOnce(httpError(404));
    await startSync();

    // No fresh PRF was created...
    expect(mockAxios.post).not.toHaveBeenCalledWith(
      '/api/digital-prf', expect.anything(), expect.anything(),
    );
    // ...and the crew's work is preserved.
    const [kept] = await getAll();
    expect(kept.payload).toEqual({ patient_name: 'Unattributed Patient' });
    expect(await getCount()).toBe(1);
  });
});

describe('syncEngine — ordering', () => {
  it('drains oldest first, so a save queued before a submit is sent first', async () => {
    await queueSave(PRF, { step: 1 });
    await new Promise(r => setTimeout(r, 5));
    await queueSubmit(PRF, { step: 2 });

    await startSync();

    const patchOrder = mockAxios.patch.mock.calls.map(c => (c[1] as any).step);
    expect(patchOrder).toEqual([1, 2]);
    expect(await getCount()).toBe(0);
  });
});

/**
 * Resolving the Case id for an offline-confirmed facility email.
 *
 * The outbox looked this up with `GET /api/digital-prf/{prfId}` and read
 * `case_id` off it — a key that response has NEVER contained (it returns
 * case_NUMBER). So it resolved undefined every single time, attachCaseId never
 * fired, and markSynced then deleted the outbox entry, leaving nothing to
 * retry. Every facility email confirmed offline silently never sent, and
 * nothing anywhere recorded that one was owed.
 *
 * The online path polls /case-status directly, which is why this went unseen.
 */
describe('facility-email Case id after an offline submit', () => {
  const EMAIL_PRF = '99999999-8888-7777-6666-555555555555';

  beforeEach(async () => {
    await clearAll();
    localStorage.clear();
    setOnline(true);
    vi.clearAllMocks();
    mockToken.mockReturnValue('crew-token-abc');
  });

  it('asks /case-status, the only endpoint that returns case_id', async () => {
    const { rememberPendingEmail, getPendingEmail, __clearAllPendingEmails } =
      await import('../services/pendingFacilityEmail');
    __clearAllPendingEmails();
    rememberPendingEmail(EMAIL_PRF, 'dr@hospital.co.za', 'provider-a');

    mockAxios.patch.mockResolvedValue({ data: {} });
    // Submit answers WITHOUT a case_id — the real 202 shape, because the
    // billing pipeline has not run yet.
    mockAxios.post.mockResolvedValue({
      data: { status: 'submitted', prf_number: 42, case_number: 'X-2026-01-000042' },
    });
    (axios as any).get = vi.fn(async (url: string) => {
      if (url.endsWith('/case-status')) return { data: { case_id: 'the-case-id' } };
      // The detail endpoint: has case_number, never case_id.
      return { data: { id: EMAIL_PRF, case_number: 'X-2026-01-000042' } };
    });

    await queueSubmit(EMAIL_PRF, { form_data: {} });
    await startSync();

    const urls = ((axios as any).get as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(
      urls.some((u: string) => u.includes('/case-status')),
      `no /case-status lookup was made; it asked: ${JSON.stringify(urls)}`,
    ).toBe(true);

    expect(
      getPendingEmail(EMAIL_PRF)?.caseId,
      'the Case id was never attached, so the hospital never gets the PRF',
    ).toBe('the-case-id');
  });

  it('leaves the record pending — not deleted — when the Case is not ready yet', async () => {
    // The Case is created asynchronously, so one lookup is routinely too early.
    const { rememberPendingEmail, getPendingEmail, __clearAllPendingEmails } =
      await import('../services/pendingFacilityEmail');
    __clearAllPendingEmails();
    rememberPendingEmail(EMAIL_PRF, 'dr@hospital.co.za', 'provider-a');

    mockAxios.patch.mockResolvedValue({ data: {} });
    mockAxios.post.mockResolvedValue({ data: { status: 'submitted' } });
    (axios as any).get = vi.fn(async () => ({ data: { case_id: null } }));

    await queueSubmit(EMAIL_PRF, { form_data: {} });
    await startSync();

    const pending = getPendingEmail(EMAIL_PRF);
    expect(pending, 'an owed handover document must never be dropped').toBeDefined();
    expect(pending?.caseId).toBeFalsy();
    expect(pending?.attempts ?? 0, 'a slow pipeline must not burn a send attempt').toBe(0);
  });
});

/**
 * The 404 self-heal must be idempotent.
 *
 * When a queued PRF's server row has been swept, the outbox re-creates it. That
 * create sent NO client_id, so it was not idempotent: every retry minted a
 * brand-new server row and submitted it, and each of those rows runs the
 * billing pipeline and produces its own Case and Claim. One ambulance call
 * billed once per retry, up to five times before the entry is marked dead — and
 * a network wobble between the create and the submit was enough to trigger it.
 */
describe('outbox 404 self-heal', () => {
  const DEAD = '44444444-3333-2222-1111-000000000000';

  beforeEach(async () => {
    await clearAll();
    localStorage.clear();
    localStorage.setItem('crew_profile', JSON.stringify({ provider_id: 'prov-1', id: 'crew-1' }));
    localStorage.setItem('active_vehicle', JSON.stringify({ id: 'veh-1' }));
    setOnline(true);
    vi.clearAllMocks();
    mockToken.mockReturnValue('crew-token-abc');
  });

  /** submit 404s (row swept); the re-create + patch + submit then succeed. */
  function wireSweptPrf(createdId = 'server-side-new-id') {
    mockAxios.patch.mockResolvedValue({ data: {} });
    mockAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/digital-prf/${DEAD}/submit`)) throw httpError(404, 'PRF not found');
      if (url === '/api/digital-prf') return { data: { id: createdId } };
      return { data: { status: 'submitted' } };
    });
    (axios as any).get = vi.fn(async () => ({ data: { case_id: null } }));
  }

  it('sends a client_id on the re-create so a retry cannot bill twice', async () => {
    wireSweptPrf();
    await queueSubmit(DEAD, { form_data: { patient_name: 'Swept' } });
    await startSync();

    const creates = mockAxios.post.mock.calls.filter((c: any[]) => c[0] === '/api/digital-prf');
    expect(creates.length, 'expected exactly one re-create').toBe(1);
    expect(
      creates[0][1]?.client_id,
      'the re-create carried no client_id, so every retry mints another billable PRF',
    ).toBeTruthy();
  });

  it('reuses the SAME id when the heal is retried', async () => {
    // First pass: the re-create lands but the follow-up submit dies.
    mockAxios.patch.mockResolvedValue({ data: {} });
    mockAxios.post.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/digital-prf/${DEAD}/submit`)) throw httpError(404, 'PRF not found');
      if (url === '/api/digital-prf') return { data: { id: 'server-side-new-id' } };
      throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
    });
    (axios as any).get = vi.fn(async () => ({ data: { case_id: null } }));

    await queueSubmit(DEAD, { form_data: { patient_name: 'Swept' } });
    await startSync();

    const firstId = mockAxios.post.mock.calls
      .filter((c: any[]) => c[0] === '/api/digital-prf')[0][1].client_id;

    // Second pass — the entry is still queued and retries.
    vi.clearAllMocks();
    wireSweptPrf();
    await startSync();

    const secondCreate = mockAxios.post.mock.calls.filter((c: any[]) => c[0] === '/api/digital-prf');
    expect(secondCreate.length).toBe(1);
    expect(
      secondCreate[0][1].client_id,
      'the retry chose a NEW id — the server has no way to recognise the replay, ' +
      'so it creates a second billable PRF for the same call',
    ).toBe(firstId);
  });
});
