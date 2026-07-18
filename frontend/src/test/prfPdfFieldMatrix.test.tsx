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
 * Billing types (BILLING_TYPE_OPTS):
 *   MED AID, IOD, RAF, PVT, EVENT, CALL OUT FEE
 *
 * Billing availability rules (from BillingTypePicker.billingOpts):
 *   DOD   → MED AID, PVT          (no IOD / RAF — no third-party patient to bill)
 *   RESUS → MED AID, PVT          (restricted to these two)
 *   else  → MED AID, IOD, RAF, PVT, EVENT, CALL OUT FEE
 *
 * Each scenario uses unique sentinel values so a missing field is unambiguous:
 * the failing assertion prints the exact value that dropped off the PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import axios from 'axios';
import PRFView from '../pages/PRFView';

// ── Mocks ─────────────────────────────────────────────────────────────────
vi.mock('axios');
vi.mock('jspdf', () => ({
  jsPDF: vi.fn(() => ({
    addPage: vi.fn(), addImage: vi.fn(),
    output: vi.fn(() => new Blob()), save: vi.fn(),
  })),
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

  // Sentinels that must be visible. Arrays / row objects / images are checked
  // structurally elsewhere; here we list the scalar text values.
  const visible = [
    // referring_doctor + handover_name are captured but no longer rendered on
    // the PRF (removed by request), so they're not asserted as visible.
    fd.incident_location, fd.suburb_ward, fd.receiving_facility,
    fd.ward, fd.receiving_doctor,
    fd.patient_name, fd.patient_surname, fd.patient_id_number, fd.patient_passport_number,
    fd.age, fd.patient_dob, fd.patient_address, fd.patient_suburb, fd.patient_postal_code,
    fd.patient_postal_address, fd.patient_postal_suburb, fd.patient_postal_address_code,
    fd.patient_phone_home, fd.patient_phone_work, fd.patient_phone_cell, fd.accompanying_persons_count,
    fd.debtor_name, fd.debtor_surname, fd.debtor_id_number, fd.debtor_passport_number,
    fd.debtor_age, fd.debtor_dob, fd.debtor_address, fd.debtor_suburb, fd.debtor_postal_code,
    fd.debtor_phone_home, fd.debtor_phone_cell,
    fd.mechanism_other,
    fd.handover_qualification, fd.handover_doctor_email, fd.handover_notes,
    fd.valuables_handed_to, fd.valuables_description, fd.management_notes,
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
  return { fd, visible };
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
        // PRFView only adds a 2nd chip for IHT/IFT/RHT/COURTESY — RESUS shows
        // just the "Transfer" chip.
        chips: ['Transfer'],
      };
    case 'DOD': // declaration of death — DoD sub-block
      return {
        fd: {
          call_type: 'DOD',
          med_aid_dec_death: true,
          med_aid_dec_death_time: `DodTime-${tag}`,
          med_aid_dec_death_declared_by: `DodBy-${tag}`,
          med_aid_dec_death_hpcsa: `DodHpcsa-${tag}`,
        },
        visible: [`DodTime-${tag}`, `DodBy-${tag}`, `DodHpcsa-${tag}`],
        // DOD likewise renders only the "Transfer" chip on page 1.
        chips: ['Transfer'],
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
    case 'EVENT': // event standby (legacy)
      return {
        fd: {
          billing_type: 'EVENT',
          event_name: `EventName-${tag}`,
          event_organiser: `EventOrg-${tag}`,
          event_date: `EventDate-${tag}`,
          event_booking_ref: `EventRef-${tag}`,
          event_contact_person: `EventContact-${tag}`,
        },
        visible: [
          `EventName-${tag}`, `EventOrg-${tag}`, `EventDate-${tag}`,
          `EventRef-${tag}`, `EventContact-${tag}`,
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
      return { fd: { billing_type: billingType }, visible: [] };
  }
}

// ── Fixture assembly ────────────────────────────────────────────────────────
function buildPrf(callType: string, billingType: string) {
  const tag = `${callType}-${billingType}`.replace(/[^A-Za-z0-9]/g, '');
  const common = commonGroup(tag);
  const call = callGroup(callType, tag);
  const billing = billingGroup(billingType, tag);

  const fd = { ...common.fd, ...call.fd, ...billing.fd };
  const visible = [...common.visible, ...call.visible, ...billing.visible];
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

  // Provider / vehicle / crew / km sentinels render on every PRF too.
  const metaVisible = [
    prf.case_number, prf.provider.name, prf.provider.phone, prf.provider.pr_number,
    prf.provider.address, prf.vehicle.callsign, prf.vehicle.registration,
    prf.crew_1.full_name, prf.crew_1.hpcsa_number, prf.crew_2.full_name, prf.crew_2.hpcsa_number,
    ...Object.values(prf.kms),
  ];

  return { prf, fd, visible: [...visible, ...metaVisible], chips };
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

// ── The matrix: every valid (call_type, billing_type) pairing ───────────────
const ALL_BILLING = ['MED AID', 'IOD', 'RAF', 'PVT', 'EVENT', 'CALL OUT FEE'];
const MATRIX: Record<string, string[]> = {
  PRIMARY:  ALL_BILLING,
  IHT:      ALL_BILLING,             // IFT/IHT
  RHT:      ALL_BILLING,
  COURTESY: ALL_BILLING,
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

      describe(label, () => {
        it('renders every captured field onto the PDF pages', async () => {
          const built = buildPrf(callType, billingType);
          currentPrf = built.prf;
          renderPrfView();
          await screen.findByText((c) => c.includes(built.fd.patient_name));
          built.visible.forEach(expectVisible);
        });

        it('shows the correct call-type and billing-type chips', async () => {
          const built = buildPrf(callType, billingType);
          currentPrf = built.prf;
          renderPrfView();
          await screen.findByText((c) => c.includes(built.fd.patient_name));
          // billing-type chip (e.g. "MED AID") — appears in the Billing Type
          // section. Substring match so "IOD" still matches the canonical
          // "WCA / IOD" label that the form stores.
          expect(screen.queryAllByText((c) => c.includes(billingType)).length).toBeGreaterThan(0);
          // call-type chip(s). PRFView renders transfer subtypes as a single
          // combined label (e.g. "Transfer — IHT"), so match by substring
          // rather than exact text.
          built.chips.forEach(chip => {
            const matches = screen.queryAllByText((c) => c.includes(chip));
            expect(matches.length, `call chip "${chip}" missing`).toBeGreaterThan(0);
          });
        });

        it('renders all 6 signatures with no "Not captured" placeholders', async () => {
          const built = buildPrf(callType, billingType);
          currentPrf = built.prf;
          const { container } = renderPrfView();
          await screen.findByText((c) => c.includes(built.fd.patient_name));
          // 3 T&C + handover + 2 crew = 6 (patient/witness under Valuables removed)
          expect(container.querySelectorAll('img[alt="signature"]').length).toBe(6);
          expect(screen.queryAllByText('Not captured')).toHaveLength(0);
        });
      });
    }
  }
});
