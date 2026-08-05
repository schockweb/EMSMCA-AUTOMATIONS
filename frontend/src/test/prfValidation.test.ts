/**
 * Unit tests: PRF Validation Rules (prfValidation.ts)
 *
 * These are pure-function tests — no DOM, no React, no network.
 * They run in milliseconds and verify the medical billing rules that
 * drive in-form validation and claim adjudication.
 */
import { describe, it, expect } from 'vitest';
import {
  RULES,
  buildContext,
  blockers,
  warnings,
  validatePhase,
  type PrfData,
  type ValidationContext,
} from '../pages/crew/prfValidation';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal passing context */
function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    vitalsCount: 3,
    ivCount: 0,
    medCount: 0,
    medTypesLower: '',
    hasCrew2: true,
    hasPatientSig: true,
    hasCrewSig: true,
    hasHandoverSig: true,
    sceneMinutes: null,
    totalCallMinutes: null,
    patientCarryingKm: null,
    ...overrides,
  };
}

/** Evaluate a single rule by ID and return whether it passes */
function evalRule(ruleId: string, data: PrfData, context: ValidationContext = ctx()): boolean {
  const rule = RULES.find(r => r.id === ruleId);
  if (!rule) throw new Error(`Rule not found: ${ruleId}`);
  return rule.check(data, context);
}

