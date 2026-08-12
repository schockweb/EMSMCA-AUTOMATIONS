/**
 * The crew is never warned mid-call. Warnings belong at review.
 *
 * On the Handover phase a crew member was shown an amber box reading
 * "2 warnings — claim may be rejected if not addressed", listing the missing
 * patient and handover signatures. That is billing-desk information delivered
 * to someone standing next to a patient, and it is the second time this class
 * of thing has had to be taken out of the crew form.
 *
 * It was not a one-off render either: a debounced effect re-ran every scheme
 * billing rule ~600ms after the crew stopped typing purely to keep that box
 * current. So the test has to WAIT past that debounce — asserting immediately
 * after mount would pass even with the old code, and prove nothing.
 *
 * The warnings themselves are not lost. The Review Before Submitting popup
 * builds its own list at submit time, which is where they belong.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';

vi.mock('axios');
import DigitalPRFForm from '../pages/crew/DigitalPRFForm';

const PRF_ID = '11111111-2222-3333-4444-555555555555';
const PROVIDER = 'harness-ems';

/** Handover phase, ER24 scheme, no signatures — trips ER24-HANDOVER-SIG. */
function seedHandoverDraft() {
  localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
    fd: {
      patient_name: 'Warn', patient_surname: 'Test',
      call_type: 'PRIMARY',
      billing_type: 'MED_AID',
      medical_scheme: 'er24',
      treating_practitioner_category: 'ECP',
      assessment_level: 'ILS',
      receiving_facility: 'Chatsmed Hospital',
    },
    vitals: [{ time: '10:05', hr: '88', bp: '120/80', spo2: '98', rr: '16',
               temp: '36.6', gcs_e: '4', gcs_v: '5', gcs_m: '6', bgl: '5.0', pupils: '' }],
    ivRows: [], medRows: [],
    timestamps: {
      time_dispatched: '2026-08-12T10:00:00', time_on_scene: '2026-08-12T10:04:00',
      time_depart_scene: '2026-08-12T10:20:00', time_arrive_hospital: '2026-08-12T10:40:00',
    },
    kms: { km_dispatched: '100', km_on_scene: '110', km_depart_scene: '110', km_arrive_hospital: '130' },
    geos: {},
    // Every signature deliberately absent — that is what the rules flag.
    sigs: {
      patient_signature: null, witness_signature: null, handover_signature: null,
      crew_signature: null, valuables_signature: null,
    },
    vehicle: '', crew2Id: '', phase: 5, savedAt: 1754000000000,
  }));
}

beforeEach(() => {
  const prf = {
    id: PRF_ID, prf_number: 4242, case_number: 'HARNESS-2026-08-004242',
    status: 'DRAFT', updated_at: '2026-08-12T10:00:00Z',
    form_data: {}, vehicle_id: null, crew_member_2_id: null, geo_locations: {},
  };
  const instance = {
    get: vi.fn(async () => ({ data: prf })),
    patch: vi.fn(async () => ({ data: prf })),
    post: vi.fn(async () => ({ data: prf })),
    delete: vi.fn(async () => ({ data: {} })),
  };
  (axios as any).create = vi.fn(() => instance);
  (axios as any).get = instance.get;
  (axios as any).patch = instance.patch;
  (axios as any).post = instance.post;

  localStorage.clear();
  localStorage.setItem('crew_token', 'warn-test-token');
  localStorage.setItem('crew_profile', JSON.stringify({
    id: 'crew-1', name: 'A. Mokoena', provider_id: 'prov-1',
    provider_slug: PROVIDER, provider_name: 'Harness EMS',
    qualification: 'ECP', hpcsa_number: 'ECP0012345', role: 'crew',
  }));

  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(() => 1), clearWatch: vi.fn() },
  });
  (globalThis as any).SpeechRecognition = undefined;
  (globalThis as any).webkitSpeechRecognition = undefined;
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  (Element.prototype as any).scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as any;
  window.alert = vi.fn();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mountForm = () => render(
  <MemoryRouter initialEntries={[`/${PROVIDER}/crew/prf/${PRF_ID}`]}>
    <Routes>
      <Route path="/:providerSlug/crew/prf/:prfId" element={<DigitalPRFForm />} />
    </Routes>
  </MemoryRouter>,
);

describe('Handover phase — no billing warnings in front of the crew', () => {
  it('never shows the amber "claim may be rejected" banner, even after the debounce', async () => {
    seedHandoverDraft();
    const { container } = mountForm();

    await waitFor(() => expect(container.textContent).toBeTruthy(), { timeout: 4000 });
    // Past the 600ms debounce the removed live validator used to run on.
    await new Promise(r => setTimeout(r, 1000));

    expect(
      screen.queryByText(/claim may be rejected/i),
      'the mid-call warning banner is back on the Handover phase',
    ).toBeNull();
    expect(
      container.textContent,
      'a scheme billing warning is being shown to the crew mid-call',
    ).not.toMatch(/handover signature from the receiving facility/i);
    expect(
      container.textContent,
      'the crew is being told a claim may be rejected while they are on a call',
    ).not.toMatch(/warning[s]? — claim/i);

    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  // NOTE: there is deliberately no "the review popup still shows warnings" test
  // here. The popup is reached from the Complete phase through a submit flow
  // this fixture cannot drive, and the version I first wrote asserted only that
  // the component is a function — it could not fail, which is worse than having
  // no test at all. The popup's list (`reviewWarnings`) is computed from the
  // form data and was not touched by this change.
});
