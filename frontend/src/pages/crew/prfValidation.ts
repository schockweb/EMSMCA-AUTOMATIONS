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
  // Optional deltas (populated by buildContext) used by the Discovery time/distance rules.
  responseMinutes?: number | null;   // dispatch → on-scene
  responseKm?: number | null;        // dispatch km → on-scene km
  transferMinutes?: number | null;   // depart-scene → arrival at facility
  transferKm?: number | null;        // depart-scene km → arrival km
  handoverMinutes?: number | null;   // arrival at facility → handover
  returnKm?: number | null;          // arrival km → back-to-base km
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

// All free-text places a crew can record a billing motivation / justification.
// The dedicated "Motivation / Other Notes" box (motivation_notes) is the field
// that renders on the PDF PRF, so it is the primary source; management_notes,
// events_hpi and findings_on_arrival are included as fallbacks. Lowercased so
// callers can run keyword tests directly.
const motivationText = (d: PrfData): string =>
  [d.motivation_notes, d.management_notes, d.events_hpi, d.findings_on_arrival]
    .map(v => String(v || '')).join(' ').toLowerCase();

// ────────────────────────────────────────────────────────────────────────────
// RULES — Netcare 911 Case Management Guidelines v5.2 Feb 2023
// ────────────────────────────────────────────────────────────────────────────

