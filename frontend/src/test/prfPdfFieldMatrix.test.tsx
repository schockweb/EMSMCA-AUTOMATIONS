/**
 * prfPdfFieldMatrix.test.tsx — full call-type × billing-type PDF field coverage
 *
 * The "Save as PDF" / share pipelines snapshot the rendered `.prf-page` DOM,
 * so whatever is in that DOM is exactly what reaches the medical scheme's PDF.
 * This suite mounts PRFView for EVERY valid (call_type, billing_type) pairing
 * and asserts that each field captured for that scenario renders.
 *
 * Call types  (DigitalPRFForm CALL_TYPE_OPTS):
 *   PRIMARY, IHT (labelled IFT/IHT), RHT, COURTESY, RESUS, DOD
 * Billing types (BILLING_TYPE_OPTS, DigitalPRFForm.tsx:2877):
 *   MED AID, RAF, PVT, CALL OUT FEE
 *   NOTE: 'IOD' is NOT a member. This docstring used to list it, and used to
 *   claim the default arm offered CALL OUT FEE from the picker. Both were
 *   wrong — a drifted comment on the file that documents what the scheme
 *   legally receives is worse than no comment, so it is corrected here.
 *   Scenarios below may still exercise IOD/legacy arms for backward
 *   compatibility with PRFs captured before the option was removed.
 *
 * Billing availability rules (BillingTypePicker.billingOpts, ~line 2895):
 *   baseOpts = BILLING_TYPE_OPTS minus CALL OUT FEE  (never offered in the picker)
 *   COURTESY → none  (non-billable transfer — no payer block is captured at all)
 *   DOD   → baseOpts minus RAF     → MED AID, PVT
 *   RESUS → MED AID, PVT           (restricted to these two)
 *   else  → baseOpts               → MED AID, RAF, PVT
 *
 * Not every field a call type captures reaches the PDF — the product
 * deliberately suppresses whole blocks per call type, so the expectations are
 * assembled from buckets rather than one flat list:
 *   • transport bucket  — destination / handover / valuables rows, dropped for
 *     RHT and DOD (`noTransport` in PRFView: the patient was never conveyed).
 *   • patient bucket    — the Patient Information panel, replaced on a DOD by
 *     the deceased's particulars in the Declaration of Death block.
 *   • clinical bucket   — page 2, omitted entirely for a DOD and for an RHT
 *     (a refusal has no clinical content; page 2 is the watermark alone).
 *
 * Each scenario uses unique sentinel values so a missing field is unambiguous:
 * the failing assertion prints the exact value that dropped off the PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';
import PRFView from '../pages/PRFView';

// ── Mocks ─────────────────────────────────────────────────────────────────
vi.mock('axios');
// NOTE: the implementation MUST be a plain `function` expression — an arrow
// function is not constructible, so `new jsPDF()` inside PRFView throws.
vi.mock('jspdf', () => ({
  jsPDF: vi.fn(function () {
    return {
      addPage: vi.fn(), addImage: vi.fn(),
      output: vi.fn(() => new Blob()), save: vi.fn(),
    };
  }),
}));
vi.mock('html2canvas', () => ({
  default: vi.fn(async () => {
    const c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    return c;
  }),
}));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── Field groups ────────────────────────────────────────────────────────────
// Each group returns a { fd-fragment, expected-visible-sentinels } pair so the
// fixture and its assertions never drift apart.

/** Fields present on EVERY PRF regardless of call / billing type. */
function commonGroup(tag: string) {
  const fd: Record<string, any> = {
    // Call information
    incident_location: `Incident-Rd-${tag}`,
    suburb_ward: `Suburb-${tag}`,
    referring_doctor: `Dr-Referrer-${tag}`,
    receiving_facility: `Receiving-Hosp-${tag}`,
    ward: `Ward-${tag}`,
    receiving_doctor: `Dr-Receiver-${tag}`,
    // Patient (all 17 rendered fields)
    gender: 'Male',
    patient_name: `PName-${tag}`,
    patient_surname: `PSurname-${tag}`,
    patient_id_number: `PID-${tag}`,
    patient_passport_number: `PPass-${tag}`,
    age: `Age-${tag}`,
    patient_dob: `PDob-${tag}`,
    patient_address: `PAddr-${tag}`,
    patient_suburb: `PSub-${tag}`,
    patient_postal_code: `PCode-${tag}`,
    patient_postal_address: `PPostAddr-${tag}`,
    patient_postal_suburb: `PPostSub-${tag}`,
    patient_postal_address_code: `PPostCode-${tag}`,
    patient_phone_home: `PTelH-${tag}`,
    patient_phone_work: `PTelW-${tag}`,
    patient_phone_cell: `PCell-${tag}`,
    accompanying_persons_count: `Accomp-${tag}`,
    // Debtor (distinct from patient so the full block renders)
    debtor_gender: 'Female',
    debtor_name: `DName-${tag}`,
    debtor_surname: `DSurname-${tag}`,
    debtor_id_number: `DID-${tag}`,
    debtor_passport_number: `DPass-${tag}`,
    debtor_age: `DAge-${tag}`,
    debtor_dob: `DDob-${tag}`,
    debtor_address: `DAddr-${tag}`,
    debtor_suburb: `DSub-${tag}`,
    debtor_postal_code: `DCode-${tag}`,
    debtor_phone_home: `DTelH-${tag}`,
    debtor_phone_cell: `DCell-${tag}`,
    // Priority / assessment / mechanism
    priority: 'RED',
    assessment_level: 'BLS',
    monitoring_level: 'BLS',
    mechanism: ['FALL'],
    mechanism_other: `Mech-${tag}`,
    // Receiving facility / handover
    handover_name: `Handover-${tag}`,
    handover_qualification: `HQual-${tag}`,
    handover_doctor_email: `doc-${tag.toLowerCase()}@scheme.test`,
    handover_notes: `Condition-${tag}`,
    // Valuables + management
    valuables_handed_to: `Valuables-To-${tag}`,
    valuables_description: `Valuables-Desc-${tag}`,
    management_notes: `Mgmt-Notes-${tag}`,
    // Oxygen / airway / circulation / immobilisation
    o2_flow_rate: `O2Flow-${tag}`,
    o2_percent: `O2Pct-${tag}`,
    o2_device: `O2Dev-${tag}`,
    o2_bvm: `O2Bvm-${tag}`,
    o2_start_time: `O2Start-${tag}`,
    o2_stop_time: `O2Stop-${tag}`,
    airway_interventions: ['SELF-MAINTAINED'],
    op_airway_size: `OPA-${tag}`,
    intubation_attempts: `Intub-${tag}`,
    ett_size: `ETT-${tag}`,
    ett_depth: `ETTd-${tag}`,
    ng_tube_size: `NG-${tag}`,
    circulation_interventions: ['PERIPH. IV LINE'],
    iv_attempts: `IVAtt-${tag}`,
    defib_joules: `Defib-${tag}`,
    immob_equipment: ['COLLAR'],
    other_equipment: `OtherEquip-${tag}`,
    // Surveys
    survey_a: `SurvA-${tag}`, survey_b: `SurvB-${tag}`, survey_c: `SurvC-${tag}`,
    survey_head_back: `SurvHB-${tag}`, survey_neuro: `SurvN-${tag}`,
    survey_chest: `SurvCh-${tag}`, survey_abdo: `SurvAb-${tag}`,
    survey_limbs: `SurvL-${tag}`, survey_back: `SurvBk-${tag}`,
    // History
    chief_complaint: `Complaint-${tag}`,
    primary_diagnosis: `Diag-${tag}`,
    findings_on_arrival: `Findings-${tag}`,
    allergies: `Allergy-${tag}`,
    current_medications: `CurMeds-${tag}`,
    past_medical_history: `PastHx-${tag}`,
    last_meal: `Meal-${tag}`,
    last_meal_time: `MealTime-${tag}`,
    events_hpi: `HPI-${tag}`,
    // IV + medication rows
    iv_therapy: [{
      type: `IVType-${tag}`, jelco_size: `IVJelco-${tag}`, site: `IVSite-${tag}`,
      vol_infused: `IVVol-${tag}`, time_up: `IVTime-${tag}`,
      indication: `IVInd-${tag}`, sign: `IVSign-${tag}`,
    }],
    medications: [{
      type: `MedType-${tag}`, route: `MedRoute-${tag}`, dose: `MedDose-${tag}`,
      time: `MedTime-${tag}`, reason: `MedReason-${tag}`, sign: `MedSign-${tag}`,
    }],
    // Vitals — 3 sets (max before continuation page)
    vitals_sets: [
      { time: `VT1-${tag}`, resp_rate: `RR1-${tag}`, spo2: `SP1-${tag}`, hr: `HR1-${tag}`, bp: `BP1-${tag}`, gcs_total: `GCS1-${tag}`, temp: `TMP1-${tag}`, pain: `PN1-${tag}` },
      { time: `VT2-${tag}`, resp_rate: `RR2-${tag}`, spo2: `SP2-${tag}`, hr: `HR2-${tag}`, bp: `BP2-${tag}`, gcs_total: `GCS2-${tag}`, temp: `TMP2-${tag}`, pain: `PN2-${tag}` },
      { time: `VT3-${tag}`, resp_rate: `RR3-${tag}`, spo2: `SP3-${tag}`, hr: `HR3-${tag}`, bp: `BP3-${tag}`, gcs_total: `GCS3-${tag}`, temp: `TMP3-${tag}`, pain: `PN3-${tag}` },
    ],
    // Signatures + attachments
    tc_patient_signature: PNG,
    tc_witness_signature: PNG,
    next_of_kin_signature: PNG,
    hospital_sticker: PNG,
  };

  // Sentinels that must be visible, split into the buckets PRFView actually
  // gates on. Arrays / row objects / images are checked structurally
  // elsewhere; here we list the scalar text values.
  // referring_doctor + handover_name are captured but no longer rendered on
  // the PRF (removed by request), so they're not asserted as visible.

  /** Page-1 rows that render for EVERY call type. */
  const always = [
    fd.incident_location,
    fd.debtor_name, fd.debtor_surname, fd.debtor_id_number, fd.debtor_passport_number,
    fd.debtor_age, fd.debtor_dob, fd.debtor_address, fd.debtor_suburb, fd.debtor_postal_code,
    fd.debtor_phone_home, fd.debtor_phone_cell,
  ];

  /**
   * Patient Information panel (+ the Mechanism detail that hangs off it).
   * Suppressed on a Declaration of Death — the deceased's particulars render
   * from the DoD block instead (see callGroup's DOD arm).
   */
  const patient = [
    fd.patient_name, fd.patient_surname, fd.patient_id_number, fd.patient_passport_number,
    fd.age, fd.patient_dob, fd.patient_address, fd.patient_suburb, fd.patient_postal_code,
    fd.patient_postal_address, fd.patient_postal_suburb, fd.patient_postal_address_code,
    fd.patient_phone_home, fd.patient_phone_work, fd.patient_phone_cell, fd.accompanying_persons_count,
    fd.mechanism_other,
  ];

  /**
   * Destination / handover rows + the valuables handover. PRFView drops these
   * whenever the patient was never conveyed to a facility (`noTransport` —
   * RHT refused transport, DOD deceased at scene), so nobody signs for a
   * receiving ward, a receiving doctor or the patient's valuables.
   */
  const transport = [
    // fd.suburb_ward is deliberately NOT here: the row was removed from the PDF
    // because the geocoder auto-fills it while the crew form prompts for a ward,
    // so it duplicated fd.ward below. The value is still captured — the fixture
    // at :77 keeps it — so the negative test can prove the ROW is gone rather
    // than prove the fixture is empty.
    fd.receiving_facility, fd.ward,
    fd.valuables_handed_to, fd.valuables_description,
  ];

  /**
   * The four rows that describe a handover to a RECEIVING CLINICIAN. Dropped
   * for RESUS as well as for noTransport: a resuscitation releases the deceased
   * to an undertaker, whose details and signature live in the Declaration of
   * Death block, so there is no receiving practitioner to name.
   */
  const facilityHandover = [
    fd.receiving_doctor, fd.handover_qualification,
    fd.handover_notes, fd.handover_doctor_email,
  ];

  /** Page 2 (clinical sheet) — omitted entirely for a Declaration of Death. */
  const clinical = [
    fd.management_notes,
    fd.o2_flow_rate, fd.o2_percent, fd.o2_device, fd.o2_bvm, fd.o2_start_time, fd.o2_stop_time,
    fd.op_airway_size, fd.intubation_attempts, fd.ett_size, fd.ett_depth, fd.ng_tube_size,
    fd.iv_attempts, fd.defib_joules, fd.other_equipment,
    fd.survey_a, fd.survey_b, fd.survey_c, fd.survey_head_back, fd.survey_neuro,
    fd.survey_chest, fd.survey_abdo, fd.survey_limbs, fd.survey_back,
    fd.chief_complaint, fd.primary_diagnosis, fd.findings_on_arrival, fd.allergies,
    fd.current_medications, fd.past_medical_history, fd.last_meal, fd.last_meal_time, fd.events_hpi,
    fd.iv_therapy[0].site, fd.iv_therapy[0].vol_infused, fd.iv_therapy[0].indication,
    fd.medications[0].type, fd.medications[0].dose, fd.medications[0].reason,
    // vitals scalars
    ...fd.vitals_sets.flatMap((v: any) => [v.resp_rate, v.spo2, v.hr, v.bp, v.gcs_total, v.temp, v.pain]),
  ];

  return { fd, always, patient, transport, facilityHandover, clinical };
}

