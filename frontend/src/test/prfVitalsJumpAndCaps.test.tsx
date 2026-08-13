/**
 * Two crew-reported behaviours on the ePRF.
 *
 * 1. The vitals reminder chip used to setPhase(3) unconditionally — throwing a
 *    crew still on Dispatch or Patient Info into a phase they had not reached,
 *    away from a part-filled screen, to reach a vitals set that on Dispatch is
 *    already on the same page. It must now stay put where the vitals are
 *    already rendered, and otherwise route to Dispatch until Transport has
 *    actually been reached.
 *
 *    The assertion that matters is WHICH phase we land on. Both the old and the
 *    new behaviour leave a vitals anchor in the DOM — the old one because the
 *    standalone Clinical screen has one too — so asserting "the vitals section
 *    is visible" would pass either way and prove nothing. The Dispatch time
 *    rows are the discriminator.
 *
 * 2. Patient Information is captured in block capitals, the way the paper PRF
 *    is, and the stored value must be capitalised too — not just the display —
 *    or the PDF would not match what the crew typed.
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

function seedDraft(phase: number, fdExtra: Record<string, any> = {}) {
  localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
    fd: {
      patient_name: '', patient_surname: '',
      call_type: 'PRIMARY',
      treating_practitioner_category: 'ECP',
      assessment_level: 'ILS',           // drives the vitals-due interval
      ...fdExtra,
    },
    // One vital already recorded — the reminder chip only exists once there is
    // a previous set to count from.
    vitals: [{ time: '10:05', hr: '88', bp: '120/80', spo2: '98', rr: '16',
               temp: '36.6', gcs_e: '4', gcs_v: '5', gcs_m: '6', bgl: '5.0', pupils: '' }],
    ivRows: [], medRows: [],
    timestamps: { time_dispatched: '2026-08-12T10:00:00', time_on_scene: '2026-08-12T10:04:00' },
    kms: { km_dispatched: '100', km_on_scene: '110' },
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
  localStorage.setItem('crew_token', 'jump-test-token');
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
  // jsdom implements neither.
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

describe('The vitals reminder must not throw the crew into a phase they have not reached', () => {
  it('from Patient Info, lands on Dispatch — where the vitals set already lives', async () => {
    seedDraft(2);
    const { container } = mountForm();

    const chip = await waitFor(
      () => screen.getByRole('button', { name: /vitals/i }),
      { timeout: 4000 },
    );
    fireEvent.click(chip);

    // The discriminator: Dispatch renders the dispatch/on-scene time rows.
    // The standalone Clinical screen the old code jumped to does not.
    await waitFor(
      () => expect(
        container.textContent,
        'the reminder did not land on Dispatch — the old code jumped straight to '
        + 'the standalone Clinical phase',
      ).toMatch(/Dispatch Time/i),
      { timeout: 4000 },
    );

    // And the vitals set is actually there to be used once we arrive.
    await waitFor(
      () => expect(
        document.getElementById('vitals-section-anchor'),
        'landed on Dispatch but the vitals set is not rendered — startedExam '
        + 'does not survive a reload and must be set when routing here',
      ).toBeTruthy(),
      { timeout: 4000 },
    );
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('centres the vitals set rather than pinning it to the top of the screen', async () => {
    seedDraft(2);
    mountForm();

    const chip = await waitFor(
      () => screen.getByRole('button', { name: /vitals/i }),
      { timeout: 4000 },
    );
    fireEvent.click(chip);

    await waitFor(() => {
      const calls = ((Element.prototype as any).scrollIntoView as any).mock.calls;
      expect(calls.length, 'nothing was ever scrolled into view').toBeGreaterThan(0);
      expect(
        calls.some((c: any[]) => c[0] && c[0].block === 'center'),
        `the vitals set was not centred: ${JSON.stringify(calls)}`,
      ).toBe(true);
    }, { timeout: 4000 });
  });
});

describe('Patient Information stays exactly as typed', () => {
  it('stores names as the crew typed them — no forced block capitals', async () => {
    // Block-caps-as-you-type shipped briefly (`upper` on the patient fields)
    // and was reverted at the user's request: the form read as shouting back
    // while typing. Names now save with the capitalisation the crew gives
    // them — "van der Merwe" must never become "VAN DER MERWE".
    seedDraft(2);
    mountForm();

    const first = await waitFor(() => {
      const el = document.getElementById('prf-field-patient_name') as HTMLInputElement;
      if (!el) throw new Error('First Name field never rendered');
      return el;
    }, { timeout: 4000 });

    fireEvent.change(first, { target: { value: 'Thabo' } });
    await waitFor(() => expect(
      (document.getElementById('prf-field-patient_name') as HTMLInputElement).value,
      'the patient first name was altered — it must store exactly as typed',
    ).toBe('Thabo'), { timeout: 4000 });

    const surname = document.getElementById('prf-field-patient_surname') as HTMLInputElement;
    fireEvent.change(surname, { target: { value: 'van der Merwe' } });
    await waitFor(() => expect(
      (document.getElementById('prf-field-patient_surname') as HTMLInputElement).value,
    ).toBe('van der Merwe'), { timeout: 4000 });
  });

  it('leaves the residential address as typed', async () => {
    // Deliberate: addresses are entered as written, not shouted. This sits
    // INSIDE Patient Information, so it is the one field that must not follow
    // the section's rule — easy to "fix" by mistake later.
    seedDraft(2);
    mountForm();

    // AddrInp carries no prf-field-* id, and three address fields share this
    // placeholder. Asserting across all of them is both simpler than picking one
    // positionally and a stronger claim: NO address field shouts.
    const addrs = await waitFor(
      () => {
        const found = screen.getAllByPlaceholderText('Street address') as HTMLInputElement[];
        if (!found.length) throw new Error('no address field rendered');
        return found;
      },
      { timeout: 4000 },
    );

    const typed = '12 Marine Drive, Umhlanga';
    for (const el of addrs) {
      fireEvent.change(el, { target: { value: typed } });
      await waitFor(() => expect(
        el.value,
        'an address field is being uppercased — addresses stay as typed',
      ).toBe(typed), { timeout: 4000 });
    }
  });

  it('leaves fields outside Patient Information alone', async () => {
    // `upper` is opt-in per field. If it ever became the default on Inp, every
    // free-text clinical note in the form would start shouting.
    // A PVT billing field — same phase, plainly not Patient Information.
    seedDraft(2, { billing_type: 'PVT', pvt_payment_method: 'Cash' });
    mountForm();

    const complaint = await waitFor(() => {
      const el = document.getElementById('prf-field-pvt_account_holder') as HTMLInputElement;
      if (!el) throw new Error('account holder field never rendered');
      return el;
    }, { timeout: 4000 });

    fireEvent.change(complaint, { target: { value: 'jane smith' } });
    await waitFor(() => expect(
      (document.getElementById('prf-field-pvt_account_holder') as HTMLInputElement).value,
      'uppercasing has leaked outside Patient Information',
    ).toBe('jane smith'), { timeout: 4000 });
  });
});
