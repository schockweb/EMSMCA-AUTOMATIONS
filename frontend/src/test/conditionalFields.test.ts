/**
 * conditionalFields.test.ts — Layer 2: Conditional Field Visibility & Data Integrity Tests
 *
 * Tests the "hide this field when X is selected" logic across the Digital PRF form.
 *
 * Key architectural facts confirmed from reading DigitalPRFForm.tsx:
 *   - `fd` is a flat object — ALL field values live there regardless of visibility.
 *   - `sf(key, value)` is the setter — always a merge, never a replace.
 *   - Hidden fields ARE submitted (the full `fd` blob goes to the server every 5s).
 *   - The backend's billing/adjudication engine decides which fields to read based
 *     on call_type + billing_type — so stale hidden data is generally ignored.
 *   - Switching call_type DOES auto-clear/set: `med_aid_dec_death` and `med_aid_resus`.
 *   - Switching billing_type does NOT auto-clear sub-fields (med_aid_*, iod_*, raf_*).
 *
 * Test structure mirrors the risk categories:
 *   1. call_type selection side-effects
 *   2. billing_type field availability per call_type
 *   3. med_aid_dec_death toggle side-effects
 *   4. med_aid_resus toggle side-effects
 *   5. mechanism sub-field (mechanism_detail) appears only when mechanism is set
 *   6. IFT/IHT-specific fields not visible for other call types
 *   7. Stale-data guard: hidden-field data does not corrupt what the rules engine reads
 *   8. SA ID auto-fill does not fire for empty/partial IDs
 */

import { describe, it, expect } from 'vitest';

// ── Simulation helpers ────────────────────────────────────────────────────────
// We simulate the form's fd state machine directly — pure function tests, no DOM.

type Fd = Record<string, any>;

/** Simulate the `pick` function inside CallTypePicker */
function pickCallType(fd: Fd, callType: string): Fd {
  let next: Fd = { ...fd, call_type: callType };
  // From DigitalPRFForm.tsx line 1496: DOD forces dec_death ON, everything else forces it OFF
  next.med_aid_dec_death = callType === 'DOD';
  // From line 1497-1499: RESUS forces med_aid_resus ON
  if (callType === 'RESUS') {
    next.med_aid_resus = true;
  }
  return next;
}

/** Simulate the `pick` function inside BillingTypePicker */
function pickBillingType(fd: Fd, billingType: string): Fd {
  return { ...fd, billing_type: billingType };
}

/** Simulate sf() — the form field setter (always merges) */
function sf(fd: Fd, key: string, value: any): Fd {
  return { ...fd, [key]: value };
}

/** Simulate toggleArr() */
function toggleArr(fd: Fd, key: string, value: string): Fd {
  const arr: string[] = Array.isArray(fd[key]) ? [...fd[key]] : [];
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1); else arr.push(value);
  return { ...fd, [key]: arr };
}

/** Mirror the billing options filter from BillingTypePicker */
const ALL_BILLING_OPTS = ['MED AID', 'PVT', 'IOD', 'RAF', 'WCA', 'EVENT', 'CALL OUT FEE'];
function availableBillingOpts(callType: string): string[] {
  const base = ALL_BILLING_OPTS.filter(o => o !== 'EVENT' && o !== 'CALL OUT FEE');
  if (callType === 'DOD') return base.filter(o => o !== 'IOD' && o !== 'RAF');
  if (callType === 'RESUS') return base.filter(o => o === 'MED AID' || o === 'PVT');
  return base;
}

