/**
 * HPCSA Scope of Practice Matrix
 *
 * Authoritative source for what each registered EMS practitioner category is
 * allowed to perform. Used to:
 *   1. Block PRF creation when neither crew member can practise above BAA
 *      (Basic Ambulance Assistant) and the call requires it.
 *   2. Gate the Clinical phase of the Digital PRF on identifying the treating
 *      practitioner so only their authorised actions are offered.
 *   3. Validate each individual intervention (airway, ventilation, circulation,
 *      drug administration) against the treating practitioner's category.
 *
 * This file is fed page-by-page from the HPCSA Professional Board for Emergency
 * Care scope tables. Each section corresponds to one published table. Adding a
 * section is purely additive — no existing entries should be reshaped.
 *
 * IMPORTANT: This is the source of truth for the UI. The backend should mirror
 * the same matrix (or import a generated version of it) before relying on
 * client-side gating for any audit / billing claim.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Category codes
// ─────────────────────────────────────────────────────────────────────────────

/** HPCSA registration categories (six recognised tiers). */
export type HpcsaCategory =
  | 'BAA'  // Basic Ambulance Assistant         (BLS tier)
  | 'AEA'  // Ambulance Emergency Assistant     (ILS tier)
  | 'ECT'  // Emergency Care Technician         (own tier)
  | 'ECA'  // Emergency Care Assistant          (own tier)
  | 'ANT'  // CCA — Critical Care Assistant     (ALS tier)
  | 'ECP'; // Emergency Care Practitioner       (ALS tier)

export const HPCSA_CATEGORIES: readonly HpcsaCategory[] = [
  'BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP',
] as const;

