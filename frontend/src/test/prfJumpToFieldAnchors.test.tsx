/**
 * Every field the review popup can flag must be findable by tap-to-jump.
 *
 * Tapping a "not filled in" item calls jumpToField, which looks the field up as
 * `prf-field-<key>` (or via FIELD_ANCHOR) and flashes it. Only Inp/VoiceTxt/
 * ComboInp emit that id automatically — Toggles, button grids and pickers do
 * not — so five flagged fields could never be found.
 *
 * That used to be papered over by a sweep: on a miss, jumpToField walked a
 * candidate phase queue calling setPhase on each, and the crew watched the form
 * march through Dispatch, Patient Info, Transport and Handover on its own. The
 * sweep is gone, so a missing anchor now means the jump quietly does nothing —
 * a much better failure, but one no test would otherwise notice.
 *
 * Hence this file: it asserts the anchors exist, per phase, in the real form.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';

vi.mock('axios');
import DigitalPRFForm from '../pages/crew/DigitalPRFForm';

const PRF_ID = '11111111-2222-3333-4444-555555555555';
const PROVIDER = 'harness-ems';

function seed(phase: number, fdExtra: Record<string, any> = {}) {
  localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
    fd: {
      patient_name: 'Anchor', patient_surname: 'Test',
      call_type: 'PRIMARY',
      treating_practitioner_category: 'ECP',
      assessment_level: 'ILS',
      ...fdExtra,
    },
    vitals: [], ivRows: [], medRows: [],
    timestamps: {
      time_dispatched: '2026-08-12T10:00:00', time_on_scene: '2026-08-12T10:04:00',
      time_depart_scene: '2026-08-12T10:20:00', time_arrive_hospital: '2026-08-12T10:40:00',
    },
    kms: { km_dispatched: '100', km_on_scene: '110', km_depart_scene: '110', km_arrive_hospital: '130' },
    geos: {},
    sigs: {
      patient_signature: null, witness_signature: null, handover_signature: null,
      crew_signature: null, valuables_signature: null,
    },
    vehicle: '', crew2Id: '', phase, savedAt: 1754000000000,
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
  localStorage.setItem('crew_token', 'anchor-test-token');
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
  // jsdom has no matchMedia; the medical-aid billing card reaches for it.
  if (!window.matchMedia) {
    (window as any).matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  }
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mountForm = () => render(
  <MemoryRouter initialEntries={[`/${PROVIDER}/crew/prf/${PRF_ID}`]}>
    <Routes>
      <Route path="/:providerSlug/crew/prf/:prfId" element={<DigitalPRFForm />} />
    </Routes>
  </MemoryRouter>,
);

const expectAnchors = async (ids: string[]) => {
  for (const id of ids) {
    await waitFor(
      () => expect(
        document.getElementById(id),
        `#${id} is missing — tapping that item in the review popup will do nothing`,
      ).not.toBeNull(),
      { timeout: 4000 },
    );
  }
};

describe('tap-to-jump anchors exist for the fields the review flags', () => {
  it('Patient Info: gender, priority (the two that emit no id of their own)', async () => {
    seed(2);
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy(), { timeout: 4000 });
    await expectAnchors(['prf-field-gender', 'prf-field-priority']);
  });

  it('Patient Info with medical aid: debtor_gender and dependent_number', async () => {
    seed(2, { billing_type: 'MED AID', medical_scheme: 'Discovery' });
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy(), { timeout: 4000 });
    await expectAnchors(['prf-field-debtor_gender', 'prf-field-dependent_number']);
  });

  it('Handover: receiving_facility, which is a picker, not an input', async () => {
    // The anchor here is written as a template literal on HospitalPicker's root
    // (id={`prf-field-${fk}`}), so a plain source grep does not see it. Only a
    // render proves it resolves.
    seed(5);
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy(), { timeout: 4000 });
    await expectAnchors(['prf-field-receiving_facility']);
  });
});
