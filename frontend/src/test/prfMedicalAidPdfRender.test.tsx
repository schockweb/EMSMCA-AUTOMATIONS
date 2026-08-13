/**
 * prfMedicalAidPdfRender.test.tsx — PRF → PDF field-visibility verification
 *
 * Scenario: PRIMARY call, billing type MED AID (medical scheme submission).
 *
 * The "Save as PDF" / share pipelines snapshot the rendered `.prf-page` DOM,
 * so whatever appears in that DOM is exactly what lands in the PDF sent to
 * the medical scheme. This suite mounts PRFView with a FULLY-populated
 * Primary + Medical-Aid PRF fixture (every field carries a unique sentinel
 * value) and asserts each sentinel is present in the rendered pages — i.e.
 * no captured field can silently drop off the scheme's PDF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';
import PRFView from '../pages/PRFView';

// ── Mocks ─────────────────────────────────────────────────────────────────
vi.mock('axios');

// jsPDF / html2canvas are only used by the export pipelines (pre-warm effect
// fires 400ms after load) — stub them so jsdom never tries to rasterise.
// NOTE: the implementation MUST be a plain `function` expression — an arrow
// function is not constructible, so `new jsPDF()` inside PRFView throws.
vi.mock('jspdf', () => ({
  jsPDF: vi.fn(function () {
    return {
      addPage: vi.fn(),
      addImage: vi.fn(),
      output: vi.fn(() => new Blob()),
      save: vi.fn(),
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

// 1×1 transparent PNG — used for every signature / attachment image
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Mirror PRFView's formatters so time/date expectations are TZ-safe
const pad = (n: number) => String(n).padStart(2, '0');
const expectTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ── Fixture: every field a Primary + MED AID PRF can carry ────────────────
const FD = {
  // Call classification — the scenario under test
  call_type: 'PRIMARY',
  billing_type: 'MED AID',

  // Call information
  incident_location: '99 Sentinel Incident Road',
  suburb_ward: 'Sentinel-Suburb',
  referring_doctor: 'Dr Sentinel-Referrer',
  receiving_facility: 'Sentinel Receiving Hospital',
  ward: 'Sentinel-Ward-7',
  receiving_doctor: 'Dr Sentinel-Receiver',

  // Patient information (all 17 rendered fields)
  gender: 'Male',
  patient_name: 'Sipho-Sentinel',
  patient_surname: 'Dlamini-Sentinel',
  patient_id_number: '9001015800086',
  patient_passport_number: 'PP-SENT-001',
  age: '36-yrs-sent',
  patient_dob: '1990-01-01-sent',
  patient_address: '12 Sentinel Residence Ave',
  patient_suburb: 'Sentinel-Res-Suburb',
  patient_postal_code: '4001-sent',
  patient_postal_address: 'PO Box Sentinel 55',
  patient_postal_suburb: 'Sentinel-Postal-Suburb',
  patient_postal_address_code: '4002-sent',
  patient_phone_home: '031-555-0001',
  patient_phone_work: '031-555-0002',
  patient_phone_cell: '082-555-0003',
  accompanying_persons_count: '2-accomp-sent',

  // Debtor (different from patient so the full block renders)
  debtor_gender: 'Female',
  debtor_name: 'Debra-Sentinel',
  debtor_surname: 'Debtor-Sentinel',
  debtor_id_number: '8505055800087',
  debtor_passport_number: 'PP-DEBT-002',
  debtor_age: '41-yrs-debt',
  debtor_dob: '1985-05-05-debt',
  debtor_address: '34 Sentinel Debtor Street',
  debtor_suburb: 'Sentinel-Debt-Suburb',
  debtor_postal_code: '4003-debt',
  debtor_phone_home: '031-555-0004',
  debtor_phone_cell: '082-555-0005',

  // Medical Aid — the scheme-billing block under test
  medical_scheme: 'Sentinel-Med-Scheme',
  medical_aid_number: 'MA-SENT-123456',
  preauth_number: 'PRE-SENT-789',
  post_auth_number: 'POST-SENT-790',
  dependent_number: '03-dep-sent',
  main_member_id: 'MM-SENT-456',
  scheme_option: 'Sentinel-Plan-Comprehensive',

  // Priority / assessment / mechanism
  priority: 'RED',
  assessment_level: 'BLS',
  monitoring_level: 'BLS',
  mechanism: ['FALL'],
  mechanism_other: 'Fell off sentinel ladder',

  // Receiving facility / handover
  handover_name: 'Nurse Sentinel-Handover',
  handover_qualification: 'RN-SENT',
  handover_doctor_email: 'doctor@sentinel-hospital.test',
  handover_notes: 'Stable on sentinel handover',

  // Valuables + notes
  valuables_handed_to: 'Sentinel Security Officer',
  valuables_description: 'Sentinel wallet and keys',
  management_notes: 'Sentinel management narrative for scheme audit',

  // Oxygen / airway / circulation / immobilisation
  o2_flow_rate: '8-lpm-sent',
  o2_percent: '60%-sent',
  o2_device: 'Sentinel-NRB-Mask',
  o2_bvm: 'BVM-sent-yes',
  o2_start_time: '09:41-o2s',
  o2_stop_time: '10:05-o2e',
  airway_interventions: ['SELF-MAINTAINED'],
  op_airway_size: 'OPA-3-sent',
  intubation_attempts: '1-int-sent',
  ett_size: '7.5-ett-sent',
  ett_depth: '21cm-ett-sent',
  ng_tube_size: '14fr-ng-sent',
  circulation_interventions: ['PERIPH. IV LINE'],
  iv_attempts: '2-ivatt-sent',
  defib_joules: '200J-sent',
  immob_equipment: ['COLLAR'],
  other_equipment: 'Sentinel vacuum splint',

  // Surveys
  survey_a: 'Airway-clear-sent',
  survey_b: 'Breathing-equal-sent',
  survey_c: 'Circulation-strong-sent',
  survey_head_back: 'Head-nad-sent',
  survey_neuro: 'Neuro-gcs15-sent',
  survey_chest: 'Chest-clear-sent',
  survey_abdo: 'Abdo-soft-sent',
  survey_limbs: 'Limbs-intact-sent',
  survey_back: 'Back-tender-sent',

  // History
  chief_complaint: 'Sentinel back pain after fall',
  primary_diagnosis: 'Sentinel suspected L2 fracture',
  findings_on_arrival: 'Sentinel patient supine on floor',
  allergies: 'Sentinel-penicillin',
  current_medications: 'Sentinel-statins',
  past_medical_history: 'Sentinel previous back surgery',
  last_meal: 'Sentinel sandwich',
  last_meal_time: '08:15-meal-sent',
  events_hpi: 'Sentinel HPI - fell from ladder height',

  // IV therapy + medication rows
  iv_therapy: [{
    type: 'Ringers-sent', jelco_size: '18G-sent', site: 'L-cubital-sent',
    vol_infused: '500ml-sent', time_up: '09:50-iv-sent',
    indication: 'Sentinel volume support', sign: 'AI-sent',
  }],
  medications: [{
    type: 'Morphine-sent', route: 'IV-med-sent', dose: '5mg-sent',
    time: '09:55-med-sent', reason: 'Sentinel analgesia', sign: 'AN-sent',
  }],

  // Vitals — 3 sets (max before the continuation page)
  vitals_sets: [
    { time: '09:45', resp_rate: '18-v1', spo2: '97-v1', hr: '88-v1', bp: '130/85-v1', gcs_total: '15-v1', temp: '36.8-v1', pain: '7-v1' },
    { time: '09:55', resp_rate: '17-v2', spo2: '98-v2', hr: '84-v2', bp: '128/84-v2', gcs_total: '15-v2', temp: '36.7-v2', pain: '5-v2' },
    { time: '10:05', resp_rate: '16-v3', spo2: '99-v3', hr: '80-v3', bp: '126/82-v3', gcs_total: '15-v3', temp: '36.6-v3', pain: '3-v3' },
  ],

  // Signatures captured on-form + attachments
  tc_patient_signature: PNG,
  tc_witness_signature: PNG,
  next_of_kin_signature: PNG,
  hospital_sticker: PNG,
  medical_aid_image: PNG,
};

const PRF_FIXTURE = {
  prf_number: 'PRF-SENT-0001',
  case_number: 'JEMS-2026-06-SENT',
  submitted_at: '2026-06-11T09:30:00',
  form_data: FD,
  timestamps: {
    time_call_received: '2026-06-11T09:30:00',
    time_dispatched: '2026-06-11T09:36:00',
    time_on_scene: '2026-06-11T09:36:00',
    time_depart_scene: '2026-06-11T09:59:00',
    time_at_destination: '2026-06-11T09:59:00',
    time_available: '2026-06-11T10:01:00',
  },
  kms: {
    km_dispatched: '23-km-a', km_on_scene: '24-km-b', km_depart_scene: '45-km-c',
    km_at_destination: '45-km-d', km_available: '23-km-e',
  },
  provider: {
    name: 'Sentinel EMS Provider', slug: 'sentinel-ems',
    phone: '078-670-6945-sent', pr_number: '0890030746-sent',
    pty_reg_number: '2017/438874/07-sent',
    address: '59 Sentinel Road, Chatsworth', email: 'ops@sentinel-ems.test',
  },
  vehicle: { callsign: 'ALPHA-1-SENT', registration: 'ND-123-456-SENT', vehicle_type: 'Ambulance-sent' },
  crew_1: { full_name: 'A.Ishwar-Sent', qualification: 'AEA-sent', hpcsa_number: 'ANA-0049530-sent' },
  crew_2: { full_name: 'A.Naidu-Sent', qualification: 'ANT-sent', hpcsa_number: 'ANT-0012793-sent' },
  signatures: {
    patient_signature: PNG,
    witness_signature: PNG,
    handover_signature: PNG,
    crew_signature: PNG,
    crew_2_signature: PNG,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────
function renderPrfView() {
  return render(
    <MemoryRouter initialEntries={['/cases/case-sent-1/prf']}>
      <Routes>
        <Route path="/cases/:caseId/prf" element={<PRFView />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Assert the sentinel appears at least once anywhere in the rendered PRF. */
