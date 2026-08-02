/**
 * The Digital PRF save contract.
 *
 * These two functions decide what reaches the server and what happens when it
 * doesn't. Both lived inside a 10,862-line component that no test mounts, so
 * neither had ever been checked — while the failures they govern are exactly
 * the ones that lose a crew's roadside patient record.
 *
 * Unlike conditionalFields.test.ts and digitalPrfSecurity.test.ts (which
 * re-implement the form's logic inside the test file and would still pass if
 * the form were deleted), this imports the real module the form imports.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSavePayload, classifySaveError, preservesWork, saveErrorMessage,
  type SaveState, type SaveErrorAction,
} from '../pages/crew/prfSaveContract';

const EMPTY_SIGS = {
  patient_signature: null, witness_signature: null, handover_signature: null,
  crew_signature: null, valuables_signature: null,
};

function state(over: Partial<SaveState> = {}): SaveState {
  return {
    fd: { patient_name: 'Roadside' },
    vitals: [], ivRows: [], medRows: [],
    timestamps: {}, kms: {}, sigs: { ...EMPTY_SIGS },
    vehicle: '', crew2Id: '',
    ...over,
  };
}

/** axios-shaped error, since the classifier branches on response.status. */
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('buildSavePayload — what reaches the server', () => {
  it('nests the clinical arrays inside form_data under the keys the backend reads', () => {
    const p = buildSavePayload(state({
      vitals: [{ hr: '80' }], ivRows: [{ type: 'NaCl' }], medRows: [{ type: 'Morphine' }],
    }));
    expect(p.form_data.vitals_sets).toEqual([{ hr: '80' }]);
    expect(p.form_data.iv_therapy).toEqual([{ type: 'NaCl' }]);
    expect(p.form_data.medications).toEqual([{ type: 'Morphine' }]);
    expect(p.form_data.patient_name).toBe('Roadside');
  });

  // ── The rule that protects every OTHER field in the request ──────────────
  it('converts an empty-string odometer to null, because "" fails the whole save', () => {
    // The backend's Numeric column rejects '' and rejects the ENTIRE request,
    // so one blank km field would discard every other value sent with it.
    const p = buildSavePayload(state({ kms: { km_on_scene: '', km_dispatched: '104219' } }));
    expect(p.km_on_scene).toBeNull();
    expect(p.km_dispatched).toBe('104219');
  });

  it('treats a whitespace-only odometer as empty', () => {
    const p = buildSavePayload(state({ kms: { km_on_scene: '   ' } }));
    expect(p.km_on_scene).toBeNull();
  });

  it('KEEPS a "0" odometer reading — it is a real measurement, not a blank', () => {
    const p = buildSavePayload(state({ kms: { km_on_scene: '0' } }));
    expect(p.km_on_scene).toBe('0');
  });

  it('KEEPS a NUMERIC zero odometer — the case a truthiness check silently drops', () => {
    // The backend stores odometers numerically. `v && String(v).trim() ? v : null`
    // is FALSE for the number 0, so a zero reading became null. Only the load
    // path's String() coercion kept that off production; the guard itself must
    // hold whatever runtime type it is handed, because wrong runtime types from
    // the API are a recurring crash/data family in this form.
    const p = buildSavePayload(state({ kms: { km_on_scene: 0 as any } }));
    expect(p.km_on_scene).toBe('0');
  });

  it('treats null and undefined odometer values as blank, not as "null" text', () => {
    const p = buildSavePayload(state({
      kms: { km_a: null as any, km_b: undefined as any },
    }));
    expect(p.km_a).toBeNull();
    expect(p.km_b).toBeNull();
  });

  it('converts empty timestamps to null and preserves real ones', () => {
    const p = buildSavePayload(state({
      timestamps: { time_on_scene: '', time_dispatched: '2026-07-28T10:00:00' },
    }));
    expect(p.time_on_scene).toBeNull();
    expect(p.time_dispatched).toBe('2026-07-28T10:00:00');
  });

  // ── Signatures: a prior release lost these ───────────────────────────────
  it('always sends all five signature keys, so a cleared signature is explicit', () => {
    const p = buildSavePayload(state());
    for (const k of Object.keys(EMPTY_SIGS)) {
      expect(p, `${k} missing from payload`).toHaveProperty(k);
    }
  });

  it('carries signatures captured seconds before submit', () => {
    const p = buildSavePayload(state({
      sigs: { ...EMPTY_SIGS, patient_signature: 'data:image/png;base64,PATIENT', crew_signature: 'data:image/png;base64,CREW' },
    }));
    expect(p.patient_signature).toBe('data:image/png;base64,PATIENT');
    expect(p.crew_signature).toBe('data:image/png;base64,CREW');
  });

  it('sends null rather than an empty string for an unset vehicle or partner', () => {
    const p = buildSavePayload(state({ vehicle: '', crew2Id: '' }));
    expect(p.vehicle_id).toBeNull();
    expect(p.crew_member_2_id).toBeNull();
  });

  it('does not crash on a state with no kms or timestamps at all', () => {
    expect(() => buildSavePayload(state({ kms: undefined as any, timestamps: undefined as any }))).not.toThrow();
  });
});

