import { openDB, type IDBPDatabase } from 'idb';

export interface OfflineEntry {
  id: string;
  action: 'create' | 'save' | 'submit';
  payload: any;
  timestamp: number;
  retries: number;
  lastError?: string;
  // 'dead' = gave up auto-retrying after too many failures. NEVER deleted (the
  // PRF never reached the server) — kept for the crew to see and manually resend.
  status: 'pending' | 'syncing' | 'failed' | 'dead';
}

const DB_NAME = 'ems-offline';
const DB_VERSION = 1;
const STORE = 'outbox';

let dbPromise: Promise<IDBPDatabase> | null = null;

export function initDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('by-status', 'status');
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Queue the CREATION of a PRF the crew started with no signal.
 *
 * The device generates the PRF's UUID itself and hands it to the server as
 * `client_id` when connectivity returns. Until then the crew works entirely
 * against the local draft under that same id, so the outbox keys, the
 * localStorage draft key and the form's route all agree from the first tap.
 *
 * The timestamp is what orders this ahead of the PRF's own save/submit entries
 * in getPending() — the row has to exist server-side before anything can PATCH
 * it. syncEngine additionally refuses to drain a PRF's save/submit while its
 * create is still outstanding, so ordering is enforced, not merely likely.
 */
export async function queueCreate(prfId: string, payload: any) {
  const db = await initDb();
  const key = `${prfId}:create`;
  await db.put(STORE, {
    id: key,
    action: 'create' as const,
    payload,
    timestamp: Date.now(),
    retries: 0,
    status: 'pending' as const,
  });
}

export async function queueSave(prfId: string, payload: any) {
  const db = await initDb();
  const key = `${prfId}:save`;
  await db.put(STORE, {
    id: key,
    action: 'save' as const,
    payload,
    timestamp: Date.now(),
    retries: 0,
    status: 'pending' as const,
  });
}

export async function queueSubmit(prfId: string, payload: any) {
  const db = await initDb();
  const key = `${prfId}:submit`;
  await db.put(STORE, {
    id: key,
    action: 'submit' as const,
    payload,
    timestamp: Date.now(),
    retries: 0,
    status: 'pending' as const,
  });
}

export async function getPending(): Promise<OfflineEntry[]> {
  const db = await initDb();
  // Include 'syncing' too — an entry orphaned mid-sync (page reload, tab close,
  // or a network hiccup during upload) would otherwise never be retried and
  // would show as "pending upload" forever, even when online.
  const all = (await db.getAll(STORE)) as OfflineEntry[];
  return all
    .filter(e => e.status === 'pending' || e.status === 'syncing' || e.status === 'failed')
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function markSyncing(key: string) {
  const db = await initDb();
  const entry = await db.get(STORE, key);
  if (entry) {
    entry.status = 'syncing';
    await db.put(STORE, entry);
  }
}

export async function markSynced(key: string) {
  const db = await initDb();
  await db.delete(STORE, key);
}

export async function markFailed(key: string, error: string) {
  const db = await initDb();
  const entry = await db.get(STORE, key);
  if (entry) {
    entry.status = 'failed';
    entry.retries = (entry.retries || 0) + 1;
    entry.lastError = error;
    await db.put(STORE, entry);
  }
}

/**
 * Auto-retry has been exhausted for this entry. Mark it 'dead' — it stops being
 * retried (getPending excludes 'dead') but is NEVER deleted, so the crew's work
 * is preserved and stays visible in the outbox count for manual resend. This
 * replaces the old behaviour of calling markSynced() (delete) on give-up, which
 * silently discarded the PRF and falsely reported "all synced".
 */
export async function markDead(key: string) {
  const db = await initDb();
  const entry = await db.get(STORE, key);
  if (entry) {
    entry.status = 'dead';
    await db.put(STORE, entry);
  }
}

export async function getCount(): Promise<number> {
  const db = await initDb();
  const all = await db.getAll(STORE);
  // 'dead' entries are included — the PRF still hasn't reached the server, so the
  // crew must keep seeing it (never let a failed upload drop silently to zero).
  return all.filter(e => e.status === 'pending' || e.status === 'syncing' || e.status === 'failed' || e.status === 'dead').length;
}

/** Breakdown so the UI can distinguish "will retry" from "gave up, needs attention". */
export async function getOutboxSummary(): Promise<{ pending: number; dead: number }> {
  const db = await initDb();
  const all = (await db.getAll(STORE)) as OfflineEntry[];
  return {
    pending: all.filter(e => e.status === 'pending' || e.status === 'syncing' || e.status === 'failed').length,
    dead: all.filter(e => e.status === 'dead').length,
  };
}

/** Resurrect every 'dead' entry (reset retries) so a manual "Retry" gives them another attempt. */
export async function retryDead(): Promise<void> {
  const db = await initDb();
  const all = (await db.getAll(STORE)) as OfflineEntry[];
  for (const e of all) {
    if (e.status === 'dead') {
      e.status = 'pending';
      e.retries = 0;
      await db.put(STORE, e);
    }
  }
}

export async function getAll(): Promise<OfflineEntry[]> {
  const db = await initDb();
  return db.getAll(STORE);
}

export async function clearAll() {
  const db = await initDb();
  await db.clear(STORE);
}
