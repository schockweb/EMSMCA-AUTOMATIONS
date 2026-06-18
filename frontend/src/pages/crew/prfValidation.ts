/**
 * PRF Validation Rules — extracted from medical scheme guideline manuals.
 *
 * Each rule is a pure data object that can be:
 *   • Filtered by phase + scheme
 *   • Evaluated against the in-progress PRF
 *   • Surfaced as an inline error message
 *
 * Source documents currently encoded:
 *   • Netcare 911 Case Management Guidelines v5.2 (Feb 2023)
 *     Document ref: NTC911-CM-WI-DC-001 V5.2
 *
 * To add scheme-specific rules later, append entries with the appropriate
 * `schemes` array. The same rule engine evaluates all schemes uniformly.
 */

// ────────────────────────────────────────────────────────────────────────────
// Phase IDs match the PHASES array in DigitalPRFForm.tsx
//   0 dispatch | 1 enroute | 2 scene | 3 clinical | 4 transport | 5 handover
//   6 complete (submission)
// ────────────────────────────────────────────────────────────────────────────

export type Phase = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Severity = 'block' | 'warn';
export type SchemeId = 'all' | 'netcare' | 'gems' | 'discovery' | 'er24' | 'bonitas';

export type PrfData = Record<string, any>;

export interface ValidationRule {
  id: string;
  schemes: SchemeId[];
  phases: Phase[];
  severity: Severity;
  field?: string;            // primary field flagged on failure (for highlighting)
  check: (d: PrfData, ctx: ValidationContext) => boolean;  // returns TRUE when rule passes
  message: string;
  source: string;
}

export interface ValidationContext {
  vitalsCount: number;
  ivCount: number;
  medCount: number;
  medTypesLower: string;             // '|'-joined lowercased medication types (live, from med rows)
  hasCrew2: boolean;
  hasPatientSig: boolean;
  hasCrewSig: boolean;
  hasHandoverSig: boolean;
  sceneMinutes: number | null;       // on-scene → depart-scene
  totalCallMinutes: number | null;   // dispatch → arrival at facility
  patientCarryingKm: number | null;  // loaded distance: on-scene km → arrival km
}