export const RULES: ValidationRule[] = [
  // ── Phase 0 (Dispatch) — call type and pre-auth gating ──
  {
    id: 'NTC-3.2-IFT-PREAUTH',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
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
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [2, 6],
    severity: 'block',
    field: 'patient_name',
    check: (d) => has(d, 'patient_name') && has(d, 'patient_surname'),
    message: 'Patient full name and surname are required.',
    source: 'Netcare CMG §3.7 — Patient details: Full name, surname, identity number',
  },
  {
    id: 'NTC-3.7-PATIENT-ID',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [2, 6],
    severity: 'block',
    field: 'incident_location',
    check: (d) => has(d, 'incident_location'),
    message: 'Full physical scene address (or GPS coordinates) is required.',
    source: 'Netcare CMG §3.7 — Scene address: Full physical location or GPS points',
  },
  {
    id: 'NTC-3.7-PATIENT-WEIGHT',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
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
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [4, 5, 6],
    severity: 'block',
    field: 'vitals_sets',
    // The fewer-than-3-vitals case is handled exclusively by the Submit-time
    // motivation prompt: once the crew records a shortfall motivation it
    // justifies the lower count, so this rule is satisfied and never raises a
    // separate blocking alert.
    check: (d, ctx) => {
      // Declaration of Death and RHT (refused transport) are exempt: a deceased
      // or refusing patient won't have 3 timed vital sets, and handleSubmit
      // already skips the shortfall-motivation prompt for them — so leaving this
      // rule blocking made DOD/RHT impossible to submit.
      if (d.call_type === 'RHT' || !!d.med_aid_dec_death) return true;
      return ctx.vitalsCount >= 3 || has(d, 'vitals_shortfall_motivation');
    },
    message:
      'At least 3 sets of vital signs must be recorded with timestamps. Use the floating "+ VITALS" button to add another set.',
    source: 'Netcare CMG §3.7 — A minimum of 3 (three) sets of vital signs must be submitted on the PRF',
  },
  {
    id: 'NTC-3.7-PRIMARY-SURVEY',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [3, 6],
    severity: 'block',
    field: 'chief_complaint',
    check: (d) => has(d, 'chief_complaint'),
    message: 'Chief complaint / presenting problem is required.',
    source: 'Netcare CMG §3.7 — Patients medical/surgical history relevant to the chief complaint',
  },
  {
    id: 'NTC-3.7-PRIMARY-DIAGNOSIS',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [3, 6],
    severity: 'warn',
    field: 'iv_therapy',
    check: (d, ctx) => {
      if (billingLevel(d) !== 'ILS' || ctx.ivCount === 0) return true;
      const meds = medListLower(d).toLowerCase();
      const notes = motivationText(d);
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
      'ILS IV therapy must fit one of the four accepted cases (50% Dextrose for hypoglycaemia, fluid for haemodynamic compromise, IV sited prior to arrival, or unstable patient with deranged vitals). Document the justification in the Motivation / Other Notes box or the claim will be rejected.',
    source: 'Netcare CMG §3.7 — IV therapy for ILS level of care will only be accepted in the following circumstances...',
  },

  // ── Resuscitation fee — strict §3.5 criteria ──
  {
    id: 'NTC-3.5-RESUS-CRITERIA',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
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
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [3, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const notes = motivationText(d);
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
    schemes: ['netcare'],
    phases: [5, 6],
    severity: 'block',
    field: 'receiving_facility',
    check: (d) => has(d, 'receiving_facility'),
    message: 'Receiving facility full physical address is required.',
    source: 'Netcare CMG §3.7 — Receiving facility address: Full physical location',
  },
  {
    id: 'NTC-4-RECEIVING-PRACTITIONER',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [5, 6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasHandoverSig,
    message: 'Receiving practitioner must sign the handover.',
    source: 'Netcare CMG §4 — Signature of the receiving practitioner at the receiving facility',
  },

  // ── Phase 6 (Complete / Submit) — ICD-10, signatures, crew, billing codes ──
  {
    id: 'NTC-4-CREW2-HPCSA',
    schemes: ['netcare'],
    phases: [6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasCrew2,
    message:
      'Two crew members with valid HPCSA registration numbers are required. End the shift and re-start with a verified Crew 2 if one is missing.',
    source: 'Netcare CMG §4 — All treating crew must be registered with the HPCSA',
  },
  {
    id: 'NTC-4-ICD10-PRIMARY',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
    phases: [6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasPatientSig,
    message: 'Patient (or guardian) signature is required to submit.',
    source: 'Netcare CMG §3.8 — All PRFs must have the treating crew signature/s; patient consent required',
  },
  {
    id: 'NTC-4-CREW-SIG',
    schemes: ['netcare'],
    phases: [6],
    severity: 'block',
    check: (_d, ctx) => ctx.hasCrewSig,
    message: 'Treating crew member signature is required to submit.',
    source: 'Netcare CMG §4 — The signature of the treating practitioner must be present',
  },

  // ── Phase 6 — multi-patient billing flag ──
  {
    id: 'NTC-3.4-MULTI-PATIENT',
    schemes: ['netcare'],
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
    schemes: ['netcare'],
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
      'Scene time exceeds 20 minutes. A motivation will be required by the case manager — document the reason in the Motivation / Other Notes box.',
    source: 'Netcare CMG §5.2.1 — Time at scene BLS/ILS/ALS/ICU: maximum 20 minutes',
  },
  {
    id: 'NTC-5.2-CALL-TIME-WARN',
    schemes: ['netcare'],
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
      'Total call time exceeds the standard limit (45 min BLS/ILS, 60 min ALS/ICU). Add a motivation to the Motivation / Other Notes box to avoid rejection.',
    source: 'Netcare CMG §5.2.1.1 — Total call time limits before motivation required',
  },
  {
    id: 'NTC-RESPONSE-TIME-RATIO',
    schemes: ['netcare'],
    phases: [4, 6],
    severity: 'warn',
    field: 'time_on_scene',
    check: (d, ctx) => {
      if (ctx.responseMinutes == null || ctx.responseKm == null || ctx.responseKm <= 0) return true;
      if (ctx.responseMinutes <= ctx.responseKm) return true;
      return /motivat|traffic|divert|access|scene safety|delay reason/.test(motivationText(d));
    },
    message:
      'Response time exceeds the Netcare ratio of 1 minute per kilometre (60 km/h). Document a motivation in the Motivation / Other Notes box.',
    source: 'Netcare CMG 5.2 - dispatch-to-scene max 1 min/km',
  },
  {
    id: 'NTC-TRANSFER-TIME-RATIO',
    schemes: ['netcare'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_at_destination',
    check: (d, ctx) => {
      if (ctx.transferMinutes == null || ctx.transferKm == null || ctx.transferKm <= 0) return true;
      if (ctx.transferMinutes <= ctx.transferKm * 1.5) return true;
      return /motivat|traffic|clinical|unstable|divert|road/.test(motivationText(d));
    },
    message:
      'Scene-to-hospital transfer time exceeds the Netcare ratio of 1.5 minutes per kilometre (40 km/h). Document a motivation in the Motivation / Other Notes box.',
    source: 'Netcare CMG 5.2 - scene-to-hospital max 1.5 min/km',
  },
  {
    id: 'NTC-HANDOVER-TIME',
    schemes: ['netcare'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_handover',
    check: (d, ctx) => {
      if (ctx.handoverMinutes == null) return true;
      const lvl = billingLevel(d);
      const limit = (lvl === 'ALS' || lvl === 'ICU') ? 20 : 10;
      if (ctx.handoverMinutes <= limit) return true;
      return /motivat|clinical|unstable|ongoing treatment/.test(motivationText(d));
    },
    message:
      'Hospital handover time exceeds the Netcare cap (10 min BLS/ILS, 20 min ALS/ICU). Record a motivation for the extended handover.',
    source: 'Netcare CMG - handover 10 min BLS/ILS, 20 min ALS/ICU',
  },
  {
    id: 'NTC-MULTI-ALS-P1-CAP',
    schemes: ['netcare'],
    phases: [2, 6],
    severity: 'warn',
    field: 'patient_count',
    check: (d) => {
      const isP1 = /priority\s*1|^p1$|\bp1\b/i.test(String(d.priority || ''));
      return !(isP1 && Number(d.patient_count || 1) > 1);
    },
    message:
      'Only one Priority 1 patient may be transported per ALS practitioner at any time. Confirm the patient count / crewing for this critical patient.',
    source: 'Netcare CMG - max one P1 patient per ALS practitioner',
  },
  {
    id: 'NTC-JLOOP-BLS',
    schemes: ['netcare'],
    phases: [3, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const lvl = billingLevel(d);
      if (lvl !== 'ILS' && lvl !== 'ALS' && lvl !== 'ICU') return true;
      const notes = motivationText(d);
      const shortLine = /j-loop|j loop|short line|no active fluid|tkvo|to keep vein open/.test(notes);
      if (!shortLine) return true;
      return /\binfus|\bbolus|fluid running|fluids up|running fluid|fluid administered|ml given|drip up/.test(notes);
    },
    message:
      'A short line / J-loop with no active fluid administration requires only BLS monitoring and must be billed as BLS. Document active fluid administration, or bill BLS.',
    source: 'Netcare CMG - short line / J-loop with no active fluid billed as BLS',
  },
  {
    id: 'NTC-RESUS-TRANSPORT-COMBO',
    schemes: ['netcare'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'perfusing_rhythm_on_handover',
    check: (d) => {
      if (!d.resuscitation_attempted) return true;
      const transported = !!d.receiving_facility || has(d, 'time_at_destination');
      if (!transported) return true;
      return !!d.perfusing_rhythm_on_handover;
    },
    message:
      'A resuscitation fee and a transport fee can only be charged together when the patient is handed over with a perfusing ECG rhythm. Confirm perfusing-rhythm-at-handover, or only the resuscitation fee applies.',
    source: 'Netcare CMG - resus + transport fee requires perfusing rhythm at handover',
  },
  {
    id: 'NTC-CLOSEST-FACILITY',
    schemes: ['netcare'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'closest_facility_bypassed',
    check: (d) => {
      if (!d.closest_facility_bypassed) return true;
      return /motivat|nearest unable|no capacity|specialis|cath lab|trauma unit|not appropriate/.test(motivationText(d));
    },
    message:
      'Closest most appropriate facility bypassed. Netcare deducts the distance difference unless a motivation is documented - add the reason to the Motivation / Other Notes box.',
    source: 'Netcare CMG - transport to closest appropriate facility; bypass requires motivation',
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
      const notes = motivationText(d);
      const motivated =
        !!String(d.referring_doctor || '').trim() ||
        /icu|ventilat|infus|monitor|inotrop|sedat|unstable|deranged|clinical/.test(notes);
      return motivated;
    },
    message:
      'Inter-facility transfers default to BLS. To bill ILS/ALS, record the referring doctor’s motivation and practice number/name on the PRF — otherwise Discovery rejects the claim.',
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
      const notes = motivationText(d);
      const justified =
        /dextrose/.test(meds) ||
        /hypoglyc|hyperglyc|hypotension|dehydrat|burn|overdose|poison|haemodynam|hemodynam|unstable|deranged|fluctuat/.test(notes);
      return justified;
    },
    message:
      'ILS billed with an IV but no clinical justification documented. Discovery funds ILS-level IV only for clear hypotension/BP fluctuation, hyperglycaemia needing IV, burns, dehydration, or overdose/poisoning — otherwise it is rejected. Document the indication in the Motivation / Other Notes box.',
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
      const notes = motivationText(d);
      const tkvo = notes.includes('tkvo') || notes.includes('to keep vein open');
      if (!tkvo) return true;
      return billingLevel(d) === 'BLS';
    },
    message:
      'A TKVO (“to keep vein open”) IV line must be billed at BLS, not ILS, unless a clinical requirement is documented. Discovery will reject the claim.',
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
      const notes = motivationText(d);
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
      'ALS billed but no ALS-level treatment is documented. Discovery rejects the claim unless an ALS drug/procedure is recorded, or the referring doctor’s motivation and practice number/name are on the PRF.',
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
      'On-scene time for a resuscitation (code 151) is limited to 20 minutes — time beyond that is cut. Document a clinical motivation in the Motivation / Other Notes box if the extra time was unavoidable.',
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
      const notes = motivationText(d);
      return /motivat|extricat|analges|jaws|delay|reason|resus|difficult|entrap/.test(notes);
    },
    message:
      'Scene time exceeds 20 minutes. Discovery caps scene time at 20 min unless a clinical motivation (e.g. extrication, analgesia onset, difficult access) is documented on the PRF — add it to the Motivation / Other Notes box to avoid a time cut.',
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

  // ── Response time: max 1 min/km (60 km/h) ──
  {
    id: 'DISC-RESPONSE-TIME-LIMIT',
    schemes: ['discovery'],
    phases: [4, 6],
    severity: 'warn',
    field: 'time_on_scene',
    check: (d, ctx) => {
      if (ctx.responseMinutes == null || ctx.responseKm == null || ctx.responseKm <= 0) return true;
      if (ctx.responseMinutes <= ctx.responseKm) return true;
      return /motivat|traffic|divert|access|scene safety|delay reason/.test(motivationText(d));
    },
    message:
      'Response time exceeds the Discovery limit of 1 minute per kilometre (60 km/h average). Document an operational/clinical motivation in the Motivation / Other Notes box or the extra time is cut.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - response to incident max 1 min/km',
  },
  // ── Handover time: 10 min BLS/ILS, 20 min ALS ──
  {
    id: 'DISC-HANDOVER-TIME-LIMIT',
    schemes: ['discovery'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_handover',
    check: (d, ctx) => {
      if (ctx.handoverMinutes == null) return true;
      const lvl = billingLevel(d);
      const limit = (lvl === 'ALS' || lvl === 'ICU') ? 20 : 10;
      if (ctx.handoverMinutes <= limit) return true;
      return /motivat|clinical|unstable|ongoing treatment/.test(motivationText(d));
    },
    message:
      'Handover time exceeds the Discovery cap (10 min BLS/ILS, 20 min ALS). Record a PRF motivation for the extended handover or the time is cut.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - handover 10 min BLS/ILS, 20 min ALS',
  },
  // ── Transfer (scene → hospital) time: max 1.5 min/km (40 km/h) ──
  {
    id: 'DISC-TRANSFER-TIME-LIMIT',
    schemes: ['discovery'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_at_destination',
    check: (d, ctx) => {
      if (ctx.transferMinutes == null || ctx.transferKm == null || ctx.transferKm <= 0) return true;
      if (ctx.transferMinutes <= ctx.transferKm * 1.5) return true;
      return /motivat|traffic|clinical|unstable|divert|road/.test(motivationText(d));
    },
    message:
      'Transfer (scene to hospital) time exceeds the Discovery limit of 1.5 minutes per kilometre (40 km/h average). Document a motivation in the Motivation / Other Notes box.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - transfer to hospital max 1.5 min/km',
  },
  // ── Return trip capped 20 km beyond loaded distance unless tracking report ──
  {
    id: 'DISC-RETURN-DISTANCE-20KM',
    schemes: ['discovery'],
    phases: [6],
    severity: 'warn',
    field: 'transfer_subtype',
    check: (d, ctx) => {
      const st = String(d.transfer_subtype || '').toLowerCase();
      if (!st.includes('return')) return true;
      if (d.vehicle_tracking_report) return true;
      if (ctx.returnKm == null || ctx.patientCarryingKm == null) return true;
      return ctx.returnKm <= ctx.patientCarryingKm + 20;
    },
    message:
      'Return-trip distance (codes 9112 / 9130 / 9142) is capped at 20 km beyond the patient-carrying distance. Attach a vehicle tracking report to claim the additional kilometres.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - return trip max 20 km beyond loaded unless tracking report [D3/D4]',
  },
  // ── Non-clinical delay motivations are rejected ──
  {
    id: 'DISC-INVALID-DELAY-MOTIVATION',
    schemes: ['discovery'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'management_notes',
    check: (d) => {
      const notes = motivationText(d);
      return !/waiting for (a )?bed|awaiting bed|no beds|paperwork|waiting for papers|police|tow truck|tow-truck|towing|administrative delay/.test(notes);
    },
    message:
      'Extended-time motivations caused by administrative or non-clinical delays (waiting for beds, papers, police, tow trucks) are not accepted by Discovery. Replace with a clinical reason or remove it.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - non-clinical/administrative delay motivations rejected',
  },
  // ── 4th (or further) patient in one vehicle not billable ──
  {
    id: 'DISC-MULTI-PATIENT-4TH-PLUS',
    schemes: ['discovery'],
    phases: [2, 6],
    severity: 'warn',
    field: 'patient_count',
    check: (d) => Number(d.patient_count || 1) < 4,
    message:
      'A fourth (or further) patient transported in the same vehicle cannot be billed to Discovery (0%). Confirm the patient count and vehicle allocation.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - multi-patient 100/75/50/0%; 4th+ not billable [M3]',
  },
  // ── IFT funded only to closest appropriately equipped facility ──
  {
    id: 'DISC-IFT-CLOSEST-FACILITY',
    schemes: ['discovery'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'closest_facility_bypassed',
    check: (d) => {
      if (!isIFT(d) || !d.closest_facility_bypassed) return true;
      return /motivat|specialis|no capacity|not equipped|cath lab|nearest unable/.test(motivationText(d));
    },
    message:
      'Inter-facility transfers are funded only to the closest appropriately equipped facility. Document why a closer facility was bypassed, or Discovery reprices the claim.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - IFT funded to closest appropriate facility only',
  },
  // ── IFT one-way only; return leg needs separate authorization ──
  {
    id: 'DISC-IFT-ONE-WAY-ONLY',
    schemes: ['discovery'],
    phases: [0, 6],
    severity: 'warn',
    field: 'transfer_subtype',
    check: (d) => {
      const st = String(d.transfer_subtype || '').toLowerCase();
      if (!st.includes('return')) return true;
      return has(d, 'preauth_number');
    },
    message:
      'Discovery funds the primary one-way transfer only. A return trip needs its own facility authorization - capture the separate pre-auth number for the return leg.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - one-way transfer funded; return needs separate authorization',
  },
  // ── Refusal with only basic first aid is private-billed ──
  {
    id: 'DISC-NO-MED-NEED-PRIVATE-BILL',
    schemes: ['discovery'],
    phases: [5, 6],
    severity: 'warn',
    field: 'billing_type',
    check: (d) => {
      const refused = String(d.call_type || '').toUpperCase() === 'RHT' || !!d.patient_refused_transport;
      if (!refused) return true;
      const lvl = billingLevel(d);
      return lvl === 'ILS' || lvl === 'ALS' || lvl === 'ICU';
    },
    message:
      'Patient refused treatment/transport with only basic first aid rendered - this cannot be billed to Discovery and must be billed to the patient privately.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - refusal with basic first aid only is member-liable (private)',
  },
  // ── ILS+ treatment then refusal → bill code 125 (up to 45 min) ──
  {
    id: 'DISC-TREATMENT-NO-TRANSPORT-125',
    schemes: ['discovery'],
    phases: [5, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const refused = String(d.call_type || '').toUpperCase() === 'RHT' || !!d.patient_refused_transport;
      if (!refused) return true;
      const lvl = billingLevel(d);
      const ilsPlus = lvl === 'ILS' || lvl === 'ALS' || lvl === 'ICU';
      return !ilsPlus;
    },
    message:
      'Billing tip: ILS-level (or higher) treatment was given and the patient then refused transport - bill code 125 (treatment, no transport) for up to 45 minutes.',
    source: 'Discovery Ambulance Guidelines (Mar 2023) - successful ILS+ treatment then refusal bills code 125 up to 45 min',
  },
];

// ----------------------------------------------------------------------------
// Shared helpers for the GEMS + ER24 rule sets below
// ----------------------------------------------------------------------------

/** TRUE when at least one medication was given and EVERY given medication used
 *  an oral / sublingual route (ER24: oral meds are not a life-saving
 *  intervention, so BLS applies when the patient is transported). */
const onlyOralMeds = (d: PrfData): boolean => {
  const meds = Array.isArray(d.medications) ? d.medications : [];
  const given = meds.filter((m: any) => m?.type);
  if (given.length === 0) return false;
  return given.every((m: any) => /^(oral|po|p\.?o\.?|sl|sublingual|buccal)$/i.test(String(m?.route || '').trim()));
};

/** Count distinct ALS "systems" treated in a resuscitation. ER24 requires at
 *  least 2 interventions across 2 different systems (e.g. intubation + IV drug).
 *  Airway/ventilation, circulation/electrical and pharmacology each count once. */
const alsSystemsCount = (d: PrfData): number => {
  const air = Array.isArray(d.airway_interventions) ? d.airway_interventions : [];
  const circ = Array.isArray(d.circulation_interventions) ? d.circulation_interventions : [];
  const meds = medListLower(d);
  let n = 0;
  if (air.includes('Intubation') || air.includes('Surg. Airway') || d.ventilator_in_use) n++;
  if (circ.includes('Defibrillation') || circ.includes('Cardio Version') || circ.includes('Pacing')) n++;
  if (/adrenaline|amiodarone|atropine|lignocaine|lidocaine|sodium bicarb|magnesium|adenosine/.test(meds)) n++;
  return n;
};

/** Valid SA external-cause ICD-10 code: starts V/W/X/Y, exactly 5 alphanumerics
 *  excluding the dot (e.g. W01.01). Z codes are never valid as a cause. */
const isValidExternalCause = (raw: string): boolean =>
  /^[VWXY]\d{2}\.?\d{2}$/i.test(String(raw || '').trim());

// ============================================================================
// RULES - GEMS EMS Claims Manual (2023)                       [schemes: 'gems']
//
// Source: "2023 GEMS EMS Claims Manual" (Government Employees Medical Scheme,
// EMED Centre / Europ Assistance). Every rule is severity 'warn' by deliberate
// product decision - a crew on a live call is NEVER blocked. Section numbers
// reference the manual so each warning traces back to source. These mirror the
// backend GEMS adjudication module (app/rules/gems.py) so the crew sees the
// same flags pre-submit that the pipeline would raise post-submit.
// ============================================================================

const GEMS_RULES: ValidationRule[] = [
  // -- Sec 3-5 / 10.1.2 / 11: EMED reference number on every claim --
  {
    id: 'GEMS-REF-NUMBER',
    schemes: ['gems'],
    phases: [0, 6],
    severity: 'warn',
    field: 'preauth_number',
    check: (d) => has(d, 'preauth_number') || has(d, 'emed_reference_number'),
    message:
      'GEMS requires an EMED pre-authorisation reference number on every claim. Phone EMED (Europ Assistance), record the reference on the PRF, or the claim will not be adjudicated.',
    source: 'GEMS EMS Claims Manual Sec 3-5, 10.1.2 and 11 - reference number required for all calls',
  },
  // -- Sec 10 / 11: IFT/IHT needs pre-authorisation --
  {
    id: 'GEMS-IFT-PREAUTH',
    schemes: ['gems'],
    phases: [0, 4, 6],
    severity: 'warn',
    field: 'preauth_number',
    check: (d) => !isIFT(d) || has(d, 'preauth_number') || has(d, 'emed_reference_number'),
    message:
      'Inter-facility transfers must be pre-authorised by GEMS EMED before the patient is moved. Obtain the reference number and capture it, or the IFT claim will be rejected.',
    source: 'GEMS EMS Claims Manual Sec 10.2 and 11 - no pre-authorisation for inter-facility transfer = rejection',
  },
  // -- Sec 10.1: two BLS crew with no supervisor is not billable --
  {
    id: 'GEMS-CREW-MIN-ILS',
    schemes: ['gems'],
    phases: [6],
    severity: 'warn',
    check: (d, ctx) => {
      if (billingLevel(d) !== 'BLS') return true;
      return ctx.hasCrew2 || has(d, 'supervising_practitioner_pr') || has(d, 'supervising_practitioner_name');
    },
    message:
      'GEMS rejects claims crewed by two BLS practitioners only. Every vehicle must be crewed to a minimum of ILS, or list an independent supervising practitioner (name + HPCSA number) on the PRF.',
    source: 'GEMS EMS Claims Manual Sec 10.1.1 - two BLS crew only / lack of supervision = rejection',
  },
  // -- Sec 10.1.18: minimum 2 sets of vitals --
  {
    id: 'GEMS-MIN-2-VITALS',
    schemes: ['gems'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'vitals_sets',
    check: (d, ctx) => ctx.vitalsCount >= 2 || has(d, 'vitals_shortfall_motivation'),
    message:
      'GEMS requires a minimum of 2 sets of vital signs (more depending on priority and transport distance). Use the "+ VITALS" button to capture another set.',
    source: 'GEMS EMS Claims Manual Sec 10.1.18 - minimum 2 sets of vitals at intervals set by patient priority',
  },
  // -- Sec 10.1.16: external-cause code format (5 digits, V/W/X/Y, not Z) --
  {
    id: 'GEMS-EXT-CAUSE-FORMAT',
    schemes: ['gems'],
    phases: [3, 6],
    severity: 'warn',
    field: 'icd10_external_cause',
    check: (d) => isBlank(d.icd10_external_cause) || isValidExternalCause(d.icd10_external_cause),
    message:
      'External-cause ICD-10 code is invalid. GEMS requires 5 characters excluding the dot, starting with V, W, X or Y (e.g. W01.01). Codes starting with Z are rejected.',
    source: 'GEMS EMS Claims Manual Sec 10.1.16 - external-cause codes: 5 digits, start V/W/X/Y, no Z',
  },
  // -- Sec 10.1.16: injury diagnosis (S/T) needs an external-cause code --
  {
    id: 'GEMS-EXT-CAUSE-REQUIRED',
    schemes: ['gems'],
    phases: [3, 6],
    severity: 'warn',
    field: 'icd10_external_cause',
    check: (d) => {
      const primary = String(d.icd10_primary || '').trim().toUpperCase();
      const isInjury = /^[ST]\d/.test(primary);
      return !isInjury || has(d, 'icd10_external_cause');
    },
    message:
      'Injury diagnoses (ICD-10 starting S or T) must always be accompanied by an external-cause code (V/W/X/Y). Add the external cause or the claim will be returned.',
    source: 'GEMS EMS Claims Manual Sec 10.1.16 - external-cause codes must accompany any injury ICD-10',
  },
  // -- Sec 10.1 / 11: bypassing nearest facility --
  {
    id: 'GEMS-CLOSEST-FACILITY',
    schemes: ['gems'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'closest_facility_bypassed',
    check: (d) => {
      if (!d.closest_facility_bypassed) return true;
      const notes = motivationText(d);
      return /motivat|nearest unable|no capacity|specialis|cath lab|trauma unit|not appropriate|bypass reason/.test(notes);
    },
    message:
      'You have bypassed the closest appropriate facility. GEMS reprices to the nearest facility able to provide the required care unless a medical justification is documented - add the reason to the Motivation / Other Notes box.',
    source: 'GEMS EMS Claims Manual Sec 10.1 and 11 - transport to closest appropriate facility, else repriced',
  },
  // -- Sec 10: direct admission bypassing casualty --
  {
    id: 'GEMS-DIRECT-ADMISSION',
    schemes: ['gems'],
    phases: [4, 6],
    severity: 'warn',
    field: 'direct_admission',
    check: (d) => {
      if (!d.direct_admission) return true;
      return !!d.emed_notified && !!d.lifesaving_intervention_required;
    },
    message:
      'Direct admission (bypassing casualty) is not covered by GEMS unless a lifesaving intervention applies (e.g. direct Cath Lab delivery) AND EMED was notified. Tick EMED-notified + lifesaving, or transport via casualty.',
    source: 'GEMS EMS Claims Manual Sec 10 - direct admission not covered unless lifesaving + EMED notified',
  },
  // -- Sec 10.1.25: cardiac incident needs 12-lead ECG / rhythm strip --
  {
    id: 'GEMS-CARDIAC-ECG',
    schemes: ['gems'],
    phases: [3, 6],
    severity: 'warn',
    field: 'has_ecg_attached',
    check: (d) => {
      const meds = medListLower(d);
      const cardiacMed = /adrenaline|amiodarone|atropine|adenosine|nitro/.test(meds);
      const isCardiac = !!d.cardiac_incident || cardiacMed;
      return !isCardiac || !!d.has_ecg_attached;
    },
    message:
      'Cardiac incident (or cardiac ALS drug) recorded but no ECG attached. GEMS requires a 12-lead ECG or rhythm strip to accompany the PRF - attach it before submission.',
    source: 'GEMS EMS Claims Manual Sec 10.1.25 - cardiac incident requires 12-lead ECG / rhythm strip',
  },
  // -- Sec 10.1.25: DOD / unsuccessful resus needs ECG rhythm strip --
  {
    id: 'GEMS-DOD-ECG',
    schemes: ['gems'],
    phases: [3, 6],
    severity: 'warn',
    field: 'has_ecg_attached',
    check: (d) => {
      const dod = String(d.call_type || '').toUpperCase() === 'DOD' || !!d.med_aid_dec_death;
      const failedResus = !!d.resuscitation_attempted && !d.rosc_achieved;
      return !(dod || failedResus) || !!d.has_ecg_attached;
    },
    message:
      'Declaration of Death / unsuccessful resuscitation requires an ECG rhythm strip plus detailed notes on the circumstances of death for the claim to be paid. Attach the rhythm strip.',
    source: 'GEMS EMS Claims Manual Sec 10.1.25 - unsuccessful resus / DOD requires ECG rhythm strip',
  },
  // -- Sec 10.1.26: resus fee + transport needs ROSC + perfusing handover --
  {
    id: 'GEMS-RESUS-ROSC',
    schemes: ['gems'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'resuscitation_attempted',
    check: (d) => {
      if (!d.resuscitation_attempted) return true;
      const transported = !!d.receiving_facility || has(d, 'time_at_destination');
      if (!transported) return true;
      return !!d.rosc_achieved && !!d.perfusing_rhythm_on_handover;
    },
    message:
      'A transport fee charged together with a resuscitation fee is only payable when ROSC is achieved post-CPR and the patient is handed over with a perfusing rhythm. Confirm ROSC and perfusing-rhythm-on-handover, or only the resuscitation fee applies.',
    source: 'GEMS EMS Claims Manual Sec 10.1.26 - ALS/ILS transport + resus fee requires ROSC and perfusing handover',
  },
  // -- Sec 8.3: on-scene time limits (15 BLS / 20 ILS / 30 ALS-ICU) --
  {
    id: 'GEMS-SCENE-TIME',
    schemes: ['gems'],
    phases: [4, 6],
    severity: 'warn',
    check: (d, ctx) => {
      if (ctx.sceneMinutes === null) return true;
      const lvl = billingLevel(d);
      const limit = lvl === 'BLS' ? 15 : (lvl === 'ALS' || lvl === 'ICU') ? 30 : 20;
      if (ctx.sceneMinutes <= limit) return true;
      return /motivat|extricat|entrap|complex|delay|prolong|difficult/.test(motivationText(d));
    },
    message:
      'On-scene time exceeds the GEMS allowance (15 min BLS, 20 min ILS, 30 min ALS/ICU). Document a motivation in the Motivation / Other Notes box on the first submission or the time will be cut.',
    source: 'GEMS EMS Claims Manual Sec 8.3 - on-scene time guidelines per level of care',
  },
  // -- Sec 8.2: multi-patient must state "X of Y" --
  {
    id: 'GEMS-MULTI-PATIENT',
    schemes: ['gems'],
    phases: [6],
    severity: 'warn',
    field: 'patient_index_of_total',
    check: (d) => {
      if (!d.is_multi_patient && Number(d.patient_count || 1) <= 1) return true;
      return /^\d+\s*(\/|of)\s*\d+$/i.test(String(d.patient_index_of_total || ''));
    },
    message:
      'For multi-patient transports both the invoice and PRF must state which patient this is, e.g. "1 of 2". Capture the patient index.',
    source: 'GEMS EMS Claims Manual Sec 8.2 - multi-patient transport must indicate patient one of two, etc.',
  },
  // -- Sec 10.1.23: patient (or guardian/witness) signature --
  {
    id: 'GEMS-PATIENT-SIG',
    schemes: ['gems'],
    phases: [6],
    severity: 'warn',
    check: (d, ctx) => ctx.hasPatientSig || has(d, 'signature_refused_reason') || ctx.hasCrew2,
    message:
      'Patient or guardian signature is required as proof of transport. Where it cannot be obtained, document the reason and have the second crew member counter-sign as witness, otherwise the claim is rejected.',
    source: 'GEMS EMS Claims Manual Sec 10.1.23 - patient signature, or documented reason + witness',
  },
  // -- Sec 10.1.24: handover signature + qualification --
  {
    id: 'GEMS-HANDOVER-SIG',
    schemes: ['gems'],
    phases: [5, 6],
    severity: 'warn',
    field: 'handover_qualification',
    check: (d, ctx) => ctx.hasHandoverSig && has(d, 'handover_qualification'),
    message:
      'Handover requires the signature AND qualification of the receiving individual as proof of patient receipt. Capture both before submitting.',
    source: 'GEMS EMS Claims Manual Sec 10.1.24 - signature and qualification of receiving individual',
  },
  // -- Sec 5.2 / 8.1 / 11: member number required when billing GEMS --
  {
    id: 'GEMS-MEMBER-NUMBER',
    schemes: ['gems'],
    phases: [2, 5, 6],
    severity: 'warn',
    field: 'medical_aid_number',
    check: (d) => {
      const bt = String(d.billing_type || '').toUpperCase();
      if (bt && !bt.includes('MED')) return true;
      return has(d, 'medical_aid_number');
    },
    message:
      'Full GEMS membership number (9 digits) is required to bill the scheme. A claim with inaccurate or missing membership details is rejected.',
    source: 'GEMS EMS Claims Manual Sec 5.2, 8.1 and 11 - full membership number required',
  },
  // -- Sec 10: pre-planned events (dialysis, oncology) not covered --
  {
    id: 'GEMS-PREPLANNED',
    schemes: ['gems'],
    phases: [0, 6],
    severity: 'warn',
    field: 'pre_planned_event',
    check: (d) => !d.pre_planned_event || has(d, 'preauth_number'),
    message:
      'GEMS does not cover transport for pre-planned events (including renal dialysis and oncology transfers) without authorisation from EMED. Confirm funding and capture the authorisation, or the member is liable.',
    source: 'GEMS EMS Claims Manual Sec 10 - pre-planned events (dialysis / oncology) not covered',
  },
  // -- Sec 10.1: ILS IV must meet one of the accepted indications --
  {
    id: 'GEMS-ILS-IV-JUSTIFY',
    schemes: ['gems'],
    phases: [3, 6],
    severity: 'warn',
    field: 'iv_therapy',
    check: (d, ctx) => {
      if (billingLevel(d) !== 'ILS' || ctx.ivCount === 0) return true;
      const meds = medListLower(d);
      const notes = motivationText(d);
      return (
        /dextrose/.test(meds) ||
        /fluid deplet|haemodynam|hemodynam|abnormal vital|deranged|co-morbid|comorbid|rapid deterior|iv sited prior|prior to arrival|significant delay/.test(notes)
      );
    },
    message:
      'ILS IV line recorded without a documented indication. GEMS funds ILS-level IV only for: fluid replacement in a depleted/compromised patient, ILS-scope medication, abnormal vitals / high deterioration risk, or an IV sited prior to your arrival. Document the indication or it is repriced to BLS.',
    source: 'GEMS EMS Claims Manual Sec 10.1 - ILS IV considered only under the listed clinical circumstances',
  },

  // ── Sec 8.3: response time 1 min/km ──
  {
    id: 'GEMS-RESPONSE-TIME-RATIO',
    schemes: ['gems'],
    phases: [4, 6],
    severity: 'warn',
    field: 'time_on_scene',
    check: (d, ctx) => {
      if (ctx.responseMinutes == null || ctx.responseKm == null || ctx.responseKm <= 0) return true;
      if (ctx.responseMinutes <= ctx.responseKm) return true;
      return /motivat|traffic|divert|access|scene safety|delay reason/.test(motivationText(d));
    },
    message:
      'Response time exceeds the GEMS ratio of 1 minute per kilometre. Document a motivation in the Motivation / Other Notes box on the first submission or the time is cut.',
    source: 'GEMS EMS Claims Manual Sec 8.3 - response to incident 1 min/km',
  },
  // ── Sec 8.3: transfer time 1.5 min/km ──
  {
    id: 'GEMS-TRANSFER-TIME-RATIO',
    schemes: ['gems'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_at_destination',
    check: (d, ctx) => {
      if (ctx.transferMinutes == null || ctx.transferKm == null || ctx.transferKm <= 0) return true;
      if (ctx.transferMinutes <= ctx.transferKm * 1.5) return true;
      return /motivat|traffic|clinical|unstable|divert|road/.test(motivationText(d));
    },
    message:
      'Scene-to-hospital transfer time exceeds the GEMS ratio of 1.5 minutes per kilometre. Document a motivation in the Motivation / Other Notes box.',
    source: 'GEMS EMS Claims Manual Sec 8.3 - scene-to-handover 1.5 min/km',
  },
  // ── Sec 8.3: handover time 15 BLS/ILS, 20 ALS/ICU ──
  {
    id: 'GEMS-HANDOVER-TIME-CAP',
    schemes: ['gems'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_handover',
    check: (d, ctx) => {
      if (ctx.handoverMinutes == null) return true;
      const lvl = billingLevel(d);
      const limit = (lvl === 'ALS' || lvl === 'ICU') ? 20 : 15;
      if (ctx.handoverMinutes <= limit) return true;
      return /motivat|clinical|unstable|complex|ongoing treatment/.test(motivationText(d));
    },
    message:
      'Hospital handover time exceeds the GEMS cap (15 min BLS/ILS, 20 min ALS/ICU). Record a motivation for the extended handover.',
    source: 'GEMS EMS Claims Manual Sec 8.3 - handover 15 min BLS/ILS, 20 min ALS/ICU',
  },
  // ── Sec 10.2: IFT with peripheral IV but no active fluid -> BLS ──
  {
    id: 'GEMS-IFT-TKVO-BLS',
    schemes: ['gems'],
    phases: [3, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      if (!isIFT(d)) return true;
      const lvl = billingLevel(d);
      if (lvl !== 'ILS' && lvl !== 'ALS' && lvl !== 'ICU') return true;
      const notes = motivationText(d);
      const tkvo = /tkvo|to keep vein open|no active fluid|short line|j-loop|j loop|prophylactic/.test(notes);
      if (!tkvo) return true;
      return /\binfus|\bbolus|fluid running|fluids up|running fluid|fluid administered|ml given|drip up/.test(notes);
    },
    message:
      'Peripheral IV with no active fluid administration (TKVO / short line / J-loop) on an IFT is billed at BLS by GEMS, not ILS. Document active fluid administration, or bill BLS.',
    source: 'GEMS EMS Claims Manual Sec 10.2 - IV with no active fluid administration billed as BLS',
  },
  // ── Sec 10 / 11: transport to non-hospital destination without authorisation ──
  {
    id: 'GEMS-NON-EMERGENCY-DEST',
    schemes: ['gems'],
    phases: [5, 6],
    severity: 'warn',
    field: 'receiving_facility',
    check: (d) => {
      const dest = String(d.receiving_facility || '').toLowerCase();
      const nonEmerg = /doctor|dr rooms|dr\.? rooms|\brooms\b|clinic|medicross|day hospital|sub-acute|subacute|old age|\bhome\b|residence|frail care/.test(dest);
      if (!nonEmerg) return true;
      return has(d, 'preauth_number') || has(d, 'emed_reference_number');
    },
    message:
      'Transport to a doctors rooms, clinic (no 24-hour trauma / overnight beds) or a residence is not covered by GEMS without EMED authorisation. Capture the authorisation, or the claim is rejected.',
    source: 'GEMS EMS Claims Manual Sec 10 & 11 - non-hospital destinations require authorisation',
  },
  // ── Sec 10.1.26: resuscitation fee requires ACLS interventions ──
  {
    id: 'GEMS-RESUS-151-ACLS',
    schemes: ['gems'],
    phases: [4, 6],
    severity: 'warn',
    field: 'resuscitation_attempted',
    check: (d) => {
      if (!d.resuscitation_attempted) return true;
      const meds = medListLower(d);
      const circ = Array.isArray(d.circulation_interventions) ? d.circulation_interventions : [];
      const air = Array.isArray(d.airway_interventions) ? d.airway_interventions : [];
      const aclsDrug = /adrenaline|amiodarone|atropine|lignocaine|lidocaine|sodium bicarb|magnesium/.test(meds);
      const aclsProc = circ.includes('Defibrillation') || circ.includes('Cardio Version') || circ.includes('Pacing') || air.includes('Intubation');
      return aclsDrug || aclsProc;
    },
    message:
      'A resuscitation fee (code 151) is only billable when ACLS interventions were used - an ALS drug, cardioversion / defibrillation, external pacing or endotracheal intubation. Record the ACLS intervention or the resuscitation fee is not paid.',
    source: 'GEMS EMS Claims Manual Sec 10.1.26 - resuscitation fee requires ACLS interventions',
  },
  // ── Sec 8.2: only one Priority 1 patient per ambulance ──
  {
    id: 'GEMS-MULTI-P1-LIMIT',
    schemes: ['gems'],
    phases: [2, 6],
    severity: 'warn',
    field: 'patient_count',
    check: (d) => {
      const isP1 = /priority\s*1|^p1$|\bp1\b/i.test(String(d.priority || ''));
      return !(isP1 && Number(d.patient_count || 1) > 1);
    },
    message:
      'Only one Priority 1 patient may be transported and billed per ambulance. Confirm the patient count / priority for this critical patient.',
    source: 'GEMS EMS Claims Manual Sec 8.2 - only one P1 patient per ambulance',
  },
  // ── Sec 10.1.16: Z-code cannot be the primary diagnosis ──
  {
    id: 'GEMS-Z-CODE-PRIMARY',
    schemes: ['gems'],
    phases: [3, 6],
    severity: 'warn',
    field: 'icd10_primary',
    check: (d) => !String(d.icd10_primary || '').trim().toUpperCase().startsWith('Z'),
    message:
      'An ICD-10 code starting with Z cannot be used as the primary diagnosis on a GEMS claim. Capture a clinical primary diagnosis code.',
    source: 'GEMS EMS Claims Manual Sec 10.1.16 - Z-codes not acceptable as a primary diagnosis',
  },
];

// ============================================================================
// RULES - ER24 Case Management Rules                          [schemes: 'er24']
//
// Source: "ER24 Case Management Rules" (clinical guidelines for assessing PRFs).
// Warn-only, like every other scheme set here. ER24 HPCSA capability matrix is
// already enforced by the scope-of-practice gate (frontend/src/data/
// hpcsaScope.ts) - these rules add ER24 billing / documentation guidelines on
// top of that.
// ============================================================================

const ER24_RULES: ValidationRule[] = [
  // -- General: reference number where possible (IFT) --
  {
    id: 'ER24-IFT-REF',
    schemes: ['er24'],
    phases: [0, 6],
    severity: 'warn',
    field: 'preauth_number',
    check: (d) => !isIFT(d) || has(d, 'preauth_number') || has(d, 'emed_reference_number'),
    message:
      'Note the ER24 reference number for this inter-facility transfer. Level-of-care transfers outside scope must be approved by the ER24 Contact Centre and the reference recorded on the PRF.',
    source: 'ER24 Case Management Rules - reference number to be noted; out-of-scope transfers approved by ER24 case manager',
  },
  // -- Mandatory member / scheme details (Medical Schemes Act 1998) --
  {
    id: 'ER24-MEMBER-NUMBER',
    schemes: ['er24'],
    phases: [2, 5, 6],
    severity: 'warn',
    field: 'medical_aid_number',
    check: (d) => {
      const bt = String(d.billing_type || '').toUpperCase();
      if (bt && !bt.includes('MED')) return true;
      return has(d, 'medical_aid_number');
    },
    message:
      'Membership number is mandatory under the Medical Schemes Act. An account submitted without it is rejected immediately. Capture the member number.',
    source: 'ER24 Case Management Rules - Medical Schemes Act 1998 mandatory fields (membership number)',
  },
  {
    id: 'ER24-SCHEME-OPTION',
    schemes: ['er24'],
    phases: [5, 6],
    severity: 'warn',
    field: 'scheme_option',
    check: (d) => {
      const bt = String(d.billing_type || '').toUpperCase();
      if (bt && !bt.includes('MED')) return true;
      return has(d, 'scheme_option') || has(d, 'plan_option');
    },
    message:
      'Medical scheme option/plan is a mandatory account field under the Medical Schemes Act. Record the scheme option (the benefit plan of the member).',
    source: 'ER24 Case Management Rules - Medical Schemes Act 1998 mandatory fields (scheme details incl. option)',
  },
  // -- Diagnosis required (ICD-10) --
  {
    id: 'ER24-DIAGNOSIS',
    schemes: ['er24'],
    phases: [3, 6],
    severity: 'warn',
    field: 'icd10_primary',
    check: (d) => /^[A-Z]\d{2}(\.\d{1,3})?$/.test(String(d.icd10_primary || '').trim().toUpperCase()),
    message:
      'A diagnosis with a valid ICD-10 code is a mandatory account field (e.g. I21.0). Capture the primary ICD-10 code.',
    source: 'ER24 Case Management Rules - Medical Schemes Act 1998 mandatory fields (diagnosis + codes)',
  },
  // -- Minimum vitals: 2 (3 for IFT, first at referring hospital) --
  {
    id: 'ER24-MIN-VITALS',
    schemes: ['er24'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'vitals_sets',
    check: (d, ctx) => {
      if (has(d, 'vitals_shortfall_motivation')) return true;
      const need = isIFT(d) ? 3 : 2;
      return ctx.vitalsCount >= need;
    },
    message:
      'ER24 requires a minimum of 2 sets of vitals on all patients, and 3 sets for inter-facility transfers (the first recorded at the referring hospital). Capture another set with the "+ VITALS" button.',
    source: 'ER24 Case Management Rules - minimum 2 sets of vitals (3 for IFT, first at referring hospital)',
  },
  // -- IV access only under the 3 accepted guidelines --
  {
    id: 'ER24-IV-JUSTIFY',
    schemes: ['er24'],
    phases: [3, 6],
    severity: 'warn',
    field: 'iv_therapy',
    check: (d, ctx) => {
      if (ctx.ivCount === 0) return true;
      const meds = ctx.medTypesLower;
      const notes = motivationText(d);
      return (
        /dextrose/.test(meds) ||
        /fluid replac|iv medication|iv drug|during transport|rapidly deterior|rapid deterior|abnormal vital|unstable|deranged|hypotens|hyperglyc|burn|dehydrat|overdose|poison/.test(notes)
      );
    },
    message:
      'IV access recorded without a documented indication. ER24 funds IV only for fluid replacement, IV medication during transport, or a patient who can rapidly deteriorate with abnormal vitals, otherwise it is rejected. Document the reason in the Motivation / Other Notes box.',
    source: 'ER24 Case Management Rules - IV access established only under the listed guidelines, else downgraded to BLS',
  },
  // -- Oral medication results in BLS when transported --
  {
    id: 'ER24-ORAL-MEDS-BLS',
    schemes: ['er24'],
    phases: [3, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      if (!onlyOralMeds(d)) return true;
      const transported = !!d.receiving_facility || has(d, 'time_at_destination');
      if (!transported) return true;
      return billingLevel(d) === 'BLS' || billingLevel(d) === '';
    },
    message:
      'Only oral medication was administered. ER24 does not consider the oral route a life-saving intervention, so a transported patient is refunded at BLS. Bill this call at BLS.',
    source: 'ER24 Case Management Rules - oral medication refunded at BLS tariff if patient transported',
  },
  // -- Resus fee: post-CPR ALS, alive at hospital, >=2 interventions/2 systems --
  {
    id: 'ER24-RESUS-CRITERIA',
    schemes: ['er24'],
    phases: [4, 6],
    severity: 'warn',
    field: 'resuscitation_attempted',
    check: (d) => {
      if (!d.resuscitation_attempted) return true;
      const lvl = billingLevel(d);
      const isAls = lvl === 'ALS' || lvl === 'ICU';
      const aliveAtHospital = !!d.rosc_achieved || !!d.perfusing_rhythm_on_handover;
      return isAls && aliveAtHospital && alsSystemsCount(d) >= 2;
    },
    message:
      'A resuscitation fee with transport is only chargeable for a post-CPR ALS patient who arrives alive at hospital after at least 2 different interventions in 2 different systems (e.g. intubation + IV drug). An ALS resus fee can never be charged for an ILS attempt.',
    source: 'ER24 Case Management Rules - resuscitation fee: 2 interventions in 2 systems, patient alive at hospital',
  },
  // -- DOD / futile resus is non-chargeable --
  {
    id: 'ER24-DOD-NONCHARGE',
    schemes: ['er24'],
    phases: [3, 6],
    severity: 'warn',
    check: (d) => {
      const dod = String(d.call_type || '').toUpperCase() === 'DOD' || !!d.med_aid_dec_death;
      if (!dod) return true;
      return !d.resuscitation_attempted;
    },
    message:
      'Declaration of Death or a futile resuscitation attempt is non-chargeable at ER24 (exceptions discussed case-by-case). Do not bill a resuscitation fee on a DOD unless ER24 has agreed.',
    source: 'ER24 Case Management Rules - DOD / futile resus initiation non-chargeable',
  },
  // -- Non-medically-justified categories: document justification --
  {
    id: 'ER24-NON-JUSTIFIED-TRANSPORT',
    schemes: ['er24'],
    phases: [3, 6],
    severity: 'warn',
    field: 'chief_complaint',
    check: (d) => {
      const cc = String(d.chief_complaint || '').toLowerCase();
      const flagged = /abdominal pain|gastroenter|obstetric|term deliver|\bent\b|malaise|general body|weakness|headache|syncope|anxiety|backache/.test(cc);
      if (!flagged) return true;
      const notes = motivationText(d);
      return notes.length > 40 || /unstable|abnormal|hypotens|tachycard|gcs|spinal|trauma|justif|motivat/.test(notes);
    },
    message:
      'This presenting complaint falls in the ER24 non-medically-justified review list. Clearly document why ambulance transport was clinically necessary, and advise the patient they may be liable if it is deemed unnecessary.',
    source: 'ER24 Case Management Rules - non-medically-justified categories require documented justification',
  },
  // -- Closest appropriate facility --
  {
    id: 'ER24-CLOSEST-FACILITY',
    schemes: ['er24'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'closest_facility_bypassed',
    check: (d) => {
      if (!d.closest_facility_bypassed) return true;
      const notes = motivationText(d);
      return /motivat|nearest unable|no capacity|specialis|cath lab|trauma unit|not appropriate/.test(notes);
    },
    message:
      'Closest appropriate facility bypassed. ER24 holds any deviation to the patient or service-provider account unless justified. Document the clinical reason in the Motivation / Other Notes box.',
    source: 'ER24 Case Management Rules - transport to closest most appropriate facility; deviations for own account',
  },
  // -- Scene time: 20 min (primary and IFT); ICU 45 with motivation --
  {
    id: 'ER24-SCENE-TIME',
    schemes: ['er24'],
    phases: [4, 6],
    severity: 'warn',
    check: (d, ctx) => {
      if (ctx.sceneMinutes === null) return true;
      const lvl = billingLevel(d);
      const limit = lvl === 'ICU' ? 45 : 20;
      if (ctx.sceneMinutes <= limit) return true;
      return /motivat|extricat|entrap|delay|analges|difficult|complex|prolong/.test(motivationText(d));
    },
    message:
      'On-scene time exceeds the ER24 allowance (20 min for primary and most IFTs; 45 min for ICU transfers). Record a motivation in the Motivation / Other Notes box or the extra time will be cut.',
    source: 'ER24 Case Management Rules - scene-time allowance 20 min (ICU 45 min with motivation)',
  },
  // -- Only one RED (P1) patient per ALS practitioner --
  {
    id: 'ER24-RED-PATIENT-ALS',
    schemes: ['er24'],
    phases: [2, 6],
    severity: 'warn',
    field: 'patient_count',
    check: (d) => {
      const isRed = /priority\s*1|^p1$|\bp1\b/i.test(String(d.priority || ''));
      const count = Number(d.patient_count || 1);
      return !(isRed && count > 1);
    },
    message:
      'Only one RED (Priority 1) patient may be transported per ALS practitioner, for both primary responses and IFTs. Confirm crewing / patient allocation for this critical patient.',
    source: 'ER24 Case Management Rules - only 1 RED patient per ALS practitioner per vehicle',
  },
  // -- Handover + patient signature --
  {
    id: 'ER24-HANDOVER-SIG',
    schemes: ['er24'],
    phases: [5, 6],
    severity: 'warn',
    check: (_d, ctx) => ctx.hasHandoverSig,
    message:
      'Every ER24 PRF must carry a handover signature from the receiving facility. Capture the handover signature.',
    source: 'ER24 Case Management Rules - all PRFs should have a handover signature',
  },
  {
    id: 'ER24-PATIENT-SIG',
    schemes: ['er24'],
    phases: [6],
    severity: 'warn',
    check: (d, ctx) => ctx.hasPatientSig || has(d, 'signature_refused_reason') || ctx.hasCrew2,
    message:
      'Every ER24 PRF must carry a patient / legal-guardian signature. If the patient refuses, capture a witness signature and note the refusal.',
    source: 'ER24 Case Management Rules - all PRFs should have a patient / legal-guardian signature',
  },

  // ── Non-emergency presentation may be repudiated (patient liable) ──
  {
    id: 'ER24-NON-EMERGENCY-REJECT',
    schemes: ['er24'],
    phases: [3, 6],
    severity: 'warn',
    field: 'chief_complaint',
    check: (d) => {
      const cc = String(d.chief_complaint || '').toLowerCase();
      const nonEmerg = /routine transport|alternative transport|general weakness|common sprain|superficial cut|painful urination|normal pregnancy|flu without fever/.test(cc);
      if (!nonEmerg) return true;
      const notes = motivationText(d);
      return notes.length > 40 || /emergenc|acute|unstable|abnormal|hypotens|tachycard|justif|severe/.test(notes);
    },
    message:
      'This presentation may be assessed by ER24 as non-emergency (scheme repudiates, patient liable). Document the clinical justification for emergency ambulance transport.',
    source: 'ER24/Mediclinic Billing - non-emergency call-outs repudiated for scheme funding',
  },
  // ── Refusal with only BLS / first-aid -> bill privately ──
  {
    id: 'ER24-RHT-BLS-PRIVATE',
    schemes: ['er24'],
    phases: [5, 6],
    severity: 'warn',
    field: 'billing_type',
    check: (d) => {
      const refused = String(d.call_type || '').toUpperCase() === 'RHT' || !!d.patient_refused_transport;
      if (!refused) return true;
      const lvl = billingLevel(d);
      return lvl === 'ILS' || lvl === 'ALS' || lvl === 'ICU';
    },
    message:
      'Patient refused transport with only first-aid / BLS care (oxygen, bandage, vitals). This cannot be billed to the scheme - bill the patient privately as a call-out fee.',
    source: 'ER24/Mediclinic Billing - RHT with BLS-only care is member-liable (private)',
  },
  // ── Refusal after ILS+ stabilisation -> code 125 ──
  {
    id: 'ER24-RHT-ILS-BILLABLE',
    schemes: ['er24'],
    phases: [5, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const refused = String(d.call_type || '').toUpperCase() === 'RHT' || !!d.patient_refused_transport;
      if (!refused) return true;
      const lvl = billingLevel(d);
      return !(lvl === 'ILS' || lvl === 'ALS' || lvl === 'ICU');
    },
    message:
      'Billing tip: patient refused transport after successful ILS/ALS stabilisation (e.g. Dextrose, nebulisation) - bill code 125 (treatment on scene) for up to 45 minutes.',
    source: 'ER24/Mediclinic Billing - RHT after ILS+ stabilisation bills code 125 up to 45 min',
  },
  // ── Response time 1 min/km ──
  {
    id: 'ER24-RESPONSE-TIME-RATIO',
    schemes: ['er24'],
    phases: [4, 6],
    severity: 'warn',
    field: 'time_on_scene',
    check: (d, ctx) => {
      if (ctx.responseMinutes == null || ctx.responseKm == null || ctx.responseKm <= 0) return true;
      if (ctx.responseMinutes <= ctx.responseKm) return true;
      return /motivat|traffic|divert|access|scene safety|delay reason/.test(motivationText(d));
    },
    message:
      'Response time exceeds the ER24 ratio of 1 minute per kilometre (60 km/h). Document a motivation in the Motivation / Other Notes box or the extra time is cut on audit.',
    source: 'ER24/Mediclinic Billing - dispatch-to-scene max 1 min/km',
  },
  // ── Transfer time 1.5 min/km ──
  {
    id: 'ER24-TRANSFER-TIME-RATIO',
    schemes: ['er24'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_at_destination',
    check: (d, ctx) => {
      if (ctx.transferMinutes == null || ctx.transferKm == null || ctx.transferKm <= 0) return true;
      if (ctx.transferMinutes <= ctx.transferKm * 1.5) return true;
      return /motivat|traffic|clinical|unstable|divert|road/.test(motivationText(d));
    },
    message:
      'Scene-to-hospital time exceeds the ER24 ratio of 1.5 minutes per kilometre (40 km/h). Document a motivation in the Motivation / Other Notes box.',
    source: 'ER24/Mediclinic Billing - scene-to-hospital max 1.5 min/km',
  },
  // ── Handover time 10 min BLS/ILS, 20 min ALS ──
  {
    id: 'ER24-HANDOVER-TIME',
    schemes: ['er24'],
    phases: [5, 6],
    severity: 'warn',
    field: 'time_handover',
    check: (d, ctx) => {
      if (ctx.handoverMinutes == null) return true;
      const lvl = billingLevel(d);
      const limit = (lvl === 'ALS' || lvl === 'ICU') ? 20 : 10;
      if (ctx.handoverMinutes <= limit) return true;
      return /motivat|clinical|unstable|ongoing treatment/.test(motivationText(d));
    },
    message:
      'Hospital handover time exceeds the ER24 cap (10 min BLS/ILS, 20 min ALS). Record a motivation or the time is cut.',
    source: 'ER24/Mediclinic Billing - handover 10 min BLS/ILS, 20 min ALS',
  },
  // ── Return distance cap 20 km unless tracking report ──
  {
    id: 'ER24-RETURN-DISTANCE-CAP',
    schemes: ['er24'],
    phases: [6],
    severity: 'warn',
    field: 'transfer_subtype',
    check: (d, ctx) => {
      const st = String(d.transfer_subtype || '').toLowerCase();
      if (!st.includes('return')) return true;
      if (d.vehicle_tracking_report) return true;
      if (ctx.returnKm == null || ctx.patientCarryingKm == null) return true;
      return ctx.returnKm <= ctx.patientCarryingKm + 20;
    },
    message:
      'Return-to-base distance (codes 9112 / 9130 / 9142) exceeds the patient-carrying distance by more than 20 km. Attach a vehicle tracking report to claim the extra kilometres.',
    source: 'ER24/Mediclinic Billing - return distance max 20 km beyond loaded unless tracking report',
  },
  // ── Invalid (non-clinical) delay motivations ──
  {
    id: 'ER24-INVALID-DELAY',
    schemes: ['er24'],
    phases: [4, 5, 6],
    severity: 'warn',
    field: 'management_notes',
    check: (d) => {
      const notes = motivationText(d);
      return !/waiting for (a )?(hospital )?bed|awaiting bed|no beds|paperwork|waiting for papers|police|tow truck|tow-truck|towing/.test(notes);
    },
    message:
      'Delay motivations citing waiting for a hospital bed, police, paperwork or a tow truck are invalid for ER24 and cause rejection. Replace with a clinical reason or remove it.',
    source: 'ER24/Mediclinic Billing - non-clinical delay motivations invalid',
  },
  // ── IFT over 100 km needs pre-authorisation ──
  {
    id: 'ER24-IFT-PREAUTH-100KM',
    schemes: ['er24'],
    phases: [4, 6],
    severity: 'warn',
    field: 'preauth_number',
    check: (d, ctx) => {
      if (!isIFT(d)) return true;
      const km = ctx.patientCarryingKm;
      if (km === null || km <= 100) return true;
      return has(d, 'preauth_number');
    },
    message:
      'Inter-facility transfers over 100 km must be pre-authorised by the ER24 / Mediclinic Contact Centre before the trip. Capture the pre-authorisation number.',
    source: 'ER24/Mediclinic Billing - IFT over 100 km requires prior pre-authorisation',
  },
  // ── IFT defaults to BLS unless higher need documented ──
  {
    id: 'ER24-IFT-DEFAULT-BLS',
    schemes: ['er24'],
    phases: [3, 4, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      if (!isIFT(d)) return true;
      const lvl = billingLevel(d);
      if (lvl === '' || lvl === 'BLS') return true;
      const notes = motivationText(d);
      return !!String(d.referring_doctor || '').trim() || /icu|ventilat|infus|monitor|inotrop|sedat|unstable|deranged|clinical|referr/.test(notes);
    },
    message:
      'Inter-facility transfers default to BLS billing. To bill ILS/ALS, document the referring doctor and the higher clinical need on the PRF, or ER24 rejects the claim.',
    source: 'ER24/Mediclinic Billing - IFT defaults to BLS unless higher need documented',
  },
  // ── Social transfer member-liable unless pre-authorised ──
  {
    id: 'ER24-SOCIAL-TRANSFER-LIABILITY',
    schemes: ['er24'],
    phases: [2, 6],
    severity: 'warn',
    field: 'preauth_number',
    check: (d) => {
      const st = String(d.transfer_subtype || '').toLowerCase();
      const social = st.includes('social') || st.includes('residence') || st.includes('home') || st.includes('old age') || st.includes('psych');
      if (!social) return true;
      return has(d, 'preauth_number');
    },
    message:
      'Social transfers (e.g. to home or an old-age home) are generally not covered - the patient is liable unless pre-authorised. Confirm funding and capture the pre-auth number.',
    source: 'ER24/Mediclinic Billing - social transfers member-liable unless pre-authorised',
  },
  // ── BLS supervision: two BAAs need a supervising practitioner ──
  {
    id: 'ER24-BLS-SUPERVISION',
    schemes: ['er24'],
    phases: [6],
    severity: 'warn',
    check: (d, ctx) => {
      if (billingLevel(d) !== 'BLS') return true;
      return ctx.hasCrew2 || has(d, 'supervising_practitioner_pr') || has(d, 'supervising_practitioner_name');
    },
    message:
      'Two Basic Ambulance Assistants are not independent practitioners. A BLS claim must include the supervising practitioner name, signature and HPCSA number on the PRF.',
    source: 'ER24/Mediclinic Billing - BLS by two BAAs requires a supervising practitioner',
  },
  // ── Prophylactic ALS downgraded ──
  {
    id: 'ER24-ALS-PROPHYLACTIC',
    schemes: ['er24'],
    phases: [3, 6],
    severity: 'warn',
    field: 'assessment_level',
    check: (d) => {
      const lvl = billingLevel(d);
      if (lvl !== 'ALS' && lvl !== 'ICU') return true;
      const meds = medListLower(d);
      const circ = Array.isArray(d.circulation_interventions) ? d.circulation_interventions : [];
      const air = Array.isArray(d.airway_interventions) ? d.airway_interventions : [];
      const alsMed = /adrenaline|amiodarone|atropine|morphine|fentanyl|ketamine|midazolam|naloxone|adenosine|tranexamic/.test(meds);
      const alsProc = circ.includes('Cardio Version') || circ.includes('Pacing') || air.includes('Intubation') || air.includes('Surg. Airway');
      const motivated = !!String(d.referring_doctor || '').trim() || /indication|interaction|active nausea|referr/.test(motivationText(d));
      return alsMed || alsProc || motivated;
    },
    message:
      'ALS billed but only prophylactic / monitoring interventions are documented (e.g. 12-lead for monitoring, anti-emetic without active nausea). ER24 rejects the claim unless an ALS drug/procedure or clinical indication is recorded.',
    source: 'ER24/Mediclinic Billing - prophylactic ALS downgraded to a lower level of care',
  },
  // ── 4th (or further) patient not billable ──
  {
    id: 'ER24-MULTI-PATIENT-4TH-PLUS',
    schemes: ['er24'],
    phases: [2, 6],
    severity: 'warn',
    field: 'patient_count',
    check: (d) => Number(d.patient_count || 1) < 4,
    message:
      'A fourth (or further) patient transported in the same ambulance cannot be billed to ER24 (0%). Confirm the patient count and vehicle allocation.',
    source: 'ER24/Mediclinic Billing - multi-patient 100/75/50/0%; 4th+ not billable',
  },
];

// Register every scheme's rules into the shared RULES table. Each rule is
// scheme-scoped (Netcare / Discovery / GEMS / ER24); validatePhase() surfaces
// only the active scheme's rules, and always as non-blocking warnings - a crew
// on a live call is never blocked by a billing rule (June 2026 crew-safety policy).
// Post-submit adjudication + tariff pricing are unaffected (they don't call this).
RULES.push(...DISCOVERY_RULES, ...GEMS_RULES, ...ER24_RULES);

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
    responseMinutes: mins(ts.time_dispatched, ts.time_on_scene),
    responseKm: (() => { const a = num(km.km_dispatched), b = num(km.km_on_scene); return a !== null && b !== null && b >= a ? b - a : null; })(),
    transferMinutes: mins(ts.time_depart_scene, ts.time_at_destination),
    transferKm: (() => { const a = num(km.km_depart_scene), b = num(km.km_at_destination); return a !== null && b !== null && b >= a ? b - a : null; })(),
    handoverMinutes: mins(ts.time_at_destination, ts.time_handover),
    returnKm: (() => { const a = num(km.km_at_destination), b = num(km.km_back_to_base); return a !== null && b !== null && b >= a ? b - a : null; })(),
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
  // suppressed. We surface ONLY the active scheme's guidance, and ONLY as
  // non-blocking warnings, so a Discovery claim shows amber "may be downgraded /
  // rejected" nudges the crew can act on but can always submit past. Post-submit
  // adjudication and tariff pricing are unaffected (they don't call this).
  const scheme = normalizeScheme(schemeId);
  if (!scheme) return [];

  const findings: ValidationFinding[] = [];
  for (const r of RULES) {
    if (!r.schemes.includes(scheme) && !r.schemes.includes('all')) continue;
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