function expectVisible(sentinel: string) {
  const matches = screen.queryAllByText(
    (content) => content.includes(sentinel),
    { exact: false },
  );
  expect(matches.length, `Field value "${sentinel}" missing from rendered PRF`).toBeGreaterThan(0);
}

beforeEach(() => {
  vi.mocked(axios.get).mockResolvedValue({ data: PRF_FIXTURE });
});

// ── Tests ─────────────────────────────────────────────────────────────────
describe('PRF PDF render — PRIMARY call, MED AID billing', () => {
  it('renders the 2 form pages plus one page per attachment', async () => {
    const { container } = renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    // 2 PRF pages + 2 attachments (hospital sticker, medical aid card).
    //
    // The sticker gets its own full-size sheet even though page 1 also carries
    // a compact copy: the page-1 block is capped to ~110px, which is too small
    // to read an MRN off, and this sheet is what an administrator zooms into.
    expect(container.querySelectorAll('.prf-page')).toHaveLength(4);
    expect(container.querySelectorAll('.prf-print-frame')).toHaveLength(4);
  });

  it('shows the PRIMARY call-type and MED AID billing checks', async () => {
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getByText('MED AID')).toBeInTheDocument();
    expect(screen.getByText('RED')).toBeInTheDocument();
  });

  it('renders every Medical Aid (scheme billing) field', async () => {
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    [
      FD.medical_scheme, FD.medical_aid_number, FD.preauth_number,
      FD.post_auth_number, FD.dependent_number, FD.main_member_id,
      FD.scheme_option,
    ].forEach(expectVisible);
  });

  it('renders every patient + debtor field', async () => {
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    [
      FD.patient_name, FD.patient_surname, FD.patient_id_number,
      FD.patient_passport_number, FD.age, FD.patient_dob, FD.patient_address,
      FD.patient_suburb, FD.patient_postal_code, FD.patient_postal_address,
      FD.patient_postal_suburb, FD.patient_postal_address_code,
      FD.patient_phone_home, FD.patient_phone_work, FD.patient_phone_cell,
      FD.accompanying_persons_count,
      FD.debtor_name, FD.debtor_surname, FD.debtor_id_number,
      FD.debtor_passport_number, FD.debtor_age, FD.debtor_dob,
      FD.debtor_address, FD.debtor_suburb, FD.debtor_postal_code,
      FD.debtor_phone_home, FD.debtor_phone_cell,
    ].forEach(expectVisible);
  });

  it('renders call information, times, kms, vehicle and provider branding', async () => {
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    [
      // referring_doctor removed from the rendered PRF (still captured).
      // FD.suburb_ward removed — see the dedicated negative test below.
      FD.incident_location,
      FD.receiving_facility, FD.ward, FD.receiving_doctor,
      PRF_FIXTURE.case_number, PRF_FIXTURE.vehicle.callsign,
      PRF_FIXTURE.vehicle.registration,
      PRF_FIXTURE.provider.name, PRF_FIXTURE.provider.phone,
      PRF_FIXTURE.provider.pr_number, PRF_FIXTURE.provider.address,
      ...Object.values(PRF_FIXTURE.kms),
    ].forEach(expectVisible);
    // Times render as HH:MM in local time
    expectVisible(expectTime(PRF_FIXTURE.timestamps.time_dispatched));
    expectVisible(expectTime(PRF_FIXTURE.timestamps.time_available));
  });

  it('renders the full clinical page (oxygen, airway, surveys, history, IV, meds)', async () => {
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    [
      FD.o2_flow_rate, FD.o2_percent, FD.o2_device, FD.o2_bvm,
      FD.o2_start_time, FD.o2_stop_time,
      'SELF-MAINTAINED', FD.op_airway_size, FD.intubation_attempts,
      FD.ett_size, FD.ett_depth, FD.ng_tube_size,
      'PERIPH. IV LINE', FD.iv_attempts, FD.defib_joules,
      'COLLAR', FD.other_equipment,
      FD.survey_a, FD.survey_b, FD.survey_c,
      FD.survey_head_back, FD.survey_neuro, FD.survey_chest,
      FD.survey_abdo, FD.survey_limbs, FD.survey_back,
      FD.chief_complaint, FD.primary_diagnosis, FD.findings_on_arrival,
      FD.allergies, FD.current_medications, FD.past_medical_history,
      FD.last_meal, FD.last_meal_time, FD.events_hpi,
      FD.iv_therapy[0].site, FD.iv_therapy[0].vol_infused,
      FD.iv_therapy[0].indication,
      FD.medications[0].type, FD.medications[0].dose,
      FD.medications[0].reason,
      FD.management_notes,
    ].forEach(expectVisible);
  });

  it('renders all 3 vitals sets without a continuation page', async () => {
    const { container } = renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    FD.vitals_sets.forEach(set => {
      [set.resp_rate, set.spo2, set.hr, set.bp, set.gcs_total, set.temp, set.pain]
        .forEach(expectVisible);
    });
    expect(screen.queryByText(/Vitals — Continuation/)).not.toBeInTheDocument();
    // The point of this assertion is that vitals did NOT spill a continuation
    // page; the count tracks the sheet total rather than being the subject.
    expect(container.querySelectorAll('.prf-page')).toHaveLength(4);
  });

  it('renders every signature block as a visible captured signature', async () => {
    const { container } = renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    // 3 T&C + handover + 2 crew = 6 captured signatures (the patient/witness
    // pair under Valuables was removed — those live under the T&Cs).
    const sigs = container.querySelectorAll('img[alt="signature"]');
    expect(sigs.length).toBe(6);
    // No "Not captured" placeholders should remain on a fully-signed PRF
    expect(screen.queryAllByText('Not captured')).toHaveLength(0);
  });

  it('renders mechanism, handover, valuables and motivation for the scheme', async () => {
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    [
      'FALL', FD.mechanism_other,
      // handover_name removed from the rendered PRF (still captured).
      FD.handover_qualification, FD.handover_doctor_email,
      FD.handover_notes,
      FD.valuables_handed_to, FD.valuables_description,
      FD.management_notes,
      PRF_FIXTURE.crew_1.full_name, PRF_FIXTURE.crew_1.hpcsa_number,
      PRF_FIXTURE.crew_2.full_name, PRF_FIXTURE.crew_2.hpcsa_number,
    ].forEach(expectVisible);
  });

  it('marks attachments and renders each on its own page', async () => {
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    // Each attachment renders on its own page, headed
    // "Patient Documents (Attachments) - <label>".
    expect(screen.getAllByText(/Patient Documents \(Attachments\)/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Attachments\) - Medical Aid Card/)).toBeInTheDocument();
    // The sticker keeps its own full-size sheet even when page 1 carries a
    // compact copy — an administrator needs to be able to read the label.
    expect(screen.getByText(/Attachments\) - Hospital Sticker/)).toBeInTheDocument();
  });
});