export interface ValidationFinding {
  id: string;
  severity: Severity;
  field?: string;
  message: string;
  source: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const isBlank = (v: any): boolean => {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
};

const has = (d: PrfData, k: string): boolean => !isBlank(d[k]);

const isIFT = (d: PrfData): boolean => {
  const t = (d.dispatch_type || d.call_type || '').toString().toUpperCase();
  return t === 'IFT' || t === 'TRANSFER' || t === 'IHT' || t === 'RHT' || t === 'COURTESY';
};

const billingLevel = (d: PrfData): string =>
  (d.assessment_level || d.billing_level || '').toString().toUpperCase();

const medListLower = (d: PrfData): string => {
  const meds = Array.isArray(d.medications) ? d.medications : [];
  return meds.map((m: any) => (m?.type || '').toLowerCase()).join('|');
};

// ────────────────────────────────────────────────────────────────────────────
// RULES — Netcare 911 Case Management Guidelines v5.2 Feb 2023
// ────────────────────────────────────────────────────────────────────────────

export const RULES: ValidationRule[] = [
  // ── Phase 0 (Dispatch) — call type and pre-auth gating ──
  {
    id: 'NTC-3.2-IFT-PREAUTH',
    schemes: ['all'],
    phases: [0, 6],
    severity: 'block',
    field: 'preauth_number',
    check: (d) => {
      const t = (d.dispatch_type || d.call_type || '').toString().toUpperCase();
      if (t !== 'IFT' && t !== 'IHT') return true;
      const digits = (d.preauth_number || '').toString().replace(/\D/g, '');
      return digits.length === 13;
    },
    message:
      'IFT/IHT requires a 13-digit pre-authorisation number. Call the Netcare 911 dispatch centre to obtain one before transporting.',
    source: 'Netcare CMG §3.2 — All IFTs require pre-authorisation, failing which the claim will be immediately rejected',
  },
  {
    id: 'NTC-3.2-IFT-SUBTYPE',
    schemes: ['all'],
    phases: [0, 6],
    severity: 'block',
    field: 'transfer_subtype',
    check: (d) => !isIFT(d) || has(d, 'transfer_subtype'),
    message:
      'Select the IFT subtype (social / upgrade / downgrade / sideways / hospital-to-hospital / residence-to-hospital / psychiatric).',
    source: 'Netcare CMG §3.2.1 — IFT classification list',
  },
  {
    id: 'NTC-3.7-INCIDENT-TYPE',
    schemes: ['all'],
    phases: [0, 6],
    severity: 'block',
    field: 'incident_classification',
    check: (d) => has(d, 'incident_classification'),
    message: 'Tick whether the incident is MEDICAL or TRAUMA.',
    source: 'Netcare CMG §3.7 — Incident type: Primary/IHT; medical/trauma',
  },

  // ── Phase 2 (On Scene) — patient identity and scheme ──
  {
    id: 'NTC-3.7-PATIENT-NAME',
    schemes: ['all'],
    phases: [2, 6],
    severity: 'block',
    field: 'patient_name',
    check: (d) => has(d, 'patient_name') && has(d, 'patient_surname'),
    message: 'Patient full name and surname are required.',
    source: 'Netcare CMG §3.7 — Patient details: Full name, surname, identity number',
  },
  {
    id: 'NTC-3.7-PATIENT-ID',
    schemes: ['all'],
    phases: [2, 6],
    severity: 'block',
    field: 'patient_id_number',
    check: (d) => {
      const id = String(d.patient_id_number || '').replace(/\s/g, '');
      // SA ID = 13 digits. Allow passport (alphanumeric, 6-15 chars) as fallback.
      return /^\d{13}$/.test(id) || /^[A-Z0-9]{6,15}$/i.test(id);
    },
    message:
      'Patient ID number must be a valid 13-digit SA ID or a passport number. Required for claim submission.',
    source: 'Netcare CMG §3.7 + §4 — Patient ID required, valid format',
  },
  {
    id: 'NTC-3.7-SCENE-ADDRESS',
    schemes: ['all'],
    phases: [2, 6],
    severity: 'block',
    field: 'incident_location',
    check: (d) => has(d, 'incident_location'),
    message: 'Full physical scene address (or GPS coordinates) is required.',
    source: 'Netcare CMG §3.7 — Scene address: Full physical location or GPS points',
  },
  {
    id: 'NTC-3.7-PATIENT-WEIGHT',
    schemes: ['all'],
    phases: [2, 6],
    severity: 'warn',
    field: 'patient_weight_kg',
    check: (d) => {
      if (has(d, 'patient_weight_kg')) return true;
      // Only warn if any medication has been administered (weight needed for dose calc)
      return medListLower(d).length === 0;
    },
    message:
      'Patient weight should be recorded — required for dose calculation when medications are given.',
    source: 'Netcare CMG §3.7 — Patient weight: To be included for calculation of appropriate medication dose',
  },

  // ── Phase 2/6 — medical scheme details (only when billing to scheme) ──
  {
    id: 'NTC-3.7-SCHEME-NAME',
    schemes: ['all'],
    phases: [5, 6],
    severity: 'block',
    field: 'medical_scheme',
    check: (d) => {
      const bt = (d.billing_type || '').toString().toUpperCase();
      // Only required when billing a medical aid
      if (bt && !bt.includes('MED')) return true;
      return has(d, 'medical_scheme');
    },
    message: "Medical scheme name is required when billing type is 'Med Aid'.",
    source: 'Netcare CMG §3.7 — Medical scheme details: Name of patient\'s medical scheme',
  },
  {
    id: 'NTC-3.7-MEMBER-NUMBER',
    schemes: ['all'],
    phases: [5, 6],
    severity: 'block',
    field: 'medical_aid_number',
    check: (d) => {
      const bt = (d.billing_type || '').toString().toUpperCase();
      if (bt && !bt.includes('MED')) return true;
      return has(d, 'medical_aid_number');
    },
    message: 'Member number is required when billing a medical scheme.',
    source: 'Netcare CMG §4 — Medical aid membership number must be supplied',
  },

  // ── Phase 3 (Clinical) — vitals, surveys, scope-of-practice ──
  {
    id: 'NTC-3.7-MIN-3-VITALS',
    schemes: ['all'],
    phases: [4, 5, 6],
    severity: 'block',
    field: 'vitals_sets',
    // The fewer-than-3-vitals case is handled exclusively by the Submit-time
    // motivation prompt: once the crew records a shortfall motivation it
    // justifies the lower count, so this rule is satisfied and never raises a
    // separate blocking alert.
    check: (d, ctx) => ctx.vitalsCount >= 3 || has(d, 'vitals_shortfall_motivation'),
    message:
      'At least 3 sets of vital signs must be recorded with timestamps. Use the floating "+ VITALS" button to add another set.',
    source: 'Netcare CMG §3.7 — A minimum of 3 (three) sets of vital signs must be submitted on the PRF',
  },
  {
    id: 'NTC-3.7-PRIMARY-SURVEY',
    schemes: ['all'],
    phases: [3, 6],
    severity: 'block',
    field: 'survey_a',
    check: (d) =>
      has(d, 'survey_a') && has(d, 'survey_b') && has(d, 'survey_c'),
    message:
      'Complete the primary survey (A — Airway, B — Breathing, C — Circulation).',
    source: 'Netcare CMG §3.7 — Complete primary and secondary survey examination notes',
  },
  {
    id: 'NTC-3.7-CHIEF-COMPLAINT',
    schemes: ['all'],
    phases: [3, 6],
    severity: 'block',
    field: 'chief_complaint',
    check: (d) => has(d, 'chief_complaint'),
    message: 'Chief complaint / presenting problem is required.',
    source: 'Netcare CMG §3.7 — Patients medical/surgical history relevant to the chief complaint',
  },
  {
    id: 'NTC-3.7-PRIMARY-DIAGNOSIS',
    schemes: ['all'],
    phases: [3, 6],
    severity: 'block',
    field: 'primary_diagnosis',
    check: (d) => {
      const v = String(d.primary_diagnosis || '').trim();
      return v.length > 0 && v.endsWith('?');
    },
    message: 'Primary Diagnosis is required and must end with a question mark.',
    source: 'Clinical protocol — Primary diagnosis must be documented with a question mark.',
  },

  // ── ILS IV-therapy gate (Netcare §3.7 — IV for ILS only valid in 4 cases) ──
  {
    id: 'NTC-3.7-ILS-IV-JUSTIFICATION',
    schemes: ['all'],
    phases: [3, 6],
    severity: 'warn',
    field: 'iv_therapy',
    check: (d, ctx) => {
      if (billingLevel(d) !== 'ILS' || ctx.ivCount === 0) return true;
      const meds = medListLower(d).toLowerCase();
      const notes = String(d.management_notes || d.events_hpi || '').toLowerCase();
      const justified =
        meds.includes('dextrose') ||
        notes.includes('hypoglycaemic') ||
        notes.includes('hypoglycemic') ||
        notes.includes('haemodynamic') ||
        notes.includes('hemodynamic') ||
        notes.includes('iv inserted prior') ||
        notes.includes('unstable patient') ||
        notes.includes('deranged vitals');
      return justified;
    },
    message:
      'ILS IV therapy must fit one of the four accepted cases (50% Dextrose for hypoglycaemia, fluid for haemodynamic compromise, IV sited prior to arrival, or unstable patient with deranged vitals). Document the justification in management notes or the claim will be downgraded.',
    source: 'Netcare CMG §3.7 — IV therapy for ILS level of care will only be accepted in the following circumstances...',
  },

  // ── Resuscitation fee — strict §3.5 criteria ──
  {
    id: 'NTC-3.5-RESUS-CRITERIA',
    schemes: ['all'],
    phases: [4, 5, 6],
    severity: 'block',
    field: 'resuscitation_attempted',
    check: (d) => {
      if (!d.resuscitation_attempted) return true;
      // All three must be present
      const secondVehicle = !!d.second_vehicle_present;
      const isALS = billingLevel(d) === 'ALS' || billingLevel(d) === 'ICU';
      const interventions = Array.isArray(d.circulation_interventions) ? d.circulation_interventions : [];
      const airway = Array.isArray(d.airway_interventions) ? d.airway_interventions : [];
      const meds = medListLower(d);
      const hasALSIntervention =
        interventions.includes('Cardio Version') ||
        interventions.includes('Pacing') ||
        airway.includes('Intubation') ||
        meds.includes('adrenaline') ||
        meds.includes('amiodarone') ||
        meds.includes('atropine');
      return secondVehicle && isALS && hasALSIntervention;
    },
    message:
      'Resuscitation fee requires ALL of: (1) a second vehicle on scene, (2) ALS practitioner, (3) at least one ALS intervention (advanced cardiac life support drug, defibrillation/cardioversion, external pacing, or endotracheal intubation).',
    source: 'Netcare CMG §3.5 — Resuscitation fees criteria',
  },

  // ── ILS call escalating to ALS — prompt crew to call dispatch for upgrade ──
  {
    id: 'ILS-UPGRADE-TO-ALS',
    schemes: ['all'],
    phases: [3, 4, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      if (billingLevel(d) !== 'ILS') return true;
      const interventions = Array.isArray(d.circulation_interventions) ? d.circulation_interventions : [];
      const airway = Array.isArray(d.airway_interventions) ? d.airway_interventions : [];
      const meds = medListLower(d);
      const hasALSIntervention =
        interventions.includes('Cardio Version') ||
        interventions.includes('Pacing') ||
        airway.includes('Intubation') ||
        airway.includes('Surg. Airway') ||
        meds.includes('adrenaline') ||
        meds.includes('amiodarone') ||
        meds.includes('atropine') ||
        meds.includes('midazolam') ||
        meds.includes('naloxone');
      return !hasALSIntervention;
    },
    message:
      'Please call to upgrade call — ALS-level interventions detected on an ILS dispatch. Notify dispatch to upgrade this call to ALS.',
    source: 'Operational protocol — ILS scope-of-practice escalation',
  },

  // ── Level-of-care downgrade traps (CMG §3.6) ──
  {
    id: 'NTC-3.6-PARACETAMOL-BLS',
    schemes: ['all'],
    phases: [3, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const meds = medListLower(d);
      // Only Paracetamol given (no other meds) → must bill BLS
      const onlyOral = meds.includes('paracetamol') && !/(adrenaline|morphine|nitro|tranexamic|amiodarone|atropine|midazolam|naloxone|salbutamol|ipratropium|adenosine|dextrose)/.test(meds);
      if (!onlyOral) return true;
      return billingLevel(d) === 'BLS';
    },
    message:
      "Oral Paracetamol only → claim must be billed at BLS level. Don't escalate to ILS/ALS for this medication alone.",
    source: 'Netcare CMG §3.6.12 — Paracetamol oral only = BLS level of care',
  },
  {
    id: 'NTC-3.6-TKVO-IV-BLS',
    schemes: ['all'],
    phases: [3, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const notes = String(d.management_notes || '').toLowerCase();
      const isTKVO = notes.includes('tkvo') || notes.includes('to keep vein open');
      if (!isTKVO) return true;
      return billingLevel(d) === 'BLS';
    },
    message:
      'TKVO IV without clinical/pathophysiological reason is billed as BLS, not ILS. Document the clinical reason if you intend to claim ILS.',
    source: 'Netcare CMG §3.6.5 — TKVO IV billed as BLS',
  },

  // ── Phase 5 (Handover) — receiving facility + practitioner ──
  {
    id: 'NTC-3.7-RECEIVING-FACILITY',
    schemes: ['all'],
    phases: [5, 6],
    severity: 'block',
    field: 'receiving_facility',
    check: (d) => has(d, 'receiving_facility'),
    message: 'Receiving facility full physical address is required.',
    source: 'Netcare CMG §3.7 — Receiving facility address: Full physical location',
  },
  {
    id: 'NTC-4-RECEIVING-PRACTITIONER',
    schemes: ['all'],
    phases: [5, 6],
    severity: 'block',
    field: 'handover_qualification',
    check: (d) => has(d, 'handover_qualification'),
    message:
      'Receiving practitioner qualification is required at handover.',
    source: 'Netcare CMG §4 — Signature, and qualification of the receiving practitioner',
  },
  {
    id: 'NTC-4-HANDOVER-SIG',
    schemes: ['all'],
    phases: [5, 6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasHandoverSig,
    message: 'Receiving practitioner must sign the handover.',
    source: 'Netcare CMG §4 — Signature of the receiving practitioner at the receiving facility',
  },

  // ── Phase 6 (Complete / Submit) — ICD-10, signatures, crew, billing codes ──
  {
    id: 'NTC-4-CREW2-HPCSA',
    schemes: ['all'],
    phases: [6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasCrew2,
    message:
      'Two crew members with valid HPCSA registration numbers are required. End the shift and re-start with a verified Crew 2 if one is missing.',
    source: 'Netcare CMG §4 — All treating crew must be registered with the HPCSA',
  },
  {
    id: 'NTC-4-ICD10-PRIMARY',
    schemes: ['all'],
    phases: [6],
    severity: 'block',
    field: 'icd10_primary',
    check: (d) => {
      const v = String(d.icd10_primary || '').trim().toUpperCase();
      // ICD-10: letter + 2 digits, optional .digit(s) — e.g. I21.0, S72.001
      return /^[A-Z]\d{2}(\.\d{1,3})?$/.test(v);
    },
    message:
      'Primary ICD-10 code is required and must be in standard format (e.g. I21.0 for STEMI, J18.9 for pneumonia).',
    source: 'Netcare CMG §4 — Correct ICD10 coding must be used',
  },
  {
    id: 'NTC-4-PATIENT-SIG',
    schemes: ['all'],
    phases: [6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasPatientSig,
    message: 'Patient (or guardian) signature is required to submit.',
    source: 'Netcare CMG §3.8 — All PRFs must have the treating crew signature/s; patient consent required',
  },
  {
    id: 'NTC-4-CREW-SIG',
    schemes: ['all'],
    phases: [6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasCrewSig,
    message: 'Treating crew member signature is required to submit.',
    source: 'Netcare CMG §4 — The signature of the treating practitioner must be present',
  },

  // ── Phase 6 — multi-patient billing flag ──
  {
    id: 'NTC-3.4-MULTI-PATIENT',
    schemes: ['all'],
    phases: [6],
    severity: 'block',
    field: 'patient_index_of_total',
    check: (d) => {
      if (!d.is_multi_patient) return true;
      const v = String(d.patient_index_of_total || '');
      // Format: "1 of 3" or "1/3"
      return /^\d+\s*(\/|of)\s*\d+$/i.test(v);
    },
    message:
      'For multi-patient transports, indicate which patient this PRF is for in the format "X of Y" (e.g. "1 of 3").',
    source: 'Netcare CMG §3.4.2 — PRF should clearly state which patient is being referred to',
  },

  // ── Time-limit warnings (don't block — schemes accept with motivation) ──
  {
    id: 'NTC-5.2-SCENE-TIME-WARN',
    schemes: ['all'],
    phases: [4, 6],
    severity: 'warn',
    check: (d) => {
      if (!d.time_on_scene || !d.time_depart_scene) return true;
      const a = new Date(d.time_on_scene).getTime();
      const b = new Date(d.time_depart_scene).getTime();
      if (isNaN(a) || isNaN(b)) return true;
      const minutes = (b - a) / 60000;
      return minutes <= 20;
    },
    message:
      'Scene time exceeds 20 minutes. A motivation will be required by the case manager — document the reason in management notes.',
    source: 'Netcare CMG §5.2.1 — Time at scene BLS/ILS/ALS/ICU: maximum 20 minutes',
  },
  {
    id: 'NTC-5.2-CALL-TIME-WARN',
    schemes: ['all'],
    phases: [6],
    severity: 'warn',
    check: (d, _ctx) => {
      if (!d.time_dispatched || !d.time_handover) return true;
      const a = new Date(d.time_dispatched).getTime();
      const b = new Date(d.time_handover).getTime();
      if (isNaN(a) || isNaN(b)) return true;
      const minutes = (b - a) / 60000;
      const limit = (billingLevel(d) === 'ALS' || billingLevel(d) === 'ICU') ? 60 : 45;
      return minutes <= limit;
    },
    message:
      'Total call time exceeds the standard limit (45 min BLS/ILS, 60 min ALS/ICU). Add a motivation to management notes to avoid downgrade.',
    source: 'Netcare CMG §5.2.1.1 — Total call time limits before motivation required',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// RULES — Discovery Health General Ambulance Billing Guidelines (March 2023)
//
// Source: "General Ambulance Billing Guidelines" (Discovery Health, Mar 2023),
// encoded from the EMSMCA Claim Rejection-Prevention Rules Matrix. Every rule is
// severity 'warn' by deliberate product decision: a crew working a live call is
// NEVER blocked by billing rules — they see an amber "Discovery may downgrade /
// reject" nudge they can act on, but can always submit. Matrix IDs referenced in
// each source string for traceability back to the spreadsheet.
//
// Fields not yet captured by the digital PRF (so not enforceable here yet):
//   • Multiple patients on one ambulance (100%/75%/50%/none) — Matrix M1–M3
//   • Return-leg km vs loaded km (20 km cap / tracking report) — Matrix D3/D4
// Add these rules once the corresponding form fields exist.
// ────────────────────────────────────────────────────────────────────────────

const DISCOVERY_RULES: ValidationRule[] = [
  // ── Inter-facility transfer: >100 km must be pre-authorised (Matrix IF2) ──
  {
    id: 'DISC-IFT-100KM-PREAUTH',
    schemes: ['discovery'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'preauth_number',
    check: (d, ctx) => {
      if (!isIFT(d)) return true;
      const km = ctx.patientCarryingKm;
      if (km === null || km <= 100) return true;
      return has(d, 'preauth_number');
    },
    message:
      'Inter-facility transfer over 100 km must be pre-authorised by Discovery 911 (0860 999 911) — with exact km and reason — BEFORE transport, or the claim will be rejected. Capture the pre-auth number.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Inter-facility transfers: >100 km to be pre-authorised [Matrix IF2]',
  },
  // ── Inter-facility transfers default to BLS unless motivated (Matrix IF1) ──
  {
    id: 'DISC-IFT-BLS-DEFAULT',
    schemes: ['discovery'],
    phases: [3, 4, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      if (!isIFT(d)) return true;
      const lvl = billingLevel(d);
      if (lvl === '' || lvl === 'BLS') return true;
      const notes = String(d.management_notes || d.events_hpi || '').toLowerCase();
      const motivated =
        !!String(d.referring_doctor || '').trim() ||
        /icu|ventilat|infus|monitor|inotrop|sedat|unstable|deranged|clinical/.test(notes);
      return motivated;
    },
    message:
      'Inter-facility transfers default to BLS. To bill ILS/ALS, record the referring doctor’s motivation and practice number/name on the PRF — otherwise Discovery downgrades the claim to BLS.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Inter-facility transfers accepted at BLS unless motivated [Matrix IF1]',
  },
  // ── ILS IV must be clinically justified, else billed BLS (Matrix IV2/IV4) ──
  {
    id: 'DISC-ILS-IV-JUSTIFY',
    schemes: ['discovery'],
    phases: [3, 4, 6],
    severity: 'warn',
    field: 'iv_therapy',
    check: (d, ctx) => {
      if (billingLevel(d) !== 'ILS' || ctx.ivCount === 0) return true;
      const meds = ctx.medTypesLower;
      const notes = String(d.management_notes || d.events_hpi || '').toLowerCase();
      const justified =
        /dextrose/.test(meds) ||
        /hypoglyc|hyperglyc|hypotension|dehydrat|burn|overdose|poison|haemodynam|hemodynam|unstable|deranged|fluctuat/.test(notes);
      return justified;
    },
    message:
      'ILS billed with an IV but no clinical justification documented. Discovery funds ILS-level IV only for clear hypotension/BP fluctuation, hyperglycaemia needing IV, burns, dehydration, or overdose/poisoning — otherwise it is downgraded to BLS. Document the indication in management notes.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — IV line placement; prophylactic IV not funded [Matrix IV2/IV4]',
  },
  // ── TKVO IV line must be billed BLS (Matrix IV2) ──
  {
    id: 'DISC-TKVO-BLS',
    schemes: ['discovery'],
    phases: [3, 4, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const notes = String(d.management_notes || d.events_hpi || '').toLowerCase();
      const tkvo = notes.includes('tkvo') || notes.includes('to keep vein open');
      if (!tkvo) return true;
      return billingLevel(d) === 'BLS';
    },
    message:
      'A TKVO (“to keep vein open”) IV line must be billed at BLS, not ILS, unless a clinical requirement is documented. Discovery will downgrade to BLS.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — IV line TKVO billed as BLS [Matrix IV2]',
  },
  // ── ALS must show ALS-level treatment or motivation (Matrix A1/A3) ──
  {
    id: 'DISC-ALS-INDICATION',
    schemes: ['discovery'],
    phases: [3, 4, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d, ctx) => {
      const lvl = billingLevel(d);
      if (lvl !== 'ALS' && lvl !== 'ICU') return true;
      const meds = ctx.medTypesLower;
      const circ = Array.isArray(d.circulation_interventions) ? d.circulation_interventions : [];
      const air = Array.isArray(d.airway_interventions) ? d.airway_interventions : [];
      const notes = String(d.management_notes || d.events_hpi || '').toLowerCase();
      const alsMed = /adrenaline|amiodarone|atropine|morphine|fentanyl|ketamine|midazolam|naloxone|adenosine|tranexamic/.test(meds);
      const alsProc =
        circ.includes('Cardio Version') || circ.includes('Pacing') ||
        air.includes('Intubation') || air.includes('Surg. Airway');
      const motivated =
        !!String(d.referring_doctor || '').trim() ||
        /interaction|half-life|infus|practice no|referr/.test(notes);
      return alsMed || alsProc || motivated;
    },
    message:
      'ALS billed but no ALS-level treatment is documented. Discovery downgrades to the lowest level of care needed unless an ALS drug/procedure is recorded, or the referring doctor’s motivation and practice number/name are on the PRF.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — ALS treatment must be indicated/motivated [Matrix A1/A3]',
  },
  // ── Resuscitation (151) on-scene time capped at 20 min (Matrix RS1) ──
  {
    id: 'DISC-RESUS-151-SCENE',
    schemes: ['discovery'],
    phases: [4, 6],
    severity: 'warn',
    field: 'time_on_scene',
    check: (d, ctx) => {
      const isResus = d.call_type === 'RESUS' || !!d.med_aid_resus;
      if (!isResus) return true;
      if (ctx.sceneMinutes === null) return true;
      return ctx.sceneMinutes <= 20;
    },
    message:
      'On-scene time for a resuscitation (code 151) is limited to 20 minutes — time beyond that is cut. Document a clinical motivation in management notes if the extra time was unavoidable.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Resuscitation in progress; on-scene time limited to 20 min [Matrix RS1]',
  },
  // ── General scene time > 20 min must be motivated (Matrix T4) ──
  {
    id: 'DISC-SCENE-TIME-20',
    schemes: ['discovery'],
    phases: [4, 6],
    severity: 'warn',
    check: (d, ctx) => {
      if (ctx.sceneMinutes === null || ctx.sceneMinutes <= 20) return true;
      const notes = String(d.management_notes || d.events_hpi || '').toLowerCase();
      return /motivat|extricat|analges|jaws|delay|reason|resus|difficult|entrap/.test(notes);
    },
    message:
      'Scene time exceeds 20 minutes. Discovery caps scene time at 20 min unless a clinical motivation (e.g. extrication, analgesia onset, difficult access) is documented on the PRF — add it to management notes to avoid a time cut.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Scene time max 20 min; extended time must be motivated [Matrix T4/T7]',
  },
  // ── Transport with no documented clinical need is not funded (Matrix N1) ──
  {
    id: 'DISC-NO-CLINICAL-NEED',
    schemes: ['discovery'],
    phases: [5, 6],
    severity: 'warn',
    field: 'chief_complaint',
    check: (d, ctx) => {
      if (d.call_type === 'RHT' || d.med_aid_dec_death) return true;
      const transported = !!d.receiving_facility;
      if (!transported) return true;
      const anyClinical =
        ctx.vitalsCount > 0 || ctx.medCount > 0 || ctx.ivCount > 0 ||
        (Array.isArray(d.circulation_interventions) && d.circulation_interventions.length > 0) ||
        (Array.isArray(d.airway_interventions) && d.airway_interventions.length > 0) ||
        !!String(d.management_notes || '').trim();
      return anyClinical;
    },
    message:
      'No clinical treatment is documented for this transport. Discovery does not fund transport without clinical need — record vitals, treatment given, or a clinical motivation on the PRF, or the claim will be reworked / recovered.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Transport with no clinical need is not paid [Matrix N1]',
  },
  // ── Member number required to bill a medical scheme (Matrix G1) ──
  {
    id: 'DISC-MEMBER-NUMBER',
    schemes: ['discovery'],
    phases: [5, 6],
    severity: 'warn',
    field: 'medical_aid_number',
    check: (d) => {
      const bt = String(d.billing_type || '').toUpperCase();
      if (bt && !bt.includes('MED')) return true;
      return has(d, 'medical_aid_number');
    },
    message:
      'Member (medical aid) number is required to bill Discovery — a claim without it will be rejected.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Claim must comply with Regulation 5; member details required [Matrix G1]',
  },
  // ── BLS-only service needs a supervising independent practitioner (Matrix B1/B2) ──
  {
    id: 'DISC-BLS-SUPERVISION',
    schemes: ['discovery'],
    phases: [6],
    severity: 'warn',
    check: (d, ctx) => {
      if (billingLevel(d) !== 'BLS') return true;
      return ctx.hasCrew2;
    },
    message:
      'BLS-level transport is only funded if a supervising independent practitioner is identified (name + HPCSA number on the PRF). Record a second / qualified crew member, or Discovery will not fund the transport.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Funding of BLS-only service; HPCSA supervision required [Matrix B1/B2]',
  },
  // ── Social / residence transfers are member-liable unless pre-authorised (Matrix S1) ──
  {
    id: 'DISC-SOCIAL-TRANSFER-PREAUTH',
    schemes: ['discovery'],
    phases: [2, 6],
    severity: 'warn',
    field: 'preauth_number',
    check: (d) => {
      const st = String(d.transfer_subtype || '').toLowerCase();
      const social = st.includes('social') || st.includes('residence') || st.includes('home') || st.includes('psych');
      if (!social) return true;
      return has(d, 'preauth_number');
    },
    message:
      'Social / residence transfers (e.g. to home, old-age home, follow-up, planned admission) are member-liable unless pre-authorised by Discovery 911 (0860 999 911). Confirm funding and capture the pre-auth number.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) — Social transfers; member liable unless pre-authorised [Matrix S1]',
  },
];

// Register Discovery rules into the shared RULES table. The legacy Netcare/'all'
// rules above remain in the table but are NOT surfaced to crew (see validatePhase).
RULES.push(...DISCOVERY_RULES);

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export function buildContext(args: {
  vitals: any[];
  ivRows: any[];
  medRows: any[];
  sigs: Record<string, any>;
  crew2Id: string;
  prfMeta: any;
  timestamps?: Record<string, any>;
  kms?: Record<string, any>;
}): ValidationContext {
  const ts = args.timestamps || {};
  const km = args.kms || {};
  const mins = (a?: any, b?: any): number | null => {
    if (!a || !b) return null;
    const t1 = new Date(a).getTime(), t2 = new Date(b).getTime();
    if (isNaN(t1) || isNaN(t2)) return null;
    return (t2 - t1) / 60000;
  };
  const num = (v: any): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(/\s/g, ''));
    return isNaN(n) ? null : n;
  };
  const loadedKm = (() => {
    const a = num(km.km_on_scene), b = num(km.km_at_destination);
    return a !== null && b !== null && b >= a ? b - a : null;
  })();
  return {
    vitalsCount: Array.isArray(args.vitals) ? args.vitals.filter(v => v && v.time).length : 0,
    ivCount: Array.isArray(args.ivRows) ? args.ivRows.filter(r => r && r.type).length : 0,
    medCount: Array.isArray(args.medRows) ? args.medRows.filter(r => r && r.type).length : 0,
    medTypesLower: Array.isArray(args.medRows)
      ? args.medRows.map((m: any) => (m?.type || '').toLowerCase()).filter(Boolean).join('|')
      : '',
    hasPatientSig: !!args.sigs?.patient_signature,
    hasCrewSig: !!args.sigs?.crew_signature,
    hasHandoverSig: !!args.sigs?.handover_signature,
    hasCrew2: !!(args.crew2Id || args.prfMeta?.crew_member_2_id || args.prfMeta?.crew_member_2),
    sceneMinutes: mins(ts.time_on_scene, ts.time_depart_scene),
    totalCallMinutes: mins(ts.time_dispatched, ts.time_at_destination),
    patientCarryingKm: loadedKm,
  };
}

/** Map a free-text scheme name (e.g. "Discovery Health Medical Scheme") to a SchemeId. */
function normalizeScheme(s?: string): SchemeId | null {
  const v = (s || '').toLowerCase();
  if (!v) return null;
  if (v.includes('discovery')) return 'discovery';
  if (v.includes('netcare')) return 'netcare';
  if (v.includes('gems')) return 'gems';
  if (v.includes('er24') || v.includes('er 24')) return 'er24';
  if (v.includes('bonitas')) return 'bonitas';
  return null;
}

export function validatePhase(
  phase: Phase,
  data: PrfData,
  ctx: ValidationContext,
  schemeId?: string,
): ValidationFinding[] {
  // Crew-safety policy (June 2026): a crew working a live call is NEVER blocked
  // or warned by the legacy scheme-agnostic ('all') rules — those stay
  // suppressed. We surface ONLY Discovery-scoped guidance, and ONLY as
  // non-blocking warnings, so a Discovery claim shows amber "may be downgraded /
  // rejected" nudges the crew can act on but can always submit past. Post-submit
  // adjudication and tariff pricing are unaffected (they don't call this).
  const scheme = normalizeScheme(schemeId);
  if (scheme !== 'discovery') return [];

  const findings: ValidationFinding[] = [];
  for (const r of RULES) {
    if (!r.schemes.includes('discovery')) continue;   // Discovery-scoped rules only
    if (!r.phases.includes(phase)) continue;
    let passed = true;
    try {
      passed = r.check(data, ctx);
    } catch {
      passed = true;                                   // fail-open: never break the form
    }
    if (!passed) {
      findings.push({
        id: r.id,
        severity: 'warn',                              // block nothing, ever
        field: r.field,
        message: r.message,
        source: r.source,
      });
    }
  }
  return findings;
}

export function blockers(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter(f => f.severity === 'block');
}

export function warnings(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter(f => f.severity === 'warn');
}