/** Call-type-specific fields + the rendered call-type chip text. */
function callGroup(callType: string, tag: string): { fd: Record<string, any>; visible: string[]; chips: string[] } {
  // The page-1 call-type checks: PRIMARY shows "Primary"; transfers show
  // "Transfer" plus the subtype chip for IHT/IFT/RHT/COURTESY.
  switch (callType) {
    case 'PRIMARY':
      return { fd: { call_type: 'PRIMARY' }, visible: [], chips: ['Primary'] };
    case 'IHT': // labelled IFT/IHT — transfer with pre-auth + requesting provider
      return {
        fd: {
          call_type: 'IHT',
          preauth_number: `PreAuth-${tag}`,
          post_auth_number: `PostAuth-${tag}`,
        },
        visible: [`PreAuth-${tag}`, `PostAuth-${tag}`],
        chips: ['Transfer', 'IHT'],
      };
    case 'RHT': // return transfer — call-out fee + return-trip times
      return {
        fd: {
          call_type: 'RHT',
          rht_call_out_fee: `CallOutFee-${tag}`,
          return_despatch_time: `RetDisp-${tag}`,
          return_on_scene_time: `RetScene-${tag}`,
          return_depart_scene_time: `RetDepart-${tag}`,
          return_at_destination_time: `RetDest-${tag}`,
          return_handover_time: `RetHandover-${tag}`,
          return_available_time: `RetAvail-${tag}`,
        },
        visible: [
          `CallOutFee-${tag}`, `RetDisp-${tag}`, `RetScene-${tag}`, `RetDepart-${tag}`,
          `RetDest-${tag}`, `RetHandover-${tag}`, `RetAvail-${tag}`,
        ],
        // NOT 'Transfer'. RHT is Refused Hospital Transport — the opposite
        // of a transfer — and the PDF printed "Transfer — RHT" on a call where
        // nobody was moved. This expectation encoded that bug as correct.
        chips: ['Refused Hospital Transport'],
      };
    case 'COURTESY':
      return { fd: { call_type: 'COURTESY' }, visible: [], chips: ['Transfer', 'COURTESY'] };
    case 'RESUS': // resuscitation — med-aid resus sub-block
      return {
        fd: {
          call_type: 'RESUS',
          med_aid_resus: true,
          med_aid_resus_level: `ResusLvl-${tag}`,
          med_aid_resus_fee: `ResusFee-${tag}`,
        },
        visible: [`ResusLvl-${tag}`, `ResusFee-${tag}`],
        // Resus is not a transfer — the Call Type row reads plain "Resus".
        chips: ['Resus'],
      };
    case 'DOD':
      // Declaration of death. PRFView renders a death certificate instead of
      // the standard panel: the Patient Information column, the whole clinical
      // sheet and the closeout band are suppressed, and the deceased's
      // identity comes from the med_aid_dec_death_deceased_* fields.
      return {
        fd: {
          call_type: 'DOD',
          med_aid_dec_death: true,
          med_aid_dec_death_time: `DodTime-${tag}`,
          med_aid_dec_death_date: `DodDate-${tag}`,
          med_aid_dec_death_location: `DodLoc-${tag}`,
          med_aid_dec_death_identified_by: `DodIdBy-${tag}`,
          // Particulars of the deceased — these stand in for the Patient
          // Information panel, which is not rendered on a DoD.
          med_aid_dec_death_deceased_gender: `DodGender-${tag}`,
          med_aid_dec_death_deceased_first_name: `DodFirst-${tag}`,
          med_aid_dec_death_deceased_surname: `DodSurname-${tag}`,
          med_aid_dec_death_deceased_id: `DodId-${tag}`,
          med_aid_dec_death_deceased_passport: `DodPass-${tag}`,
          med_aid_dec_death_deceased_dob: `DodDob-${tag}`,
          med_aid_dec_death_deceased_age: `DodAge-${tag}`,
          med_aid_dec_death_deceased_cell: `DodCell-${tag}`,
          med_aid_dec_death_deceased_tel_home: `DodTelH-${tag}`,
          med_aid_dec_death_deceased_tel_work: `DodTelW-${tag}`,
          med_aid_dec_death_deceased_address: `DodAddr-${tag}`,
          med_aid_dec_death_deceased_suburb: `DodSub-${tag}`,
          med_aid_dec_death_deceased_postal_code: `DodCode-${tag}`,
          // The signed declaration — the two signatures that replace the
          // T&C / handover stack on a DoD.
          med_aid_dec_death_signature: PNG,
          med_aid_dec_death_crew_attended_signature: PNG,
        },
        visible: [
          `DodTime-${tag}`, `DodDate-${tag}`, `DodLoc-${tag}`, `DodIdBy-${tag}`,
          `DodGender-${tag}`, `DodFirst-${tag}`, `DodSurname-${tag}`, `DodId-${tag}`,
          `DodPass-${tag}`, `DodDob-${tag}`, `DodAge-${tag}`, `DodCell-${tag}`,
          `DodTelH-${tag}`, `DodTelW-${tag}`, `DodAddr-${tag}`, `DodSub-${tag}`,
          `DodCode-${tag}`,
        ],
        // Not a transfer — the Call Type row reads plain "DOD".
        chips: ['DOD'],
      };
    default:
      return { fd: { call_type: callType }, visible: [], chips: [] };
  }
}