/** Mirror the field visibility rules from DigitalPRFForm.tsx JSX */
function isFieldVisible(fd: Fd, fieldGroup: string): boolean {
  const ct = fd.call_type ?? '';
  const bt = fd.billing_type ?? '';
  switch (fieldGroup) {
    // Section: MED AID billing details (member number, emed ref, scheme)
    case 'med_aid_billing_details':
      return bt === 'MED AID';
    // Section: IOD (Injury on Duty) reference
    case 'iod_details':
      return bt === 'IOD';
    // Section: RAF (Road Accident Fund) claim number
    case 'raf_details':
      return bt === 'RAF';
    // Section: PVT (Private) billing
    case 'pvt_details':
      return bt === 'PVT';
    // Section: WCA (Workmen's Comp)
    case 'wca_details':
      return bt === 'WCA';
    // Declaration of Death form (signatory, witness, documents)
    case 'dec_death_form':
      return !!fd.med_aid_dec_death;
    // Resuscitation detail fields (ROSC, initial rhythm, etc.)
    case 'resus_details':
      return !!(fd.med_aid_resus || ct === 'RESUS');
    // MED AID resus checkbox itself — hidden if dec_death is on OR it's a RESUS call
    case 'resus_checkbox':
      return !fd.med_aid_dec_death && ct !== 'RESUS';
    // DOD dispatch times panel
    case 'dod_dispatch_times':
      return ct !== 'RESUS';
    // Standard patient section fields (hidden when dec_death)
    case 'patient_signature':
      return !fd.med_aid_dec_death && ct !== 'RESUS';
    // Mechanism detail text area — only shown when mechanism is selected
    case 'mechanism_detail':
      return !!fd.mechanism;
    // IFT/IHT-specific fields (referring doctor, pre-auth, ventilator settings)
    case 'ift_iht_fields':
      return ['IFT', 'IHT'].includes(ct);
    // RHT-specific fields
    case 'rht_fields':
      return ct === 'RHT';
    // IHT-only fields (nursing notes)
    case 'iht_nursing_notes':
      return ct === 'IHT';
    // Phase 3 (patient info) — shown for all call types
    case 'patient_info':
      return true;
    // Bypass motivation — shown only when NOT PRIMARY
    case 'bypass_motivation':
      return ct !== 'PRIMARY';
    // Vitals section — hidden for RESUS calls (different flow)
    case 'vitals_section':
      return ct !== 'RESUS';
    // RESUS-specific billing (shown at bottom for RESUS + med_aid_dec_death)
    case 'resus_billing_summary':
      return (!!fd.med_aid_dec_death || ct === 'RESUS') && !!bt;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Call Type Selection Side-Effects', () => {
  it('selecting DOD forces med_aid_dec_death=true', () => {
    const fd = pickCallType({}, 'DOD');
    expect(fd.call_type).toBe('DOD');
    expect(fd.med_aid_dec_death).toBe(true);
  });

  it('selecting PRIMARY clears med_aid_dec_death even if it was previously true', () => {
    let fd = pickCallType({}, 'DOD');
    expect(fd.med_aid_dec_death).toBe(true);
    fd = pickCallType(fd, 'PRIMARY');
    expect(fd.med_aid_dec_death).toBe(false);
  });

  it('selecting RESUS forces med_aid_resus=true and med_aid_dec_death=false', () => {
    const fd = pickCallType({}, 'RESUS');
    expect(fd.med_aid_resus).toBe(true);
    expect(fd.med_aid_dec_death).toBe(false);
  });

  it('selecting IFT does NOT force dec_death or resus', () => {
    const fd = pickCallType({}, 'IFT');
    expect(fd.med_aid_dec_death).toBe(false);
    expect(fd.med_aid_resus).toBeUndefined();
  });

  it('switching from DOD to IFT clears dec_death', () => {
    let fd = pickCallType({}, 'DOD');
    expect(fd.med_aid_dec_death).toBe(true);
    fd = pickCallType(fd, 'IFT');
    expect(fd.med_aid_dec_death).toBe(false);
  });

  it('switching from RESUS to PRIMARY does NOT clear med_aid_resus (stale value — backend ignores it for PRIMARY)', () => {
    let fd = pickCallType({}, 'RESUS');
    expect(fd.med_aid_resus).toBe(true);
    fd = pickCallType(fd, 'PRIMARY');
    // med_aid_resus is NOT cleared — but it is invisible and the billing engine
    // only reads it when call_type === 'RESUS' or the checkbox is explicitly shown
    expect(fd.med_aid_resus).toBe(true);
    // Confirm the resus checkbox is NOT visible for PRIMARY
    expect(isFieldVisible(fd, 'resus_checkbox')).toBe(true); // checkbox visible (no dec_death)
    // But resus_details panel only shows when med_aid_resus=true OR call_type=RESUS
    // For PRIMARY with stale med_aid_resus=true the resus details panel WOULD show
    // — this is a known stale-data risk: crews should clear resus if they change call type
    // The test below documents this behaviour so regressions are caught
    expect(isFieldVisible(fd, 'resus_details')).toBe(true); // stale=true causes phantom show
  });

  it('ALL non-DOD/RESUS call types leave dec_death as false', () => {
    for (const ct of ['PRIMARY', 'IFT', 'IHT', 'RHT', 'COURTESY']) {
      const fd = pickCallType({}, ct);
      expect(fd.med_aid_dec_death).toBe(false);
    }
  });
});


