/**
 * The Digital PRF's local draft — the crew's only copy of a patient record
 * between server saves.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The write can FAIL, and how that failure is handled decides whether the
 * record survives. It used to be `catch { /* non-fatal *\/ }`, which was the
 * opposite of non-fatal:
 *
 *   `fd` carries base64 attachments — a 10 MB PDF becomes ~13 MB of string
 *   against a browser quota of roughly 5 MB. Once a write starts failing, the
 *   PREVIOUS draft survives untouched and goes stale while the crew keeps
 *   working. On the next load that stale draft WINS (the load boundary checks
 *   only whether the key exists), the form rehydrates from it, and the next
 *   save replaces newer server data with it — destroying everything captured
 *   in between, while showing the crew their own older data so nothing looks
 *   wrong.
 *
 * Storage is injected so the quota path can actually be tested; a real browser
 * only throws once several megabytes are already resident.
 */

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type DraftWriteResult = 'ok' | 'failed';

export const draftKey = (prfId: string) => `prf-draft:${prfId}`;

/**
 * Persist the draft.
 *
 * On failure the draft is DELETED rather than left to go stale, which makes the
 * server authoritative again (it has no comparable size limit — nginx allows
 * 50 MB). Callers are expected to react to 'failed' by forcing a server save;
 * the device has no local safety net until the next successful write.
 */
export function writeDraft(
  storage: DraftStorage,
  key: string,
  draft: Record<string, any>,
): DraftWriteResult {
  try {
    storage.setItem(key, JSON.stringify(draft));
    return 'ok';
  } catch {
    try { storage.removeItem(key); } catch { /* nothing more we can do */ }
    return 'failed';
  }
}

/** Read a draft back, tolerating anything malformed. */
export function readDraft(storage: DraftStorage, key: string): Record<string, any> | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // The form's loader requires `fd`; anything without it cannot rehydrate and
    // is treated as absent rather than as a draft that shadows the server.
    if (!parsed || typeof parsed !== 'object' || !parsed.fd) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(storage: DraftStorage, key: string): void {
  try { storage.removeItem(key); } catch { /* ignore */ }
}

/** True when a draft is present and usable — i.e. it would shadow the server. */
export function hasUsableDraft(storage: DraftStorage, key: string): boolean {
  return readDraft(storage, key) !== null;
}