/** Billing-type-specific channel fields + the rendered billing-type chip. */
function billingGroup(billingType: string, tag: string): { fd: Record<string, any>; visible: string[] } {
  switch (billingType) {
    case 'MED AID':
      return {
        fd: {
          billing_type: 'MED AID',
          medical_scheme: `Scheme-${tag}`,
          medical_aid_number: `AidNo-${tag}`,
          preauth_number: `MAPreAuth-${tag}`,
          post_auth_number: `MAPostAuth-${tag}`,
          dependent_number: `Dep-${tag}`,
          main_member_id: `MainMem-${tag}`,
          scheme_option: `Plan-${tag}`,
          medical_aid_image: PNG,
        },
        visible: [
          `Scheme-${tag}`, `AidNo-${tag}`, `MAPreAuth-${tag}`, `MAPostAuth-${tag}`,
          `Dep-${tag}`, `MainMem-${tag}`, `Plan-${tag}`,
        ],
      };
    case 'IOD': // injury-on-duty / WCA compensation
      // The crew form models this as the WCA_IOD *call type*, which auto-sets
      // billing_type to the canonical 'WCA / IOD' — that's the value PRFView's
      // billing block keys off, so the fixture must store it, not bare 'IOD'.
      return {
        fd: {
          billing_type: 'WCA / IOD',
          compensation_reference: `IodRef-${tag}`,
          wca_employer: `IodEmployer-${tag}`,
          wca_employee_number: `IodEmpNo-${tag}`,
          wca_injury_date: `IodInjDate-${tag}`,
          wca_oar_number: `IodOar-${tag}`,
        },
        visible: [
          `IodRef-${tag}`, `IodEmployer-${tag}`, `IodEmpNo-${tag}`,
          `IodInjDate-${tag}`, `IodOar-${tag}`,
        ],
      };
    case 'RAF': // road accident fund
      return {
        fd: {
          billing_type: 'RAF',
          compensation_reference: `RafRef-${tag}`,
          raf_accident_date: `RafDate-${tag}`,
          raf_police_case_number: `RafSaps-${tag}`,
          raf_accident_location: `RafLoc-${tag}`,
          raf_sketch: PNG,
        },
        visible: [`RafRef-${tag}`, `RafDate-${tag}`, `RafSaps-${tag}`, `RafLoc-${tag}`],
      };
    case 'PVT': // private / account holder
      return {
        fd: {
          billing_type: 'PVT',
          pvt_payment_method: `PvtMethod-${tag}`,
          pvt_account_holder: `PvtHolder-${tag}`,
          pvt_account_holder_id: `PvtHolderId-${tag}`,
          pvt_account_holder_phone: `PvtPhone-${tag}`,
          pvt_account_holder_address: `PvtAddr-${tag}`,
        },
        visible: [
          `PvtMethod-${tag}`, `PvtHolder-${tag}`, `PvtHolderId-${tag}`,
          `PvtPhone-${tag}`, `PvtAddr-${tag}`,
        ],
      };
    case 'CALL OUT FEE': // call-out / stand-down (legacy)
      return {
        fd: {
          billing_type: 'CALL OUT FEE',
          callout_requested_by: `CoReqBy-${tag}`,
          callout_authorisation: `CoAuth-${tag}`,
          callout_standdown_reason: `CoReason-${tag}`,
        },
        visible: [`CoReqBy-${tag}`, `CoAuth-${tag}`, `CoReason-${tag}`],
      };
    default:
      // 'NONE' — the billing-free scenario used for Courtesy calls, which
      // capture no payer at all. Deliberately contributes NO billing_type key
      // so the fixture matches what the crew form actually stores.
      return { fd: {}, visible: [] };
  }
}