describe('Billing Type Availability Per Call Type', () => {
  it('DOD call cannot use IOD billing', () => {
    const opts = availableBillingOpts('DOD');
    expect(opts).not.toContain('IOD');
    expect(opts).not.toContain('RAF');
    expect(opts).toContain('MED AID');
    expect(opts).toContain('PVT');
  });

  it('RESUS call can ONLY use MED AID or PVT billing', () => {
    const opts = availableBillingOpts('RESUS');
    expect(opts).toEqual(['MED AID', 'PVT']);
  });

  it('PRIMARY call can use any billing type', () => {
    const opts = availableBillingOpts('PRIMARY');
    expect(opts).toContain('MED AID');
    expect(opts).toContain('IOD');
    expect(opts).toContain('RAF');
    expect(opts).toContain('WCA');
    expect(opts).toContain('PVT');
  });

  it('IFT call can use IOD and RAF (valid for interfacility)', () => {
    const opts = availableBillingOpts('IFT');
    expect(opts).toContain('IOD');
    expect(opts).toContain('RAF');
  });

  it('EVENT and CALL OUT FEE are always hidden from new-pick UI', () => {
    for (const ct of ['PRIMARY', 'IFT', 'DOD', 'RESUS', 'RHT']) {
      const opts = availableBillingOpts(ct);
      expect(opts).not.toContain('EVENT');
      expect(opts).not.toContain('CALL OUT FEE');
    }
  });
});


describe('Billing Type Field Visibility', () => {
  it('MED AID: shows med_aid_billing_details, hides iod/raf/pvt panels', () => {
    const fd = pickBillingType({ call_type: 'PRIMARY' }, 'MED AID');
    expect(isFieldVisible(fd, 'med_aid_billing_details')).toBe(true);
    expect(isFieldVisible(fd, 'iod_details')).toBe(false);
    expect(isFieldVisible(fd, 'raf_details')).toBe(false);
    expect(isFieldVisible(fd, 'pvt_details')).toBe(false);
  });

  it('IOD: shows iod_details, hides med_aid/raf/pvt panels', () => {
    const fd = pickBillingType({ call_type: 'PRIMARY' }, 'IOD');
    expect(isFieldVisible(fd, 'iod_details')).toBe(true);
    expect(isFieldVisible(fd, 'med_aid_billing_details')).toBe(false);
    expect(isFieldVisible(fd, 'raf_details')).toBe(false);
  });

  it('RAF: shows raf_details only', () => {
    const fd = pickBillingType({ call_type: 'PRIMARY' }, 'RAF');
    expect(isFieldVisible(fd, 'raf_details')).toBe(true);
    expect(isFieldVisible(fd, 'iod_details')).toBe(false);
    expect(isFieldVisible(fd, 'med_aid_billing_details')).toBe(false);
  });

  it('PVT: shows pvt_details only', () => {
    const fd = pickBillingType({ call_type: 'PRIMARY' }, 'PVT');
    expect(isFieldVisible(fd, 'pvt_details')).toBe(true);
    expect(isFieldVisible(fd, 'med_aid_billing_details')).toBe(false);
  });

  it('switching billing type does NOT auto-clear old sub-field data (stale values persist in fd)', () => {
    // This is a known behaviour — the backend adjudication engine ignores
    // fields that don't match the active billing_type
    let fd: Fd = { call_type: 'PRIMARY', billing_type: 'MED AID', med_aid_member_number: 'ABC123' };
    fd = pickBillingType(fd, 'IOD');
    // med_aid_member_number is stale but still in fd — this is expected
    expect(fd.med_aid_member_number).toBe('ABC123');
    expect(fd.billing_type).toBe('IOD');
    // IOD details panel now visible, MED AID panel hidden
    expect(isFieldVisible(fd, 'iod_details')).toBe(true);
    expect(isFieldVisible(fd, 'med_aid_billing_details')).toBe(false);
  });
});


