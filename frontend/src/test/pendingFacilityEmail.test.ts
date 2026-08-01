/**
 * Facility email confirmed offline, sent once there is signal.
 *
 * Reported from the field: a PRF submitted with no signal never reached the
 * cases list AND the receiving hospital never got the handover document. The
 * second half is this module's problem: online, submitting a PRF with a
 * handover address routes the crew to the viewer with ?send=1 where they
 * confirm and it goes. Offline that step was skipped entirely — the submit was
 * queued, the crew returned to the dashboard, and nothing recorded that an
 * email was ever owed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberPendingEmail,
  getPendingEmail,
  getPendingEmails,
  attachCaseId,
  recordAttempt,
  clearPendingEmail,
  isExhausted,
  isStale,
  pendingForProvider,
  MAX_SEND_ATTEMPTS,
  STALE_AFTER_MS,
  __clearAllPendingEmails,
} from '../services/pendingFacilityEmail';

const PRF = 'prf-uuid-1';
const OTHER = 'prf-uuid-2';
const PROVIDER = 'provider-a';

describe('pending facility email', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearAllPendingEmails();
  });

  it('remembers the address the crew CONFIRMED', () => {
    rememberPendingEmail(PRF, 'dr@hospital.co.za', PROVIDER);
    const e = getPendingEmail(PRF);
    expect(e?.recipient).toBe('dr@hospital.co.za');
    expect(e?.providerId).toBe(PROVIDER);
    expect(e?.attempts).toBe(0);
    expect(e?.caseId).toBeUndefined();
  });

  it('trims whitespace, which is what a phone keyboard adds', () => {
    rememberPendingEmail(PRF, '  dr@hospital.co.za  ');
    expect(getPendingEmail(PRF)?.recipient).toBe('dr@hospital.co.za');
  });

  it('a re-confirm replaces rather than duplicating', () => {
    rememberPendingEmail(PRF, 'wrong@hospital.co.za');
    rememberPendingEmail(PRF, 'right@hospital.co.za');
    expect(getPendingEmails()).toHaveLength(1);
    expect(getPendingEmail(PRF)?.recipient).toBe('right@hospital.co.za');
  });

  it('ignores an empty confirmation instead of queueing a send to nowhere', () => {
    rememberPendingEmail(PRF, '');
    rememberPendingEmail('', 'dr@hospital.co.za');
    expect(getPendingEmails()).toHaveLength(0);
  });

  it('keeps separate PRFs separate', () => {
    rememberPendingEmail(PRF, 'a@h.co.za');
    rememberPendingEmail(OTHER, 'b@h.co.za');
    expect(getPendingEmails()).toHaveLength(2);
  });

  it('attaches the Case id once the pipeline has produced one', () => {
    rememberPendingEmail(PRF, 'dr@hospital.co.za');
    attachCaseId(PRF, 'case-123');
    expect(getPendingEmail(PRF)?.caseId).toBe('case-123');
  });

  it('attaching to an unknown PRF is a no-op, not a crash', () => {
    expect(() => attachCaseId('nope', 'case-1')).not.toThrow();
    expect(getPendingEmails()).toHaveLength(0);
  });

  it('counts attempts and stops auto-retrying — without deleting', () => {
    rememberPendingEmail(PRF, 'dr@hospital.co.za');
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) recordAttempt(PRF, 'smtp down');

    const e = getPendingEmail(PRF)!;
    expect(isExhausted(e)).toBe(true);
    expect(e.lastError).toBe('smtp down');
    // The record MUST survive. Deleting it silently is precisely the failure
    // this feature exists to prevent — the hospital would never be emailed and
    // nothing would say so.
    expect(getPendingEmail(PRF)).toBeDefined();
  });

  it('only clears when the server has actually accepted the send', () => {
    rememberPendingEmail(PRF, 'dr@hospital.co.za');
    clearPendingEmail(PRF);
    expect(getPendingEmail(PRF)).toBeUndefined();
  });

  it('flags an entry that has been waiting too long', () => {
    rememberPendingEmail(PRF, 'dr@hospital.co.za');
    const fresh = getPendingEmail(PRF)!;
    expect(isStale(fresh)).toBe(false);
    // A handover document loses clinical value as it ages — the receiving team
    // needs it while the patient is still in front of them.
    expect(isStale(fresh, Date.now() + STALE_AFTER_MS + 1000)).toBe(true);
  });

  it('never offers another provider’s PRF to this crew', () => {
    rememberPendingEmail(PRF, 'a@h.co.za', 'provider-a');
    rememberPendingEmail(OTHER, 'b@h.co.za', 'provider-b');

    const forA = pendingForProvider('provider-a');
    expect(forA.map((e) => e.prfId)).toEqual([PRF]);
  });

  it('keeps unattributed legacy entries visible rather than hiding them', () => {
    // An entry queued before authorship stamping is still an owed handover
    // document. Hiding it would be the silent-loss failure again.
    rememberPendingEmail(PRF, 'a@h.co.za', undefined);
    expect(pendingForProvider('provider-a').map((e) => e.prfId)).toEqual([PRF]);
  });

  it('survives a corrupt store instead of throwing on every read', () => {
    localStorage.setItem('pending_facility_emails_v1', '{not an array');
    expect(getPendingEmails()).toEqual([]);
    expect(() => rememberPendingEmail(PRF, 'a@h.co.za')).not.toThrow();
    expect(getPendingEmail(PRF)?.recipient).toBe('a@h.co.za');
  });
});