// ── Fixture assembly ────────────────────────────────────────────────────────
function buildPrf(callType: string, billingType: string) {
  const tag = `${callType}-${billingType}`.replace(/[^A-Za-z0-9]/g, '');
  const common = commonGroup(tag);
  const call = callGroup(callType, tag);
  const billing = billingGroup(billingType, tag);

  // PRFView's own guards, mirrored here so the expectations track the product:
  //   noTransport → the patient was never conveyed (RHT refused transport,
  //                 DOD deceased at scene): destination / handover / valuables
  //                 rows and the Depart + Arrival KM rows are dropped.
  //   isDoD       → a death certificate replaces the standard panel: no
  //                 Patient Information column and no clinical sheet.
  const noTransport = callType === 'RHT' || callType === 'DOD';
  const isDoD = callType === 'DOD';

  const fd = { ...common.fd, ...call.fd, ...billing.fd };
  const visible = [
    ...common.always,
    ...(isDoD ? [] : common.patient),
    ...(noTransport ? [] : common.transport),
    // NOT excluded for RESUS: a resuscitation the crew wins is conveyed and
    // handed over like any other call. These rows drop only once a Declaration
    // of Death is made (fd.med_aid_dec_death), which this fixture does not set.
    ...(noTransport ? [] : common.facilityHandover),
    // The clinical sheet is omitted for a Declaration of Death AND for a
    // refusal. On a refusal nothing clinical exists — the patient declined
    // before any observation or intervention was made — so page 2 is the
    // "Patient Refused Treatment" watermark and nothing else. Printing the
    // grid produced section headings over empty rows, which reads as an
    // unfinished form rather than a completed refusal.
    ...(isDoD || noTransport ? [] : common.clinical),
    ...call.visible,
    ...billing.visible,
  ];
  const chips = call.chips;

  const prf = {
    prf_number: `PRF-${tag}`,
    case_number: `CASE-${tag}`,
    submitted_at: '2026-06-11T09:30:00',
    form_data: fd,
    timestamps: {
      time_call_received: '2026-06-11T09:30:00',
      time_dispatched: '2026-06-11T09:36:00',
      time_on_scene: '2026-06-11T09:36:00',
      time_depart_scene: '2026-06-11T09:59:00',
      time_at_destination: '2026-06-11T09:59:00',
      time_available: '2026-06-11T10:01:00',
    },
    kms: {
      km_dispatched: `KMa-${tag}`, km_on_scene: `KMb-${tag}`, km_depart_scene: `KMc-${tag}`,
      km_at_destination: `KMd-${tag}`, km_available: `KMe-${tag}`,
    },
    provider: {
      name: `Provider-${tag}`, slug: 'sentinel-ems',
      phone: `Phone-${tag}`, pr_number: `PR-${tag}`, pty_reg_number: `PTY-${tag}`,
      address: `ProvAddr-${tag}`, email: `ops-${tag.toLowerCase()}@ems.test`,
    },
    vehicle: { callsign: `CS-${tag}`, registration: `REG-${tag}`, vehicle_type: 'Ambulance' },
    crew_1: { full_name: `Crew1-${tag}`, qualification: `Q1-${tag}`, hpcsa_number: `HP1-${tag}` },
    crew_2: { full_name: `Crew2-${tag}`, qualification: `Q2-${tag}`, hpcsa_number: `HP2-${tag}` },
    signatures: {
      patient_signature: PNG, witness_signature: PNG, handover_signature: PNG,
      crew_signature: PNG, crew_2_signature: PNG,
    },
  };

  // Provider / vehicle / crew / km sentinels render on every PRF too — except
  // the Depart + Arrival-At-Facility KM readings, which sit on the two time
  // rows PRFView omits under the same noTransport guard as the transport
  // bucket above.
  const metaVisible = [
    prf.case_number, prf.provider.name, prf.provider.phone, prf.provider.pr_number,
    prf.provider.address, prf.vehicle.callsign, prf.vehicle.registration,
    prf.crew_1.full_name, prf.crew_1.hpcsa_number, prf.crew_2.full_name, prf.crew_2.hpcsa_number,
    prf.kms.km_dispatched, prf.kms.km_on_scene, prf.kms.km_available,
    ...(noTransport ? [] : [prf.kms.km_depart_scene, prf.kms.km_at_destination]),
  ];

  // The sentinel each test waits on before asserting. A DoD has no Patient
  // Information panel, so the deceased's first name is the anchor there.
  const anchor: string = isDoD
    ? fd.med_aid_dec_death_deceased_first_name
    : fd.patient_name;

  return { prf, fd, visible: [...visible, ...metaVisible], chips, anchor, noTransport, isDoD };
}