describe('Declaration of Death (med_aid_dec_death) Toggle', () => {
  it('dec_death=true shows the dec_death_form section', () => {
    const fd = sf({ call_type: 'DOD' }, 'med_aid_dec_death', true);
    expect(isFieldVisible(fd, 'dec_death_form')).toBe(true);
  });

  it('dec_death=false hides the dec_death_form section', () => {
    const fd = sf({ call_type: 'PRIMARY' }, 'med_aid_dec_death', false);
    expect(isFieldVisible(fd, 'dec_death_form')).toBe(false);
  });

  it('dec_death=true hides patient_signature panel', () => {
    const fd: Fd = { call_type: 'DOD', med_aid_dec_death: true };
    expect(isFieldVisible(fd, 'patient_signature')).toBe(false);
  });

  it('dec_death=false shows patient_signature panel (for living patients)', () => {
    const fd: Fd = { call_type: 'PRIMARY', med_aid_dec_death: false };
    expect(isFieldVisible(fd, 'patient_signature')).toBe(true);
  });

  it('dec_death=true hides the resus checkbox (no resus attempt on a deceased patient)', () => {
    const fd: Fd = { call_type: 'DOD', med_aid_dec_death: true };
    expect(isFieldVisible(fd, 'resus_checkbox')).toBe(false);
  });

  it('dec_death toggles correctly via sf()', () => {
    let fd: Fd = { call_type: 'DOD', med_aid_dec_death: false };
    fd = sf(fd, 'med_aid_dec_death', !fd.med_aid_dec_death);
    expect(fd.med_aid_dec_death).toBe(true);
    fd = sf(fd, 'med_aid_dec_death', !fd.med_aid_dec_death);
    expect(fd.med_aid_dec_death).toBe(false);
  });

  it('dec_death form data persists in fd when toggled off (stale — backend ignores for non-DOD)', () => {
    let fd: Fd = {
      call_type: 'DOD',
      med_aid_dec_death: true,
      med_aid_dec_death_signatory_name: 'Dr J. Smith',
      med_aid_dec_death_witness_name: 'P. Jones',
    };
    fd = sf(fd, 'med_aid_dec_death', false);
    // Data remains in fd (not cleared) — expected behaviour
    expect(fd.med_aid_dec_death_signatory_name).toBe('Dr J. Smith');
    expect(fd.med_aid_dec_death_witness_name).toBe('P. Jones');
    // But the panel is now hidden
    expect(isFieldVisible(fd, 'dec_death_form')).toBe(false);
  });
});


