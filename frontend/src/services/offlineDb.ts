import { openDB, type IDBPDatabase } from 'idb';

export interface OfflineEntry {
  id: string;
  action: 'save' | 'submit';
  payload: any;
  timestamp: number;
  retries: number;
  lastError?: string;
  status: 'pending' | 'syncing' | 'failed';
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
  const all = await db.getAllFromIndex(STORE, 'by-status', 'pending');
  return all.sort((a, b) => a.timestamp - b.timestamp);
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

export async function getCount(): Promise<number> {
  const db = await initDb();
  const all = await db.getAll(STORE);
  return all.filter(e => e.status === 'pending' || e.status === 'syncing').length;
}

export async function getAll(): Promise<OfflineEntry[]> {
  const db = await initDb();
  return db.getAll(STORE);
}

export async function clearAll() {
  const db = await initDb();
  await db.clear(STORE);
}