function renderPrfView() {
  return render(
    <MemoryRouter initialEntries={['/cases/case-x/prf']}>
      <Routes>
        <Route path="/cases/:caseId/prf" element={<PRFView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function expectVisible(sentinel: string) {
  const matches = screen.queryAllByText(
    (content) => content.includes(sentinel),
    { exact: false },
  );
  expect(matches.length, `"${sentinel}" missing from rendered PRF PDF`).toBeGreaterThan(0);
}

/**
 * Assert a labelled FieldRow renders a value containing `expected`.
 *
 * An unanchored `queryAllByText(c => c.includes(x))` is worthless here: every
 * sentinel in this fixture is tagged `<callType>-<billingType>`, so a bare
 * `includes('IOD')` matches the tag baked into unrelated field values and the
 * assertion passes without the row ever rendering. Anchoring to the row's own
 * label makes the test fail when the row is actually gone.
 */
function expectFieldRow(label: string, expected: string) {
  // getAllByText throws when the row isn't rendered at all — which is exactly
  // the failure we want. Some labels legitimately repeat (e.g. "Depart"
  // appears on both the outbound time grid and the Return Trip block), so any
  // matching row satisfies the assertion.
  const rows = screen.getAllByText(label).map(el => el.parentElement?.textContent ?? '');
  expect(
    rows.some(text => text.includes(expected)),
    `no "${label}" row shows "${expected}" (rows found: ${JSON.stringify(rows)})`,
  ).toBe(true);
}

// ── The matrix: every valid (call_type, billing_type) pairing ───────────────
// 'EVENT' is gone: DigitalPRFForm's BILLING_TYPE_OPTS no longer offers it and
// coerces any legacy 'EVENT' value to ''.
const ALL_BILLING = ['MED AID', 'IOD', 'RAF', 'PVT', 'CALL OUT FEE'];
const MATRIX: Record<string, string[]> = {
  PRIMARY:  ALL_BILLING,
  IHT:      ALL_BILLING,             // IFT/IHT
  RHT:      ALL_BILLING,
  // Courtesy calls are non-billable transfers: PRFView wraps the whole payer
  // block (and the page-1 "Billing Type" meta row) in call_type !== 'COURTESY',
  // so there is exactly one billing-free scenario to cover.
  COURTESY: ['NONE'],
  RESUS:    ['MED AID', 'PVT'],      // restricted by billingOpts
  DOD:      ['MED AID', 'PVT'],      // restricted by billingOpts (no IOD/RAF)
};
const CALL_LABEL: Record<string, string> = { IHT: 'IFT/IHT (IHT)' };

let currentPrf: any = null;
beforeEach(() => {
  vi.mocked(axios.get).mockImplementation(async () => ({ data: currentPrf }));
});

describe('PRF PDF field coverage — every call-type × billing-type', () => {
  for (const callType of Object.keys(MATRIX)) {
    for (const billingType of MATRIX[callType]) {
      const label = `${CALL_LABEL[callType] ?? callType} + ${billingType}`;

      // Signature count is call-type dependent, so it can't be hard-coded:
      //   standard  → 3 T&C (patient / witness / next-of-kin) + handover
      //               + 2 crew sign-offs = 6
      //   RHT       → the patient refused transport, so there is no facility
      //               Handover Signature = 5
      //   DOD       → the death-certificate layout replaces the T&C + handover
      //               stack with 2 crew sign-offs, the recipient signature and
      //               the 2 declaration signatures = 5
      // RESUS is 3, not 6: the handover mark and the two crew sign-offs. The
      // three Terms & Conditions marks (patient/rep, witness, next of kin) are
      // gone because the T&C block no longer prints on a resuscitation — the
      // crew form gates it behind `call_type !== 'RESUS'`
      // (DigitalPRFForm.tsx:9089), so those three could never be genuinely
      // captured on such a call. The fixture sets them synthetically, which is
      // exactly how a PDF ended up showing a patient in cardiac arrest having
      // "accepted full responsibility for all payments".
      const expectedSignatures =
        callType === 'RHT' ? 5 :
        callType === 'DOD' ? 5 :
        callType === 'RESUS' ? 3 : 6;

      describe(label, () => {
        it('renders every captured field onto the PDF pages', async () => {
          const built = buildPrf(callType, billingType);
          currentPrf = built.prf;
          renderPrfView();
          await screen.findByText((c) => c.includes(built.anchor));
          built.visible.forEach(expectVisible);
        });

        it('shows the correct call-type and billing-type rows', async () => {
          const built = buildPrf(callType, billingType);
          currentPrf = built.prf;
          renderPrfView();
          await screen.findByText((c) => c.includes(built.anchor));

          if (billingType === 'NONE') {
            // Courtesy: the payer block AND the page-1 "Billing Type" meta row
            // are both suppressed — assert their absence rather than a chip.
            // The neighbouring section head is asserted present first so a
            // typo in the queries below can't make this pass vacuously.
            expect(screen.queryByText('Debtor Information')).not.toBeNull();
            expect(screen.queryByText('Billing Information')).toBeNull();
            expect(screen.queryByText('Billing Type')).toBeNull();
          } else {
            // Substring match inside the row so "IOD" still matches the
            // canonical "WCA / IOD" label the form stores, and "PVT" matches
            // the "PVT — <method>" variant.
            expectFieldRow('Billing Type', billingType);
          }

          // Call type renders as one labelled row: "Primary", "Resus", "DOD",
          // "Refused Hospital Transport", or "Transfer — <subtype>" for IHT/IFT/COURTESY.
          built.chips.forEach(chip => expectFieldRow('Call Type', chip));
        });

        it(`renders ${expectedSignatures} signatures with no "Not captured" placeholders`, async () => {
          const built = buildPrf(callType, billingType);
          currentPrf = built.prf;
          const { container } = renderPrfView();
          await screen.findByText((c) => c.includes(built.anchor));
          expect(
            container.querySelectorAll('img[alt="signature"]').length,
            `${callType} should render ${expectedSignatures} captured signatures`,
          ).toBe(expectedSignatures);
          expect(screen.queryAllByText('Not captured')).toHaveLength(0);
        });
      });
    }
  }
});

// ── Return Trip: partial capture ────────────────────────────────────────────
/**
 * Regression guard for PRFView's `returnTripHasContent`.
 *
 * The guard used to test `fd.return_depart_time` — a key the crew form never
 * writes — and never looked at `fd.return_at_destination_time` at all. A
 * return leg where the crew captured only "Depart" and/or "At Dest" therefore
 * evaluated as empty and the ENTIRE Return Trip block was dropped from the PDF
 * that goes to the scheme, silently losing captured times.
 *
 * The guard must cover every key the block renders; these two are the ones
 * that were missing, so each is exercised on its own.
 */
describe('PRF PDF — Return Trip renders on a partially-captured return leg', () => {
  const CASES: Array<{ key: string; rowLabel: string }> = [
    { key: 'return_depart_scene_time',   rowLabel: 'Depart'  },
    { key: 'return_at_destination_time', rowLabel: 'At Dest' },
  ];

  for (const { key, rowLabel } of CASES) {
    it(`keeps the Return Trip block when only ${key} was captured`, async () => {
      const built = buildPrf('PRIMARY', 'MED AID');
      const sentinel = `ReturnOnly-${rowLabel.replace(/\s/g, '')}`;
      // The PRIMARY fixture carries no return-trip keys of its own, so this
      // single value is the ONLY thing that can keep the block alive.
      const fd = { ...built.fd, [key]: sentinel };
      currentPrf = { ...built.prf, form_data: fd };

      renderPrfView();
      await screen.findByText((c) => c.includes(built.anchor));

      expect(
        screen.queryByText('Return Trip'),
        `Return Trip block dropped when only ${key} was captured`,
      ).not.toBeNull();
      expectFieldRow(rowLabel, sentinel);
    });
  }
});

/**
 * ATTACHMENT / EXTRA-PAGE FAMILY
 *
 * This whole family had ZERO coverage: a keyword scan of both PDF test files
 * found 0 hits for raf_oar_report_pdf, attachedDocs, 'Attached Document',
 * body_marks and nursing_notes, while med_aid_dec_death had 22. Everything
 * beyond page 1 / page 2 / the Declaration of Death was untested.
 *
 * That gap hid a real defect: `raf_oar_report_pdf` is ONE form field that was
 * fed into TWO independent page loops, so a RAF OAR produced two sheets — and
 * the second rendered the PDF inside an <iframe>, which html2canvas cannot
 * rasterise, so the exported document carried a blank page.
 *
 * These assert SHEET COUNT and header text, which needs no un-mocking of
 * html2canvas and would have caught the duplicate immediately.
 */
describe('PRF PDF — attachments and extra sheets', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

  /** Sheets rendered for a fixture, after waiting for the PRF to load. */
  async function sheetsFor(extraFd: Record<string, any>) {
    const built = buildPrf('PRIMARY', 'MED AID');
    currentPrf = { ...built.prf, form_data: { ...built.fd, ...extraFd } };
    const { container } = renderPrfView();
    // findAllByText, not findByText: each attached-document sheet repeats the
    // patient identity in its own mini-header, so the anchor legitimately
    // appears more than once and the singular query would throw.
    await screen.findAllByText((c) => c.includes(built.anchor));
    return { container, sheets: container.querySelectorAll('.prf-print-frame').length };
  }

  /**
   * The PRIMARY fixture already carries attachments of its own, so these assert
   * the DELTA a field adds rather than an absolute count — that way the tests
   * keep meaning if the fixture gains or loses an attachment later.
   */
  async function baselineSheets() {
    const { sheets } = await sheetsFor({});
    cleanup();
    return sheets;
  }

  it('adds EXACTLY ONE sheet for a RAF OAR report, not two', async () => {
    // The regression this pins: raf_oar_report_pdf is ONE form field that was
    // listed in BOTH attachedDocs and the Patient Documents loop, so a single
    // uploaded OAR produced two sheets — and the second was an <iframe>, which
    // html2canvas cannot rasterise, so the exported PDF carried a blank page.
    const base = await baselineSheets();
    const { sheets } = await sheetsFor({
      raf_oar_report_pdf: { name: 'oar-report.pdf', size: 1024, data_url: PDF },
    });
    expect(sheets - base).toBe(1);
  });

  it('routes the OAR through the attached-document sheet, which handles a PDF honestly', async () => {
    await sheetsFor({
      raf_oar_report_pdf: { name: 'oar-report.pdf', size: 1024, data_url: PDF },
    });
    // attachedDocs renders "Attached Document — OAR Report" and degrades to a
    // labelled record block, because a canvas snapshot cannot render PDF pages.
    expect(screen.getAllByText(/Attached Document/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/OAR Report/i).length).toBeGreaterThan(0);
  });

  it('never renders an <iframe> — html2canvas cannot rasterise one, so it exports blank', async () => {
    const { container } = await sheetsFor({
      raf_oar_report_pdf: { name: 'oar-report.pdf', size: 1024, data_url: PDF },
    });
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('adds one sheet per nursing note', async () => {
    const base = await baselineSheets();
    const { sheets } = await sheetsFor({
      nursing_notes: [{ data_url: PNG }, { data_url: PNG }],
    });
    expect(sheets - base).toBe(2);
  });

  it('counts WCA documents and an OAR together without double-counting', async () => {
    const base = await baselineSheets();
    const { sheets } = await sheetsFor({
      wca_payslip_pdf:        { name: 'payslip.pdf', data_url: PDF },
      wca_medical_report_pdf: { name: 'medreport.pdf', data_url: PDF },
      raf_oar_report_pdf:     { name: 'oar.pdf', data_url: PDF },
    });
    expect(sheets - base).toBe(3);   // three documents, one sheet each
  });

  it('ignores an attachment field with no data_url rather than emitting a blank sheet', async () => {
    const base = await baselineSheets();
    const { sheets } = await sheetsFor({
      raf_oar_report_pdf: { name: 'oar.pdf', size: 0 },   // no data_url
    });
    expect(sheets - base).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Refusal of transport must PRINT as a refusal
// ════════════════════════════════════════════════════════════════════════════
//
// The crew captured a refusal declaration, a capacity checklist, the patient's
// stated reason, two printed names, a date and two signatures. NONE of it
// reached the PDF. The signature images did render — under "Terms and
// Conditions", above the billing clauses — so the permanent record showed a
// patient assenting to PAYMENT TERMS with nothing on it saying they had
// refused transport, who witnessed it, or when.
//
// A signature is only evidence of what sits above it.
// ════════════════════════════════════════════════════════════════════════════
// Page 1 has a hard height ceiling, so the tallest blocks live on page 2
// ════════════════════════════════════════════════════════════════════════════
//
// The ceiling is ~944 CSS px and comes from the legibility floor: printed text
// may not drop below 0.9 of design size, so the exporter may reflow no wider
// than 1220/0.9 ≈ 1355px, and at the A4-landscape ratio (0.697) that is 944px
// of height. Reallocating budget between reflow-widening and uniform shrink
// does NOT move it — widening lets a taller page fit but shrinks text by the
// same factor. Above the ceiling the exporter slices into even bands, which is
// what put half an IFT/IHT page 1 onto a second sheet, cut through the patient
// panel.
//
// So the two tallest blocks moved to page 2. jsdom has no layout engine and
// cannot measure any of that — what it CAN pin is the invariant that keeps the
// fix honest: each block renders EXACTLY ONCE, and never disappears on a call
// type that has no page 2 to hold it.
describe('page 1 height — the tall blocks moved, and did not go missing', () => {
  const withSticker = { hospital_sticker: 'data:image/png;base64,iVBORw0KGgo=' };

  async function renderCall(callType: string, billing: string, extra: Record<string, unknown> = {}) {
    const built = buildPrf(callType, billing);
    Object.assign(built.prf.form_data, extra);
    currentPrf = built.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(built.anchor), { exact: false });
    return built;
  }

  // Which SHEET a block lands on — not merely that it rendered.
  //
  // An earlier version only counted occurrences, and a mutation removing the
  // placement guards passed all of it: the block still rendered exactly once,
  // just on the wrong sheet. Counting is not placement.
  const sheets = () => Array.from(document.querySelectorAll('.prf-page'));
  const sheetContaining = (label: string): number =>
    sheets().findIndex(pg =>
      Array.from(pg.querySelectorAll('*')).some(
        el => el.children.length === 0 && el.textContent?.trim() === label));

  // Assert on the IMAGE, not on a heading. The reported defect was the same
  // picture printed TWICE — compact on the attachments sheet and full-size on
  // its own patient-documents page — and a heading count cannot see that,
  // because the two copies sit under different headings.
  const stickerImgs = () =>
    Array.from(document.querySelectorAll('img'))
      .filter(im => im.getAttribute('src') === withSticker.hospital_sticker);

  it('prints the hospital sticker EXACTLY once, and never on page 1', async () => {
    await renderCall('IHT', 'PVT', withSticker);
    expect(stickerImgs().length,
      'the sticker image is rendered on more than one sheet'
    ).toBe(1);
    // Page 1 carries the ~944px ceiling; the image is the tallest thing its
    // column can hold, so it must not be there.
    const pageOne = sheets()[0];
    expect(pageOne.contains(stickerImgs()[0]),
      'the sticker image is on page 1, which is at the height ceiling'
    ).toBe(false);
  });

  it('leaves a pointer on page 1 so nobody hunts for it', async () => {
    await renderCall('IHT', 'PVT', withSticker);
    expect(screen.queryAllByText((c) => c.includes('Hospital sticker — see the patient documents sheet'),
      { exact: false }).length).toBeGreaterThan(0);
  });

  // ── The two compact payers carry it on page 1 instead ────────────────────
  // Medical Aid bills a fixed short set of rows, and an Indigent PVT captures
  // no amounts at all, so the Billing column has slack the image can use —
  // measured in Chrome, page 1 does not grow at all, because the grid was
  // already stretching that column to match the taller Patient column.
  //
  // Each of these asserts BOTH halves: on page 1, and still exactly once. The
  // count alone would pass if it were restored to the attachments sheet too,
  // which is the defect this placement rule exists to prevent.
  for (const [label, extra] of [
    ['MED AID', { ...withSticker }],
    ['an Indigent PVT', { ...withSticker, pvt_payment_method: 'Indigent' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const billing = label === 'MED AID' ? 'MED AID' : 'PVT';

    it(`prints the sticker on page 1 under Billing Information for ${label}`, async () => {
      await renderCall('IHT', billing, extra);
      expect(stickerImgs().length,
        `the sticker is rendered ${stickerImgs().length} times on ${label} — it must be exactly once`
      ).toBe(1);
      expect(sheets()[0].contains(stickerImgs()[0]),
        `the sticker is not on page 1 for ${label}, where the billing column has room for it`
      ).toBe(true);
    });

    it(`drops the "see the documents sheet" pointer for ${label}`, async () => {
      await renderCall('IHT', billing, extra);
      expect(screen.queryAllByText((c) => c.includes('see the patient documents sheet'),
        { exact: false }).length,
        `${label} still cross-references a sheet the sticker is no longer on`
      ).toBe(0);
    });
  }

  it('still prints the cash receipt on a refusal, whose page 2 is watermark-only', async () => {
    // A refusal can take cash — "Refusal Of Treatment" is a selectable call-out
    // fee basis — and this is the only record of who handed money over. The
    // sheet is created on demand, so it exists whatever the call type; the
    // earlier page-2 version needed a fallback here and could drop the block.
    await renderCall('RHT', 'PVT', { pvt_payment_method: 'Cash' });
    expect(screen.queryAllByText('Cash Verification', { exact: true }).length,
      'the cash receipt vanished on a refusal'
    ).toBe(1);
    expect(sheetContaining('Cash Verification')).toBeGreaterThan(0);
  });

  it('does not create a second sheet for the sticker — it already has one', async () => {
    // The attachments sheet carries the cash receipt only. A captured sticker
    // is served by the "Patient Documents (Attachments)" loop, which gives it a
    // full sheet of its own; rendering it in both places is what printed it
    // twice. Exactly the mistake raf_oar_report_pdf made — one field feeding
    // two page-producing lists.
    await renderCall('IHT', 'PVT', { pvt_payment_method: 'Cash', ...withSticker });
    expect(screen.queryAllByText('Cash Verification', { exact: true }).length).toBe(1);
    expect(stickerImgs().length, 'the sticker image printed twice').toBe(1);
    const cashSheet = sheetContaining('Cash Verification');
    expect(cashSheet).toBeGreaterThan(0);
    // The two live on DIFFERENT sheets now: cash on the on-demand attachments
    // sheet, the sticker on its own full-size document page.
    expect(sheets()[cashSheet].contains(stickerImgs()[0])).toBe(false);
  });

  it('creates the extra sheet ON DEMAND, not for every PRF', async () => {
    // If it rendered unconditionally every PRF would gain a blank page — worse
    // than the layout bug it fixes, and nobody would notice until a scheme
    // complained about the volume. Measured as a DIFFERENCE: the fixture also
    // emits sheets for attached documents, so an absolute count proves nothing.
    // hospital_sticker is cleared explicitly: the SHARED fixture sets one on
    // every PRF, so "no overrides" is not "nothing to put on the sheet" — the
    // first version of this test measured a difference of zero for that reason.
    await renderCall('IHT', 'PVT', { hospital_sticker: '' });
    const without = sheets().length;
    expect(screen.queryAllByText('Cash Verification', { exact: true }).length).toBe(0);
    expect(screen.queryAllByText('Hospital Sticker', { exact: true }).length,
      'an empty sticker slot should stay on page 1, not claim a sheet'
    ).toBe(1);
    cleanup();

    await renderCall('IHT', 'PVT', { hospital_sticker: '', pvt_payment_method: 'Cash' });
    expect(sheets().length - without,
      'the cash receipt did not add exactly one sheet'
    ).toBe(1);
  });

});

describe('RHT — the refusal reaches the printed record', () => {
  const REFUSAL = {
    rht_waiver_signatory_name: 'Thandi Mokoena',
    rht_waiver_witness_name: 'Sipho Dlamini',
    rht_waiver_date: '2026-08-03',
    rht_refusal_reason: 'I feel fine, I will see my own doctor tomorrow',
    rht_cap_alert: true,
    rht_cap_no_impairment: true,
    rht_cap_risks_explained: true,
    rht_cap_questions: true,
    rht_cap_advised_recall: true,
    rht_cap_alternative_care: false,   // one unticked, so ☐ must render too
  };

  async function renderRefusal() {
    const built = buildPrf('RHT', 'PVT');
    Object.assign(built.prf.form_data, REFUSAL);
    currentPrf = built.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(built.anchor), { exact: false });
    return built;
  }

  it('names it a refusal, not a transfer', async () => {
    await renderRefusal();
    expectVisible('Refused Hospital Transport');
    const rows = screen.queryAllByText((c) => c.includes('Transfer'), { exact: false });
    expect(rows.length, 'the PDF still calls a refusal a transfer').toBe(0);
  });

  it('prints the declaration, both signatories, the date and the reason', async () => {
    await renderRefusal();
    expectVisible('Refusal of Treatment / Transport');
    expectVisible('Thandi Mokoena');
    expectVisible('Sipho Dlamini');
    expectVisible('2026-08-03');
    expectVisible('I feel fine, I will see my own doctor tomorrow');
    // The substance of informed refusal — not a blanket indemnity.
    expectVisible('against the advice given');
    expectVisible('call again');
  });

  it('prints the capacity checklist, ticked and unticked', async () => {
    await renderRefusal();
    expectVisible('Alert and fully oriented');
    expectVisible('No apparent impairment');
    // A checklist that only ever renders ticks proves nothing; the unticked
    // item must be visibly unticked.
    const ticked = screen.queryAllByText((c) => c.includes('☑'), { exact: false });
    const unticked = screen.queryAllByText((c) => c.includes('☐'), { exact: false });
    expect(ticked.length, 'no ticked capacity checks rendered').toBeGreaterThan(0);
    expect(unticked.length, 'an unticked capacity check rendered as ticked').toBeGreaterThan(0);
  });

  it('names the signed-in provider, never a hard-coded one', async () => {
    await renderRefusal();
    const body = document.body.textContent || '';
    expect(body, 'the refusal names a hard-coded company').not.toContain('JEMS');
  });

  // An empty section heading on a legal record does not read as "nothing to
  // show here" — it reads as "something failed to print", which invites exactly
  // the question this document exists to answer. Suppressing the duplicated
  // refusal marks left the "Signatures" band sitting above white space; the
  // 415-test suite passed straight through it, because every existing
  // assertion asked what IS on the page and none asked what is on it POINTLESSLY.
  // ── Layout: a refusal is not a billing document ─────────────────────────

  it('does not print Terms and Conditions on a refusal', async () => {
    await renderRefusal();
    // The digital PRF never presents these clauses for a refusal, so nobody
    // agreed to them — and they open with "I acknowledge that the treatment
    // and/or transportation noted on this document was received by the patient"
    // and "I accept full responsibility for all payments", on the one record
    // whose entire content is that treatment was DECLINED.
    expect(screen.queryAllByText('Terms and Conditions').length,
      'the billing/indemnity clauses print on a refusal'
    ).toBe(0);
    expect(screen.queryAllByText((c) => c.includes('was received by the patient'),
      { exact: false }).length,
      'a clause asserting treatment was received prints on a refusal'
    ).toBe(0);
  });

  it('states the refusal in the patient and billing blocks', async () => {
    await renderRefusal();
    // Both blocks are otherwise near-empty on a refusal, and an empty block
    // reads exactly like a call where the crew captured nothing. Twice: once
    // under Patient Information, once under Billing Information.
    const notes = screen.queryAllByText('Patient refused treatment', { exact: false });
    expect(notes.length,
      'the refusal is not stated on the face of the patient / billing blocks'
    ).toBeGreaterThanOrEqual(2);
  });

  it('still prints the payer details, because a call-out fee is billable', async () => {
    const built = await renderRefusal();
    // "Refusal Of Treatment" is one of the selectable call-out fee bases, so
    // the scheme and member number are what that fee is claimed against.
    // Replacing the payer grid with a refusal notice was the first attempt and
    // would have stripped the payer from the call type most likely to be queried.
    expect(screen.queryAllByText('Billing Information').length).toBeGreaterThan(0);
    expect(built).toBeTruthy();
  });

  it('keeps a next-of-kin signature that was actually captured', async () => {
    // The crew form presents Terms & Conditions for every call type except
    // RESUS, so a next-of-kin mark CAN exist on a refusal. Dropping the clauses
    // must not drop the signature with them — a captured signature that never
    // reaches the PDF is the exact defect this whole block was rewritten to fix.
    await renderRefusal();
    expect(screen.queryAllByText('Next of Kin').length,
      'a captured next-of-kin signature vanished with the T&C clauses'
    ).toBeGreaterThan(0);
  });

  it('drops the handover rows, duplicate signature and sticker once death is DECLARED', async () => {
    // A resuscitation releases the deceased to an UNDERTAKER. There is no
    // receiving clinician to name, no condition-on-handover to record, no
    // facility to email, and no facility patient label to affix — so all of
    // those printed either a row of "—" or an empty slot.
    //
    // The handover signature is the sharper one: the mark captured on a Resus
    // is the undertaker's, and it already prints beside the Undertaker Details
    // in the Declaration of Death block. Under a bare "Handover Signature"
    // heading on page 1 it read as a facility receiving a live patient, and it
    // was the same mark twice.
    const built = buildPrf('RESUS', 'MED AID');
    // The DECLARATION is the trigger, not the call type. Without this the fixture
    // is a resuscitation the crew WON, which is conveyed and handed over
    // normally — and every assertion below would be wrong.
    built.prf.form_data.med_aid_dec_death = true;
    currentPrf = built.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(built.anchor), { exact: false });

    // Assert on the VALUES for the four Call Information rows, not their labels.
    // "Qualification" is also the label of the certifying practitioner's row
    // inside the Declaration of Death block, which legitimately prints — a
    // global label count cannot tell the two apart. The sentinels can.
    for (const value of [built.fd.receiving_doctor, built.fd.handover_qualification,
                         built.fd.handover_notes, built.fd.handover_doctor_email]) {
      expect(
        screen.queryAllByText((c) => c.includes(value), { exact: false }).length,
        `"${value}" still prints once death is declared`,
      ).toBe(0);
    }
    // These two headings ARE unique to the blocks being removed.
    for (const label of ['Handover Signature', 'Hospital Sticker']) {
      expect(
        screen.queryAllByText(label, { exact: true }).length,
        `"${label}" still prints once death is declared`,
      ).toBe(0);
    }
    expect(screen.queryAllByText(/Affix hospital sticker here/i)).toHaveLength(0);

    // The rows that DO belong on a Resus must survive — otherwise this is
    // satisfied by dropping the whole Call Information block.
    expect(screen.queryAllByText('Dest Facility').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Ward').length).toBeGreaterThan(0);

    // Control 1: a resuscitation with NO declaration keeps everything — the
    // patient was brought back and taken to a hospital. This is the case the
    // first version of this change got wrong.
    cleanup();
    const liveResus = buildPrf('RESUS', 'MED AID');
    currentPrf = liveResus.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(liveResus.anchor), { exact: false });
    for (const label of ['Receiving Dr', 'Condition', 'Handover Signature', 'Hospital Sticker']) {
      expect(
        screen.queryAllByText(label, { exact: true }).length,
        `"${label}" is missing from a resuscitation that did NOT declare death`,
      ).toBeGreaterThan(0);
    }

    // Control 2: an ordinary call still carries all six.
    cleanup();
    const primary = buildPrf('PRIMARY', 'MED AID');
    currentPrf = primary.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(primary.anchor), { exact: false });
    for (const label of ['Receiving Dr', 'Condition', 'Handover Signature', 'Hospital Sticker']) {
      expect(
        screen.queryAllByText(label, { exact: true }).length,
        `"${label}" was removed from ordinary calls too`,
      ).toBeGreaterThan(0);
    }
  });

  it('prints no Terms and Conditions on a Resus — nobody was ever shown them', async () => {
    // The crew form gates its whole T&C block behind `call_type !== 'RESUS'`
    // (DigitalPRFForm.tsx:9089). So on a resuscitation the clauses are never
    // presented, nobody acknowledges them, and no signature can be captured
    // against them — yet the PDF printed the clauses AND a signing line, on the
    // record of a patient in cardiac arrest. Same defect the RHT case fixed,
    // simply never extended here.
    //
    // The signature-count assertion alone would not pin this: it is satisfied
    // by any change that happens to drop three marks. This names the clauses.
    const built = buildPrf('RESUS', 'MED AID');
    currentPrf = built.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(built.anchor), { exact: false });

    expect(screen.queryAllByText('Terms and Conditions')).toHaveLength(0);
    expect(
      document.body.textContent,
      'the financial-responsibility clause is printing on a cardiac arrest',
    ).not.toMatch(/accept full responsibility for all payments/i);
    for (const label of ['Patient / Rep.', 'Witness', 'Next of Kin']) {
      expect(
        screen.queryAllByText(label, { exact: true }).length,
        `a "${label}" signing line prints on a Resus, for terms never shown`,
      ).toBe(0);
    }
    // Control: a call type that DOES present the terms must still print them,
    // so this cannot be satisfied by removing the block outright.
    cleanup();
    const primary = buildPrf('PRIMARY', 'MED AID');
    currentPrf = primary.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(primary.anchor), { exact: false });
    expect(screen.queryAllByText('Terms and Conditions').length).toBeGreaterThan(0);
  });

  it('prints no orphaned signing lines on a refusal with nothing to sign', async () => {
    // This used to guard an empty "Signatures" section heading. That heading is
    // gone — the signing lines now sit inside the Terms and Conditions panel —
    // but the property it protected is unchanged and still matters: on a legal
    // record, a labelled line with nothing under it does not read as "nothing to
    // show", it reads as "something failed to print".
    const built = await renderRefusal();
    // The shared fixture carries a next-of-kin signature, which legitimately
    // fills the block. A real refusal has none — the only marks are the
    // patient's and the witness's, and both belong under the Refusal heading —
    // so clear it to reproduce the case that actually printed empty.
    delete built.prf.form_data.next_of_kin_signature;
    delete (built.prf as any).signatures?.next_of_kin_signature;
    cleanup();
    currentPrf = built.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(built.anchor), { exact: false });

    // "Witness" is deliberately NOT checked here: the Refusal block above prints
    // its own Witness label, and that one is correct — the refusal signatures
    // live there. The other two labels are unique to the terms strip, and on an
    // RHT the only one it could still emit is Next of Kin, so their absence is
    // exactly the property under test.
    for (const label of ['Patient / Rep.', 'Next of Kin']) {
      expect(screen.queryAllByText(label, { exact: true }).length,
        `an orphaned "${label}" signing line prints on an RHT — the refusal ` +
        'signatures belong in the Refusal block, and nothing should be left ' +
        'hanging under the terms'
      ).toBe(0);
    }
  });

  it('still prints the signing lines on a call that has its own signatures', async () => {
    // The negative control, and the reason the test above cannot simply assert
    // "nothing prints": suppressing the block when it is empty must not suppress
    // it when it is not, or every ordinary PRF silently loses the patient
    // signature — the one mark that is mandatory.
    const built = buildPrf('PRIMARY', 'PVT');
    currentPrf = built.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(built.anchor), { exact: false });
    expect(screen.queryAllByText('Patient / Rep.', { exact: true }).length,
      'a normal call lost its patient signing line'
    ).toBeGreaterThan(0);
  });

  it('shows the patient signature exactly once, under the refusal', async () => {
    // It used to appear under Terms & Conditions only. Adding a refusal block
    // without suppressing that one put the same mark under two different
    // headings — refusal AND billing terms — which muddies what was assented to.
    //
    // A UNIQUE data URI is used for the patient mark. The shared fixture gives
    // every signature the same PNG, so counting by src matched all six and the
    // first version of this test failed against correct code.
    const UNIQUE = 'data:image/png;base64,UkVGVVNBTFNJRw==';
    const built = buildPrf('RHT', 'PVT');
    Object.assign(built.prf.form_data, REFUSAL);
    built.prf.signatures.patient_signature = UNIQUE;
    currentPrf = built.prf;
    renderPrfView();
    await screen.findByText((c) => c.includes(built.anchor), { exact: false });

    const occurrences = Array.from(document.querySelectorAll('img'))
      .filter((i) => i.getAttribute('src') === UNIQUE).length;
    expect(occurrences, 'the patient signature is printed more than once').toBe(1);
  });
});


// ── Full Record fallback ───────────────────────────────────────────────────
//
// The printed sheets are a fixed-size A4 reproduction with a hard per-page
// height ceiling, and data nobody anticipated can always push them out of
// shape. This view is the guarantee that the INFORMATION stays readable when
// the LAYOUT does not, so the things worth pinning are: it is offered to
// EMSMCA admins only, it replaces the sheets rather than hiding them, and it
// renders every captured field — including any this file has never heard of.
describe('Full Record — the layout-independent fallback', () => {
  const renderCrewRoute = () => render(
    <MemoryRouter initialEntries={['/harness-ems/crew/prf-view/case-x']}>
      <Routes>
        <Route path="/:providerSlug/crew/prf-view/:caseId" element={<PRFView />} />
      </Routes>
    </MemoryRouter>,
  );

  it('is offered on the admin cases route', async () => {
    currentPrf = buildPrf('IHT', 'MED AID').prf;
    renderPrfView();
    await waitFor(() => expect(screen.queryByText('Full Record')).toBeTruthy());
  });

  it('is NOT offered on the crew route', async () => {
    // The crew route runs a tenant guard that redirects when there is no
    // session; an access_token short-circuits it (PRFView checks exactly that),
    // so the view actually renders and the assertion is not vacuous.
    localStorage.setItem('access_token', 'admin-token-for-guard');
    try {
      currentPrf = buildPrf('IHT', 'MED AID').prf;
      renderCrewRoute();
      await waitFor(() => expect(document.querySelectorAll('.prf-page').length).toBeGreaterThan(0));
      expect(screen.queryByText('Full Record')).toBeNull();
    } finally {
      localStorage.removeItem('access_token');
    }
  });

  it('replaces the sheets instead of leaving a hidden copy behind', async () => {
    // A hidden copy would still be selected by buildPrfPdf and the print
    // handler, which both query .prf-page — they would snapshot something the
    // reader cannot see.
    currentPrf = buildPrf('IHT', 'MED AID').prf;
    renderPrfView();
    await waitFor(() => expect(screen.queryByText('Full Record')).toBeTruthy());
    expect(document.querySelectorAll('.prf-page').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Full Record'));
    await waitFor(() => expect(screen.queryByText('PDF View')).toBeTruthy());
    expect(document.querySelectorAll('.prf-page').length).toBe(0);
  });

  it('renders a field it has never been told about', async () => {
    // The whole point: it enumerates the DATA, so a key added to the form
    // later cannot go missing here the way it can from a curated layout.
    const built = buildPrf('IHT', 'MED AID');
    built.prf.form_data.some_unmapped_future_field = 'UNMAPPED-SENTINEL-42';
    currentPrf = built.prf;
    renderPrfView();
    await waitFor(() => expect(screen.queryByText('Full Record')).toBeTruthy());
    fireEvent.click(screen.getByText('Full Record'));
    await waitFor(() => expect(screen.queryByText('PDF View')).toBeTruthy());
    // Present under the catch-all section, which is open by default only when
    // it is one of the first three — so expand everything first.
    screen.getAllByRole('button').forEach(b => {
      if (/Other captured fields/.test(b.textContent || '')) fireEvent.click(b);
    });
    expect(screen.queryAllByText((c) => c.includes('UNMAPPED-SENTINEL-42'), { exact: false }).length)
      .toBeGreaterThan(0);
  });
});