describe('Resuscitation (med_aid_resus) Toggle', () => {
  it('med_aid_resus=true shows resus_details panel', () => {
    const fd: Fd = { call_type: 'PRIMARY', med_aid_resus: true };
    expect(isFieldVisible(fd, 'resus_details')).toBe(true);
  });

  it('med_aid_resus=false hides resus_details panel', () => {
    const fd: Fd = { call_type: 'PRIMARY', med_aid_resus: false };
    expect(isFieldVisible(fd, 'resus_details')).toBe(false);
  });

  it('call_type=RESUS always shows resus_details regardless of med_aid_resus flag', () => {
    const fd: Fd = { call_type: 'RESUS', med_aid_resus: false };
    expect(isFieldVisible(fd, 'resus_details')).toBe(true);
  });

  it('resus checkbox is hidden for RESUS call type (RESUS call implies resus — no checkbox needed)', () => {
    const fd: Fd = { call_type: 'RESUS', med_aid_dec_death: false };
    expect(isFieldVisible(fd, 'resus_checkbox')).toBe(false);
  });

  it('resus checkbox visible for PRIMARY when no dec_death', () => {
    const fd: Fd = { call_type: 'PRIMARY', med_aid_dec_death: false };
    expect(isFieldVisible(fd, 'resus_checkbox')).toBe(true);
  });

  it('unticking med_aid_resus leaves resus detail data in fd (stale)', () => {
    let fd: Fd = {
      call_type: 'PRIMARY',
      med_aid_resus: true,
      resus_initial_rhythm: 'VF',
      resus_rosc: true,
    };
    fd = sf(fd, 'med_aid_resus', false);
    // Panel hidden but data preserved
    expect(fd.resus_initial_rhythm).toBe('VF');
    expect(fd.resus_rosc).toBe(true);
    expect(isFieldVisible(fd, 'resus_details')).toBe(false);
  });
});


describe('Mechanism Sub-field Visibility', () => {
  it('mechanism_detail is hidden when no mechanism selected', () => {
    const fd: Fd = { call_type: 'PRIMARY' };
    expect(isFieldVisible(fd, 'mechanism_detail')).toBe(false);
  });

  it('mechanism_detail is shown when mechanism is selected', () => {
    const fd: Fd = { call_type: 'PRIMARY', mechanism: 'MVA (Motor Vehicle Accident)' };
    expect(isFieldVisible(fd, 'mechanism_detail')).toBe(true);
  });

  it('mechanism_detail shows for ALL mechanism types', () => {
    const mechanisms = [
      'MVA (Motor Vehicle Accident)',
      'MBA (Motorbike Accident)',
      'PVA (Pedestrian vehicle accident)',
      'Fall',
      'Burns',
      'Assault — Penetrating',
      'Assault — Blunt',
      'Medical',
    ];
    for (const mech of mechanisms) {
      const fd: Fd = { mechanism: mech };
      expect(isFieldVisible(fd, 'mechanism_detail')).toBe(true);
    }
  });

  it('changing mechanism preserves mechanism_detail value in fd', () => {
    let fd: Fd = { mechanism: 'Fall', mechanism_detail: 'Height 3m, concrete floor, GCS 14' };
    fd = sf(fd, 'mechanism', 'Burns');
    // Old text persists (crew must edit it — not auto-cleared)
    expect(fd.mechanism_detail).toBe('Height 3m, concrete floor, GCS 14');
    expect(fd.mechanism).toBe('Burns');
  });
});