/** Display metadata for each category — used by pickers and badges. */
export const CATEGORY_META: Record<HpcsaCategory, { label: string; tier: 'BLS' | 'ILS' | 'ALS' | 'ECT' | 'ECA' }> = {
  BAA: { label: 'Basic Ambulance Assistant',     tier: 'BLS' },
  AEA: { label: 'Ambulance Emergency Assistant', tier: 'ILS' },
  ECT: { label: 'Emergency Care Technician',     tier: 'ECT' },
  ECA: { label: 'Emergency Care Assistant',      tier: 'ECA' },
  ANT: { label: 'Critical Care Assistant',       tier: 'ALS' },
  ECP: { label: 'Emergency Care Practitioner',   tier: 'ALS' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Capability matrix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single capability row from an HPCSA scope table.
 *
 * - `authorised` lists every category permitted to perform the capability.
 * - `forbidden` is reserved for rows the HPCSA explicitly marks "NOT TO BE
 *   PERFORMED" by anyone (e.g. non-drug-facilitated ETT). When set, no category
 *   may perform the action regardless of `authorised`.
 * - `note` captures any qualifier shown in the source table cell (e.g. "CA"
 *   meaning Cardiac Arrest only) so the UI can surface it at point-of-use.
 */
export interface Capability {
  /** Stable machine key — used in PRF data and audit logs. */
  key: string;
  /** Human-readable name from the HPCSA scope table. */
  label: string;
  /** Categories explicitly authorised to perform this capability. */
  authorised: readonly HpcsaCategory[];
  /** True when HPCSA forbids the capability for ALL categories. */
  forbidden?: true;
  /** Per-category qualifiers (e.g. ECA may only do this in Cardiac Arrest). */
  conditions?: Partial<Record<HpcsaCategory, string>>;
  /** Free-text note printed alongside the capability. */
  note?: string;
}

export interface CapabilitySection {
  /** Section name from the HPCSA table header (e.g. "Airway Management"). */
  name: string;
  capabilities: readonly Capability[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Page 1 — Airway Management
// Source: HPCSA Professional Board for Emergency Care, scope of practice table.
// Captured 2026-05-16.
// ─────────────────────────────────────────────────────────────────────────────

const airwayManagement: CapabilitySection = {
  name: 'Airway Management',
  capabilities: [
    {
      key: 'airway_basic_manual_manoeuvres',
      label: 'Basic manual airway manoeuvres',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'airway_suction_upper',
      label: 'Suctioning of the airway — upper',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'airway_suction_endotracheal',
      label: 'Suctioning of the airway — endotracheal',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'airway_suction_extraglottic',
      label: 'Suctioning of the airway — extraglottic',
      authorised: ['ECA', 'ANT', 'ECP'],
    },
    {
      key: 'airway_manual_obstruction_conscious_choking',
      label: 'Manual airway obstruction manoeuvres (conscious choking patient)',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'airway_magills_forceps',
      label: "Use of Magill's forceps / equivalent",
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'airway_opa_insertion',
      label: 'Oropharyngeal airway insertion',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'airway_npa_insertion',
      label: 'Nasopharyngeal tube airway insertion',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'airway_ett_drug_facilitated',
      label: 'Endotracheal intubation — drug-facilitated (induction, neuromuscular blockade, mechanical ventilation, airway adjuncts)',
      authorised: ['ECP'],
    },
    {
      key: 'airway_ett_non_drug_or_deep_sedation',
      label: 'Endotracheal intubation — non-drug facilitated or via deep sedation techniques',
      authorised: [],
      forbidden: true,
      note: 'HPCSA: NOT TO BE PERFORMED by any category.',
    },
    {
      key: 'airway_video_laryngoscopy',
      label: 'Video laryngoscopy',
      authorised: ['ECP'],
    },
    {
      key: 'airway_supraglottic_extraglottic_device',
      label: 'Supraglottic / extraglottic airway device insertion',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
      conditions: {
        ECA: 'Cardiac Arrest only',
      },
    },
    {
      key: 'airway_oro_nasogastric_tube',
      label: 'Oro / nasogastric tube insertion',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'airway_needle_cricothyroidotomy',
      label: 'Needle cricothyroidotomy',
      authorised: ['AEA', 'ECT', 'ANT', 'ECP'],
    },
    {
      key: 'airway_surgical_cricothyroidotomy',
      label: 'Surgical cricothyroidotomy (adolescent / adult)',
      authorised: ['ECT', 'ANT', 'ECP'],
      note: 'Commercial device recommended.',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Page 2 — Oxygenation and Ventilation
// Source: HPCSA Professional Board for Emergency Care, scope of practice table.
// Captured 2026-05-16.
// ─────────────────────────────────────────────────────────────────────────────

const oxygenationVentilation: CapabilitySection = {
  name: 'Oxygenation and Ventilation',
  capabilities: [
    {
      key: 'o2_oxygen_administration',
      label: 'Oxygen administration',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_nebulisation_in_scope',
      label: 'Nebulisation of medications on scope of practice',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_pulse_oximetry',
      label: 'Use of pulse oximetry',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_needle_thoracentesis_adult_paed',
      label: 'Needle thoracentesis (adult and paediatric)',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_needle_thoracentesis_neonate',
      label: 'Needle thoracentesis (neonate)',
      authorised: ['ECP'],
    },
    {
      key: 'o2_bvm_manual_ventilation',
      label: 'Bag-valve mask manual ventilation',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_bvt_manual_ventilation',
      label: 'Bag-valve tube manual ventilation',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_interfacility_mech_vent_paed_adult',
      label: 'Interfacility mechanical ventilation (paediatric and adult — without cardiovascular support)',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'o2_mechanical_ventilation_neonate',
      label: 'Mechanical ventilation (neonate)',
      authorised: ['ECP'],
    },
    {
      key: 'o2_niv_with_mechanical_ventilator',
      label: 'Non-invasive ventilation with mechanical ventilator',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'o2_niv_oxygen_driven',
      label: 'Non-invasive ventilation — oxygen driven (without mechanical ventilator)',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_mechanical_infant_resuscitator',
      label: 'Mechanical infant resuscitator',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_capnography_ett_extraglottic',
      label: 'Use of capnography / capnometry — via endotracheal tube / extraglottic device',
      authorised: ['ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_capnography_facemask_nasal',
      label: 'Use of capnography / capnometry — via facemask / nasal cannula',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'o2_humidification',
      label: 'Humidification',
      authorised: ['ANT', 'ECP'],
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Page 3 — Circulatory Management
// Source: HPCSA Professional Board for Emergency Care, scope of practice table.
// Captured 2026-05-16.
// ─────────────────────────────────────────────────────────────────────────────

const circulatoryManagement: CapabilitySection = {
  name: 'Circulatory Management',
  capabilities: [
    {
      key: 'circ_bp_measurement_nibp',
      label: 'Blood pressure measurement including the use of NIBP (automated)',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_iv_cannulation_limbs_over_1yr',
      label: 'Peripheral intravenous cannulation as per relevant protocol — limbs and hands (all ages > 1 year old)',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_iv_cannulation_limbs_under_1yr',
      label: 'Peripheral intravenous cannulation as per relevant protocol — limbs and hands (< 1 year old)',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_iv_cannulation_infant_scalp',
      label: 'Peripheral intravenous cannulation as per relevant protocol — infant scalp',
      authorised: ['ECP'],
    },
    {
      key: 'circ_external_jugular_cannulation',
      label: 'External jugular vein cannulation',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_intraosseous_all_ages',
      label: 'Intra-osseous insertion — all ages',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'circ_intraosseous_adult',
      label: 'Intra-osseous insertion — adult',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_umbilical_vein_cannulation',
      label: 'Umbilical vein cannulation',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'circ_iv_fluid_therapy_adult',
      label: 'Intravenous fluid therapy (for purposes other than drug administration) — adult',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_iv_fluid_therapy_infant_paed',
      label: 'Intravenous fluid therapy (for purposes other than drug administration) — infant and paediatric',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'circ_oral_rehydration',
      label: 'Oral rehydration',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_oral_rehydration_via_ngt',
      label: 'Oral rehydration via NGT',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_drug_admin_iv_io',
      label: 'Intravenous / intraosseous drug administration as per scope of practice',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_drug_admin_subcutaneous',
      label: 'Subcutaneous drug administration as per scope of practice',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_drug_admin_intramuscular',
      label: 'Intramuscular drug administration as per scope of practice',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    // ── Page 4 continuation (captured 2026-05-16) ────────────────────────────
    {
      key: 'circ_drug_admin_endotracheal',
      label: 'Endotracheal drug administration',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_iv_infusion_devices',
      label: 'Use of intravenous infusion devices including pressure infuser, volumetric infusion pump and syringe driver',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'circ_external_haemorrhage_control',
      label: 'External haemorrhage control including use of tourniquet',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_topical_haemostatic_agents',
      label: 'Topical haemostatic agents',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_pneumatic_anti_shock_garment',
      label: 'Use of pneumatic anti-shock garment',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_non_pneumatic_anti_shock_garment',
      label: 'Use of non-pneumatic anti-shock garment',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_aed',
      label: 'Automated external defibrillation (AED)',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_manual_defibrillation',
      label: 'Manual defibrillation (asynchronous)',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_precordial_thump',
      label: 'Precordial thump',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_synchronised_cardioversion',
      label: 'Synchronised cardioversion',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_vagal_manoeuvres',
      label: 'Vagal manoeuvres',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_central_line_management',
      label: 'Central line management of lines in-situ',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_transcutaneous_cardiac_pacing',
      label: 'Transcutaneous cardiac pacing',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'circ_3_lead_ecg',
      label: '3-Lead ECG monitoring and diagnosis as per scope of practice',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'circ_12_lead_ecg_diagnosis',
      label: '12-Lead ECG diagnosis',
      authorised: ['ECP'],
    },
    {
      key: 'circ_fibrinolysis',
      label: 'Fibrinolysis (with documented telemetry or equivalent)',
      authorised: ['ECP'],
    },
    {
      key: 'circ_targeted_temperature_management',
      label: 'Targeted temperature management (inter-facility transfer and where capabilities exist)',
      authorised: ['ECP'],
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Page 5 (top half) — Obstetric Management
// Source: HPCSA Professional Board for Emergency Care, scope of practice table.
// Captured 2026-05-16.
// Every row authorises ALL six categories — the entire obstetric set is
// considered core scope for every registered practitioner.
// ─────────────────────────────────────────────────────────────────────────────

const ALL_CATEGORIES: readonly HpcsaCategory[] = ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'];

const obstetricManagement: CapabilitySection = {
  name: 'Obstetric Management',
  capabilities: [
    {
      key: 'ob_normal_vaginal_delivery',
      label: 'Normal vaginal delivery as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'ob_prolapsed_cord_management',
      label: 'Prolapsed cord management as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'ob_breech_delivery_management',
      label: 'Breech delivery management as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'ob_mal_presentations_management',
      label: 'Mal-presentations management as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'ob_preterm_labour_management',
      label: 'Preterm labour management as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'ob_obstructed_labour_management',
      label: 'Obstructed labour management as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'ob_postpartum_haemorrhage_management',
      label: 'Post-partum haemorrhage management as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Page 5 (bottom half) — Diagnostic and Clinical Aids
// Captured 2026-05-16.
// ─────────────────────────────────────────────────────────────────────────────

const diagnosticAndClinicalAids: CapabilitySection = {
  name: 'Diagnostic and Clinical Aids',
  capabilities: [
    {
      key: 'diag_ultrasound',
      label: 'Use of ultrasound',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'diag_fundoscopy',
      label: 'Fundoscopy',
      authorised: ['ECP'],
    },
    {
      key: 'diag_otoscope',
      label: 'Use of an otoscope',
      authorised: ['ECP'],
    },
    {
      key: 'diag_snellen_chart',
      label: 'Use of a Snellen chart',
      authorised: ['ECP'],
    },
    {
      key: 'diag_abg_sampling_and_analysis',
      label: 'Arterial blood gas sampling and analysis',
      authorised: ['ECP'],
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Page 6 — General
// Captured 2026-05-16.
// Three rows reference HPCSA footnotes (¹ Spinal Movement Restriction,
// ² Withholding resuscitation, ³ On-scene discharge). The footnote text was
// not in the supplied table, so the exact qualifier is captured in `note`
// and per-category `conditions` for later refinement once the footnote bodies
// are known.
// ─────────────────────────────────────────────────────────────────────────────

const generalCare: CapabilitySection = {
  name: 'General',
  capabilities: [
    {
      key: 'gen_cardiac_arrest_management',
      label: 'Cardiac arrest management (adult, child, infant & neonate) as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_clinical_assessment',
      label: 'Clinical assessment (as per level of care)',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_vital_sign_assessment',
      label: 'Vital sign assessment',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_finger_prick_glucose',
      label: 'Finger prick and blood glucose measurement (manual and electronic)',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_peak_flow',
      label: 'Peak flow measurement and interpretation',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'gen_poc_blood_sampling_capillary',
      label: 'Point of care blood sampling (capillary)',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'gen_cervical_spinal_clearance',
      label: 'Cervical spinal clearance',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'gen_spinal_movement_restriction',
      label: 'Spinal movement restriction',
      authorised: ALL_CATEGORIES,
      note: 'HPCSA footnote ¹ applies — definition pending from source table.',
    },
    {
      key: 'gen_limb_splints',
      label: 'Application of limb splints',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_pelvic_binding',
      label: 'Application of pelvic binding devices',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_vacuum_mattress',
      label: 'Application of vacuum mattress',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_urinary_catheterization',
      label: 'Urinary catheterisation',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'gen_emergency_wound_care',
      label: 'Emergency wound care as per scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_suturing',
      label: 'Suturing',
      authorised: ['ECP'],
    },
    {
      key: 'gen_withdrawal_of_resuscitation',
      label: 'Withdrawal of resuscitation efforts',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'gen_withholding_resuscitation',
      label: 'Withholding resuscitation',
      authorised: ALL_CATEGORIES,
      conditions: {
        BAA: 'Per HPCSA footnote ² — definition pending from source table.',
      },
      note: 'HPCSA footnote ² applies — definition pending from source table.',
    },
    {
      key: 'gen_on_scene_discharge',
      label: 'On-scene discharge',
      authorised: ['ECP'],
      note: 'HPCSA footnote ³ applies — definition pending from source table.',
    },
    {
      key: 'gen_interfacility_transfer',
      label: 'Inter-facility transfer as per relevant scope of practice',
      authorised: ALL_CATEGORIES,
    },
    {
      key: 'gen_incubator',
      label: 'Use of an incubator',
      authorised: ALL_CATEGORIES,
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Pages 7–9 — List of Medications (Route of Administration)
// Source: HPCSA Professional Board for Emergency Care, scope of practice table.
// Captured 2026-05-16.
//
// The source-table footer reads:
//   "* Mandatory Senior Emergency Care Practitioner and/or Supervising Medical
//    Officer consultation required"
// so every "x*" cell becomes a per-category `conditions` entry. Where a row
// also distinguishes a specific indication (e.g. "Adrenaline — use in
// anaphylaxis and cardiac arrest" vs. "Adrenaline"), each indication is its
// own capability entry to preserve the distinct authorised set.
// ─────────────────────────────────────────────────────────────────────────────

/** Standardised qualifier text for the HPCSA "x*" cell convention. */
export const CONSULTATION_REQUIRED =
  'Mandatory Senior Emergency Care Practitioner and/or Supervising Medical Officer consultation required.';

const medications: CapabilitySection = {
  name: 'List of Medications (Route of Administration)',
  capabilities: [
    {
      key: 'med_acetyl_salicylic_acid',
      label: 'Acetyl Salicylic Acid',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_activated_charcoal',
      label: 'Activated Charcoal',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_adenosine',
      label: 'Adenosine',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_adrenaline_anaphylaxis_arrest',
      label: 'Adrenaline — use in anaphylaxis and cardiac arrest',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_adrenaline_general',
      label: 'Adrenaline',
      authorised: ['ECT', 'ANT', 'ECP'],
      conditions: { ECT: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_amiodarone',
      label: 'Amiodarone Hydrochloride',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_atropine_toxidrome',
      label: 'Atropine Sulphate — use in toxidrome',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_atropine',
      label: 'Atropine Sulphate',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_betamethasone',
      label: 'Betamethasone',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_calcium_chloride_gluconate',
      label: 'Calcium Chloride / Calcium Gluconate',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_clopidogrel',
      label: 'Clopidogrel',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_hydrocortisone_iv',
      label: 'Hydrocortisone (IV)',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_methylprednisolone_iv',
      label: 'Methylprednisolone (IV)',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_dexamethasone',
      label: 'Dexamethasone',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_dextrose_iv_adult',
      label: 'Dextrose Intravenous (adult)',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_dextrose_iv_paed_neonate',
      label: 'Dextrose Intravenous (paediatric and neonate)',
      authorised: ['AEA', 'ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_dopamine',
      label: 'Dopamine',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_diazepam',
      label: 'Diazepam',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_dobutamine',
      label: 'Dobutamine',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_enoxaparin',
      label: 'Enoxaparin',
      authorised: ['ECP'],
    },
    {
      key: 'med_etomidate',
      label: 'Etomidate',
      authorised: ['ECP'],
    },
    {
      key: 'med_fentanyl_iv',
      label: 'Fentanyl (intravenous)',
      authorised: ['ANT', 'ECP'],
      conditions: { ANT: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_fentanyl_intranasal',
      label: 'Fentanyl (intranasal)',
      authorised: ['ANT', 'ECP'],
      conditions: { ANT: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_flumazenil_iatrogenic',
      label: 'Flumazenil (only in cases of iatrogenic benzodiazepine overdose)',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_flumazenil_general',
      label: 'Flumazenil',
      authorised: ['ECP'],
    },
    {
      key: 'med_furosemide',
      label: 'Furosemide',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_glucagon',
      label: 'Glucagon',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
      conditions: { AEA: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_glyceryl_trinitrate',
      label: 'Glyceryl Trinitrate',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_heparin_sodium',
      label: 'Heparin Sodium',
      authorised: ['ECP'],
    },
    {
      key: 'med_hydralazine',
      label: 'Hydralazine',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_ipratropium_bromide',
      label: 'Ipratropium Bromide',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_ketamine_iv',
      label: 'Ketamine — intravenous',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_ketamine_im',
      label: 'Ketamine — intramuscular',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_ketamine_intranasal',
      label: 'Ketamine — intranasal',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_labetalol',
      label: 'Labetalol',
      authorised: ['ECP'],
    },
    {
      key: 'med_lignocaine_io_flush',
      label: 'Lignocaine hydrochloride (IO flush — local anaesthetic)',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_lignocaine_systemic_arrhythmia',
      label: 'Lignocaine hydrochloride (systemic — arrhythmia management)',
      authorised: ['ANT', 'ECP'],
      note: 'Source-image cell values were not perfectly legible — please verify authorised categories.',
    },
    {
      key: 'med_lorazepam',
      label: 'Lorazepam',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_magnesium_sulphate_im',
      label: 'Magnesium Sulphate (intramuscular)',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
      conditions: { AEA: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_magnesium_sulphate_iv',
      label: 'Magnesium Sulphate (intravenous)',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_medical_oxygen',
      label: 'Medical oxygen',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_metoclopramide',
      label: 'Metoclopramide monohydrochloride',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_midazolam',
      label: 'Midazolam',
      authorised: ['ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_morphine_sulphate',
      label: 'Morphine Sulphate',
      authorised: ['ECT', 'ANT', 'ECP'],
      conditions: { ECT: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_naloxone_hydrochloride',
      label: 'Naloxone hydrochloride',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
      conditions: { AEA: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_neostigmine',
      label: 'Neostigmine',
      authorised: ['ECP'],
    },
    {
      key: 'med_nifedipine',
      label: 'Nifedipine (oral / IV)',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_nitrates_iv',
      label: 'Nitrates (intravenous)',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_nitrous_oxide',
      label: 'Nitrous oxide',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_ondansetron',
      label: 'Ondansetron',
      authorised: ['ECP'],
    },
    {
      key: 'med_oral_glucose',
      label: 'Oral glucose powder / gel',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_oxytocin',
      label: 'Oxytocin',
      authorised: ['ECT', 'ANT', 'ECP'],
      conditions: {
        ECT: CONSULTATION_REQUIRED,
        ANT: CONSULTATION_REQUIRED,
      },
    },
    {
      key: 'med_paracetamol_oral',
      label: 'Paracetamol (oral)',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_paracetamol_iv',
      label: 'Paracetamol (intravenous)',
      authorised: ['ANT', 'ECP'],
      conditions: { ANT: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_p2y12_inhibitors',
      label: 'P2Y12 Inhibitors',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_prednisolone_oral',
      label: 'Prednisolone (oral)',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_promethazine',
      label: 'Promethazine',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_procainamide',
      label: 'Procainamide',
      authorised: ['ECP'],
    },
    {
      key: 'med_rocuronium',
      label: 'Rocuronium',
      authorised: ['ECP'],
    },
    {
      key: 'med_sodium_bicarbonate',
      label: 'Sodium Bicarbonate 8.5%',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_sotalol',
      label: 'Sotalol',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    // ── Final medications page (captured 2026-05-16) ─────────────────────────
    {
      key: 'med_sugammadex',
      label: 'Sugammadex',
      authorised: ['ECP'],
    },
    {
      key: 'med_streptokinase',
      label: 'Streptokinase',
      authorised: ['ECP'],
    },
    {
      key: 'med_suxamethonium_chloride',
      label: 'Suxamethonium Chloride',
      authorised: ['ECP'],
    },
    {
      key: 'med_tenecteplase',
      label: 'Tenecteplase',
      authorised: ['ECP'],
    },
    {
      key: 'med_thiamine',
      label: 'Thiamine',
      authorised: ['AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_tranexamic_acid',
      label: 'Tranexamic Acid',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_vecuronium',
      label: 'Vecuronium',
      authorised: ['ECP'],
    },
    {
      key: 'med_beta2_stimulants_inhaled',
      label: 'β2 Stimulants (inhaled)',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_beta2_stimulants_systemic',
      label: 'β2 Stimulants (systemic)',
      authorised: ['ECT', 'ANT', 'ECP'],
    },
    {
      key: 'med_nsaid_non_iv',
      label: 'Non-Steroidal Anti-Inflammatories (non-IV)',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_gp_iib_iiia_inhibitors',
      label: 'GPIIb/IIIa Inhibitors',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_direct_thrombin_inhibitors',
      label: 'Direct Thrombin Inhibitors',
      authorised: ['ECP'],
      conditions: { ECP: CONSULTATION_REQUIRED },
    },
    {
      key: 'med_penthroxyflurane',
      label: 'Penthroxyflurane',
      authorised: ['BAA', 'AEA', 'ECT', 'ECA', 'ANT', 'ECP'],
    },
    {
      key: 'med_cyanide_antidotes_ohs',
      label: 'Cyanide antidotes (within occupational health and safety system)',
      authorised: ['ANT', 'ECP'],
    },
    {
      key: 'med_anti_emetic_remote_oral',
      label: 'Anti-emetic (oral only — within remote site medicine scenario)',
      authorised: ['ECP'],
    },
    {
      key: 'med_anti_spasmodics_remote_oral',
      label: 'Anti-spasmodics (oral only — within remote site medicine scenario)',
      authorised: ['ECP'],
    },
    {
      key: 'med_anti_diarrhoeals_remote_oral',
      label: 'Anti-diarrhoeals (oral only — within remote site medicine scenario)',
      authorised: ['ECP'],
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Master matrix — append a new CapabilitySection per HPCSA page received.
// ─────────────────────────────────────────────────────────────────────────────

export const HPCSA_SCOPE: readonly CapabilitySection[] = [
  airwayManagement,
  oxygenationVentilation,
  circulatoryManagement,
  obstetricManagement,
  diagnosticAndClinicalAids,
  generalCare,
  medications,
];

// ─────────────────────────────────────────────────────────────────────────────
// Medication catalogue — convenience exports for form pickers / datalists.
// ─────────────────────────────────────────────────────────────────────────────

/** All medication display names from the HPCSA catalogue, in source order. */
export const MEDICATION_NAMES: readonly string[] =
  medications.capabilities.map(c => c.label);

/** Look up a medication capability by its display label (case-insensitive). */
export function findMedicationByName(name: string): Capability | undefined {
  if (!name) return undefined;
  const target = name.trim().toLowerCase();
  return medications.capabilities.find(c => c.label.toLowerCase() === target);
}

/**
 * Legacy SAPAESA tier strings that may still appear in crew profiles loaded
 * from localStorage or fetched from an unmigrated backend. Normalised to the
 * closest matching HPCSA category before scope checks. Mirrors the backend's
 * `app.utils.hpcsa.normalise_category` mapping so the two layers agree.
 */
const LEGACY_TIER_TO_CATEGORY: Readonly<Record<string, HpcsaCategory>> = {
  BLS:       'BAA',
  ILS:       'AEA',
  ALS:       'ECP',
  ICU:       'ECP',
  // Free-text variants we've observed on paper PRFs (mirror of backend map).
  PARAMEDIC: 'ECP',
  'EMT-B':   'BAA',
  'EMT-I':   'AEA',
  'EMT-P':   'ECP',
  CCA:       'ANT',
  BASIC:     'BAA',
};

/**
 * Normalises any practitioner-qualification string to a canonical HPCSA
 * category code, or `undefined` if the input is empty / unrecognised.
 *
 * Use this anywhere the frontend needs to scope-check based on a value
 * read from `fd.treating_practitioner_category`, `crew.qualification`,
 * `localStorage.crew_profile.qualification`, or an API response that
 * may still carry legacy tier strings (`"ALS"` / `"ILS"` / `"BLS"`)
 * because the backend Alembic migration hasn't run yet, or because a
 * crew session was started before the migration.
 */
export function normaliseHpcsaCategory(input: string | undefined | null): HpcsaCategory | undefined {
  if (!input) return undefined;
  const upper = input.toString().trim().toUpperCase();
  if ((HPCSA_CATEGORIES as readonly string[]).includes(upper)) {
    return upper as HpcsaCategory;
  }
  return LEGACY_TIER_TO_CATEGORY[upper];
}

/**
 * Medication labels authorised for the supplied HPCSA category, in source
 * order. Used by the Digital PRF's medication datalist to hide drugs the
 * treating practitioner cannot administer.
 *
 * Accepts any string — legacy tier values are normalised through
 * `normaliseHpcsaCategory`. Returns every medication when the input is
 * empty or unrecognised (fail-open — the Phase 2 gate normally prevents
 * the empty case).
 */
export function medicationNamesForCategory(category: string | undefined | null): readonly string[] {
  const normalised = normaliseHpcsaCategory(category);
  if (!normalised) return MEDICATION_NAMES;
  return medications.capabilities
    .filter(c => c.authorised.includes(normalised))
    .map(c => c.label);
}

// ─────────────────────────────────────────────────────────────────────────────
// Form-label → capability-key mapping
//
// The Digital PRF renders procedure checkboxes with short human labels
// (e.g. "Intubation", "Periph. IV Line"). This map translates each label into
// the canonical `Capability.key` so the form can decide whether to render the
// checkbox enabled, disabled, or with a consultation hint based on the
// treating practitioner's HPCSA category.
//
// IMPORTANT: keep this in sync with the literal arrays passed to <Chk fk="..."
// val="..."> in `frontend/src/pages/crew/DigitalPRFForm.tsx`. A label without
// an entry here is treated as "no scope mapping" — the checkbox renders
// normally with no enforcement (fail-open: better to leave a control usable
// than to silently disable it because of a typo in this map).
// ─────────────────────────────────────────────────────────────────────────────

export const FORM_LABEL_TO_CAPABILITY: Readonly<Record<string, string>> = {
  // Airway interventions (P3 — Airway card)
  //
  // "Intubation" is the drug-facilitated ETT row (RSI — ECP scope), and the
  // ETT-specific sub-fields (Size, Depth, Attempts) appear when ticked.
  // "Supraglottic Airway" is the separate row for iGel / LMA / King LT / etc.,
  // so ECT / ECA / ANT can record advanced airway placement without being
  // wrongly locked out of the ETT-only checkbox.
  'Self-maintained':     'airway_basic_manual_manoeuvres',
  'Intubation':          'airway_ett_drug_facilitated',
  'Supraglottic Airway': 'airway_supraglottic_extraglottic_device',
  'Suction':             'airway_suction_upper',
  'Chest Decompression': 'o2_needle_thoracentesis_adult_paed',
  'Surg. Airway':        'airway_surgical_cricothyroidotomy',

  // Circulation interventions (P3 — Circulation card)
  //
  // "IO Line" maps to the adult-IO capability (the most permissive of the two
  // IO rows in the matrix) so ECA — which is authorised for adult IO but not
  // paediatric — can still tick the box. Paediatric IO is a narrower scope
  // that would need its own checkbox to enforce strictly.
  'Periph. IV Line':  'circ_iv_cannulation_limbs_over_1yr',
  'Cardio Version':   'circ_synchronised_cardioversion',
  'IO Line':          'circ_intraosseous_adult',
  'Pacing':           'circ_transcutaneous_cardiac_pacing',
  'Central Line':     'circ_central_line_management',
  'Defib J/NR':       'circ_manual_defibrillation',
  'CPR':              'gen_cardiac_arrest_management',
};

/**
 * Convenience: resolve a form label to its capability + scope verdict for a
 * given practitioner. Returns:
 *   - `unmapped`     — no entry in the form-label map (fail-open, render normally)
 *   - `authorised`   — practitioner may perform; `condition` set if consultation required
 *   - `unauthorised` — practitioner is out of scope; UI should disable
 */
export type ScopeVerdict =
  | { kind: 'unmapped'; capabilityKey: undefined }
  | { kind: 'authorised'; capabilityKey: string; condition?: string }
  | { kind: 'unauthorised'; capabilityKey: string };

export function scopeForFormLabel(
  label: string,
  category: string | undefined | null,
): ScopeVerdict {
  const key = FORM_LABEL_TO_CAPABILITY[label];
  if (!key) return { kind: 'unmapped', capabilityKey: undefined };
  // Accept legacy tier values (`"ALS"`/`"ILS"`/`"BLS"`) so the form behaves
  // correctly when the data migration hasn't run yet or a stale crew session
  // is loaded from localStorage.
  const normalised = normaliseHpcsaCategory(category);
  // No treating practitioner identified yet — Phase 2 gate normally prevents
  // this, but if we got here, fail-open rather than disable every option.
  if (!normalised) return { kind: 'authorised', capabilityKey: key };
  if (!isAuthorised(normalised, key)) return { kind: 'unauthorised', capabilityKey: key };
  const condition = conditionFor(normalised, key);
  return { kind: 'authorised', capabilityKey: key, condition };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITY_INDEX: Map<string, Capability> = (() => {
  const m = new Map<string, Capability>();
  for (const section of HPCSA_SCOPE) {
    for (const cap of section.capabilities) {
      if (m.has(cap.key)) {
        // Surface integrity bugs at import time so duplicate keys never ship.
        throw new Error(`HPCSA scope: duplicate capability key "${cap.key}"`);
      }
      m.set(cap.key, cap);
    }
  }
  return m;
})();

export function getCapability(key: string): Capability | undefined {
  return CAPABILITY_INDEX.get(key);
}

/**
 * Returns true when the given category is authorised for the capability.
 * Forbidden capabilities (HPCSA "NOT TO BE PERFORMED") always return false.
 *
 * Unknown capability keys throw — silently allowing an unknown action would
 * defeat the whole point of the matrix.
 */
export function isAuthorised(category: HpcsaCategory, capabilityKey: string): boolean {
  const cap = CAPABILITY_INDEX.get(capabilityKey);
  if (!cap) throw new Error(`HPCSA scope: unknown capability key "${capabilityKey}"`);
  if (cap.forbidden) return false;
  return cap.authorised.includes(category);
}

/** Any conditional qualifier attached to (category, capability), if present. */
export function conditionFor(category: HpcsaCategory, capabilityKey: string): string | undefined {
  return CAPABILITY_INDEX.get(capabilityKey)?.conditions?.[category];
}

/**
 * True when at least one of the supplied crew categories is authorised above
 * the BAA / BLS tier — used to gate PRF creation when both crew are BAA.
 */
export function crewCanExceedBls(categories: readonly HpcsaCategory[]): boolean {
  return categories.some(c => c !== 'BAA');
}
