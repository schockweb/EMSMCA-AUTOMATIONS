/**
 * DEV-ONLY harness for the PRF PDF export path.  NOT part of the app bundle.
 *
 * WHY IT EXISTS
 * -------------
 * The 72-test PDF suite mocks html2canvas to a blank 10x10 canvas and mocks
 * jsPDF's addImage/save to no-ops, so `buildPrfPdf` — the entire export path —
 * is never executed by any test. Every layout, rasterisation and pagination
 * defect is structurally invisible to it.
 *
 * This mounts the REAL PRFView with the REAL html2canvas and jsPDF, against a
 * synthetic PRF whose size is controlled by the URL:
 *
 *     /pdf-harness.html?iv=6&med=8      <- a busy code / long IHT
 *     /pdf-harness.html?iv=0&med=0      <- a minimal call
 *
 * No patient data and no credentials: axios.get is stubbed before PRFView runs.
 *
 * "Measure geometry" reports what buildPrfPdf's fit loop will actually do to
 * each sheet, including the resulting physical text size in points — the number
 * that decides whether an adjudicator can read the page.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';
// The app's global reset — WITHOUT it the harness lays out at content-box, so
// the 2px page border fell outside the 1220px design width and every measured
// height was taken from a box model the real app never uses.
import './index.css';
import {
  DESIGN_W_PX, SLICE_ESCAPE_W as SHIPPED_MAX_FIT_W,
  MAX_FIT_W as SHIPPED_PREFERRED_W, MIN_LEGIBLE_SCALE,
  SHRINK_LIMIT_MM, planPlacement, printedPt,
} from './pages/prfPdfLayout';

const qs = new URLSearchParams(location.search);
const IV_ROWS = Number(qs.get('iv') ?? 6);
const MED_ROWS = Number(qs.get('med') ?? 8);
const VITALS = Number(qs.get('vitals') ?? 3);

// ── Fixture ────────────────────────────────────────────────────────────────
// Values are realistic in LENGTH, because the fit loop's premise is that
// widening the sheet lets text re-wrap; short values cannot re-wrap, which is
// exactly the condition under test.
const ivTherapy = Array.from({ length: IV_ROWS }, (_, i) => ({
  type: ['0.9% NaCl', "Ringer's Lactate", '5% Dextrose'][i % 3],
  jelco_size: ['18G', '20G', '16G'][i % 3],
  site: ['Left ACF', 'Right ACF', 'Left dorsum', 'Right forearm'][i % 4],
  volume: `${250 * ((i % 4) + 1)} ml`,
  time: `10:${String(10 + i * 4).padStart(2, '0')}`,
  practitioner: 'A. Mokoena',
}));

const medications = Array.from({ length: MED_ROWS }, (_, i) => ({
  type: ['Morphine Sulphate', 'Adrenaline 1:10000', 'Amiodarone', 'Midazolam',
         'Paracetamol', 'Ondansetron', 'Ipratropium Bromide', 'Salbutamol'][i % 8],
  route: ['IV', 'IM', 'Nebulised', 'PO'][i % 4],
  dose: ['5 mg', '1 mg', '300 mg', '2.5 mg'][i % 4],
  time: `10:${String(12 + i * 3).padStart(2, '0')}`,
  practitioner: 'A. Mokoena',
}));

const vitalsSets = Array.from({ length: VITALS }, (_, i) => ({
  time: `10:${String(15 + i * 10).padStart(2, '0')}`,
  bp: `${120 + i * 4}/${78 + i * 2}`, pulse: `${88 + i * 3}`, resp: `${18 + i}`,
  spo2: `${96 - i}`, temp: `36.${8 - i}`, gcs_total: `${15 - i}`,
  gcs_e: '4', gcs_v: '5', gcs_m: '6', bgl: `${5 + i}.4`, pain: `${7 - i}`,
}));

// ?call=IHT renders the inter-facility variant of page 1 — which carries the
// Return Trip block that a Primary call does not. That block is what pushed
// page 1 past one A4 sheet and made the export slice mid-signature-box; the
// harness could never reproduce it while the fixture was hard-coded to Primary.
const CALL_TYPE = qs.get('call') || 'Primary';
// ?long=1 seeds the long wrapped addresses / notes a real crew types;
// ?sig=N (1-3) captures that many Terms & Conditions signatures.
const LONG = qs.get('long') === '1';
// ?dod=1 — the crew ticked "Declaration of Death". On a RESUS this is the
// difference between a resuscitation the crew WON (conveyed, handed over,
// stickered) and one they lost (released to an undertaker). The harness could
// not express it, which is how a change keyed on the call type rather than on
// the declaration reached a real PDF.
const DECLARED_DEAD = qs.get('dod') === '1';
const SIGS = Number(qs.get('sig') ?? 0);
// A visible stand-in for captured ink — a short scribble path.
const INK = 'data:image/svg+xml;base64,' + btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="70">' +
  '<path d="M8 52 C40 8, 70 62, 100 30 S160 8, 200 46" fill="none" stroke="#111" stroke-width="3"/></svg>');
const IS_IFT = CALL_TYPE === 'IHT' || CALL_TYPE === 'IFT';
// ?max=1 — EVERY field the PDF can render, at a realistic worst-case LENGTH.
// The per-flag fixtures above each reproduce one reported defect; this one
// answers a different question: with this call type and payer, what is the
// tallest the sheet can legitimately get? Field lists drift, so the values
// below are keyed to the `fd.*` keys PRFView actually reads — add a field to
// the PDF and it belongs here too, or the matrix silently stops covering it.
const MAXFILL = qs.get('max') === '1';
// ?refused=1 — RHT where the patient declined. Hides five blocks and prints
// the waiver instead, so it is a different page-1 shape, not a smaller one.
const REFUSED = qs.get('refused') === '1';
// ?text=N multiplies every free-text block. Row counts are paginated now
// (vitals, IV, medication), so narrative length is the remaining unbounded
// dimension — a genuinely sick patient is not extra ROWS so much as a much
// longer history, findings and management note. This is the axis that decides
// whether page 1 and the clinical page hold.
const TEXT_MULT = Math.max(1, Number(qs.get('text') ?? 1));
const LOREM = (n: number) => Array.from({ length: n * TEXT_MULT }, (_, i) =>
  `Line ${i + 1}: documented in full by the attending practitioner at the scene, including all relevant observations and the clinical reasoning applied.`).join(' ');

// ?sticker=1 attaches a hospital sticker. A CAPTURED sticker is what changes
// pagination (the empty slot is ~110px, the image takes the block to ~230px)
// and it is also the artefact that was being printed twice — once compact on
// the attachments sheet and once full-size on its own patient-documents page.
// Without a sticker in the fixture the harness cannot see either behaviour.
const STICKER = qs.get('sticker') === '1'
  ? 'data:image/svg+xml;base64,' + btoa(
      // SQUARE, not wide. A wide sticker is constrained by the column width and
      // never reaches the height cap, so it cannot reproduce the case where the
      // image drives the Billing column's height — which is the one that pushed
      // page 1 past the sheet ceiling. Real hospital labels and logos are often
      // roughly square.
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">' +
      '<rect width="300" height="300" fill="#e5e7eb"/>' +
      '<text x="20" y="60" font-size="20" font-family="monospace">HOSPITAL LABEL</text>' +
      '<text x="20" y="140" font-size="16" font-family="monospace">HARNESS PATIENT</text>' +
      '<text x="20" y="220" font-size="16" font-family="monospace">MRN 0099887</text></svg>')
  : '';

const FD: Record<string, any> = {
  // ?billing=PVT exercises the private-cash block (Cash Verification).
  call_type: CALL_TYPE, billing_type: (qs.get('billing') || 'MED AID'), priority: 'RED',
  // Return-trip times only exist on an inter-facility transfer.
  ...(IS_IFT ? {
    return_despatch_time: '11:48',
    return_on_scene_time: '12:49',
    return_depart_scene_time: '11:49',
    return_at_destination_time: '11:49',
    return_handover_time: '11:49',
    return_available_time: '11:49',
  } : {}),
  patient_name: 'Sipho', patient_surname: 'Harness',
  patient_id_number: '9001015800083', patient_age: '42', patient_gender: 'Male',
  medical_scheme: 'GEMS', medical_aid_number: 'GEMS-1234567',
  preauth_number: 'AUTH-99881', main_member_name: 'Sipho Harness',
  chief_complaint: 'Central crushing chest pain radiating to the left arm, onset 40 minutes prior to EMS arrival.',
  events_hpi: 'Patient collapsed at home while climbing stairs. Bystander CPR not required. On arrival patient was alert, diaphoretic and clammy with severe central chest pain rated 8/10, radiating to the left arm and jaw. Aspirin given by family prior to arrival.',
  current_medications: 'Metformin 850mg BD, Enalapril 10mg daily, Simvastatin 20mg nocte',
  allergies: 'Penicillin — rash',
  past_history: 'Type 2 diabetes mellitus, hypertension, previous NSTEMI 2023',
  iv_therapy: ivTherapy,
  medications,
  vitals_sets: vitalsSets,
  management_notes: 'Oxygen via non-rebreather at 15 L/min. IV access established. Cardiac monitoring commenced showing sinus tachycardia. 12-lead ECG performed showing ST elevation in leads II, III and aVF. Pre-hospital notification given to receiving facility cardiac unit.',
  destination_facility: 'Netcare Sunninghill Hospital',
  transport_priority: 'RED',
  // Fields that were captured by the crew but never reached the PDF until
  // 2026-07-28. Present here so the harness proves they now render.
  ...(STICKER ? { hospital_sticker: STICKER } : {}),
  // Mechanism + priority: needed to see the blocks that moved to page 2.
  mechanism: ['MVA (MOTOR VEHICLE ACCIDENT)'],
  mechanism_other: 'Car versus pedestrian at speed',
  assessment_level: 'BLS',
  monitoring_level: 'ALS',
  transfer_subtype: 'Hospital to Hospital',
  primary_iv_fluid_resuscitation: true,
  primary_iv_profuse_bleeding: true,
  iv_medication_administration: true,
  billing_type_pvt_cash: true,
  pvt_payment_method: 'Cash',
  pvt_cash_amount_paid: '1500',
  pvt_cash_payer_name: 'Nomsa Harness-Payer',
  pvt_cash_crew_received: '1500',

  // ?long=1 — the realistic worst case for page 1, and the one that was
  // missing here. Page 1's height is driven by its TALLEST BAND-B COLUMN, and
  // the fixture above has short one-line addresses, so it could not reproduce a
  // real PRF where the crew types a rambling residential address, a debtor
  // address and a full page of motivation notes. Those wrap to many lines and
  // are what actually pushes page 1 past the one-sheet ceiling into a slice.
  ...(LONG ? {
    patient_address: 'Sjakjsks on the side of some road to springbok and they’d wan aisndo sonwisne. Dis e mix me Kane widow s Kane die. Eid e eidoi i jekkwkdnd e enekieje eksoosnejd d jdjeneodjendnen d make s. E',
    // Both passports and the work number are OPTIONAL rows — they only render
    // when captured. They are in the long fixture because they are exactly what
    // tips a marginal page over: each adds ~22px to the tallest Band B column,
    // and the reported slice came from a PRF that had all three.
    patient_passport_number: '123344556678990',
    debtor_passport_number: '1234',
    patient_suburb: 'pe', patient_postal_code: '1839',
    patient_phone_home: '46618161918', patient_phone_work: '454546914',
    patient_phone_cell: '80373438', accompanying_persons_count: '4',
    debtor_name: 'Michael', debtor_surname: 'Sxhuttler', debtor_gender: 'Male',
    debtor_id_number: '1234', debtor_age: '26',
    debtor_address: '28 lemon woood is this was a good idea and a good one to start off the week off right',
    debtor_suburb: 'centurion', debtor_postal_code: '0193',
    debtor_phone_home: '848484', debtor_phone_cell: '2848454',
    mechanism: ['MVA (MOTOR VEHICLE ACCIDENT)'],
    mechanism_other: 'A car hit a motor vehicle',
    motivation_notes: 'And and other notes Motivation and other notes motivation and other notes motivation and other notes motivation and other notes motivation and other notes motivation and other',
  } : {}),

  // ?sig=3 — all three Terms & Conditions marks captured. The default fixture
  // has none, so it could not reproduce the fully-signed page either.
  ...(SIGS >= 1 ? { tc_patient_signature: INK } : {}),
  ...(SIGS >= 2 ? { tc_witness_signature: INK } : {}),
  ...(SIGS >= 3 ? { next_of_kin_signature: INK } : {}),

  // ── Maximum fill ────────────────────────────────────────────────────────
  ...(MAXFILL ? {
    // Patient + postal + debtor, every optional row present.
    patient_name: 'Sipho Thembalethu', patient_surname: 'Ndlovu-Harrington',
    patient_id_number: '9001015800083', patient_passport_number: 'A01234567',
    patient_dob: '1990-01-01', age: '42', gender: 'Male',
    patient_address: '1147 Emfuleni Drive, Extension 14, Sebokeng Unit 7, Vanderbijlpark',
    patient_suburb: 'Sebokeng Unit 7', patient_postal_code: '1983',
    patient_postal_address: 'PO Box 88214, Emfuleni Central Post Office',
    patient_postal_suburb: 'Vanderbijlpark Central', patient_postal_address_code: '1900',
    patient_phone_home: '016 555 0142', patient_phone_work: '011 555 0987',
    patient_phone_cell: '082 555 0176',
    accompanying_persons_count: '4',
    debtor_name: 'Nomsa Precious', debtor_surname: 'Ndlovu-Harrington',
    debtor_gender: 'Female', debtor_id_number: '9203026100085',
    debtor_passport_number: 'B07654321', debtor_dob: '1992-03-02', debtor_age: '34',
    debtor_address: '28 Lemonwood Crescent, Highveld Techno Park, Centurion',
    debtor_suburb: 'Highveld Techno Park', debtor_postal_code: '0157',
    debtor_phone_home: '012 555 0033', debtor_phone_cell: '083 555 0044',
    // Payer blocks — all of them, so the widest one is always exercised.
    medical_scheme: 'Government Employees Medical Scheme (GEMS)',
    medical_aid_number: 'GEMS-1234567-01', dependent_number: '04',
    main_member_id: '8801015800081', scheme_option: 'Emerald Value Option',
    preauth_number: 'AUTH-99881-2026', post_auth_number: 'POST-99881-2026',
    med_aid_quoted: true, med_aid_quoted_amount: '4750.00',
    compensation_reference: 'REF-COMP-2026-000871',
    raf_police_case_number: 'CAS 214/08/2026 Vanderbijlpark SAPS',
    raf_accident_date: '2026-08-11',
    raf_accident_location: 'N1 South, 2.4 km before the Grasmere Plaza off-ramp',
    // The sketch + OAR each add a full sheet — without them the max-fill
    // undercounts the tallest legitimate RAF export by two pages.
    raf_sketch: INK,
    raf_oar_report_pdf: { name: 'oar-report.pdf', size: 2048, page_count: 2, data_url: INK, extra_pages: [INK] },
    wca_employer: 'Emfuleni Industrial Fabrication (Pty) Ltd',
    wca_employer_address: '14 Foundry Road, Vereeniging Industrial Sites, Gauteng',
    wca_employer_contact: '016 555 0900', wca_employee_number: 'EMP-0099213',
    wca_employer_responsible_person: 'Mr T. van der Westhuizen (Safety Officer)',
    wca_oar_number: 'OAR-2026-114872', wca_injury_date: '2026-08-11',
    wca_incident_description: LOREM(2),
    pvt_payment_method: 'Cash', pvt_cash_amount_paid: '1500.00',
    pvt_cash_payer_name: 'Nomsa Precious Ndlovu-Harrington',
    pvt_cash_crew_received: '1500.00', pvt_cash_payer_signature: INK,
    pvt_cash_crew_signature: INK,
    pvt_account_holder: 'Ndlovu-Harrington Family Trust',
    pvt_account_holder_id: '9203026100085',
    pvt_account_holder_address: '28 Lemonwood Crescent, Highveld Techno Park',
    pvt_account_holder_phone: '083 555 0044',
    // Clinical narrative — the blocks that absorb leftover height.
    primary_diagnosis: 'ST-elevation myocardial infarction, inferior wall, Killip class II',
    findings_on_arrival: LOREM(3),
    past_medical_history: 'Type 2 diabetes mellitus, hypertension, previous NSTEMI 2023, chronic kidney disease stage 2',
    last_meal: 'Light breakfast — bread and tea', last_meal_time: '07:20',
    survey_a: 'Patent, self-maintained', survey_b: 'Equal bilateral air entry, no adventitious sounds',
    survey_c: 'Radial pulses present, capillary refill 3 seconds, skin cool and clammy',
    survey_head_back: 'No external head injury, no Battle sign, no raccoon eyes',
    survey_chest: 'No flail segment, no surgical emphysema, sternal tenderness on palpation',
    survey_abdo: 'Soft, non-distended, mild epigastric tenderness, no guarding',
    survey_limbs: 'No deformity, full range of movement, peripheral pulses intact',
    survey_neuro: 'GCS 15/15, PEARL, no focal deficit, moving all four limbs',
    survey_back: 'No step, no deformity, no midline tenderness on log roll',
    management_notes: LOREM(4), motivation_notes: LOREM(3),
    nursing_notes: LOREM(2),
    // Interventions.
    airway_interventions: ['OP Airway', 'Suction', 'Intubation'],
    circulation_interventions: ['IV Access', 'Fluid Resuscitation', 'Cardiac Monitoring'],
    o2_device: 'Non-rebreather mask', o2_flow_rate: '15', o2_percent: '95',
    o2_start_time: '10:12', o2_stop_time: '10:52', o2_bvm: true,
    op_airway_size: '4', ett_size: '7.5', ett_depth: '22', intubation_attempts: '2',
    ng_tube_size: '16', iv_attempts: '2', defib_joules: '200',
    immob_equipment: 'Cervical collar, scoop stretcher, head blocks',
    other_equipment: 'Traction splint, pelvic binder, 12-lead monitor',
    // Handover.
    receiving_facility: 'Netcare Sunninghill Hospital — Cardiac Catheterisation Unit',
    ward: 'Cath Lab 2', receiving_doctor: 'Dr M. van Rensburg',
    handover_qualification: 'PR0123456', handover_doctor_email: 'cathlab@sunninghill.test',
    handover_notes: LOREM(2),
    valuables_handed_to: 'Sister P. Mahlangu (Casualty)',
    valuables_description: 'One wallet with R240 cash, one Samsung cellular telephone, one wedding band, one set of house keys',
    valuables_signature: INK,
    // Every attachment slot — each one adds a full sheet to the export.
    admission_form_image: STICKER || INK, id_document_image: INK,
    medical_aid_image: INK, aod_document: INK, additional_document_image: INK,
    // Crew.
    assessed_by: 'A. Mokoena', assessor_qualifications: 'ECP',
    managed_by: 'T. Dlamini', manager_qualifications: 'AEA',
    extra_crew: [{ name: 'L. Sithole', qualification: 'BAA', hpcsa_number: 'BAA0011223' }],
    crew_signoff_sigs: { c1: INK, c2: INK, c3: INK },
    tc_patient_signature: INK, tc_witness_signature: INK, next_of_kin_signature: INK,
    vitals_shortfall_motivation: LOREM(1),
    // The submit waiver — new, and it prints on the clinical sheet, so the
    // matrix has to see what it does to that page's height.
    submit_override_reason: LOREM(1),
    submit_override_items: [
      { field: 'hospital_sticker', label: 'Hospital sticker' },
      { field: 'handover_signature', label: 'Handover signature (receiving practitioner)' },
    ],
    submit_override_by: 'A. Mokoena · ECP0012345',
    submit_override_at: '2026-08-12T11:05:00Z',
  } : {}),

  ...(REFUSED ? {
    patient_refused_treatment: true,
    rht_refusal_reason: LOREM(2),
    rht_waiver_date: '2026-08-12',
    rht_waiver_signatory_name: 'Sipho Thembalethu Ndlovu-Harrington',
    rht_waiver_witness_name: 'Constable K. Mabaso, SAPS Vanderbijlpark',
    rht_call_out_fee: 'Standby Cancellation',
  } : {}),

  ...(DECLARED_DEAD ? {
    med_aid_dec_death: true,
    med_aid_dec_death_hcp_name: 'Dr N. Harness',
    med_aid_dec_death_hcp_qualification: 'MBChB',
    med_aid_dec_death_hcp_hpcsa: 'MP0123456',
    med_aid_dec_death_med_carotid: 'Absent',
    med_aid_dec_death_med_heart_sounds: 'Absent',
    undertaker_name: 'Harness Funeral Services',
    undertaker_phone: '011 555 0000',
    undertaker_collector_name: 'S. Collector',
    undertaker_collector_signature: INK,
  } : {}),
};

const PRF_FIXTURE = {
  prf_number: 'PRF-HARNESS-0001',
  case_number: 'HARNESS-2026-07-000001',
  submitted_at: '2026-07-28T10:05:00',
  form_data: FD,
  timestamps: {
    time_call_received: '2026-07-28T09:58:00',
    time_dispatched: '2026-07-28T10:00:00',
    time_on_scene: '2026-07-28T10:09:00',
    time_depart_scene: '2026-07-28T10:31:00',
    time_at_destination: '2026-07-28T10:52:00',
    time_available: '2026-07-28T11:10:00',
  },
  kms: {
    km_dispatched: '104213', km_on_scene: '104219', km_depart_scene: '104219',
    km_at_destination: '104238', km_available: '104238',
  },
  provider: {
    name: 'Harness EMS Provider', slug: 'harness-ems',
    phone: '011 000 0000', pr_number: '0890030746',
    pty_reg_number: '2017/438874/07',
    address: '1 Harness Road, Johannesburg', email: 'ops@harness.test',
  },
  crew_1: { name: 'A. Mokoena', hpcsa_number: 'ECP0012345', qualification: 'ECP' },
  crew_2: { name: 'T. Dlamini', hpcsa_number: 'AEA0067890', qualification: 'AEA' },
  vehicle: { callsign: 'JEMS-01', registration: 'ND 123-456' },
};

// ── Stub the backend, BEFORE PRFView is imported ───────────────────────────
// Replacing axios.get is unreliable here (Vite pre-bundles axios, so the
// harness and PRFView can hold different bindings). Swapping the ADAPTER
// intercepts every axios request whatever method is used.
(axios.defaults as any).adapter = async (config: any) => {
  const url: string = config.url || '';
  const respond = (data: any, status = 200) => ({
    data, status, statusText: 'OK', headers: {}, config, request: {},
  });
  if (url.includes('/api/digital-prf/admin/by-case/')) return respond(PRF_FIXTURE);
  // Anything else the page happens to ask for resolves empty rather than
  // erroring, so one unrelated call cannot blank the whole render.
  return respond({}, 200);
};
localStorage.setItem('access_token', 'harness-dev-token');

// ── Geometry probe — mirrors buildPrfPdf's fit loop exactly ────────────────
const PAGE_W_MM = 297, PAGE_H_MM = 210, INSET_MM = 5;
const maxW = PAGE_W_MM - INSET_MM * 2;          // 287
const maxH = PAGE_H_MM - INSET_MM * 2;          // 200
const SHEET_RATIO = maxH / maxW;                // ~0.697
// The SMALLEST text on the sheet, not merely a representative one. The probe
// used to be the 0.56rem FieldRow label, which made the harness report "ok"
// while the Terms & Conditions clause body (PRFView.tsx, 0.46rem — 18% smaller,
// and on page 1 of every non-DOD call) printed a full point smaller than the
// number shown. A legibility probe anchored above the true minimum certifies
// pages it has not actually checked.
const LABEL_REM = 0.56;                         // FieldRow label
const SMALLEST_REM = 0.46;                      // T&C clause body — the real floor
const ROOT_PX = 16;
// Imported from the shipped policy so the harness can never drift from it.
// `?cap=2400` replays the pre-fix behaviour for a like-for-like comparison.
const DESIGN_W = DESIGN_W_PX;
const MAX_FIT_W = Number(qs.get('cap') ?? SHIPPED_MAX_FIT_W);

function measure() {
  // Measure the .prf-page — the element BOTH real pipelines measure and widen
  // (buildPrfPdf and the beforeprint fit()). The probe used to read
  // .prf-print-frame, which is styled only inside `@media print`: on screen it
  // is an unstyled block, so its offsetWidth was the container's, and setting a
  // width on it could not override the inline width:1220 on the .prf-page
  // inside it. The widen loop was therefore a no-op and every number this
  // harness printed described a page the exporter never sees.
  const frames = Array.from(document.querySelectorAll<HTMLElement>('.prf-page'));
  const lines: string[] = [];
  lines.push(`call=${CALL_TYPE} iv=${IV_ROWS} med=${MED_ROWS} vitals=${VITALS}  sheets=${frames.length}`);
  lines.push('');
  frames.forEach((el, i) => {
    const w0 = el.offsetWidth || DESIGN_W;
    const h0 = el.offsetHeight || 862;
    // Replay the widen loop without mutating the live DOM permanently.
    const prevW = el.style.width, prevMinW = el.style.minWidth;
    let w = w0, h = h0, passes = 0;
    for (let pass = 0; pass < 4 && h / w > SHEET_RATIO + 0.002; pass++) {
      w = Math.min(Math.ceil(h / SHEET_RATIO), MAX_FIT_W);
      el.style.width = `${w}px`; el.style.minWidth = `${w}px`;
      h = el.offsetHeight; w = el.offsetWidth || w;
      passes++;
      if (w >= MAX_FIT_W) break;
    }
    // Same claw-back as production: the wider reflow is kept only when it
    // actually avoided a slice, so a page that slices either way keeps the
    // larger text it had before.
    if (w > SHIPPED_PREFERRED_W && h / w > SHEET_RATIO + 0.002) {
      w = SHIPPED_PREFERRED_W;
      el.style.width = `${w}px`; el.style.minWidth = `${w}px`;
      h = el.offsetHeight; w = el.offsetWidth || w;
    }
    el.style.width = prevW; el.style.minWidth = prevMinW;

    // Use the SHIPPED policy so the harness reports what production will do.
    const cw = w * 1.5, ch = h * 1.5;                    // html2canvas scale: 1.5
    // Page 1 never slices — mirror the production call exactly.
    const plan = planPlacement(cw, ch, w, { neverSlice: i === 0 });
    const branch = plan.kind === 'slice' ? `slice x${plan.sheets}` : plan.kind;
    const labelPt = printedPt(LABEL_REM, plan.textScale, ROOT_PX);
    const smallestPt = printedPt(SMALLEST_REM, plan.textScale, ROOT_PX);
    const capped = w >= MAX_FIT_W;
    lines.push(
      `sheet ${i + 1}: ${w0}x${h0}px -> width ${w}px (${passes} pass${passes === 1 ? '' : 'es'})` +
      `${capped ? ' [at cap]' : ''}  branch=${branch}\n` +
      `          label  ${LABEL_REM}rem: ${labelPt.toFixed(2)}pt${labelPt < 5 ? '   <<< BELOW LEGIBILITY' : '   ok'}\n` +
      `          T&C ${SMALLEST_REM}rem: ${smallestPt.toFixed(2)}pt   (smallest text on the sheet)`,
    );
  });
  return lines.join('\n');
}

(window as any).__measure = measure;
// Diagnostic capture probe — runs the EXACT html2canvas call buildPrfPdf
// makes against the first .prf-page and reports the canvas dimensions plus
// where the ink actually ends inside it. Used to chase the "export breaks
// under browser zoom / on a small laptop" report: measurements are pure
// arithmetic and provably viewport-independent, so if the export differs
// the rasteriser is the stage doing it.
(window as any).__captureProbe = async (idx = 0, scale = 1.5) => {
  const el = document.querySelectorAll<HTMLElement>('.prf-page')[idx];
  if (!el) return { error: 'no sheet' };
  const { default: h2c } = await import('html2canvas');
  const canvas = await h2c(el, {
    scale, useCORS: true, backgroundColor: '#ffffff',
    windowWidth: el.scrollWidth, windowHeight: el.scrollHeight,
  });
  const ctx = canvas.getContext('2d')!;
  // Find the lowest row containing any dark pixel — cropped content shows
  // up as inkBottom << canvas height; overflow shows as ink at the very end.
  let inkBottom = 0;
  const step = Math.max(1, Math.floor(canvas.height / 400));
  for (let y = canvas.height - 1; y >= 0 && !inkBottom; y -= step) {
    const row = ctx.getImageData(0, y, canvas.width, 1).data;
    for (let i = 0; i < row.length; i += 4) {
      if (row[i] < 160 && row[i + 3] > 40) { inkBottom = y; break; }
    }
  }
  return {
    dpr: window.devicePixelRatio,
    elW: el.offsetWidth, elH: el.offsetHeight,
    cw: canvas.width, ch: canvas.height,
    expectedCw: Math.round(el.offsetWidth * 1.5),
    expectedCh: Math.round(el.offsetHeight * 1.5),
    inkBottom, inkBottomFrac: Math.round((inkBottom / canvas.height) * 100) / 100,
  };
};
// Structured form of the same numbers, for sweeping the call-type x payer
// matrix programmatically. Same code path as measure() — the text report and
// this must never be able to disagree.
(window as any).__measureJson = () => {
  const frames = Array.from(document.querySelectorAll<HTMLElement>('.prf-page'));
  const text = measure();
  const sheets = text.split('\n').filter(l => l.startsWith('sheet ')).map((l, i) => {
    const branch = /branch=([a-z0-9 x]+)/i.exec(l)?.[1]?.trim() ?? '?';
    const raw = /^sheet \d+: (\d+)x(\d+)px -> width (\d+)px/.exec(l);
    return { sheet: i + 1, w0: Number(raw?.[1]), h0: Number(raw?.[2]), w: Number(raw?.[3]), branch };
  });
  const pts = [...text.matchAll(/T&C 0\.46rem: ([0-9.]+)pt/g)].map(m => Number(m[1]));
  return {
    call: CALL_TYPE, billing: qs.get('billing') || 'MED AID',
    max: MAXFILL, refused: REFUSED, dod: DECLARED_DEAD,
    pages: frames.length, sheets, smallestPt: pts.length ? Math.min(...pts) : null, text,
  };
};

// ── Mount ──────────────────────────────────────────────────────────────────
import('./pages/PRFView').then(({ default: PRFView }) => {
  createRoot(document.getElementById('root')!).render(
    <MemoryRouter initialEntries={['/cases/harness-case-1/prf']}>
      <Routes>
        <Route path="/cases/:caseId/prf" element={<PRFView />} />
      </Routes>
    </MemoryRouter>,
  );

  const out = document.getElementById('harness-out')!;
  document.getElementById('harness-rows')!.textContent = `iv=${IV_ROWS} med=${MED_ROWS}`;
  document.getElementById('btn-measure')!.addEventListener('click', () => {
    out.textContent = measure();
    console.log(measure());
  });
  document.getElementById('btn-export')!.addEventListener('click', () => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => /save as pdf|download|export/i.test(b.textContent || ''));
    if (btn) { out.textContent = 'clicked: ' + btn.textContent; (btn as HTMLButtonElement).click(); }
    else out.textContent = 'no export button found on the page';
  });
});