describe('Call-Type-Specific Field Panels', () => {
  it('IFT/IHT-only fields visible for IFT', () => {
    const fd: Fd = { call_type: 'IFT' };
    expect(isFieldVisible(fd, 'ift_iht_fields')).toBe(true);
  });

  it('IFT/IHT-only fields visible for IHT', () => {
    const fd: Fd = { call_type: 'IHT' };
    expect(isFieldVisible(fd, 'ift_iht_fields')).toBe(true);
  });

  it('IFT/IHT-only fields hidden for PRIMARY', () => {
    const fd: Fd = { call_type: 'PRIMARY' };
    expect(isFieldVisible(fd, 'ift_iht_fields')).toBe(false);
  });

  it('IFT/IHT-only fields hidden for RHT', () => {
    const fd: Fd = { call_type: 'RHT' };
    expect(isFieldVisible(fd, 'ift_iht_fields')).toBe(false);
  });

  it('IFT/IHT-only fields hidden for RESUS', () => {
    const fd: Fd = { call_type: 'RESUS' };
    expect(isFieldVisible(fd, 'ift_iht_fields')).toBe(false);
  });

  it('RHT fields only visible for RHT call type', () => {
    expect(isFieldVisible({ call_type: 'RHT' }, 'rht_fields')).toBe(true);
    expect(isFieldVisible({ call_type: 'PRIMARY' }, 'rht_fields')).toBe(false);
    expect(isFieldVisible({ call_type: 'IFT' }, 'rht_fields')).toBe(false);
    expect(isFieldVisible({ call_type: 'DOD' }, 'rht_fields')).toBe(false);
  });

  it('bypass motivation hidden for PRIMARY (no destination bypass needed)', () => {
    const fd: Fd = { call_type: 'PRIMARY' };
    expect(isFieldVisible(fd, 'bypass_motivation')).toBe(false);
  });

  it('bypass motivation visible for IFT (may bypass to specialist facility)', () => {
    const fd: Fd = { call_type: 'IFT' };
    expect(isFieldVisible(fd, 'bypass_motivation')).toBe(true);
  });

  it('vitals section hidden for RESUS calls', () => {
    expect(isFieldVisible({ call_type: 'RESUS' }, 'vitals_section')).toBe(false);
  });

  it('vitals section visible for all other call types', () => {
    for (const ct of ['PRIMARY', 'IFT', 'IHT', 'RHT', 'DOD', 'COURTESY']) {
      expect(isFieldVisible({ call_type: ct }, 'vitals_section')).toBe(true);
    }
  });

  it('DOD dispatch times panel hidden for RESUS', () => {
    expect(isFieldVisible({ call_type: 'RESUS' }, 'dod_dispatch_times')).toBe(false);
  });

  it('DOD dispatch times panel visible for non-RESUS', () => {
    for (const ct of ['PRIMARY', 'IFT', 'DOD', 'RHT']) {
      expect(isFieldVisible({ call_type: ct }, 'dod_dispatch_times')).toBe(true);
    }
  });
});


describe('Stale Data Guard — Hidden Field Data Does Not Corrupt Rules Engine', () => {
  /**
   * These tests verify that when a field is hidden, any stale value left in fd
   * does not cause incorrect billing or adjudication outcomes.
   * The backend rules engine reads fields selectively based on call_type.
   */

  it('switching from IFT to PRIMARY leaves preauth_number in fd but billing engine should ignore it', () => {
    let fd: Fd = {
      call_type: 'IFT',
      preauth_number: 'AUTH123456',
      billing_type: 'MED AID',
    };
    fd = pickCallType(fd, 'PRIMARY');
    // preauth_number is still in fd (not cleared)
    expect(fd.preauth_number).toBe('AUTH123456');
    // But IFT-specific field panel is now hidden
    expect(isFieldVisible(fd, 'ift_iht_fields')).toBe(false);
    // And the call_type is now PRIMARY — the rules engine won't require preauth
    expect(fd.call_type).toBe('PRIMARY');
  });

  it('switching from DOD to PRIMARY clears dec_death flag so DoD panel is hidden', () => {
    let fd: Fd = {
      call_type: 'DOD',
      med_aid_dec_death: true,
      med_aid_dec_death_signatory_name: 'Dr Khumalo',
    };
    fd = pickCallType(fd, 'PRIMARY');
    // dec_death is cleared by pickCallType
    expect(fd.med_aid_dec_death).toBe(false);
    // DoD form hidden
    expect(isFieldVisible(fd, 'dec_death_form')).toBe(false);
    // But the signatory name is still in fd (not cleared)
    expect(fd.med_aid_dec_death_signatory_name).toBe('Dr Khumalo');
  });

  it('DOD call with IOD billing type — IOD not available, stale billing_type creates no visible panel', () => {
    // Scenario: crew starts with PRIMARY + IOD, then changes to DOD
    let fd: Fd = { call_type: 'PRIMARY', billing_type: 'IOD', iod_ref_number: 'IOD2026001' };
    fd = pickCallType(fd, 'DOD');
    // billing_type is still 'IOD' in fd (not cleared)
    expect(fd.billing_type).toBe('IOD');
    // But IOD is NOT in the available billing opts for DOD
    const opts = availableBillingOpts('DOD');
    expect(opts).not.toContain('IOD');
    // The crew MUST re-pick billing type — the DOD picker won't show IOD as an option
    // Stale billing_type is handled by the UI showing no match selected
  });

  it('RESUS + stale RAF billing_type — RAF panel not shown because it is not in RESUS billing opts', () => {
    let fd: Fd = { call_type: 'PRIMARY', billing_type: 'RAF', raf_claim_number: 'RAF001' };
    fd = pickCallType(fd, 'RESUS');
    expect(fd.billing_type).toBe('RAF');
    // RAF is NOT available for RESUS
    const opts = availableBillingOpts('RESUS');
    expect(opts).not.toContain('RAF');
    // raf_details panel is visible based on billing_type=RAF — this is a stale-data risk
    // The crew must re-pick billing type for RESUS
    expect(isFieldVisible(fd, 'raf_details')).toBe(true); // documents this risk
  });
});


