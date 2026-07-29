/**
 * The local draft store — the crew's only copy of a patient record between
 * server saves.
 *
 * The behaviour under test is what happens when the WRITE FAILS. That used to
 * be swallowed, and swallowing it was silently destructive: the previous draft
 * survived and went stale while the crew kept working, then won on the next
 * load (the form's load boundary checks only whether the key exists) and
 * overwrote newer server data on the next save.
 *
 * A real browser only throws once several megabytes are resident, which is why
 * storage is injected here.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  writeDraft, readDraft, clearDraft, hasUsableDraft, draftKey,
  type DraftStorage,
} from '../pages/crew/prfDraftStore';

/** In-memory storage whose quota can be made to bite on demand. */
function makeStorage(opts: { failWritesAfter?: number } = {}): DraftStorage & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>();
  const s = {
    map,
    writes: 0,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem(k: string, v: string) {
      s.writes += 1;
      if (opts.failWritesAfter !== undefined && s.writes > opts.failWritesAfter) {
        // What Chrome/Safari actually throw when the quota is exhausted.
        const e: any = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, v);
    },
    removeItem: (k: string) => { map.delete(k); },
  };
  return s;
}

const KEY = draftKey('prf-1');
const DRAFT = (n: number) => ({ fd: { patient_name: `Patient-${n}` }, savedAt: n });

describe('draft key', () => {
  it('is namespaced per PRF', () => {
    expect(draftKey('abc')).toBe('prf-draft:abc');
  });
});

describe('writeDraft — the happy path', () => {
  it('stores the draft and reports ok', () => {
    const s = makeStorage();
    expect(writeDraft(s, KEY, DRAFT(1))).toBe('ok');
    expect(readDraft(s, KEY)).toEqual(DRAFT(1));
  });

  it('replaces the previous draft rather than accumulating', () => {
    const s = makeStorage();
    writeDraft(s, KEY, DRAFT(1));
    writeDraft(s, KEY, DRAFT(2));
    expect(s.map.size).toBe(1);
    expect(readDraft(s, KEY)!.savedAt).toBe(2);
  });
});

describe('writeDraft — quota exhausted (the destructive case)', () => {
  it('reports failure rather than swallowing it', () => {
    const s = makeStorage({ failWritesAfter: 0 });
    expect(writeDraft(s, KEY, DRAFT(1))).toBe('failed');
  });

  it('DELETES the previous draft instead of leaving a stale one behind', () => {
    // This is the whole fix. A surviving older draft would shadow the server on
    // the next load and then overwrite it, destroying everything captured after
    // the write started failing — while showing the crew their own older data,
    // so nothing looks wrong.
    const s = makeStorage({ failWritesAfter: 1 });
    expect(writeDraft(s, KEY, DRAFT(1))).toBe('ok');
    expect(readDraft(s, KEY)!.savedAt).toBe(1);

    expect(writeDraft(s, KEY, DRAFT(2))).toBe('failed');
    expect(readDraft(s, KEY), 'stale draft survived a failed write').toBeNull();
    expect(hasUsableDraft(s, KEY)).toBe(false);
  });

  it('leaves the server authoritative — no draft means the load boundary uses the server', () => {
    const s = makeStorage({ failWritesAfter: 1 });
    writeDraft(s, KEY, DRAFT(1));
    writeDraft(s, KEY, DRAFT(2));
    // hasUsableDraft is exactly the condition the form's load boundary tests.
    expect(hasUsableDraft(s, KEY)).toBe(false);
  });

  it('does not throw even when the cleanup delete ALSO fails', () => {
    const s: DraftStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('storage gone'); },
    };
    expect(() => writeDraft(s, KEY, DRAFT(1))).not.toThrow();
    expect(writeDraft(s, KEY, DRAFT(1))).toBe('failed');
  });

  it('recovers cleanly once there is room again', () => {
    const s = makeStorage({ failWritesAfter: 1 });
    writeDraft(s, KEY, DRAFT(1));
    writeDraft(s, KEY, DRAFT(2));           // fails, draft dropped
    const roomy = makeStorage();
    expect(writeDraft(roomy, KEY, DRAFT(3))).toBe('ok');
    expect(readDraft(roomy, KEY)!.savedAt).toBe(3);
  });
});

describe('readDraft — tolerating rubbish', () => {
  it('returns null when nothing is stored', () => {
    expect(readDraft(makeStorage(), KEY)).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    const s = makeStorage();
    s.map.set(KEY, '{not json');
    expect(() => readDraft(s, KEY)).not.toThrow();
    expect(readDraft(s, KEY)).toBeNull();
  });

  it('treats a draft with no `fd` as absent — the form cannot rehydrate from it', () => {
    // The form's loadFromLocal bails on !draft.fd. If such a draft counted as
    // present it would block the server hydration while supplying nothing,
    // leaving the crew looking at an empty form.
    const s = makeStorage();
    s.map.set(KEY, JSON.stringify({ savedAt: 1 }));
    expect(readDraft(s, KEY)).toBeNull();
    expect(hasUsableDraft(s, KEY)).toBe(false);
  });

  it('survives a storage that throws on read', () => {
    const s: DraftStorage = {
      getItem: () => { throw new Error('private mode'); },
      setItem: () => {}, removeItem: () => {},
    };
    expect(readDraft(s, KEY)).toBeNull();
  });
});

describe('clearDraft', () => {
  it('removes the draft', () => {
    const s = makeStorage();
    writeDraft(s, KEY, DRAFT(1));
    clearDraft(s, KEY);
    expect(hasUsableDraft(s, KEY)).toBe(false);
  });

  it('never throws, even on a hostile storage', () => {
    const s: DraftStorage = {
      getItem: () => null, setItem: () => {},
      removeItem: () => { throw new Error('nope'); },
    };
    expect(() => clearDraft(s, KEY)).not.toThrow();
  });
});
