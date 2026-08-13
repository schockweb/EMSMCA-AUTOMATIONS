/**
 * Crew 2 must exist on a PRF captured with no signal.
 *
 * Everything the form knew about Crew 2 came from `prfMeta` — the SERVER row.
 * A PRF started offline has no server row, so `prfMeta` stayed `{}` and the
 * second practitioner vanished from the form entirely: no sign-off requested on
 * a document that names them, and no Crew 2 option in the treating / IV /
 * medication picker, which is what HPCSA scope enforcement attributes against.
 *
 * Reported from the field: submit one PRF offline, start another, and the
 * second "doesn't pick up the 2nd crew member and doesn't ask for the 2nd crew
 * member signature". The first one worked because it had been created online,
 * so its GET was already in the service worker's cache.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';

vi.mock('axios');
import DigitalPRFForm from '../pages/crew/DigitalPRFForm';
import { crewMemberById, shiftCrew } from '../pages/crew/localCrewRoster';

const PRF_ID = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
const PROVIDER = 'harness-ems';
const PARTNER_ID = 'crew-2-uuid';
const PARTNER_NAME = 'T. Ndlovu';

// ── The roster shapes that actually exist in the wild ────────────────────────
// CrewDashboard's HPCSA lookup writes `name`; saveShiftSession's declared
// CrewMemberProfile carries `full_name`. The form read only `full_name`, so its
// existing offline fallback was dead code against the dashboard's shape.
const DASHBOARD_SHAPE = {
  id: PARTNER_ID, name: PARTNER_NAME, qualification: 'AEA', hpcsa_number: 'AEA0099',
};
const WIZARD_SHAPE = {
  id: PARTNER_ID, name: PARTNER_NAME, full_name: PARTNER_NAME,
  qualification: 'AEA', hpcsa_number: 'AEA0099',
};

describe('localCrewRoster', () => {
  beforeEach(() => localStorage.clear());

  it('resolves the dashboard shape, which writes `name` and no `full_name`', () => {
    localStorage.setItem('crew2_profile', JSON.stringify(DASHBOARD_SHAPE));
    expect(crewMemberById(PARTNER_ID)?.full_name).toBe(PARTNER_NAME);
  });

  it('resolves the shift-wizard shape too', () => {
    localStorage.setItem('crew2_profile', JSON.stringify(WIZARD_SHAPE));
    expect(crewMemberById(PARTNER_ID)?.full_name).toBe(PARTNER_NAME);
  });

  it('refuses an id that is not on this device’s roster', () => {
    // A crew swap mid-shift. Printing whoever is stored NOW onto an earlier
    // call's record — and asking them to sign it — is worse than printing
    // nobody, so an unknown id must resolve to null.
    localStorage.setItem('crew2_profile', JSON.stringify(DASHBOARD_SHAPE));
    expect(crewMemberById('someone-else-entirely')).toBeNull();
  });

  it('refuses an empty id — a solo shift has no Crew 2 to invent', () => {
    localStorage.setItem('crew2_profile', JSON.stringify(DASHBOARD_SHAPE));
    expect(crewMemberById('')).toBeNull();
    expect(crewMemberById(null)).toBeNull();
  });

  it('finds a third crew member, not just the partner', () => {
    localStorage.setItem('crew2_profile', JSON.stringify(DASHBOARD_SHAPE));
    localStorage.setItem('extra_crew_profiles', JSON.stringify([
      DASHBOARD_SHAPE,
      { id: 'crew-3-uuid', name: 'P. Dlamini', qualification: 'ECP', hpcsa_number: 'ECP0100' },
    ]));
    expect(crewMemberById('crew-3-uuid')?.full_name).toBe('P. Dlamini');
  });

  it('does not list the partner twice — crew2_profile mirrors extra_crew[0]', () => {
    localStorage.setItem('crew2_profile', JSON.stringify(DASHBOARD_SHAPE));
    localStorage.setItem('extra_crew_profiles', JSON.stringify([DASHBOARD_SHAPE]));
    expect(shiftCrew()).toHaveLength(1);
  });

  it('ignores a roster entry with no usable name', () => {
    localStorage.setItem('crew2_profile', JSON.stringify({ id: PARTNER_ID }));
    expect(crewMemberById(PARTNER_ID)).toBeNull();
  });

  it('survives corrupt storage rather than taking the form down', () => {
    localStorage.setItem('crew2_profile', '{not json');
    localStorage.setItem('extra_crew_profiles', '{"not":"an array"}');
    expect(shiftCrew()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The form itself, with no reachable server — the offline case.
// ─────────────────────────────────────────────────────────────────────────────

/** Seed the local draft the offline "New PRF" button writes. `phase: 5` is
 *  Handover, which renders the Complete screen (crew details + sign-off)
 *  inline at its foot. */
function seedDraft(crew2Id: string) {
  localStorage.setItem(`prf-draft:${PRF_ID}`, JSON.stringify({
    fd: { patient_name: 'Offline', patient_surname: 'Capture' },
    vitals: [], ivRows: [], medRows: [],
    timestamps: {}, kms: {}, geos: {},
    sigs: {
      patient_signature: null, witness_signature: null, handover_signature: null,
      crew_signature: null, valuables_signature: null,
    },
    vehicle: '', crew2Id, phase: 5, savedAt: Date.now(),
  }));
}