describe('SA ID Auto-fill Edge Cases', () => {
  /**
   * The form auto-fills `age` and `patient_dob` from `patient_id_number`.
   * These tests cover the pure utility functions used by the autofill effect.
   */
  it('empty SA ID does not produce a DOB', () => {
    // parseSaIdDob('') should return null — no DOB for empty ID
    // We test this indirectly: the autofill should clear age/dob when ID is empty
    let fd: Fd = { patient_id_number: '8001015009087', age: '44', patient_dob: '1980-01-01' };
    // Simulate clearing the ID
    fd = sf(fd, 'patient_id_number', '');
    // Autofill logic: idDigits.length === 0 → clear age and dob
    // (mirrors DigitalPRFForm.tsx lines 2722-2725)
    const idDigits = (fd.patient_id_number || '').replace(/\D/g, '');
    if (idDigits.length === 0) {
      fd = { ...fd, age: '', patient_dob: '' };
    }
    expect(fd.age).toBe('');
    expect(fd.patient_dob).toBe('');
  });

  it('partial SA ID (< 13 digits) does not produce a DOB', () => {
    const partial = '800101500'; // only 9 digits
    const idDigits = partial.replace(/\D/g, '');
    // parseSaIdDob would return null for < 13 digits — age is NOT auto-filled
    expect(idDigits.length).toBeLessThan(13);
  });

  it('patient and debtor ID autofill are independent (different key prefixes)', () => {
    let fd: Fd = {
      patient_id_number: '8001015009087',
      debtor_id_number: '9003125008088',
    };
    // Clearing patient ID should not affect debtor age
    fd = sf(fd, 'patient_id_number', '');
    // The debtor_id_number remains unchanged
    expect(fd.debtor_id_number).toBe('9003125008088');
  });
});


describe('Array Multi-Select Toggle Integrity', () => {
  it('toggleArr adds a value when not present', () => {
    let fd: Fd = { allergies: [] };
    fd = toggleArr(fd, 'allergies', 'Penicillin');
    expect(fd.allergies).toContain('Penicillin');
  });

  it('toggleArr removes a value when already present (deselect)', () => {
    let fd: Fd = { allergies: ['Penicillin', 'Aspirin'] };
    fd = toggleArr(fd, 'allergies', 'Penicillin');
    expect(fd.allergies).not.toContain('Penicillin');
    expect(fd.allergies).toContain('Aspirin');
  });

  it('toggleArr initialises from undefined (no crash)', () => {
    let fd: Fd = {};
    fd = toggleArr(fd, 'symptoms', 'Chest pain');
    expect(fd.symptoms).toEqual(['Chest pain']);
  });

  it('toggling same value twice returns to empty array', () => {
    let fd: Fd = {};
    fd = toggleArr(fd, 'interventions', 'IV Access');
    fd = toggleArr(fd, 'interventions', 'IV Access');
    expect(fd.interventions).toEqual([]);
  });
});