describe('classifySaveError — what happens when the save fails', () => {
  const CASES: Array<[string, any, SaveErrorAction]> = [
    ['401 expired session', httpError(401), 'session-expired'],
    ['423 already submitted', httpError(423), 'locked'],
    ['409 concurrent writer', httpError(409), 'conflict'],
    ['404 PRF not on the server yet', httpError(404), 'queue'],
    ['500 backend error', httpError(500), 'queue'],
    ['502 gateway', httpError(502), 'queue'],
    ['504 timeout', httpError(504), 'queue'],
    ['network error (no response)', Object.assign(new Error('net'), { code: 'ERR_NETWORK' }), 'queue'],
    ['request aborted', Object.assign(new Error('abort'), { code: 'ECONNABORTED' }), 'queue'],
    ['a thrown non-error', 'something odd', 'queue'],
    ['undefined', undefined, 'queue'],
  ];

  for (const [label, err, expected] of CASES) {
    it(`${label} -> ${expected}`, () => {
      expect(classifySaveError(err)).toBe(expected);
    });
  }

  // ── The regression this module exists for ────────────────────────────────
  it('QUEUES an unknown server error instead of discarding the crew\'s work', () => {
    // A 500 during a backend restart used to fall into a branch that only set
    // an error flag. The retry it relied on required the crew to stay on the
    // screen; navigating away lost the record, with nothing queued and nothing
    // said. Regressing this would return 'error'/'drop' rather than 'queue'.
    expect(classifySaveError(httpError(500))).toBe('queue');
    expect(classifySaveError(httpError(503))).toBe('queue');
  });

  it('only a submitted (locked) PRF is allowed to stop preserving work', () => {
    const outcomes: SaveErrorAction[] = ['session-expired', 'conflict', 'queue'];
    for (const a of outcomes) expect(preservesWork(a), a).toBe(true);
    // 423 means the record is already safely on the server as a billing record.
    expect(preservesWork('locked')).toBe(false);
  });

  it('never invents an outcome outside the four known ones', () => {
    const known = ['session-expired', 'locked', 'conflict', 'queue'];
    for (const s of [400, 401, 403, 404, 409, 418, 422, 423, 429, 500, 502, 503, 504]) {
      expect(known).toContain(classifySaveError(httpError(s)));
    }
  });
});

describe('a payload that is too large is terminal, not retryable', () => {
  it('classifies 413 as too-large rather than queue', () => {
    // Everything unrecognised falls through to 'queue', which is right for a
    // network blip and wrong here: the request is too big and will be exactly
    // as big next time. It retried five times, was marked dead, and the crew's
    // PRF sat permanently unsent with no explanation.
    const err = { response: { status: 413 } };
    expect(classifySaveError(err, { online: true })).toBe('too-large');
  });

  it('still preserves the work', () => {
    expect(preservesWork('too-large' as any)).toBe(true);
  });

  it('gives the crew something they can act on', () => {
    const msg = saveErrorMessage('too-large' as any);
    expect(msg).toBeTruthy();
    expect(msg!.toLowerCase()).toMatch(/photo|attachment|document/);
  });

  it('says nothing for failures that retry on their own', () => {
    // Interrupting a crew mid-call for something the app will fix itself is the
    // behaviour this codebase deliberately avoids.
    expect(saveErrorMessage('queue' as any)).toBeNull();
    expect(saveErrorMessage('conflict' as any)).toBeNull();
  });
});