// ── Passport rows are omitted when blank ──────────────────────────────────
// Passport is the alternative to an SA ID rather than an extra field, so on a
// local patient/debtor it is always empty. It used to print a permanent row of
// "—"; it must now disappear entirely, matching how the rest of the Patient
// Information block already treats blank values.
describe('PRF PDF render — blank passport rows', () => {
  const withPassports = (patient: string | undefined, debtor: string | undefined) => ({
    ...PRF_FIXTURE,
    form_data: {
      ...FD,
      patient_passport_number: patient,
      debtor_passport_number: debtor,
    },
  });

  it('hides both Passport rows when neither was captured', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: withPassports(undefined, undefined) });
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    expect(screen.queryAllByText('Passport')).toHaveLength(0);
  });

  it('still shows a Passport row for whichever party has one', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: withPassports(undefined, 'PP-DEBT-ONLY') });
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    expect(screen.queryAllByText('Passport')).toHaveLength(1);
    expectVisible('PP-DEBT-ONLY');
  });

  it('treats a whitespace-only passport as blank', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: withPassports('   ', '   ') });
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    expect(screen.queryAllByText('Passport')).toHaveLength(0);
  });

  it('no longer prints the incident Suburb / Ward row, and keeps the crew Ward row', async () => {
    // Removed because the geocoder auto-fills suburb_ward from the incident
    // address while the crew form labels it as a ward and prompts "e.g. ICU"
    // (DigitalPRFForm.tsx), so crews typed ward names into it and it duplicated
    // the Ward row two lines below.
    //
    // The fixture still carries suburb_ward, deliberately: that is what makes
    // this a real negative rather than a proof that the fixture is empty.
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);

    expect(screen.queryAllByText('Suburb / Ward')).toHaveLength(0);
    expect(
      screen.queryAllByText((c) => c.includes(FD.suburb_ward), { exact: false }),
      'the suburb value still prints somewhere on the PDF',
    ).toHaveLength(0);

    // The rows it was being confused with must survive. In a diff these look
    // like near-duplicates of the deleted line; they are different keys fed by
    // different controls, and taking one of them with it would be the obvious
    // way for a later tidy-up to go wrong.
    expect(screen.queryAllByText('Ward').length).toBeGreaterThan(0);
    expect(screen.queryAllByText((c) => c.includes(FD.ward), { exact: false }).length)
      .toBeGreaterThan(0);
    expect(screen.queryAllByText('Dest Facility').length).toBeGreaterThan(0);
  });

  it('puts Mechanism and Patient Priority under Debtor Information', async () => {
    // Moved out of the Patient Information column. Geometry is not assertable
    // in jsdom, but these sections are siblings inside one grid column with no
    // explicit order, so DOM order is column order — the same reasoning as the
    // closeout-band test above.
    const { container } = renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);

    const order = [...container.querySelectorAll('*')]
      .filter(e => e.children.length === 0
        && ['Patient Information', 'Debtor Information', 'Mechanism', 'Patient Priority', 'Billing Information']
          .includes((e.textContent || '').trim()))
      .map(e => (e.textContent || '').trim());

    for (const s of ['Debtor Information', 'Mechanism', 'Patient Priority']) {
      expect(order, `the PDF is missing the "${s}" section`).toContain(s);
    }
    expect(
      order.indexOf('Mechanism'),
      `Mechanism must follow Debtor Information — order was ${JSON.stringify(order)}`,
    ).toBeGreaterThan(order.indexOf('Debtor Information'));
    expect(
      order.indexOf('Patient Priority'),
      `Patient Priority must follow Debtor Information — order was ${JSON.stringify(order)}`,
    ).toBeGreaterThan(order.indexOf('Debtor Information'));
    // And they are no longer sitting under Patient Information.
    expect(order.indexOf('Mechanism')).toBeGreaterThan(order.indexOf('Patient Information'));
  });

  it('offers Save as PDF and no Print button', async () => {
    // Print was removed from the toolbar for the admin and provider views
    // alike. Save as PDF renders through buildPrfPdf at the full design width,
    // so it does not depend on the browser print dialog's margin,
    // background-graphics and scale settings.
    //
    // Asserting Save as PDF is still there is the half that matters: "no Print
    // button" alone would also be satisfied by a toolbar that failed to render.
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);

    expect(
      screen.queryByLabelText('Print'),
      'the Print button is back in the PRF toolbar',
    ).toBeNull();
    expect(
      screen.queryByLabelText('Save as PDF'),
      'Save as PDF is missing — the only supported export path is gone',
    ).not.toBeNull();
  });

  it('puts Motivation first in the closeout band and Valuables last', async () => {
    // Motivation sits in the first column so it falls directly under Patient
    // Priority in the band above, which is where the crew reads it; Valuables
    // moved to the far right in the same swap.
    //
    // Geometry is not assertable here — jsdom has no layout — but DOM ORDER is,
    // and for a CSS grid with no explicit order/grid-area the two are the same
    // thing. That makes this a real guard rather than a restatement of the JSX.
    //
    // The fixture must carry motivation text: an EMPTY Motivation column now
    // hides entirely (see the test below), so the ordering can only be
    // asserted when the column exists.
    vi.mocked(axios.get).mockResolvedValue({
      data: { ...PRF_FIXTURE, form_data: { ...PRF_FIXTURE.form_data, motivation_notes: 'Ordering-sentinel motivation' } },
    });
    const { container } = renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);

    const wanted = ['Motivation / Other Notes', 'Crew · Assessed By', 'Crew · Managed By', 'Valuables'];
    const heads = [...container.querySelectorAll('*')]
      .filter(e => e.children.length === 0 && wanted.includes((e.textContent || '').trim()))
      .map(e => (e.textContent || '').trim());

    for (const w of wanted) {
      expect(heads, `the closeout band is missing "${w}"`).toContain(w);
    }
    expect(
      wanted.map(w => heads.indexOf(w)),
      `closeout band order is ${JSON.stringify(heads)} — Motivation must lead so it ` +
      'lands under Patient Priority, and Valuables must trail',
    ).toEqual([...wanted.map(w => heads.indexOf(w))].sort((a, b) => a - b));
    expect(heads.indexOf('Motivation / Other Notes')).toBeLessThan(heads.indexOf('Valuables'));
  });

  it('hides the Motivation column entirely when nothing was written', async () => {
    // An empty Motivation section used to print its letterhead over bare
    // ruled lines — reading as a hole in the record rather than "nothing to
    // declare". With no motivation text and no extra crew the whole column
    // (letterhead included) must vanish; the crew and valuables columns
    // still render.
    renderPrfView();   // default fixture: no motivation_notes, no extra_crew
    await screen.findByText(/Sipho-Sentinel/);
    expect(screen.queryByText('Motivation / Other Notes')).not.toBeInTheDocument();
    expect(screen.getAllByText('Crew · Assessed By').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Valuables').length).toBeGreaterThan(0);
  });

  it('signs on a dotted rule inside the terms panel, without losing the captured ink', async () => {
    // What the rest of the suite can and cannot see, measured rather than
    // assumed by injecting the defect:
    //   - Losing the ink IS caught. The matrix suite counts <img alt="signature">
    //     nodes, and dropping the image fails ~18 of its cases. Good.
    //   - The RESTYLE is invisible. A grep for
    //     border/minHeight/getComputedStyle/toHaveStyle across all three PDF
    //     test files returns nothing, so replacing the bordered boxes with
    //     dotted rules — the entire change — passed every existing test
    //     unchanged. Nothing pinned the layout that was just rewritten.
    // This test covers the second gap, and re-covers the first at the point of
    // change, because these three marks are captured digitally and the
    // patient's is a required field.
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);

    for (const label of ['Patient / Rep.', 'Witness', 'Next of Kin']) {
      const row = screen.getByText(label).parentElement!;
      const rule = row.querySelector('div[style*="dotted"]') as HTMLElement | null;
      expect(rule, `${label} has no dotted signing rule`).not.toBeNull();
      expect(rule!.style.border, `${label} is still drawn as a bordered box`).toBe('');
      expect(
        rule!.querySelector('img[alt="signature"]'),
        `${label} lost its captured signature — the ink must survive the restyle`,
      ).not.toBeNull();
    }

    // And the separate green "Signatures" band is gone: these lines now live
    // under the terms, as on the paper form.
    expect(screen.queryAllByText('Signatures', { exact: true })).toHaveLength(0);
  });
});

