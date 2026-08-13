/**
 * A PRF cannot be LOCKED with the last section missing.
 *
 * WHY THIS EXISTS
 * ---------------
 * The missing-items list was built inside the summary-review modal's own
 * render, and that modal only opened while `!allCrewSigned()`. handleSubmit
 * never evaluated the list itself. So once the crew had signed off, every later
 * tap on Submit walked straight past every outstanding item and locked the PRF.
 *
 * On 2026-08-12 an IFT/IHT (PRF 125) reached the billing pipeline that way with
 * its entire handover block absent — no receiving practitioner, no practitioner
 * number, no condition on handover, no facility email, no hospital sticker —
 * plus no return-trip times and none of the three T&C signatures. A submitted
 * PRF is PROCESSED and permanently uneditable, so there was no way back. The
 * crew's words: "I lost PRF data just by clicking submit".
 *
 * The gate now lives in handleSubmit and the modal draws the same list, so the
 * two cannot disagree. These tests drive the real button on the real component:
 * the assertion that matters is that POST /submit never fires.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';

vi.mock('axios');
import DigitalPRFForm from '../pages/crew/DigitalPRFForm';

const PRF_ID = '90000000-1111-2222-3333-444444444444';
const PROVIDER = 'harness-ems';
const SIG = 'data:image/png;base64,iVBORw0KGgo=';

let instance: any;

/** Three sets — enough to clear the vitals-shortfall prompt that runs first. */
const VITALS = [10, 20, 30].map(m => ({
  time: `10:${m}`, hr: '88', bp: '120/80', spo2: '98', resp_rate: '16',
  temp: '36.6', gcs_e: '4', gcs_v: '5', gcs_m: '6', bgl: '5.0', pupils: '',
}));

/**
 * An IFT/IHT sitting on Handover with the crew sign-off ALREADY captured —
 * precisely the state in which the old code skipped the review entirely.
 * `overrides` is merged over the form data so each test can vary one thing.
 */
function seedDraft(
  overrides: Record<string, any> = {},
  tsOverrides: Record<string, any> = {},
  sigOverrides: Record<string, any> = {},
) {
  localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
    fd: {
      call_type: 'IHT', transfer_subtype: 'Hospital to Hospital',
      billing_type: 'PVT', pvt_payment_method: 'Card',
      patient_name: 'MICHAEL', patient_surname: 'SCHUTTLER',
      gender: 'Male', patient_phone_cell: '0798823189', priority: 'RED',
      patient_dob: '1988-03-14',
      receiving_facility: 'Banting Place', ward: 'casualty',
      preauth_number: '1234', med_aid_quoted_amount: '250',
      treating_practitioner_category: 'ECP',
      // Clinical assessment — required by the review since 2026-08-13.
      chief_complaint: 'Chest pain radiating to left arm',
      primary_diagnosis: 'Suspected ACS?',
      survey_a: 'Patent', survey_b: 'Spontaneous', survey_c: 'Radial pulse present',
      survey_head_back: 'NAD', survey_neuro: 'Alert', survey_chest: 'Clear air entry',
      survey_abdo: 'Soft', survey_limbs: 'NAD', survey_back: 'Normal',
      // Signed off already — the condition that used to open the trapdoor.
      crew_signoff_sigs: { c1: SIG },
      ...overrides,
    },
    vitals: VITALS, ivRows: [], medRows: [],
    timestamps: {
      time_dispatched: '2026-08-12T10:00:00Z', time_on_scene: '2026-08-12T10:04:00Z',
      time_depart_scene: '2026-08-12T10:20:00Z',
      ...tsOverrides,
    },
    kms: {
      km_dispatched: '100', km_on_scene: '110',
      km_depart_scene: '110', km_at_destination: '130', km_available: '140',
    },
    geos: {},
    sigs: {
      patient_signature: null, witness_signature: null, handover_signature: null,
      crew_signature: null, valuables_signature: null,
      ...sigOverrides,
    },
    vehicle: '', crew2Id: '', phase: 5, savedAt: 1754000000000,
  }));
}

/** Everything the gate asks for, so only the tested field is outstanding. */
const COMPLETE_HANDOVER = {
  receiving_doctor: 'Dr Received', handover_qualification: 'PR0123456',
  handover_notes: 'Stable on handover', hospital_sticker: SIG,
  tc_patient_signature: SIG,
};
const COMPLETE_TIMES = {
  time_at_destination: '2026-08-12T10:40:00Z',
  time_available: '2026-08-12T11:00:00Z',
};
/** The handover signature is a top-level column, not a form_data key. */
const COMPLETE_SIGS = { handover_signature: SIG, patient_signature: SIG };

