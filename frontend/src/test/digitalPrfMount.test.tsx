/**
 * The FIRST test that actually mounts DigitalPRFForm.
 *
 * 10,862 lines, the form crews use at the roadside, and until now no test ever
 * rendered it. The two suites that appeared to cover it (conditionalFields,
 * digitalPrfSecurity) re-implement its logic inside the test file and import
 * nothing from the app — they would pass if the form were deleted.
 *
 * The point of this file is NOT exhaustive coverage. It is a smoke alarm for the
 * recurring crash family this component has:
 *   - a missing slate colour token (an undefined global that takes the whole
 *     page down through the ErrorBoundary the moment any code touches it)
 *   - wrong runtime types arriving from the API (number where a string is
 *     expected, object where an array is expected)
 *   - a non-component export that silently breaks React Fast Refresh
 * Every one of those is invisible to a pure-logic test and fatal in a crew's
 * hands. Rendering the thing once catches all of them.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';

vi.mock('axios');
import DigitalPRFForm from '../pages/crew/DigitalPRFForm';
import { shouldHideScopeOption, scopeForFormLabel } from '../data/hpcsaScope';

const PRF_ID = '11111111-2222-3333-4444-555555555555';
const PROVIDER = 'harness-ems';

/** A PRF shaped the way the admin endpoint actually returns one. */
function fixturePrf(overrides: Record<string, any> = {}) {
  return {
    id: PRF_ID,
    prf_number: 4242,
    case_number: 'HARNESS-2026-07-004242',
    status: 'DRAFT',
    updated_at: '2026-07-28T10:00:00Z',
    form_data: { patient_name: 'Mount', patient_surname: 'Test', ...(overrides.form_data || {}) },
    vehicle_id: null,
    crew_member_2_id: null,
    geo_locations: {},
    ...overrides,
  };
}

let currentPrf: any = null;

