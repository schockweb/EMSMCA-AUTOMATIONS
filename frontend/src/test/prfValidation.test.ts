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
    hasCrew2: true,
    hasPatientSig: true,
    hasCrewSig: true,
    hasHandoverSig: true,
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
// validatePhase — live-rollout short-circuit
// ══════════════════════════════════════════════════════════════════════════════
describe('validatePhase — returns empty array (disabled for live rollout)', () => {
  it('always returns [] regardless of phase or data', () => {
    expect(validatePhase(6, { icd10_primary: 'INVALID' }, ctx())).toEqual([]);
    expect(validatePhase(0, {}, ctx({ vitalsCount: 0 }))).toEqual([]);
  });
});