beforeEach(() => {
  const prf = {
    id: PRF_ID, prf_number: 125, case_number: 'HARNESS-2026-08-000125',
    status: 'DRAFT', updated_at: '2026-08-12T10:00:00Z',
    form_data: {}, vehicle_id: null, crew_member_2_id: null, geo_locations: {},
    handover_signature: null, patient_signature: null,
  };
  instance = {
    get: vi.fn(async () => ({ data: prf })),
    patch: vi.fn(async () => ({ data: prf })),
    post: vi.fn(async () => ({ data: { status: 'submitted' } })),
    delete: vi.fn(async () => ({ data: {} })),
  };
  (axios as any).create = vi.fn(() => instance);
  (axios as any).get = instance.get;
  (axios as any).patch = instance.patch;
  (axios as any).post = instance.post;

  localStorage.clear();
  localStorage.setItem('crew_token', 'gate-test-token');
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
  window.confirm = vi.fn(() => true);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mountForm = () => render(
  <MemoryRouter initialEntries={[`/${PROVIDER}/crew/prf/${PRF_ID}`]}>
    <Routes>
      <Route path="/:providerSlug/crew/prf/:prfId" element={<DigitalPRFForm />} />
    </Routes>
  </MemoryRouter>,
);

/** Taps the Submit button on the Handover screen and lets the flow settle. */
async function tapSubmit(container: HTMLElement) {
  await waitFor(() => expect(container.textContent).toBeTruthy(), { timeout: 4000 });
  const btn = await screen.findByRole('button', { name: /Complete & Submit PRF/i }, { timeout: 4000 });
  fireEvent.click(btn);
  await new Promise(r => setTimeout(r, 400));
}

const submitCalls = () =>
  instance.post.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/submit'));

describe('Submit completeness gate', () => {
  it('refuses to submit an IFT/IHT whose handover block is empty, even with the crew already signed off', async () => {
    seedDraft({}, {});                 // no handover fields, no leg times
    const { container } = mountForm();
    await tapSubmit(container);

    expect(
      submitCalls(),
      'the PRF was LOCKED with the handover section missing — the gate is bypassable again',
    ).toHaveLength(0);

    expect(
      container.textContent,
      'submission was blocked but the crew was not shown what is outstanding',
    ).toMatch(/not filled in/i);
  });

  it('names the specific items that are missing so they can be fixed', async () => {
    seedDraft({}, {});
    const { container } = mountForm();
    await tapSubmit(container);

    const text = container.textContent || '';
    for (const item of [
      /Receiving practitioner/i,
      /Practitioner number/i,
      /Condition on handover/i,
      /Receiving facility email/i,
      /Hospital sticker/i,
      /Handover signature/i,
      /Arrival At Facility time/i,
      /Available time/i,
    ]) {
      expect(text, `the review does not flag ${item}`).toMatch(item);
    }
  });

  it('flags the clinical assessment and DOB when they are empty', async () => {
    seedDraft({
      chief_complaint: '', primary_diagnosis: '', patient_dob: '',
      survey_a: '', survey_b: '', survey_c: '',
      survey_head_back: '', survey_neuro: '', survey_chest: '',
      survey_abdo: '', survey_limbs: '', survey_back: '',
    });
    const { container } = mountForm();
    await tapSubmit(container);

    expect(submitCalls()).toHaveLength(0);
    const text = container.textContent || '';
    for (const item of [
      /Chief Complaint \/ Signs and Symptoms/i,
      /Primary Diagnosis/i,
      /Primary Survey/i,
      /Secondary Survey/i,
      /Patient date of birth/i,
    ]) {
      expect(text, `the review does not flag ${item}`).toMatch(item);
    }
  });

  it('names the specific survey parts still empty, not just the section', async () => {
    seedDraft(
      { ...COMPLETE_HANDOVER, handover_doctor_email: 'ops@hospital.co.za', survey_b: '', survey_abdo: '', survey_limbs: '' },
      COMPLETE_TIMES, COMPLETE_SIGS,
    );
    const { container } = mountForm();
    await tapSubmit(container);

    expect(submitCalls()).toHaveLength(0);
    expect(container.textContent).toMatch(/Primary Survey \(Breathing\)/i);
    expect(container.textContent).toMatch(/Secondary Survey \(Abdomen, Limbs\)/i);
  });

  it('blocks a facility email with no @ instead of silently skipping the send', async () => {
    // Everything else complete: the ONLY outstanding item is the malformed
    // address. This is PRF 126 — stored as `schockweb.gmail.com`, which failed
    // the send-path regex, so the crew was told the PRF went through while the
    // receiving facility got nothing and the record was already uneditable.
    seedDraft(
      { ...COMPLETE_HANDOVER, handover_doctor_email: 'schockweb.gmail.com' },
      COMPLETE_TIMES, COMPLETE_SIGS,
    );
    const { container } = mountForm();
    await tapSubmit(container);

    expect(
      submitCalls(),
      'a PRF was locked carrying an unsendable facility address',
    ).toHaveLength(0);
    expect(container.textContent).toMatch(/does not look like an email address/i);
  });

  it('lets a complete PRF through — the gate is not a wall', async () => {
    seedDraft(
      { ...COMPLETE_HANDOVER, handover_doctor_email: 'ops@hospital.co.za' },
      COMPLETE_TIMES, COMPLETE_SIGS,
    );
    const { container } = mountForm();
    await tapSubmit(container);

    // The authoritative save must land, then the submit.
    await waitFor(() => expect(submitCalls().length).toBe(1), { timeout: 4000 });
    expect(instance.patch, 'the final save never ran before locking the PRF')
      .toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/not filled in/i);
  });
});

describe('The final save must land before the PRF is locked', () => {
  const completeDraft = () => seedDraft(
    { ...COMPLETE_HANDOVER, handover_doctor_email: 'ops@hospital.co.za' },
    COMPLETE_TIMES, COMPLETE_SIGS,
  );

  it('does not submit when the final save gets no response at all (timeout / offline)', async () => {
    // The likeliest shape of the reported loss. The final save is the biggest
    // request of the call — sticker photo plus every signature — so it is the
    // one that times out on a phone, while the POST /submit that used to
    // follow is tiny and goes through instantly, locking the row at whatever
    // the last autosave left there.
    completeDraft();
    const netErr: any = new Error('timeout of 20000ms exceeded');
    netErr.code = 'ECONNABORTED';
    instance.patch.mockRejectedValue(netErr);

    const { container } = mountForm();
    await tapSubmit(container);
    await new Promise(r => setTimeout(r, 600));

    expect(
      submitCalls(),
      'the PRF was locked even though its final save never reached the server',
    ).toHaveLength(0);
  });

  it('does not submit when the server answers and refuses the final save', async () => {
    completeDraft();
    const err: any = new Error('Request failed with status code 500');
    err.response = { status: 500, data: {} };
    instance.patch.mockRejectedValue(err);

    const { container } = mountForm();
    await tapSubmit(container);
    await new Promise(r => setTimeout(r, 600));

    expect(
      submitCalls(),
      'a 500 on the final save still locked the PRF at the last good autosave',
    ).toHaveLength(0);
    expect((window.alert as any).mock.calls.flat().join(' '))
      .toMatch(/has NOT been submitted|too large/i);
  });
});

/**
 * The waiver: a crew standing in a casualty that will not print a sticker, or
 * in front of a sister who will not sign, must still be able to submit. What
 * they may NOT do is waive something only they control — their own clock,
 * their own destination, their own typing. That split is the whole design, so
 * it is what these tests pin.
 */
describe('Submit with a reason (override)', () => {
  const OVERRIDE_BTN = /Can't get these/i;

  /** Only the hospital sticker outstanding — a third party would not supply it. */
  const softOnly = () => {
    const { hospital_sticker: _drop, ...rest } = COMPLETE_HANDOVER as any;
    seedDraft(
      { ...rest, handover_doctor_email: 'ops@hospital.co.za' },
      COMPLETE_TIMES, COMPLETE_SIGS,
    );
  };

  it('offers the waiver when every outstanding item depends on someone else', async () => {
    softOnly();
    const { container } = mountForm();
    await tapSubmit(container);

    expect(screen.queryByRole('button', { name: OVERRIDE_BTN })).not.toBeNull();
    expect(container.textContent).toMatch(/Hospital sticker/i);
  });

  it('offers the waiver for a missing date of birth — the patient may not have one to give', async () => {
    seedDraft(
      { ...COMPLETE_HANDOVER, handover_doctor_email: 'ops@hospital.co.za', patient_dob: '' },
      COMPLETE_TIMES, COMPLETE_SIGS,
    );
    const { container } = mountForm();
    await tapSubmit(container);

    expect(screen.queryByRole('button', { name: OVERRIDE_BTN })).not.toBeNull();
    expect(container.textContent).toMatch(/Patient date of birth/i);
  });

  it('does NOT offer the waiver while the clinical assessment is missing — it is the crew\'s own work', async () => {
    seedDraft(
      { ...COMPLETE_HANDOVER, handover_doctor_email: 'ops@hospital.co.za', primary_diagnosis: '', survey_a: '' },
      COMPLETE_TIMES, COMPLETE_SIGS,
    );
    const { container } = mountForm();
    await tapSubmit(container);

    expect(
      screen.queryByRole('button', { name: OVERRIDE_BTN }),
      'a crew was offered a way to waive their own clinical assessment',
    ).toBeNull();
    expect(container.textContent).toMatch(/Must be completed/i);
    expect(submitCalls()).toHaveLength(0);
  });

  it('does NOT offer the waiver while an item only the crew controls is missing', async () => {
    // Available time is the crew's own clock. Nothing external can withhold it,
    // so "we could not get it" is never true and there must be no way past it.
    const { hospital_sticker: _drop, ...rest } = COMPLETE_HANDOVER as any;
    seedDraft(
      { ...rest, handover_doctor_email: 'ops@hospital.co.za' },
      { time_at_destination: COMPLETE_TIMES.time_at_destination },  // no Available
      COMPLETE_SIGS,
    );
    const { container } = mountForm();
    await tapSubmit(container);

    expect(
      screen.queryByRole('button', { name: OVERRIDE_BTN }),
      'a crew was offered a way to waive their own Available time',
    ).toBeNull();
    expect(container.textContent).toMatch(/Must be completed/i);
    expect(submitCalls()).toHaveLength(0);
  });

  it('submits once a reason is written, and stores what was waived, by whom and when', async () => {
    softOnly();
    const { container } = mountForm();
    await tapSubmit(container);

    fireEvent.click(screen.getByRole('button', { name: OVERRIDE_BTN }));
    await new Promise(r => setTimeout(r, 150));

    // The waiver names the specific item, not a blanket "some fields".
    expect(container.textContent).toMatch(/Submit without these\?/i);
    expect(container.textContent).toMatch(/Hospital sticker/i);

    const box = container.querySelector('#prf-field-submit_override_reason') as HTMLTextAreaElement;
    expect(box, 'the reason field is missing from the waiver popup').toBeTruthy();
    fireEvent.change(box, { target: { value: 'Casualty sticker printer was offline; sister on duty confirmed none available.' } });
    await new Promise(r => setTimeout(r, 150));

    fireEvent.click(screen.getByRole('button', { name: /Record & Submit/i }));
    await waitFor(() => expect(submitCalls().length).toBe(1), { timeout: 4000 });

    const lastPatch = instance.patch.mock.calls.at(-1)?.[1];
    expect(lastPatch?.form_data?.submit_override_reason).toMatch(/printer was offline/i);
    expect(lastPatch?.form_data?.submit_override_items?.map((i: any) => i.field))
      .toContain('hospital_sticker');
    expect(lastPatch?.form_data?.submit_override_by, 'the waiver is not attributable')
      .toMatch(/Mokoena/);
    expect(lastPatch?.form_data?.submit_override_at).toBeTruthy();
  });

  it('will not let one waiver cover an item it never named', async () => {
    // A waiver recorded earlier for the sticker must not carry a later gap
    // through with it — otherwise it becomes a permanent dismiss button.
    const { hospital_sticker: _s, handover_qualification: _q, ...rest } = COMPLETE_HANDOVER as any;
    seedDraft(
      {
        ...rest,
        handover_doctor_email: 'ops@hospital.co.za',
        submit_override_reason: 'Casualty had no sticker printer.',
        submit_override_items: [{ field: 'hospital_sticker', label: 'Hospital sticker' }],
        submit_override_at: '2026-08-12T11:00:00Z',
        submit_override_by: 'A. Mokoena · ECP0012345',
      },
      COMPLETE_TIMES, COMPLETE_SIGS,
    );
    const { container } = mountForm();
    await tapSubmit(container);

    expect(
      submitCalls(),
      'a stale waiver carried an item it never named past the gate',
    ).toHaveLength(0);
    expect(container.textContent).toMatch(/Practitioner number/i);
  });
});