// ── The submit waiver must be visible to the back office ──────────────────
// A crew can submit with specific items uncaptured by writing a reason (see
// the submit completeness gate). If that reason did not print, the waiver
// would be a silent bypass: the billing office would see an incomplete PRF
// with no explanation and no way to tell a refusal apart from an omission.
describe('PRF PDF render — items not captured', () => {
  const withOverride = (extra: Record<string, unknown>) => ({
    ...PRF_FIXTURE,
    form_data: { ...FD, ...extra },
  });

  it('prints the waived items, the reason and who recorded it', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: withOverride({
        submit_override_reason: 'Sentinel-casualty sticker printer offline all night.',
        submit_override_items: [
          { field: 'hospital_sticker', label: 'Sentinel-Waived-Sticker' },
          { field: 'handover_signature', label: 'Sentinel-Waived-Signature' },
        ],
        submit_override_by: 'Sentinel-Waiver-Crew',
        submit_override_at: '2026-06-11T10:05:00Z',
      }),
    });
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);

    expect(screen.queryAllByText(/Not Captured/i).length,
      'the waiver has no heading on the PDF').toBeGreaterThan(0);
    expectVisible('Sentinel-Waived-Sticker');
    expectVisible('Sentinel-Waived-Signature');
    expectVisible('sticker printer offline all night');
    expectVisible('Sentinel-Waiver-Crew');
  });

  it('prints nothing at all on the ordinary PRF that has no waiver', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: PRF_FIXTURE });
    renderPrfView();
    await screen.findByText(/Sipho-Sentinel/);
    expect(screen.queryAllByText(/Not Captured/i)).toHaveLength(0);
  });
});