beforeEach(() => {
  currentPrf = fixturePrf();
  // The form builds its own axios instance via axios.create().
  const instance = {
    get: vi.fn(async () => ({ data: currentPrf })),
    patch: vi.fn(async () => ({ data: currentPrf })),
    post: vi.fn(async () => ({ data: currentPrf })),
    delete: vi.fn(async () => ({ data: {} })),
  };
  (axios as any).create = vi.fn(() => instance);
  (axios as any).get = instance.get;
  (axios as any).patch = instance.patch;
  (axios as any).post = instance.post;

  localStorage.clear();
  localStorage.setItem('crew_token', 'mount-test-token');
  localStorage.setItem('crew_profile', JSON.stringify({
    id: 'crew-1', name: 'A. Mokoena', provider_id: 'prov-1',
    provider_slug: PROVIDER, provider_name: 'Harness EMS',
    qualification: 'ECP', hpcsa_number: 'ECP0012345', role: 'crew',
  }));

  // Browser APIs the form reaches for that jsdom does not implement.
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

function mountForm() {
  return render(
    <MemoryRouter initialEntries={[`/${PROVIDER}/crew/prf/${PRF_ID}`]}>
      <Routes>
        <Route path="/:providerSlug/crew/prf/:prfId" element={<DigitalPRFForm />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DigitalPRFForm — it renders at all', () => {
  it('mounts and loads the PRF without throwing', async () => {
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    // Not the ErrorBoundary's output — the form itself.
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('renders without a single console error', async () => {
    // Undefined colour tokens, bad prop types and React key/DOM violations all
    // announce themselves here and nowhere else in a pure-logic test.
    const errors: any[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    mountForm();
    await waitFor(() => expect(screen.queryByText(/PRF/i)).toBeTruthy());
    spy.mockRestore();
    const text = errors.map(e => String(e[0])).join('\n');
    expect(text, `console.error during mount:\n${text}`).toBe('');
  });

  it('survives a PRF whose numeric fields arrive as NUMBERS, not strings', async () => {
    // The recurring crash family: the backend stores odometer values
    // numerically, and code downstream calls .split()/.trim() on them.
    currentPrf = fixturePrf({
      km_on_scene: 104219, km_dispatched: 0,
      prf_number: 4242,
      form_data: { patient_name: 'Numeric', age: 42, patient_id_number: 9001015800083 },
    });
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('survives a numeric SA ID restored from a LOCAL DRAFT (no normaliser on that path)', async () => {
    // Two independent layers protect this, and only one of them covers the
    // draft path. normalizeFormData runs on the SERVER load branch; loadFromLocal
    // calls setFd(draft.fd) with no normalisation at all. So a draft written
    // from bad data reaches autofillAgeFromId raw, inside a mount-time effect,
    // where .replace() on a number takes the whole form down through the
    // ErrorBoundary before the crew can type anything.
    localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
      fd: { patient_name: 'Draft', patient_id_number: 9001015800083, age: 42 },
      vitals: [], ivRows: [], medRows: [],
      timestamps: {}, kms: {}, geos: {},
      sigs: {
        patient_signature: null, witness_signature: null, handover_signature: null,
        crew_signature: null, valuables_signature: null,
      },
      vehicle: '', crew2Id: '', phase: 0, savedAt: Date.now(),
    }));
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('keeps a manually-typed DOB when the patient has no ID number', async () => {
    // The SA-ID autofill's clear branch exists for the transition "crew
    // deletes the ID". Effects also run once on mount, and that run used to
    // hit the branch with an empty ID and wipe a manually-typed patient_dob
    // and age (passport holders and unidentified patients have no SA ID),
    // then autosave the wipe over the record.
    localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
      fd: { patient_name: 'Passport', patient_surname: 'Holder', patient_dob: '1988-03-14', age: '38' },
      vitals: [], ivRows: [], medRows: [],
      timestamps: {}, kms: {}, geos: {},
      sigs: {
        patient_signature: null, witness_signature: null, handover_signature: null,
        crew_signature: null, valuables_signature: null,
      },
      vehicle: '', crew2Id: '', phase: 2, savedAt: Date.now(),
    }));
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    await new Promise(r => setTimeout(r, 200));
    const yearSeg = Array.from(container.querySelectorAll('input.prf-date-seg'))
      .find(i => (i as HTMLInputElement).value === '1988');
    expect(yearSeg, 'the mount-time ID autofill cleared a DOB it never derived').toBeTruthy();
  });

  it('survives array fields arriving as null or as the wrong type', async () => {
    currentPrf = fixturePrf({
      form_data: {
        patient_name: 'Shapes',
        vitals_sets: null, iv_therapy: null, medications: null,
        mechanism: 'FALL',            // a string where an array is expected
        airway_interventions: null,
      },
    });
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('survives a completely empty form_data — the state at the start of every call', async () => {
    currentPrf = fixturePrf({ form_data: {} });
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('does not crash when the PRF fails to load', async () => {
    const failing = {
      get: vi.fn(async () => { throw Object.assign(new Error('boom'), { response: { status: 500 } }); }),
      patch: vi.fn(), post: vi.fn(), delete: vi.fn(),
    };
    (axios as any).create = vi.fn(() => failing);
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });
});

/**
 * HPCSA scope visibility.
 *
 * Asserted against the rule itself rather than through the DOM: the Airway and
 * Circulation grids live inside a CollapsibleSection that starts closed, so
 * their contents are not rendered until a crew taps the header. Driving that
 * would test the accordion, not the scope rule.
 */
describe('HPCSA scope — a recorded procedure must never be hidden', () => {
  it('hides an out-of-scope option only while nothing is recorded against it', () => {
    // Clean grid: a BAA crew is not offered procedures they cannot perform.
    expect(shouldHideScopeOption(true, false)).toBe(true);
  });

  it('KEEPS a recorded procedure visible even once it is out of scope', () => {
    // The defect: the form unmounted every out-of-scope option unconditionally,
    // so changing the treating practitioner mid-call made an already-ticked
    // Intubation or Surgical Airway vanish from the screen while staying in
    // form_data and in the submitted PRF — invisible and uncorrectable, on a
    // document that then asserted a practitioner exceeded their scope.
    expect(shouldHideScopeOption(true, true)).toBe(false);
  });

  it('never hides anything that is in scope', () => {
    expect(shouldHideScopeOption(false, false)).toBe(false);
    expect(shouldHideScopeOption(false, true)).toBe(false);
  });

  it('agrees with the real scope matrix: a BAA may not intubate', () => {
    // Guards against the rule being right while the inputs are wrong.
    const verdict = scopeForFormLabel('Intubation', 'BAA');
    expect(verdict.kind).toBe('unauthorised');
    const outOfScope = verdict.kind === 'unauthorised';
    expect(shouldHideScopeOption(outOfScope, false)).toBe(true);   // never ticked -> hidden
    expect(shouldHideScopeOption(outOfScope, true)).toBe(false);   // ticked -> stays visible
  });

  it('an ECP may intubate, so the option is offered normally', () => {
    const verdict = scopeForFormLabel('Intubation', 'ECP');
    expect(verdict.kind).toBe('authorised');
    expect(shouldHideScopeOption(false, false)).toBe(false);
  });
});

/**
 * Tenant isolation must be visible.
 *
 * A 403 from the load endpoint is the server's tenant guard: this PRF belongs to
 * another provider. The load path used to treat ANY error as recoverable when a
 * local draft existed, so a 403 rendered as a normally-loaded form — the crew
 * kept editing another provider's patient record and nothing on screen said so.
 */
describe('DigitalPRFForm — a 403 is never suppressed by a local draft', () => {
  function seedDraft(fd: Record<string, any>) {
    localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
      fd, vitals: [], ivRows: [], medRows: [],
      timestamps: {}, kms: {}, geos: {},
      sigs: {
        patient_signature: null, witness_signature: null, handover_signature: null,
        crew_signature: null, valuables_signature: null,
      },
      vehicle: '', crew2Id: '', phase: 0, savedAt: Date.now(),
    }));
  }

  function failWith(status: number) {
    const inst = {
      get: vi.fn(async () => { throw Object.assign(new Error('x'), { response: { status } }); }),
      patch: vi.fn(), post: vi.fn(), delete: vi.fn(),
    };
    (axios as any).create = vi.fn(() => inst);
  }

  it('surfaces a provider mismatch instead of rendering the draft as normal', async () => {
    seedDraft({ patient_name: 'ForeignTenantPatient' });
    failWith(403);
    const { container } = mountForm();
    await waitFor(() => {
      expect(container.textContent).toMatch(/different service provider/i);
    }, { timeout: 4000 });
  });

  it('still tolerates a network failure by continuing from the local draft', async () => {
    // The suppression exists for a good reason — offline work must continue.
    // Only 403 is carved out of it.
    seedDraft({ patient_name: 'OfflinePatient' });
    const inst = {
      get: vi.fn(async () => { throw Object.assign(new Error('net'), { code: 'ERR_NETWORK' }); }),
      patch: vi.fn(), post: vi.fn(), delete: vi.fn(),
    };
    (axios as any).create = vi.fn(() => inst);
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toMatch(/different service provider/i);
    expect(container.textContent).not.toMatch(/could not reach the server/i);
  });
});

// ── Viewport reactivity (the useIsMobile migration) ────────────────────────
//
// Four layout reads in this form used to sample window.innerWidth ONCE at
// render and never update — rotating a tablet left the previous orientation's
// layout on screen until something else forced a render, mid-call. They now go
// through the shared useIsMobile hook. These tests exist because that migration
// touched the riskiest screen in the product: a hook called in the wrong place
// (after Modal's early return, or inside the conditionally-invoked P0) throws
// "rendered fewer hooks than expected" only at runtime, on a phone.
describe('DigitalPRFForm — viewport handling', () => {
  const setWidth = (w: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
  };

  afterEach(() => setWidth(1024));

  it('mounts at a phone width without throwing', async () => {
    setWidth(375);
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });

  it('mounts at a phone width with no console error', async () => {
    setWidth(375);
    const errors: any[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    mountForm();
    await waitFor(() => expect(screen.queryByText(/PRF/i)).toBeTruthy());
    spy.mockRestore();
    const text = errors.map(e => String(e[0])).join(' | ');
    expect(text, 'console.error at 375px: ' + text).toBe('');
  });

  it('survives rotation — resize and orientationchange keep hook order intact', async () => {
    // The failure this guards against surfaces on the RE-RENDER, not on mount:
    // a conditionally-called hook throws "rendered fewer hooks than expected".
    setWidth(375);
    const errors: any[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toBeTruthy());

    await act(async () => {
      setWidth(1024);                                   // rotate to landscape
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
    });
    await waitFor(() => expect(container.textContent).toBeTruthy());

    await act(async () => {
      setWidth(375);                                    // and back to portrait
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
    });
    await waitFor(() => expect(container.textContent).toBeTruthy());

    spy.mockRestore();
    const text = errors.map(e => String(e[0])).join(' | ');
    expect(text, 'console.error while rotating: ' + text).toBe('');
    expect(container.textContent).not.toMatch(/something went wrong/i);
  });
});
