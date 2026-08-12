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
