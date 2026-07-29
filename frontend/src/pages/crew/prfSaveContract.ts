/**
 * The save contract for a Digital PRF: what gets sent, and what happens when
 * sending fails.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * These two decisions govern whether a crew's roadside patient record survives.
 * They lived inside a 10,862-line component that no test mounts, so neither had
 * ever been checked. Both are pure functions of their inputs, so they can live
 * here and be tested directly — the same pattern as prfValidation.ts,
 * utils/prfResumePhase.ts and pages/prfPdfLayout.ts.
 *
 * (Also a separate file because DigitalPRFForm.tsx must not export
 * non-components: that disables React Fast Refresh. See its header at ~L715.)
 */

export interface SaveState {
  fd: Record<string, any>;
  vitals: any[];
  ivRows: any[];
  medRows: any[];
  timestamps: Record<string, string | null>;
  kms: Record<string, string>;
  sigs: Record<string, string | null>;
  vehicle: string;
  crew2Id: string;
}

/**
 * Assemble the PATCH body.
 *
 * Two rules here are load-bearing and easy to break by accident:
 *
 *  - Empty-string km and timestamp values MUST become null. The backend's
 *    Numeric/timestamp columns reject '' and the ENTIRE save fails — losing
 *    every other field in the same request, not just the blank one.
 *  - A '0' odometer reading is a real value and must survive. Using a falsy
 *    check instead of a trimmed-empty check would silently drop it.
 *
 * All five signature keys are always present (via the spread), so clearing a
 * signature sends an explicit null rather than omitting the key.
 */
export function buildSavePayload(s: SaveState): Record<string, any> {
  const cleanKms: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(s.kms || {})) {
    // Compare against the STRINGIFIED value, not the value's truthiness.
    // `v && ...` is false for the number 0, so a legitimate zero odometer
    // reading would be silently converted to null. The load path currently
    // coerces km to a string (DigitalPRFForm ~L4608, whose comment says "so a
    // legit 0 is kept"), which is the only reason that is not live today —
    // this makes the guard hold regardless of the runtime type it receives.
    const str = v == null ? '' : String(v);
    cleanKms[k] = str.trim() ? str : null;
  }
  const cleanTs: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(s.timestamps || {})) {
    cleanTs[k] = v || null;
  }
  return {
    form_data: {
      ...s.fd,
      vitals_sets: s.vitals,
      iv_therapy: s.ivRows,
      medications: s.medRows,
    },
    vehicle_id: s.vehicle || null,
    crew_member_2_id: s.crew2Id || null,
    ...cleanTs,
    ...cleanKms,
    ...s.sigs,
  };
}

/**
 * What to do when a save fails.
 *
 *   session-expired  401 — queue the work, then route to login.
 *   locked           423 — the PRF is submitted and permanently uneditable;
 *                          stop saving (retrying loops forever and trips the
 *                          rate limiter, blocking the whole device).
 *   conflict         409 — another writer touched it; refresh the version
 *                          token and retry. The payload stays in memory.
 *   queue            everything else — preserve the payload in the outbox.
 *
 * THE INVARIANT: every outcome except `locked` keeps the crew's work somewhere.
 * `queue` deliberately catches unknown server errors (500/502/504) as well as
 * offline and 404. It previously did not: a 500 during a backend restart set an
 * error flag and dropped the payload, so the work vanished as soon as the crew
 * navigated away — no queue entry, no warning. A 404 is normal for a PRF
 * created offline whose creation has not drained yet, so it must queue rather
 * than surface an error.
 */
export type SaveErrorAction = 'session-expired' | 'locked' | 'conflict' | 'queue';

export function classifySaveError(
  err: any,
  opts: { online?: boolean } = {},
): SaveErrorAction {
  const status = err?.response?.status;
  if (status === 401) return 'session-expired';
  if (status === 423) return 'locked';
  if (status === 409) return 'conflict';
  return 'queue';
}

/** True when the failure means the work must be preserved rather than dropped. */
export function preservesWork(action: SaveErrorAction): boolean {
  return action !== 'locked';
}
