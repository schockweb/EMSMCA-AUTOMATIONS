/**
 * The alert banners must not sit above the vitals inputs on Dispatch.
 *
 * Dispatch is where the crew first captures HR / BP / SpO₂, and the clinical
 * body is rendered inline there. Both banners render ABOVE those inputs and both
 * appear the moment a value crosses a threshold — so typing an HR of 190 made a
 * red two-line banner materialise above the field being typed in and pushed it
 * down the screen mid-entry. On a phone that reads as the keyboard losing the
 * field.
 *
 * This was fought once before with a 700ms debounce on the allergies value (see
 * the comment above `debouncedAllergies`). That only delays the shove — the
 * banner still appears and still moves the field, just a moment later. Removing
 * the banners from the capture screen is the fix; the debounce is not.
 *
 * The second test is the one that keeps this honest: the banners must still
 * render on Transport. A regression that deleted them outright would satisfy
 * the first test alone.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';

vi.mock('axios');
import DigitalPRFForm from '../pages/crew/DigitalPRFForm';

const PRF_ID = '11111111-2222-3333-4444-555555555555';
const PROVIDER = 'harness-ems';

/** A vitals set that trips every critical threshold at once. */
const CRITICAL_VITALS = [{
  time: '10:05', hr: '190', bp: '82/50', spo2: '84', rr: '30',
  temp: '36.5', gcs_e: '2', gcs_v: '2', gcs_m: '3', bgl: '5.5', pupils: '',
}];

function seedDraft(phase: number) {
  localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
    fd: {
      patient_name: 'Banner', patient_surname: 'Test',
      call_type: 'PRIMARY',
      // Set so the Start Exam click does not open the treating-practitioner
      // picker over the content we are asserting on.
      treating_practitioner_category: 'ECP',
      allergies: 'Penicillin',
    },
    vitals: CRITICAL_VITALS,
    ivRows: [], medRows: [],
    timestamps: {
      time_dispatched: '10:00', time_on_scene: '10:04',
      time_depart_scene: '10:20', time_arrive_hospital: '10:40',
    },
    kms: {
      km_dispatched: '100', km_on_scene: '110',
      km_depart_scene: '110', km_arrive_hospital: '130',
    },
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
  localStorage.setItem('crew_token', 'banner-test-token');
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

describe('Dispatch — the capture screen must not shift under the crew', () => {
  it('shows neither banner above the vitals inputs, with every threshold tripped', async () => {
    seedDraft(0);
    const { container } = mountForm();

    // Open the inline clinical body — the same tap the crew makes.
    const startExam = await waitFor(() => {
      const el = document.getElementById('start-exam-button');
      if (!el) throw new Error('Start Exam button never appeared');
      return el;
    }, { timeout: 4000 });
    fireEvent.click(startExam);

    // Non-vacuity: prove the clinical body really is on screen. Without this,
    // a form that failed to render at all would pass every assertion below.
    await waitFor(
      () => expect(container.textContent).toMatch(/vital/i),
      { timeout: 4000 },
    );

    // Past the 700ms allergy debounce — the banner's last chance to appear.
    await new Promise(r => setTimeout(r, 1100));

    expect(
      screen.queryByText(/Critical Vitals Alert/i),
      'the critical vitals banner is back on Dispatch — it sits above the HR/BP/SpO2 '
      + 'inputs and shoves the field being typed in down the screen',
    ).toBeNull();
    expect(
      screen.queryByText(/Allergy Alert/i),
      'the allergy banner is back on Dispatch',
    ).toBeNull();
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });
});

describe('Transport — allergy stays, critical vitals goes', () => {
  it('drops the critical vitals banner but keeps the allergy banner', async () => {
    // The Critical Vitals banner is gone from Transport too (the crew's phase
    // 3), for the same reason it left Dispatch: it sits above the vitals inputs
    // and appears the moment a value crosses a threshold, so it shoves the field
    // being typed in. It also only ever restates a number the crew just keyed.
    //
    // The Allergy banner stays, and asserting that here is what stops this from
    // being satisfied by deleting both: allergies are information the crew did
    // NOT just type and cannot see anywhere else on this screen.
    seedDraft(4);
    const { container } = mountForm();

    await waitFor(
      () => expect(container.textContent).toBeTruthy(),
      { timeout: 4000 },
    );
    await new Promise(r => setTimeout(r, 1100));

    await waitFor(() => {
      expect(
        screen.queryByText(/Allergy Alert/i),
        'the allergy banner has been removed from Transport too — that is not '
        + 'what was asked for, and the crew has no other sight of allergies here',
      ).toBeTruthy();
    }, { timeout: 4000 });
    expect(
      screen.queryByText(/Critical Vitals Alert/i),
      'the critical vitals banner is still on Transport',
    ).toBeNull();
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });
});