function mountForm() {
  return render(
    <MemoryRouter initialEntries={[`/${PROVIDER}/crew/prf/${PRF_ID}`]}>
      <Routes>
        <Route path="/:providerSlug/crew/prf/:prfId" element={<DigitalPRFForm />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DigitalPRFForm with no server row (captured offline)', () => {
  beforeEach(() => {
    // Every request fails at the transport layer — a PRF that has never
    // existed server-side, on a device with no signal.
    const offline = {
      get: vi.fn(async () => { throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }); }),
      patch: vi.fn(async () => { throw new Error('Network Error'); }),
      post: vi.fn(async () => { throw new Error('Network Error'); }),
      delete: vi.fn(async () => { throw new Error('Network Error'); }),
    };
    (axios as any).create = vi.fn(() => offline);
    (axios as any).get = offline.get;
    (axios as any).patch = offline.patch;
    (axios as any).post = offline.post;

    localStorage.clear();
    localStorage.setItem('crew_token', 'offline-test-token');
    localStorage.setItem('crew_profile', JSON.stringify({
      id: 'crew-1', name: 'A. Mokoena', provider_id: 'prov-1',
      provider_slug: PROVIDER, provider_name: 'Harness EMS',
      qualification: 'ECP', hpcsa_number: 'ECP0012345', role: 'crew',
    }));
    localStorage.setItem('crew2_profile', JSON.stringify(DASHBOARD_SHAPE));

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

  it('shows Crew 2 even though the PRF has never reached the server', async () => {
    seedDraft(PARTNER_ID);
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toMatch(/Crew Details/i));
    expect(container.textContent).not.toMatch(/something went wrong/i);
    expect(
      container.textContent,
      'the partner recorded on this PRF must appear on the completion screen',
    ).toContain(PARTNER_NAME);
  });

  it('shows nobody as Crew 2 on a solo call', async () => {
    // The partner is still in storage from an earlier shift configuration.
    // This PRF records no crew 2, so none may be shown — the roster is a
    // lookup table, not a default.
    seedDraft('');
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toMatch(/Crew Details/i));
    expect(container.textContent).not.toContain(PARTNER_NAME);
  });

  it('shows nobody as Crew 2 when the recorded partner is not on this roster', async () => {
    seedDraft('a-crew-member-this-device-never-saw');
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toMatch(/Crew Details/i));
    expect(container.textContent).not.toContain(PARTNER_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ONLINE case: the server row names the crew, and it is authoritative.
//
// Crew 1 on the Complete screen used to render straight from the device's
// localStorage profile. Reported from the field mid-call: a session whose
// stored profile had no usable name showed Crew 1 as "—" on a two-crew call,
// while the server row named the lead crew the whole time. The form documents
// who was ON the call, not whose session is rendering it.
// ─────────────────────────────────────────────────────────────────────────────

describe('DigitalPRFForm with a server row — the PRF record names Crew 1', () => {
  const LEAD_NAME = 'Maria Mahon';

  function mockServerPrf() {
    const prf = {
      id: PRF_ID,
      prf_number: 30,
      case_number: 'HARNESS-2026-08-000030',
      status: 'DRAFT',
      updated_at: '2026-08-13T12:44:16Z',
      form_data: { patient_name: 'Online', patient_surname: 'Capture' },
      vehicle_id: null,
      crew_member_1_id: 'crew-1-uuid',
      crew_member_2_id: PARTNER_ID,
      crew_member_1: { full_name: LEAD_NAME, qualification: 'ECP', hpcsa_number: 'ECP0001678' },
      crew_member_2: { full_name: PARTNER_NAME, qualification: 'AEA', hpcsa_number: 'AEA0099' },
      geo_locations: {},
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
  }

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('crew_token', 'online-test-token');
    mockServerPrf();

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

  it('names Crew 1 from the server row when the device profile has no name', async () => {
    // The field report: crew_profile exists (valid token, id, qualification)
    // but carries no `name`. Both crew are on the server row.
    localStorage.setItem('crew_profile', JSON.stringify({
      id: 'crew-1-uuid', provider_id: 'prov-1', provider_slug: PROVIDER,
      provider_name: 'Harness EMS', qualification: 'ECP', role: 'crew',
    }));
    seedDraft('');
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toMatch(/Crew Details/i));
    expect(
      container.textContent,
      'the lead crew recorded on this PRF must appear on the completion screen',
    ).toContain(LEAD_NAME);
    expect(container.textContent).toContain(PARTNER_NAME);
  });

  it('prefers the recorded Crew 1 over a different logged-in viewer', async () => {
    // An admin (or partner device) opening the record must see the crew that
    // is ON the PRF, not themselves.
    localStorage.setItem('crew_profile', JSON.stringify({
      id: 'admin-uuid', name: 'Back Office Admin', provider_id: 'prov-1',
      provider_slug: PROVIDER, provider_name: 'Harness EMS',
      qualification: 'BAA', role: 'crew_admin',
    }));
    seedDraft('');
    const { container } = mountForm();
    await waitFor(() => expect(container.textContent).toMatch(/Crew Details/i));
    expect(container.textContent).toContain(LEAD_NAME);
  });
});
