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
 *   • clinical bucket   — page 2, omitted entirely for a DOD.
 *
 * Each scenario uses unique sentinel values so a missing field is unambiguous:
 * the failing assertion prints the exact value that dropped off the PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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
    fd.suburb_ward, fd.receiving_facility, fd.ward, fd.receiving_doctor,
    fd.handover_qualification, fd.handover_notes, fd.handover_doctor_email,
    fd.valuables_handed_to, fd.valuables_description,
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

  return { fd, always, patient, transport, clinical };
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
        chips: ['Transfer', 'RHT'],
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
    ...(isDoD ? [] : common.clinical),
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
      const expectedSignatures =
        callType === 'RHT' ? 5 :
        callType === 'DOD' ? 5 : 6;

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
          // or "Transfer — <subtype>" for IHT/IFT/RHT/COURTESY.
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