// ══════════════════════════════════════════════════════════════════════════════
// IFT Pre-authorisation (NTC-3.2-IFT-PREAUTH)
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-3.2-IFT-PREAUTH — IFT requires 13-digit pre-auth number', () => {
  it('passes for a non-IFT call with no preauth', () => {
    expect(evalRule('NTC-3.2-IFT-PREAUTH', { dispatch_type: 'Primary' })).toBe(true);
  });

  it('passes for IFT with a valid 13-digit preauth', () => {
    expect(
      evalRule('NTC-3.2-IFT-PREAUTH', {
        dispatch_type: 'IFT',
        preauth_number: '1234567890123',
      }),
    ).toBe(true);
  });

  it('fails for IFT with missing preauth', () => {
    expect(evalRule('NTC-3.2-IFT-PREAUTH', { dispatch_type: 'IFT' })).toBe(false);
  });

  it('fails for IFT with a partial preauth (only 7 digits)', () => {
    expect(
      evalRule('NTC-3.2-IFT-PREAUTH', {
        dispatch_type: 'IFT',
        preauth_number: '1234567',
      }),
    ).toBe(false);
  });

  it('also recognises IHT as requiring preauth', () => {
    expect(evalRule('NTC-3.2-IFT-PREAUTH', { call_type: 'IHT' })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Patient Identity (NTC-3.7-PATIENT-ID)
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-3.7-PATIENT-ID — valid SA ID or passport', () => {
  it('passes a standard 13-digit SA ID', () => {
    expect(evalRule('NTC-3.7-PATIENT-ID', { patient_id_number: '9001015009087' })).toBe(true);
  });

  it('passes a passport number (6-15 alphanumeric)', () => {
    expect(evalRule('NTC-3.7-PATIENT-ID', { patient_id_number: 'AB123456' })).toBe(true);
  });

  it('fails when patient ID is empty', () => {
    expect(evalRule('NTC-3.7-PATIENT-ID', { patient_id_number: '' })).toBe(false);
  });

  it('passes 12 digits — accepted as a valid numeric passport/foreign ID (6-15 char fallback)', () => {
    // The rule accepts any alphanumeric string 6-15 chars as a passport fallback.
    // A 12-digit number satisfies that regex. Only 13 digits triggers the strict SA-ID path.
    expect(evalRule('NTC-3.7-PATIENT-ID', { patient_id_number: '123456789012' })).toBe(true);
  });

  it('fails for a 3-character value (too short for passport fallback)', () => {
    expect(evalRule('NTC-3.7-PATIENT-ID', { patient_id_number: 'ABC' })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ICD-10 Format (NTC-4-ICD10-PRIMARY)
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-4-ICD10-PRIMARY — standard ICD-10 format', () => {
  it('passes a simple code like I21', () => {
    expect(evalRule('NTC-4-ICD10-PRIMARY', { icd10_primary: 'I21' })).toBe(true);
  });

  it('passes a code with decimal like I21.0', () => {
    expect(evalRule('NTC-4-ICD10-PRIMARY', { icd10_primary: 'I21.0' })).toBe(true);
  });

  it('passes a code with multi-digit decimal like S72.001', () => {
    expect(evalRule('NTC-4-ICD10-PRIMARY', { icd10_primary: 'S72.001' })).toBe(true);
  });

  it('fails when empty', () => {
    expect(evalRule('NTC-4-ICD10-PRIMARY', { icd10_primary: '' })).toBe(false);
  });

  it('fails for a free-text description instead of code', () => {
    expect(evalRule('NTC-4-ICD10-PRIMARY', { icd10_primary: 'Heart attack' })).toBe(false);
  });

  it('fails for a code missing the leading letter', () => {
    expect(evalRule('NTC-4-ICD10-PRIMARY', { icd10_primary: '21.0' })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Primary Diagnosis (NTC-3.7-PRIMARY-DIAGNOSIS)
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-3.7-PRIMARY-DIAGNOSIS — primary diagnosis must end with a question mark', () => {
  it('passes when diagnosis is present and ends with a question mark', () => {
    expect(evalRule('NTC-3.7-PRIMARY-DIAGNOSIS', { primary_diagnosis: 'Suspected appendicitis?' })).toBe(true);
  });

  it('fails when diagnosis does not end with a question mark', () => {
    expect(evalRule('NTC-3.7-PRIMARY-DIAGNOSIS', { primary_diagnosis: 'Suspected appendicitis' })).toBe(false);
  });

  it('fails when diagnosis is empty', () => {
    expect(evalRule('NTC-3.7-PRIMARY-DIAGNOSIS', { primary_diagnosis: '' })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Minimum Vitals (NTC-3.7-MIN-3-VITALS)
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-3.7-MIN-3-VITALS — at least 3 vitals sets required', () => {
  it('passes with exactly 3 vitals', () => {
    expect(evalRule('NTC-3.7-MIN-3-VITALS', {}, ctx({ vitalsCount: 3 }))).toBe(true);
  });

  it('passes with more than 3 vitals', () => {
    expect(evalRule('NTC-3.7-MIN-3-VITALS', {}, ctx({ vitalsCount: 5 }))).toBe(true);
  });

  it('fails with only 2 vitals', () => {
    expect(evalRule('NTC-3.7-MIN-3-VITALS', {}, ctx({ vitalsCount: 2 }))).toBe(false);
  });

  it('fails with 0 vitals', () => {
    expect(evalRule('NTC-3.7-MIN-3-VITALS', {}, ctx({ vitalsCount: 0 }))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Resuscitation Fee Criteria (NTC-3.5-RESUS-CRITERIA)
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-3.5-RESUS-CRITERIA — strict resus fee requirements', () => {
  const validResusData: PrfData = {
    resuscitation_attempted: true,
    second_vehicle_present: true,
    assessment_level: 'ALS',
    circulation_interventions: ['Cardio Version'],
    airway_interventions: [],
    medications: [],
  };

  it('passes when all three criteria are met (ALS + second vehicle + ALS intervention)', () => {
    expect(evalRule('NTC-3.5-RESUS-CRITERIA', validResusData)).toBe(true);
  });

  it('passes when resuscitation was not attempted (rule is irrelevant)', () => {
    expect(evalRule('NTC-3.5-RESUS-CRITERIA', { resuscitation_attempted: false })).toBe(true);
  });

  it('fails without a second vehicle', () => {
    expect(
      evalRule('NTC-3.5-RESUS-CRITERIA', { ...validResusData, second_vehicle_present: false }),
    ).toBe(false);
  });

  it('fails when crew is ILS not ALS', () => {
    expect(
      evalRule('NTC-3.5-RESUS-CRITERIA', { ...validResusData, assessment_level: 'ILS' }),
    ).toBe(false);
  });

  it('fails with no ALS intervention performed', () => {
    expect(
      evalRule('NTC-3.5-RESUS-CRITERIA', {
        ...validResusData,
        circulation_interventions: [],
        airway_interventions: [],
        medications: [],
      }),
    ).toBe(false);
  });

  it('passes with adrenaline as the ALS intervention', () => {
    expect(
      evalRule('NTC-3.5-RESUS-CRITERIA', {
        ...validResusData,
        circulation_interventions: [],
        medications: [{ type: 'Adrenaline', dose: '1mg' }],
      }),
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scene Time Warning (NTC-5.2-SCENE-TIME-WARN)
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-5.2-SCENE-TIME-WARN — scene time over 20 minutes', () => {
  const base = new Date('2026-05-23T10:00:00Z').getTime();

  it('passes when scene time is exactly 20 minutes', () => {
    expect(
      evalRule('NTC-5.2-SCENE-TIME-WARN', {
        time_on_scene: new Date(base).toISOString(),
        time_depart_scene: new Date(base + 20 * 60 * 1000).toISOString(),
      }),
    ).toBe(true);
  });

  it('warns when scene time exceeds 20 minutes (returns false = rule fires)', () => {
    expect(
      evalRule('NTC-5.2-SCENE-TIME-WARN', {
        time_on_scene: new Date(base).toISOString(),
        time_depart_scene: new Date(base + 25 * 60 * 1000).toISOString(),
      }),
    ).toBe(false);
  });

  it('passes when timestamps are missing', () => {
    expect(evalRule('NTC-5.2-SCENE-TIME-WARN', {})).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// buildContext helper
// ══════════════════════════════════════════════════════════════════════════════
describe('buildContext — builds correct validation context', () => {
  it('counts vitals with a time field only', () => {
    const result = buildContext({
      vitals: [{ time: '10:00', hr: 70 }, { time: '', hr: 80 }, { time: '10:20', hr: 75 }],
      ivRows: [],
      medRows: [],
      sigs: {},
      crew2Id: '',
      prfMeta: null,
    });
    expect(result.vitalsCount).toBe(2); // only rows with a time count
  });

  it('detects crew2 from crew2Id prop', () => {
    const result = buildContext({
      vitals: [],
      ivRows: [],
      medRows: [],
      sigs: {},
      crew2Id: 'some-uuid',
      prfMeta: null,
    });
    expect(result.hasCrew2).toBe(true);
  });

  it('detects patient signature', () => {
    const result = buildContext({
      vitals: [],
      ivRows: [],
      medRows: [],
      sigs: { patient_signature: 'data:image/png;base64,...' },
      crew2Id: '',
      prfMeta: null,
    });
    expect(result.hasPatientSig).toBe(true);
  });

  it('returns false for hasPatientSig when signature is empty', () => {
    const result = buildContext({
      vitals: [],
      ivRows: [],
      medRows: [],
      sigs: { patient_signature: '' },
      crew2Id: '',
      prfMeta: null,
    });
    expect(result.hasPatientSig).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// blockers / warnings filter helpers
// ══════════════════════════════════════════════════════════════════════════════
describe('blockers() and warnings() filter functions', () => {
  const findings = [
    { id: 'A', severity: 'block' as const, message: 'Block A', source: '' },
    { id: 'B', severity: 'warn' as const, message: 'Warn B', source: '' },
    { id: 'C', severity: 'block' as const, message: 'Block C', source: '' },
  ];

  it('blockers() returns only block-severity findings', () => {
    expect(blockers(findings)).toHaveLength(2);
    expect(blockers(findings).every(f => f.severity === 'block')).toBe(true);
  });

  it('warnings() returns only warn-severity findings', () => {
    expect(warnings(findings)).toHaveLength(1);
    expect(warnings(findings)[0].id).toBe('B');
  });

  it('both return empty arrays for empty input', () => {
    expect(blockers([])).toHaveLength(0);
    expect(warnings([])).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// validatePhase — Discovery warn-only surfacing
// ══════════════════════════════════════════════════════════════════════════════
describe('validatePhase — unknown scheme silent, known schemes surface', () => {
  // Scheme-scoped rule IDs are prefixed by scheme; the scheme-agnostic
  // completeness rules added 2026-08-05 are prefixed ALL-.
  const isSchemeScoped = (id: string) => !id.startsWith('ALL-');

  it('surfaces NO scheme-scoped rule when no scheme is supplied', () => {
    const findings = validatePhase(6, { icd10_primary: 'INVALID' }, ctx());
    expect(findings.filter(f => isSchemeScoped(f.id))).toEqual([]);
  });

  it('surfaces NO scheme-scoped rule for an unrecognised scheme name', () => {
    const findings = validatePhase(6, { icd10_primary: 'INVALID' }, ctx(), 'Some Unknown Scheme');
    expect(findings.filter(f => isSchemeScoped(f.id))).toEqual([]);
  });

  it('still says nothing at all during the phases a crew is treating a patient', () => {
    // Phases 0-4 carry no completeness rules by design — the banner must stay
    // off the screen while the crew is working the call.
    for (const phase of [0, 1, 2, 3, 4] as const) {
      expect(validatePhase(phase, {}, ctx({ vitalsCount: 0 }))).toEqual([]);
    }
  });

  it('DOES surface scheme-agnostic completeness rules with no scheme set', () => {
    // This is the point of the ALL- rules: an unsigned PRF with no destination
    // is worth a nudge whether or not a medical aid is involved.
    const findings = validatePhase(6, {}, ctx({ hasCrewSig: false }));
    expect(findings.some(f => f.id === 'ALL-A4-CREW-SIG')).toBe(true);
    expect(findings.every(f => f.severity === 'warn')).toBe(true);
    expect(blockers(findings)).toHaveLength(0);
  });
});

describe('validatePhase — Discovery rules surface as non-blocking warnings only', () => {
  const DISCOVERY = 'Discovery Health Medical Scheme';

  it('every finding for a Discovery claim is a warning (never a blocker)', () => {
    // A claim that trips several rules: ALS billed with no ALS treatment, no member no.
    const data: PrfData = {
      assessment_level: 'ALS', billing_type: 'Med Aid', receiving_facility: 'Test Hosp',
    };
    const findings = validatePhase(6, data, ctx({ vitalsCount: 0 }), DISCOVERY);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(f => f.severity === 'warn')).toBe(true);
    expect(blockers(findings)).toHaveLength(0);
  });

  it('warns when member number is missing on a med-aid claim', () => {
    const findings = validatePhase(6, { billing_type: 'Med Aid' }, ctx(), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-MEMBER-NUMBER')).toBe(true);
  });

  it('does NOT warn about member number when it is present', () => {
    const findings = validatePhase(6, { billing_type: 'Med Aid', medical_aid_number: 'MA123' }, ctx(), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-MEMBER-NUMBER')).toBe(false);
  });

  it('warns when an IFT over 100 km has no pre-auth number', () => {
    const findings = validatePhase(6, { call_type: 'IFT' }, ctx({ patientCarryingKm: 140 }), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-IFT-100KM-PREAUTH')).toBe(true);
  });

  it('does NOT warn about pre-auth when the IFT is under 100 km', () => {
    const findings = validatePhase(6, { call_type: 'IFT' }, ctx({ patientCarryingKm: 40 }), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-IFT-100KM-PREAUTH')).toBe(false);
  });

  it('warns when ALS is billed with no ALS treatment or motivation', () => {
    const findings = validatePhase(3, { assessment_level: 'ALS' }, ctx(), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-ALS-INDICATION')).toBe(true);
  });

  it('clears the ALS warning when an ALS drug is recorded', () => {
    const findings = validatePhase(3, { assessment_level: 'ALS' }, ctx({ medTypesLower: 'morphine' }), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-ALS-INDICATION')).toBe(false);
  });

  it('warns when scene time exceeds 20 minutes with no motivation', () => {
    const findings = validatePhase(6, {}, ctx({ sceneMinutes: 35 }), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-SCENE-TIME-20')).toBe(true);
  });

  it('clears the scene-time warning when a motivation is documented', () => {
    const findings = validatePhase(6, { management_notes: 'Prolonged extrication by fire dept' }, ctx({ sceneMinutes: 35 }), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-SCENE-TIME-20')).toBe(false);
  });

  it('warns when a transport has no documented clinical need', () => {
    const findings = validatePhase(6, { receiving_facility: 'Test Hosp' }, ctx({ vitalsCount: 0, medCount: 0, ivCount: 0 }), DISCOVERY);
    expect(findings.some(f => f.id === 'DISC-NO-CLINICAL-NEED')).toBe(true);
  });
});


// ============================================================================
// validatePhase - GEMS surfacing (warn-only)
// ============================================================================
describe('validatePhase - GEMS rules surface as non-blocking warnings', () => {
  const GEMS = 'GEMS';

  it('every GEMS finding is a warning, never a blocker', () => {
    const f = validatePhase(6, { billing_type: 'Med Aid', call_type: 'IFT' }, ctx({ vitalsCount: 0 }), GEMS);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every(x => x.severity === 'warn')).toBe(true);
    expect(blockers(f)).toHaveLength(0);
  });

  it('warns when the member number is missing on a med-aid claim', () => {
    expect(validatePhase(6, { billing_type: 'Med Aid' }, ctx(), GEMS).some(x => x.id === 'GEMS-MEMBER-NUMBER')).toBe(true);
  });

  it('rejects a Z external-cause code but accepts W01.01', () => {
    expect(validatePhase(3, { icd10_external_cause: 'Z01.1' }, ctx(), GEMS).some(x => x.id === 'GEMS-EXT-CAUSE-FORMAT')).toBe(true);
    expect(validatePhase(3, { icd10_external_cause: 'W01.01' }, ctx(), GEMS).some(x => x.id === 'GEMS-EXT-CAUSE-FORMAT')).toBe(false);
  });

  it('warns below 2 vitals and clears at 2', () => {
    expect(validatePhase(6, {}, ctx({ vitalsCount: 1 }), GEMS).some(x => x.id === 'GEMS-MIN-2-VITALS')).toBe(true);
    expect(validatePhase(6, {}, ctx({ vitalsCount: 2 }), GEMS).some(x => x.id === 'GEMS-MIN-2-VITALS')).toBe(false);
  });

  it('warns when an IFT has no pre-authorisation reference', () => {
    expect(validatePhase(6, { call_type: 'IFT' }, ctx(), GEMS).some(x => x.id === 'GEMS-IFT-PREAUTH')).toBe(true);
  });
});

// ============================================================================
// validatePhase - ER24 surfacing (warn-only)
// ============================================================================
describe('validatePhase - ER24 rules surface as non-blocking warnings', () => {
  const ER24 = 'ER24';

  it('every ER24 finding is a warning, never a blocker', () => {
    const f = validatePhase(6, { billing_type: 'Med Aid', call_type: 'IFT' }, ctx({ vitalsCount: 0 }), ER24);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every(x => x.severity === 'warn')).toBe(true);
    expect(blockers(f)).toHaveLength(0);
  });

  it('IFT requires 3 vitals (warns at 2, clears at 3)', () => {
    expect(validatePhase(5, { call_type: 'IFT' }, ctx({ vitalsCount: 2 }), ER24).some(x => x.id === 'ER24-MIN-VITALS')).toBe(true);
    expect(validatePhase(5, { call_type: 'IFT' }, ctx({ vitalsCount: 3 }), ER24).some(x => x.id === 'ER24-MIN-VITALS')).toBe(false);
  });

  it('warns when the diagnosis ICD-10 is missing or invalid', () => {
    expect(validatePhase(3, { icd10_primary: 'heart attack' }, ctx(), ER24).some(x => x.id === 'ER24-DIAGNOSIS')).toBe(true);
    expect(validatePhase(3, { icd10_primary: 'I21.0' }, ctx(), ER24).some(x => x.id === 'ER24-DIAGNOSIS')).toBe(false);
  });
});

// ============================================================================
// validatePhase - Netcare now surfaces (previously deliberately suppressed)
// ============================================================================
describe('validatePhase - Netcare rules surface as non-blocking warnings', () => {
  const NETCARE = 'Netcare 911';

  it('Netcare surfaces findings, all warn-only', () => {
    const f = validatePhase(6, { billing_type: 'Med Aid', call_type: 'IFT' }, ctx({ vitalsCount: 0, hasPatientSig: false }), NETCARE);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every(x => x.severity === 'warn')).toBe(true);
    expect(blockers(f)).toHaveLength(0);
  });

  it('warns when an IFT has no 13-digit pre-auth, clears with one', () => {
    expect(validatePhase(6, { call_type: 'IFT' }, ctx(), NETCARE).some(x => x.id === 'NTC-3.2-IFT-PREAUTH')).toBe(true);
    expect(validatePhase(6, { call_type: 'IFT', preauth_number: '1234567890123' }, ctx(), NETCARE).some(x => x.id === 'NTC-3.2-IFT-PREAUTH')).toBe(false);
  });

  it('does not leak Netcare findings into a Discovery claim', () => {
    const f = validatePhase(6, { call_type: 'IFT' }, ctx(), 'Discovery Health Medical Scheme');
    // Scheme-scoped findings must all be Discovery's. Scheme-agnostic ALL-
    // completeness rules legitimately appear alongside them.
    expect(f.filter(x => !x.id.startsWith('ALL-')).every(x => x.id.startsWith('DISC-'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scheme-agnostic completeness rules (ALL-*) — added 2026-08-05
//
// Evaluated with NO scheme so only the ALL- rules fire, which keeps each
// assertion isolated from scheme billing rules.
// ══════════════════════════════════════════════════════════════════════════════
describe('ALL-* completeness rules', () => {
  const fire = (data: PrfData, c: Partial<ValidationContext> = {}, phase: 5 | 6 = 6) =>
    validatePhase(phase, data, ctx(c)).map(f => f.id);

  // ── Global safety properties ──
  it('every completeness finding is a non-blocking warning', () => {
    const findings = validatePhase(6, {}, ctx({ hasPatientSig: false, hasCrewSig: false, hasHandoverSig: false }));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(f => f.severity === 'warn')).toBe(true);
    expect(blockers(findings)).toHaveLength(0);
  });

  it('never fires during the treating phases (0-4)', () => {
    const messy: PrfData = {
      billing_type: 'MED AID', call_type: 'PRIMARY',
      vitals_sets: [{ hr: '1200', spo2: '140' }],
      circulation_interventions: ['CPR'],
    };
    for (const phase of [0, 1, 2, 3, 4] as const) {
      const ids = validatePhase(phase, messy, ctx({ hasPatientSig: false, hasCrewSig: false })).map(f => f.id);
      expect(ids.filter(id => id.startsWith('ALL-'))).toEqual([]);
    }
  });

  // ── A. Completeness ──
  it('A1 warns on a med-aid claim with no scheme or member number', () => {
    expect(fire({ billing_type: 'MED AID' })).toContain('ALL-A1-SCHEME-DETAILS');
    expect(fire({ billing_type: 'MED AID', medical_scheme: 'GEMS', medical_aid_number: 'M123' }))
      .not.toContain('ALL-A1-SCHEME-DETAILS');
    // main_member_id is an accepted alternative to medical_aid_number
    expect(fire({ billing_type: 'MED AID', medical_scheme: 'GEMS', main_member_id: 'X1' }))
      .not.toContain('ALL-A1-SCHEME-DETAILS');
    // Not a scheme claim → not this rule's business
    expect(fire({ billing_type: 'PVT' })).not.toContain('ALL-A1-SCHEME-DETAILS');
  });

  it('A2 accepts a recorded refusal instead of a signature', () => {
    expect(fire({}, { hasPatientSig: false })).toContain('ALL-A2-PATIENT-SIG');
    expect(fire({ signature_refused_reason: 'Patient unconscious' }, { hasPatientSig: false }))
      .not.toContain('ALL-A2-PATIENT-SIG');
  });

  it('A3 asks for a handover signature only when a patient was transported', () => {
    expect(fire({ call_type: 'PRIMARY' }, { hasHandoverSig: false })).toContain('ALL-A3-HANDOVER-SIG');
    expect(fire({ call_type: 'RHT' }, { hasHandoverSig: false })).not.toContain('ALL-A3-HANDOVER-SIG');
    expect(fire({ call_type: 'DOD' }, { hasHandoverSig: false })).not.toContain('ALL-A3-HANDOVER-SIG');
  });

  it('A3 and A5 are available at handover, where they can still be fixed', () => {
    const ids = fire({ call_type: 'PRIMARY' }, { hasHandoverSig: false }, 5);
    expect(ids).toContain('ALL-A3-HANDOVER-SIG');
    expect(ids).toContain('ALL-A5-DESTINATION');
  });

  it('A4 warns on a missing crew signature', () => {
    expect(fire({}, { hasCrewSig: false })).toContain('ALL-A4-CREW-SIG');
    expect(fire({}, { hasCrewSig: true })).not.toContain('ALL-A4-CREW-SIG');
  });

  it('A5 warns on a transported patient with no destination', () => {
    expect(fire({ call_type: 'PRIMARY' })).toContain('ALL-A5-DESTINATION');
    expect(fire({ call_type: 'PRIMARY', receiving_facility: 'Milpark' })).not.toContain('ALL-A5-DESTINATION');
    expect(fire({ call_type: 'DOD' })).not.toContain('ALL-A5-DESTINATION');
  });

  it('A6 warns when surname or ID is missing', () => {
    expect(fire({})).toContain('ALL-A6-PATIENT-IDENTITY');
    expect(fire({ patient_surname: 'Dlamini' })).toContain('ALL-A6-PATIENT-IDENTITY');
    expect(fire({ patient_surname: 'Dlamini', patient_id_number: '8001015009087' }))
      .not.toContain('ALL-A6-PATIENT-IDENTITY');
  });

  // ── C. Plausibility — must catch typos WITHOUT firing on sick patients ──
  it('C1 flags an impossible pulse but stays silent on a real tachycardia', () => {
    expect(fire({ vitals_sets: [{ hr: '1200' }] })).toContain('ALL-C1-HR-RANGE');
    expect(fire({ vitals_sets: [{ hr: '280' }] })).not.toContain('ALL-C1-HR-RANGE');   // infant SVT is real
    expect(fire({ vitals_sets: [{ hr: '38' }] })).not.toContain('ALL-C1-HR-RANGE');    // bradycardia is real
  });

  it('C2 flags an impossible respiratory rate but not a neonatal one', () => {
    expect(fire({ vitals_sets: [{ resp_rate: '160' }] })).toContain('ALL-C2-RR-RANGE');
    expect(fire({ vitals_sets: [{ resp_rate: '55' }] })).not.toContain('ALL-C2-RR-RANGE'); // neonate
  });

  it('says NOTHING about an arrest patient recorded as 0/0 — the key false positive', () => {
    // A pulse and respiratory rate of zero is the correct record for a patient
    // in cardiac arrest. Warning here would fire on every resuscitation.
    const ids = fire({
      call_type: 'RESUS',
      circulation_interventions: ['CPR'],
      vitals_sets: [{ hr: '0', resp_rate: '0', spo2: '0' }],
    });
    expect(ids.filter(id => id.startsWith('ALL-C'))).toEqual([]);
    expect(ids).not.toContain('ALL-D2-CPR-CALL-TYPE');   // RESUS is the right call type
  });

  it('C3 flags a saturation above 100%', () => {
    expect(fire({ vitals_sets: [{ spo2: '101' }] })).toContain('ALL-C3-SPO2-RANGE');
    expect(fire({ vitals_sets: [{ spo2: '88' }] })).not.toContain('ALL-C3-SPO2-RANGE');
  });

  it('C4 flags an impossible temperature but not a real fever or hypothermia', () => {
    expect(fire({ vitals_sets: [{ temp: '400' }] })).toContain('ALL-C4-TEMP-RANGE');
    expect(fire({ vitals_sets: [{ temp: '41.5' }] })).not.toContain('ALL-C4-TEMP-RANGE');
    expect(fire({ vitals_sets: [{ temp: '28' }] })).not.toContain('ALL-C4-TEMP-RANGE');
  });

  it('C rules stay silent on blank or unparseable readings', () => {
    const ids = fire({ vitals_sets: [{ hr: '', spo2: null, temp: 'see chart', resp_rate: undefined }] });
    expect(ids.filter(id => id.startsWith('ALL-C'))).toEqual([]);
  });

  // ── D. Consistency ──
  it('D1 flags a time recorded before arrival on scene', () => {
    expect(fire({
      time_on_scene: '2026-08-05T14:00:00',
      medications: [{ type: 'Morphine', time: '13:30' }],
    })).toContain('ALL-D1-TIME-BEFORE-SCENE');
  });

  it('D1 does NOT fire on a call that runs past midnight', () => {
    // On scene 23:50, observation at 00:10 the next day — legitimate, and the
    // single most likely false positive for this rule.
    expect(fire({
      time_on_scene: '2026-08-05T23:50:00',
      vitals_sets: [{ time: '00:10' }],
    })).not.toContain('ALL-D1-TIME-BEFORE-SCENE');
  });

  it('D1 stays silent without a usable scene time, and tolerates clock jitter', () => {
    expect(fire({ medications: [{ time: '10:00' }] })).not.toContain('ALL-D1-TIME-BEFORE-SCENE');
    expect(fire({
      time_on_scene: '2026-08-05T14:00:00',
      vitals_sets: [{ time: '13:58' }],           // 2 min — jitter, not a typo
    })).not.toContain('ALL-D1-TIME-BEFORE-SCENE');
  });

  it('D2 flags CPR recorded against a routine call type', () => {
    expect(fire({ circulation_interventions: ['CPR'], call_type: 'PRIMARY' }))
      .toContain('ALL-D2-CPR-CALL-TYPE');
    expect(fire({ circulation_interventions: ['CPR'], call_type: 'RESUS' }))
      .not.toContain('ALL-D2-CPR-CALL-TYPE');
    expect(fire({ circulation_interventions: ['Periph. IV Line'], call_type: 'PRIMARY' }))
      .not.toContain('ALL-D2-CPR-CALL-TYPE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Removed rules
// ══════════════════════════════════════════════════════════════════════════════
describe('NTC-3.7-PATIENT-WEIGHT is gone', () => {
  it('is no longer registered (the form has no weight input, so it was unsatisfiable)', () => {
    expect(RULES.some(r => r.id === 'NTC-3.7-PATIENT-WEIGHT')).toBe(false);
  });

  it('a Netcare claim with medications and no weight raises no weight warning', () => {
    const findings = validatePhase(
      6,
      { call_type: 'PRIMARY', medications: [{ type: 'Morphine' }] },
      ctx({ medCount: 1, medTypesLower: 'morphine' }),
      'Netcare 911',
    );
    expect(findings.some(f => f.field === 'patient_weight_kg')).toBe(false);
  });
});
